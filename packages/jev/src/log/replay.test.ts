import { Task, type DecisionRecord, type ToolCall, type ToolName } from '@desiide/protocol';
import { exampleCostRouteState, exampleWorkflowSelectState } from '@desiide/protocol/fixtures';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createPolicyGate, type PolicySettings } from '../policy/gate.ts';
import { DEFAULT_THRESHOLDS } from '../policy/thresholds.ts';
import { decideWorkflow } from '../policy/workflow.ts';
import { createRuleJevEngine } from '../rules/engine.ts';
import type { JevEngine } from '../types.ts';
import { createDecisionLog } from './decisionLog.ts';
import { ReplayError, replayDecision } from './replay.ts';

const rules = createRuleJevEngine();
const conservative: PolicySettings = {
  mode: 'conservative',
  thresholds: { ...DEFAULT_THRESHOLDS },
};
const strict: PolicySettings = { ...conservative, mode: 'strict' };
const task = Task.parse({ id: 't1', kind: 'bug_fix', instruction: 'x' });

let ids = 0;
const newId = (): string => `dec-${ids++}`;
const call = (tool: ToolName, args: Record<string, unknown>): ToolCall => ({
  id: `c-${ids++}`,
  tool,
  args,
  sideEffect: tool === 'propose_edit' ? 'workspace' : tool === 'shell' ? 'external' : 'none',
});

/** Tool calls covering every path through the gate. */
const CALLS: [string, ToolCall, PolicySettings][] = [
  ['plain read', call('read_file', { path: 'src/a.ts' }), conservative],
  ['sensitive read', call('read_file', { path: '.env' }), conservative],
  ['list', call('list_files', { path: 'src' }), conservative],
  ['git_read', call('git_read', { command: 'diff' }), conservative],
  ['read-only shell', call('shell', { command: 'git status' }), conservative],
  ['deny-listed', call('shell', { command: 'rm -rf /' }), conservative],
  ['force push', call('shell', { command: 'git push --force origin main' }), conservative],
  ['migration', call('shell', { command: 'npm run migrate' }), conservative],
  ['plain command', call('shell', { command: 'echo hi' }), conservative],
  ['install', call('shell', { command: 'pnpm add zod' }), conservative],
  ['configured tests', call('run_tests', {}), conservative],
  ['single edit', call('propose_edit', { files: [{ path: 'src/a.ts' }] }), conservative],
  [
    'multi edit',
    call('propose_edit', { files: [{ path: 'src/a.ts' }, { path: 'src/b.ts' }] }),
    conservative,
  ],
  ['strict command', call('shell', { command: 'echo hi' }), strict],
  ['strict read', call('read_file', { path: 'src/a.ts' }), strict],
];

async function gateRecords(
  c: ToolCall,
  settings: PolicySettings,
  testCommand?: string,
): Promise<DecisionRecord[]> {
  const records: DecisionRecord[] = [];
  await createPolicyGate({
    engine: rules,
    settings: () => settings,
    project: () => Promise.resolve(testCommand ? { testCommand } : {}),
    git: () => Promise.resolve({ branch: 'feature/x', hasPendingMigrations: false }),
    newId,
    onDecision: (r) => records.push(r),
  }).evaluate(c, task, new AbortController().signal);
  return records;
}

