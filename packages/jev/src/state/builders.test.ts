import { describe, expect, it } from 'vitest';
import {
  MAX_COMMAND_CHARS,
  MAX_FILES_TOUCHED,
  type FileMeta,
  type ToolCall,
} from '@desiide/protocol';
import { parsePackState } from '../packs/registry.ts';
import { createRuleJevEngine } from '../rules/engine.ts';
import {
  buildCostRouteState,
  buildRiskGateState,
  buildWorkflowSelectState,
  truncateCommand,
} from './builders.ts';
import { createPathRedactor } from './redact.ts';
import { actionFromToolCall } from './toolCall.ts';

const SECRET = 'TOP-SECRET-FILE-CONTENTS';

/** FileMeta objects as a careless caller might pass them: with contents attached at runtime. */
function file(path: string, sensitive = false, sizeLines = 10): FileMeta {
  return Object.assign(
    { path, sizeLines, language: 'typescript', sensitive },
    { content: SECRET, text: SECRET },
  );
}

const ALLOWED_KEYS = new Set([
  // workflow_select
  'pack',
  'taskType',
  'filesTouched',
  'truncatedCount',
  'estimatedDiffSize',
  'lastRunStatus',
  'userPreference',
  'availableModels',
  'path',
  'sizeLines',
  'language',
  'sensitive',
  'id',
  'contextTokens',
  'latencyMs',
  'costTier',
  // risk_gate
  'actionType',
  'command',
  'editFileCount',
  'context',
  'branch',
  'env',
  'hasPendingMigrations',
  // cost_route
  'filesTouchedCount',
  'projectSizeLines',
  'userCostBias',
  'recentFailures',
]);

function allKeys(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((v) => allKeys(v, out));
  else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      allKeys(v, out);
    }
  }
  return out;
}

function expectMetadataOnly(state: unknown) {
  // AC3: no key other than the allowed metadata fields, and no contents anywhere.
  expect(allKeys(state).filter((k) => !ALLOWED_KEYS.has(k))).toEqual([]);
  expect(JSON.stringify(state)).not.toContain(SECRET);
  expect(parsePackState(state)).toEqual(state);
}

const task = { kind: 'bug_fix', preference: 'balance' } as const;
const models = [
  Object.assign(
    { id: 'ollama-qwen', contextTokens: 32_768, latencyMs: 400, costTier: 'free' as const },
    { apiKey: SECRET, baseUrl: 'http://localhost:11434' },
  ),
];

describe('state builders: metadata only', () => {
  it('workflow_select drops contents and extra fields', () => {
    const bundle = Object.assign(
      { files: [file('src/cart/total.ts'), file('src/auth/session.ts', true)] },
      { sections: [{ text: SECRET }], tokenEstimate: 1200 },
    );
    const state = buildWorkflowSelectState({
      task,
      context: bundle,
      estimatedDiffSize: 12,
      lastRunStatus: 'none',
      models,
    });
    expectMetadataOnly(state);
    expect(state.filesTouched.map((f) => f.path)).toEqual([
      'src/auth/session.ts',
      'src/cart/total.ts',
    ]);
  });

  it('risk_gate from a propose_edit tool call never includes edit text', () => {
    const call: ToolCall = {
      id: 'c1',
      tool: 'propose_edit',
      sideEffect: 'workspace',
      args: {
        files: [
          { path: 'src/billing/invoice.ts', edits: [{ search: SECRET, replace: SECRET }] },
          { path: 'src/billing/invoice.ts', edits: [{ search: 'a', replace: 'b' }] },
          { path: 'src/cart/total.ts', edits: [{ search: SECRET, replace: 'x' }] },
        ],
      },
    };
    const action = actionFromToolCall(call);
    expect(action).toEqual({
      actionType: 'apply_edit',
      editFileCount: 2,
      paths: ['src/billing/invoice.ts', 'src/cart/total.ts'],
    });
    const state = buildRiskGateState({
      action,
      files: [file('src/billing/invoice.ts', true), file('src/cart/total.ts')],
      git: { branch: 'main', hasPendingMigrations: false },
    });
    expectMetadataOnly(state);
  });

  it('cost_route counts files without listing them', () => {
    const state = buildCostRouteState({
      task,
      context: { files: [file('a.ts'), file('b.ts')] },
      projectSizeLines: 42_000,
      recentFailures: 1,
    });
    expectMetadataOnly(state);
    expect(state).toEqual({
      pack: 'cost_route@1',
      taskType: 'bug_fix',
      filesTouchedCount: 2,
      projectSizeLines: 42_000,
      userCostBias: 'balance',
      recentFailures: 1,
    });
  });
});

