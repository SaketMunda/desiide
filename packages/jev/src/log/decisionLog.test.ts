import type { DecisionRecord } from '@desiide/protocol';
import { exampleRiskGateState } from '@desiide/protocol/fixtures';
import { mkdtemp, readFile, readdir, rm, stat, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stateHash } from '../policy/gate.ts';
import { DECISION_LOG_FILE, InvalidCursorError, createDecisionLog } from './decisionLog.ts';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'desiide-declog-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

let n = 0;
function rec(over: Partial<DecisionRecord> = {}): DecisionRecord {
  n += 1;
  return {
    id: `d-${String(n).padStart(5, '0')}`,
    taskId: 't-1',
    pack: 'risk_gate@1',
    question: 'safe_now',
    engine: 'rules',
    stateHash: stateHash(exampleRiskGateState),
    state: { ...exampleRiskGateState },
    result: { kind: 'noul', answer: 'no', pYes: 0.1 },
    policyOutcome: 'confirm',
    reasons: ['sensitive_file'],
    latencyMs: 1,
    ts: new Date(1_700_000_000_000 + n).toISOString(),
    ...over,
  };
}

async function lines(file: string): Promise<string[]> {
  return (await readFile(file, 'utf8')).split('\n').filter((l) => l !== '');
}

describe('createDecisionLog', () => {
  it('appends JSONL under a self-gitignored directory', async () => {
    const log = createDecisionLog({ dir });
    const r = rec();
    await log.append(r);
    expect(log.path).toBe(join(dir, DECISION_LOG_FILE));
    expect((await lines(log.path)).map((l) => JSON.parse(l) as unknown)).toEqual([r]);
    expect(await readFile(join(dir, '.gitignore'), 'utf8')).toBe('*\n');
    expect((await stat(log.path)).mode & 0o777).toBe(0o600);
  });

  it('rejects records that do not match the schema, without wedging later appends', async () => {
    const log = createDecisionLog({ dir });
    await expect(log.append({ ...rec(), latencyMs: -1 })).rejects.toThrow();
    await log.append(rec());
    expect(await lines(log.path)).toHaveLength(1);
  });

  it('AC1: concurrent writes from two tasks produce valid JSONL with no interleaved lines', async () => {
    const log = createDecisionLog({ dir, maxBytes: 256 * 1024 });
    // Large states make torn or interleaved writes visible if appends weren't serialized.
    const big = { ...exampleRiskGateState, command: 'x'.repeat(500) };
    const task = (taskId: string) =>
      Array.from({ length: 150 }, () => log.append(rec({ taskId, state: big })));
    await Promise.all([...task('task-a'), ...task('task-b')]);

    const all: DecisionRecord[] = [];
    for (const f of await readdir(dir)) {
      if (!f.startsWith(DECISION_LOG_FILE)) continue;
      for (const line of await lines(join(dir, f))) all.push(JSON.parse(line) as DecisionRecord);
    }
    // keep=3 at 256 KiB holds all of them; every line parses and every record is whole.
    expect(all).toHaveLength(300);
    expect(new Set(all.map((r) => r.id)).size).toBe(300);
    expect(all.filter((r) => r.taskId === 'task-a')).toHaveLength(150);
    expect(all.every((r) => r.state.command === big.command)).toBe(true);
  });

  it('AC1: two writers on the same file (e.g. two windows) still produce whole lines', async () => {
    const a = createDecisionLog({ dir });
    const b = createDecisionLog({ dir });
    await Promise.all(
      Array.from({ length: 100 }, (_, i) => (i % 2 ? a : b).append(rec({ taskId: `t-${i % 2}` }))),
    );
    const parsed = (await lines(a.path)).map((l) => JSON.parse(l) as DecisionRecord);
    expect(parsed).toHaveLength(100);
  });

  it('AC2: rotates at maxBytes, keeps `keep` files, and list spans the rotated files', async () => {
    const one = Buffer.byteLength(`${JSON.stringify(rec())}\n`);
    const log = createDecisionLog({ dir, maxBytes: one * 10, keep: 3 });
    const written: DecisionRecord[] = [];
    for (let i = 0; i < 45; i++) {
      const r = rec();
      written.push(r);
      await log.append(r);
    }
    const names = (await readdir(dir)).filter((f) => f.startsWith(DECISION_LOG_FILE)).sort();
    expect(names).toEqual([
      DECISION_LOG_FILE,
      `${DECISION_LOG_FILE}.1`,
      `${DECISION_LOG_FILE}.2`,
      `${DECISION_LOG_FILE}.3`,
    ]);
    for (const f of names) expect((await stat(join(dir, f))).size).toBeLessThanOrEqual(one * 10);

    // 45 written as 10+10+10+10+5: four rotations, so the oldest full file (10) was dropped.
    const kept = written.slice(10).reverse();
    const { decisions, nextCursor } = await log.list({ limit: 500 });
    expect(decisions.map((r) => r.id)).toEqual(kept.map((r) => r.id));
    expect(nextCursor).toBeUndefined();

    // Paging walks across file boundaries without gaps or repeats.
    const paged: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await log.list({ limit: 7, ...(cursor ? { cursor } : {}) });
      paged.push(...page.decisions.map((r) => r.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(paged).toEqual(kept.map((r) => r.id));

    expect(await log.get(written[12]?.id ?? '')).toEqual(written[12]);
    expect(await log.get(written[0]?.id ?? '')).toBeUndefined();
  });

  it('AC2: a log reopened over existing files keeps rotating from the right size', async () => {
    const one = Buffer.byteLength(`${JSON.stringify(rec())}\n`);
    const first = createDecisionLog({ dir, maxBytes: one * 3 });
    for (let i = 0; i < 2; i++) await first.append(rec());
    const second = createDecisionLog({ dir, maxBytes: one * 3 });
    for (let i = 0; i < 2; i++) await second.append(rec());
    expect(await lines(second.path)).toHaveLength(1);
    expect(await lines(`${second.path}.1`)).toHaveLength(3);
  });

  it('filters by taskId, pack and outcome', async () => {
    const log = createDecisionLog({ dir });
    const a = rec({ taskId: 'a', policyOutcome: 'auto' });
    const b = rec({ taskId: 'b', policyOutcome: 'block' });
    const w = rec({
      taskId: 'a',
      pack: 'workflow_select@1',
      question: 'workflow',
      result: { kind: 'choice', selected: 'local-single', probs: { 'local-single': 0.85 } },
      workflow: 'local-single',
    });
    delete w.policyOutcome;
    for (const r of [a, b, w]) await log.append(r);
    const ids = async (q: Parameters<typeof log.list>[0]) =>
      (await log.list(q)).decisions.map((r) => r.id);
    expect(await ids({ limit: 50, taskId: 'a' })).toEqual([w.id, a.id]);
    expect(await ids({ limit: 50, pack: 'risk_gate@1' })).toEqual([b.id, a.id]);
    expect(await ids({ limit: 50, outcome: 'block' })).toEqual([b.id]);
    expect(await ids({ limit: 50, taskId: 'a', outcome: 'block' })).toEqual([]);
  });

  it('includes records whose append is still in flight', async () => {
    const log = createDecisionLog({ dir });
    const r = rec();
    void log.append(r);
    expect((await log.list({ limit: 1 })).decisions).toEqual([r]);
  });

  it('skips torn or invalid lines and reports them', async () => {
    const onInvalidLine = vi.fn();
    const log = createDecisionLog({ dir, onInvalidLine });
    const good = rec();
    await log.append(good);
    await appendFile(log.path, '{"id":"torn", "pack":\n{"id":"x"}\n');
    expect((await log.list({ limit: 50 })).decisions).toEqual([good]);
    expect(onInvalidLine).toHaveBeenCalledTimes(2);
  });

  it('returns an empty page when the log does not exist yet', async () => {
    const log = createDecisionLog({ dir: join(dir, 'missing') });
    expect(await log.list({ limit: 50 })).toEqual({ decisions: [] });
  });

  it('a cursor whose record rotated away yields an empty page; a garbage cursor throws', async () => {
    const log = createDecisionLog({ dir });
    await log.append(rec());
    const gone = Buffer.from('rotated-away').toString('base64url');
    expect(await log.list({ limit: 5, cursor: gone })).toEqual({ decisions: [] });
    await expect(log.list({ limit: 5, cursor: '***' })).rejects.toBeInstanceOf(InvalidCursorError);
  });
});