describe('replayDecision', () => {
  it.each(CALLS)(
    'AC3: a rules-engine record for "%s" replays to the same result',
    async (_name, c, settings) => {
      const records = await gateRecords(c, settings, 'pnpm test');
      expect(records.length).toBeGreaterThan(0);
      for (const record of records) {
        const replay = await replayDecision(record, { rules, settings });
        expect(replay.rules).toEqual({
          engine: record.engine,
          result: record.result,
          policyOutcome: record.policyOutcome,
          latencyMs: expect.any(Number) as number,
        });
        expect(replay.differs).toBe(false);
        expect(replay.jev).toBeUndefined();
      }
    },
  );

  it('AC3: run_tests with no command configured replays as a read-only tool', async () => {
    const [record] = await gateRecords(call('run_tests', {}), conservative);
    expect(record?.reasons).toEqual(['read_only_allow']);
    const replay = await replayDecision(record as DecisionRecord, {
      rules,
      settings: conservative,
    });
    expect(replay.differs).toBe(false);
  });

  it('AC3: routing records (workflow_select, cost_route) replay to the same result', async () => {
    const records: DecisionRecord[] = [];
    await decideWorkflow(
      {
        task: Task.parse({ id: 't2', kind: 'bug_fix', instruction: 'x', preference: 'balance' }),
        workflowState: exampleWorkflowSelectState,
        costState: exampleCostRouteState,
      },
      { engine: rules, newId, onDecision: (r) => records.push(r) },
    );
    expect(records.map((r) => r.question)).toEqual(['workflow', 'complexity', 'cheap_success']);
    for (const record of records) {
      const replay = await replayDecision(record, { rules, settings: conservative });
      expect(replay.rules.result).toEqual(record.result);
      expect(replay.rules.policyOutcome).toBeUndefined();
      expect(replay.differs).toBe(false);
    }
  });

  it('AC3: records replay identically after a round trip through the log on disk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'desiide-replay-'));
    try {
      const log = createDecisionLog({ dir });
      const written: DecisionRecord[] = [];
      for (const [, c, settings] of CALLS) {
        for (const r of await gateRecords(c, settings, 'pnpm test')) {
          written.push(r);
          await log.append(r);
        }
      }
      const { decisions } = await log.list({ limit: 500 });
      expect(decisions).toHaveLength(written.length);
      for (const record of decisions) {
        // Strict mode is a setting, not state: replay with the settings the record was made under.
        const settings = record.reasons.includes('policy_override:strict_mode')
          ? strict
          : conservative;
        const replay = await replayDecision(record, { rules, settings });
        expect(replay.differs, record.id).toBe(false);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reports a diff when the current settings decide differently', async () => {
    const [record] = await gateRecords(call('shell', { command: 'echo hi' }), conservative);
    const replay = await replayDecision(record as DecisionRecord, { rules, settings: strict });
    expect(record?.policyOutcome).not.toBe('confirm');
    expect(replay.rules.policyOutcome).toBe('confirm');
    expect(replay.differs).toBe(true);
  });

  it('runs Jev too when configured and diffs it against the record', async () => {
    const overconfident: JevEngine = {
      kind: 'jev',
      choice: () => Promise.reject(new Error('unused')),
      score: () => Promise.reject(new Error('unused')),
      noul: () =>
        Promise.resolve({
          engine: 'jev',
          result: { kind: 'noul', answer: 'yes', pYes: 0.99 },
          rationale: [],
          latencyMs: 12,
        }),
    };
    const records = await gateRecords(call('shell', { command: 'npm run migrate' }), conservative);
    const safeNow = records.find((r) => r.question === 'safe_now') as DecisionRecord;
    const replay = await replayDecision(safeNow, {
      rules,
      jev: overconfident,
      settings: conservative,
    });
    expect(replay.rules.result).toEqual(safeNow.result);
    expect(replay.jev).toEqual({
      engine: 'jev',
      result: { kind: 'noul', answer: 'yes', pYes: 0.99 },
      // The migration floor holds whatever Jev says.
      policyOutcome: 'confirm',
      latencyMs: 12,
    });
    expect(replay.differs).toBe(true);
  });

  it('a failing Jev becomes jevError; the rules run still comes back', async () => {
    const broken: JevEngine = {
      kind: 'jev',
      choice: () => Promise.reject(new Error('down')),
      score: () => Promise.reject(new Error('down')),
      noul: () => Promise.reject(new Error('Jev endpoint unreachable')),
    };
    // Not read-only, so the gate asks the engine (`echo` would be decided by policy alone).
    const records = await gateRecords(call('shell', { command: 'npm run build' }), conservative);
    expect(records[0]?.question).toBe('safe_now');
    const replay = await replayDecision(records[0] as DecisionRecord, {
      rules,
      jev: broken,
      settings: conservative,
    });
    expect(replay.jev).toBeUndefined();
    expect(replay.jevError).toBe('Jev endpoint unreachable');
    expect(replay.differs).toBe(false);
  });

  it('refuses records from packs it does not know', async () => {
    const [record] = await gateRecords(call('read_file', { path: 'src/a.ts' }), conservative);
    const future = {
      ...(record as DecisionRecord),
      pack: 'risk_gate@2',
      state: { pack: 'risk_gate@2' },
    };
    await expect(replayDecision(future, { rules, settings: conservative })).rejects.toBeInstanceOf(
      ReplayError,
    );
  });

  it('propagates aborts', async () => {
    const records = await gateRecords(call('shell', { command: 'echo hi' }), conservative);
    const ac = new AbortController();
    ac.abort();
    await expect(
      replayDecision(records[0] as DecisionRecord, { rules, settings: conservative }, ac.signal),
    ).rejects.toThrow();
  });
});