describe('state builders: caps', () => {
  it('caps files at 50, sensitive first, then larger, and records truncatedCount', () => {
    const files = [
      ...Array.from({ length: 60 }, (_, i) =>
        file(`src/f${String(i).padStart(2, '0')}.ts`, false, i),
      ),
      file('src/auth/a.ts', true, 1),
      file('db/migrations/0001.sql', true, 2),
    ];
    const state = buildWorkflowSelectState({
      task,
      context: { files },
      estimatedDiffSize: 0,
      lastRunStatus: 'none',
      models: [],
    });
    expect(state.filesTouched).toHaveLength(MAX_FILES_TOUCHED);
    expect(state.truncatedCount).toBe(12);
    expect(state.filesTouched.slice(0, 3).map((f) => f.path)).toEqual([
      'db/migrations/0001.sql',
      'src/auth/a.ts',
      'src/f59.ts',
    ]);
    expect(state.filesTouched.at(-1)?.path).toBe('src/f12.ts');
  });

  it('omits truncatedCount when nothing was dropped', () => {
    const state = buildRiskGateState({
      action: { actionType: 'apply_edit', editFileCount: 1 },
      files: [file('src/a.ts')],
      git: { branch: null, hasPendingMigrations: false },
    });
    expect(state).not.toHaveProperty('truncatedCount');
  });

  it('truncates commands to MAX_COMMAND_CHARS', () => {
    const long = `echo ${'x'.repeat(2000)}`;
    const state = buildRiskGateState({
      action: { actionType: 'run_command', command: long },
      files: [],
      git: { branch: 'feature/x', hasPendingMigrations: false },
    });
    expect(state.command).toHaveLength(MAX_COMMAND_CHARS);
    expect(state.command?.endsWith('…')).toBe(true);
    expect(truncateCommand('ls')).toBe('ls');
  });

  it('rejects inputs that would produce an invalid state', () => {
    expect(() =>
      buildCostRouteState({
        task,
        context: { files: [] },
        projectSizeLines: -5,
        recentFailures: 0,
      }),
    ).toThrow(expect.objectContaining({ code: 'invalid_state' }));
  });
});

describe('state builders: redaction', () => {
  const redactor = createPathRedactor({ salt: 'per-workspace-salt-xyz' });

  it('redacts file paths and paths inside commands, deterministically', () => {
    const input = {
      action: { actionType: 'run_command' as const, command: 'node scripts/acme-migrate.js' },
      files: [file('src/acme/ledger.ts', true)],
      git: { branch: 'main', hasPendingMigrations: true },
    };
    const a = buildRiskGateState(input, { redactor });
    const b = buildRiskGateState(input, {
      redactor: createPathRedactor({ salt: 'per-workspace-salt-xyz' }),
    });
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).not.toContain('acme');
    expect(a.filesTouched[0]?.path).toMatch(/^src\/h_[0-9a-f]{10}\/h_[0-9a-f]{10}\.ts$/);
    expect(a.command).toMatch(/^node scripts\/h_[0-9a-f]{10}\.js$/);
  });

  it('redacts workflow_select paths', () => {
    const state = buildWorkflowSelectState(
      {
        task,
        context: { files: [file('src/acme/ledger.ts')] },
        estimatedDiffSize: 1,
        lastRunStatus: 'none',
        models: [],
      },
      { redactor },
    );
    expect(state.filesTouched[0]?.path).not.toContain('acme');
  });
});

describe('tool call → risk action', () => {
  const call = (tool: ToolCall['tool'], args: Record<string, unknown>): ToolCall => ({
    id: 'c',
    tool,
    args,
    sideEffect: 'external',
  });

  it.each<[string, ToolCall, ReturnType<typeof actionFromToolCall>]>([
    [
      'shell',
      call('shell', { command: 'make build' }),
      { actionType: 'run_command', command: 'make build', paths: [] },
    ],
    [
      'push',
      call('shell', { command: 'git push origin main' }),
      { actionType: 'git_push', command: 'git push origin main', paths: [] },
    ],
    [
      'commit',
      call('shell', { command: 'git commit -m x' }),
      { actionType: 'git_commit', command: 'git commit -m x', paths: [] },
    ],
    [
      'install',
      call('shell', { command: 'pnpm add zod' }),
      { actionType: 'install_dependency', command: 'pnpm add zod', paths: [] },
    ],
    ['bad shell args', call('shell', { cmd: 1 }), { actionType: 'run_command', paths: [] }],
    [
      'git_read',
      call('git_read', { command: 'status' }),
      { actionType: 'run_command', command: 'git status', paths: [] },
    ],
    [
      'git_read bad',
      call('git_read', { command: 'status; rm -rf /' }),
      { actionType: 'other', paths: [] },
    ],
    [
      'read_file',
      call('read_file', { path: 'src/a.ts' }),
      { actionType: 'other', paths: ['src/a.ts'] },
    ],
    ['search', call('search', { query: 'x' }), { actionType: 'other', paths: [] }],
    ['bad edit', call('propose_edit', { files: 'nope' }), { actionType: 'apply_edit', paths: [] }],
  ])('%s', (_name, toolCall, expected) => {
    expect(actionFromToolCall(toolCall)).toEqual(expected);
  });

  it('uses the configured test and lint commands', () => {
    expect(actionFromToolCall(call('run_tests', {}), { testCommand: 'pnpm test' })).toEqual({
      actionType: 'run_tests',
      command: 'pnpm test',
      paths: [],
    });
    expect(actionFromToolCall(call('lint', {}))).toEqual({ actionType: 'lint', paths: [] });
  });

  it('end to end: built migrate state is answered not-safe by the rules', async () => {
    const action = actionFromToolCall(call('shell', { command: 'npm run migrate' }));
    const state = buildRiskGateState({
      action,
      files: [file('src/billing/invoice.ts', true)],
      git: { branch: 'main', hasPendingMigrations: true },
    });
    const answer = await createRuleJevEngine().noul({ state, question: 'safe_now' });
    expect(answer.result.answer).toBe('no');
  });
});
