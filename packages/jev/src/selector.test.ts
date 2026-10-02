import { describe, expect, it, vi } from 'vitest';
import type { RiskGateState } from '@desiide/protocol';
import { riskGateReadOnlyState } from '@desiide/protocol/fixtures';
import { createRuleJevEngine } from './rules/engine.ts';
import { createEngineSelector } from './selector.ts';
import { JevRequestError, type JevEngine, type NoulResult } from './types.ts';

const state: RiskGateState = { ...riskGateReadOnlyState, filesTouched: [] };
const request = { state, question: 'safe_now' };
const configured = { enabled: true, endpoint: 'https://jev.example.com' };

function fakeJev(noul: JevEngine['noul']): JevEngine {
  const unused = () => Promise.reject(new Error('unused'));
  return { kind: 'jev', choice: unused, score: unused, noul };
}

const jevAnswer = (pYes: number) => ({
  engine: 'jev' as const,
  result: { kind: 'noul', answer: 'yes', pYes } satisfies NoulResult,
  rationale: [],
  latencyMs: 12,
});

describe('EngineSelector', () => {
  const rules = createRuleJevEngine();

  it('uses rules when Jev is not configured, without a fallback reason', async () => {
    const jev = fakeJev(vi.fn());
    for (const config of [{ enabled: false, endpoint: configured.endpoint }, { enabled: true }]) {
      const selector = createEngineSelector({ rules, jev, config });
      expect(selector.status()).toEqual({ engine: 'rules', reason: 'not_configured' });
      expect(selector.select()).toBe(rules);
      const answer = await selector.noul(request);
      expect(answer.engine).toBe('rules');
      expect(answer).not.toHaveProperty('fallbackReason');
    }
    expect(jev.noul).not.toHaveBeenCalled();
    expect(createEngineSelector({ rules, config: configured }).status().engine).toBe('rules');
  });

  it('uses Jev when configured and healthy, tagging results', async () => {
    const jev = fakeJev(async () => jevAnswer(0.99));
    const selector = createEngineSelector({ rules, jev, config: configured });
    expect(selector.kind).toBe('jev');
    expect(selector.select()).toBe(jev);
    expect(await selector.noul(request)).toEqual(jevAnswer(0.99));
  });

  it('falls back to rules on a Jev error and cools down', async () => {
    let t = 1_000;
    const noul = vi.fn<JevEngine['noul']>(async () => {
      throw new Error('502');
    });
    const selector = createEngineSelector({
      rules,
      jev: fakeJev(noul),
      config: configured,
      cooldownMs: 10_000,
      now: () => t,
    });
    const first = await selector.noul(request);
    expect(first).toMatchObject({ engine: 'rules', fallbackReason: 'jev_error' });
    expect(selector.status()).toEqual({ engine: 'rules', reason: 'unhealthy' });

    const second = await selector.noul(request);
    expect(second).toMatchObject({ engine: 'rules', fallbackReason: 'jev_unavailable' });
    expect(noul).toHaveBeenCalledTimes(1);

    t += 10_001;
    noul.mockResolvedValueOnce(jevAnswer(0.9));
    expect((await selector.noul(request)).engine).toBe('jev');
    expect(selector.status()).toEqual({ engine: 'jev' });
  });

  it('times out a slow Jev and answers with rules', async () => {
    const slow = fakeJev(
      (_req, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    );
    const selector = createEngineSelector({ rules, jev: slow, config: configured, timeoutMs: 20 });
    const answer = await selector.noul(request);
    expect(answer).toMatchObject({ engine: 'rules', fallbackReason: 'jev_timeout' });
    expect(answer.result).toEqual({ kind: 'noul', answer: 'yes', pYes: 0.95 });
  });

  it('never relabels a rules answer as Jev, even if the engine lies', async () => {
    const lying = fakeJev(async () => ({ ...jevAnswer(0.99), engine: 'rules' as const }));
    const selector = createEngineSelector({ rules, jev: lying, config: configured });
    expect((await selector.noul(request)).engine).toBe('jev');
  });

  it('propagates caller cancellation and request errors instead of falling back', async () => {
    const controller = new AbortController();
    const jev = fakeJev(async () => {
      controller.abort();
      throw new DOMException('aborted', 'AbortError');
    });
    const selector = createEngineSelector({ rules, jev, config: configured });
    await expect(selector.noul(request, controller.signal)).rejects.toThrow();
    expect(selector.status()).toEqual({ engine: 'jev' });

    const bad = fakeJev(async () => {
      throw new JevRequestError('unknown_question', 'nope');
    });
    const selector2 = createEngineSelector({ rules, jev: bad, config: configured });
    await expect(selector2.noul(request)).rejects.toBeInstanceOf(JevRequestError);
  });

  it('falls back when Jev returns a malformed or mismatched answer', async () => {
    for (const result of [
      { kind: 'noul', answer: 'yes', pYes: 7 },
      { kind: 'score', score: 2 },
    ]) {
      const jev = fakeJev(async () => ({ ...jevAnswer(0.9), result }) as never);
      const selector = createEngineSelector({ rules, jev, config: configured });
      expect(await selector.noul(request)).toMatchObject({
        engine: 'rules',
        fallbackReason: 'jev_error',
      });
    }
  });

  it('update() swaps config and engine and clears the cooldown', async () => {
    const selector = createEngineSelector({ rules, config: { enabled: false } });
    expect(selector.kind).toBe('rules');
    selector.update({ config: configured, jev: fakeJev(async () => jevAnswer(0.5)) });
    expect(selector.kind).toBe('jev');
    selector.update({ jev: null });
    expect(selector.kind).toBe('rules');
  });

  it('routes choice and score through the same fallback', async () => {
    const selector = createEngineSelector({ rules, config: { enabled: false } });
    const { exampleWorkflowSelectState: ws, exampleCostRouteState: cr } =
      await import('@desiide/protocol/fixtures');
    const choice = await selector.choice({
      state: {
        ...ws,
        filesTouched: [...ws.filesTouched],
        availableModels: [...ws.availableModels],
      },
      question: 'workflow',
    });
    expect(choice.engine).toBe('rules');
    expect(
      (await selector.score({ state: { ...cr }, question: 'cheap_success' })).result.score,
    ).toBe(3);
  });
});
