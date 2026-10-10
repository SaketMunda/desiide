import type Anthropic from '@anthropic-ai/sdk';
import type { CostPerMTok } from '@desiide/protocol';
import type { ModelCapabilities, ReasoningLevel } from './types.ts';

/**
 * How a Claude model takes its thinking setting. The API differs by generation, and a wrong shape
 * is a 400, so each model says which one it speaks:
 * - `always`: thinking can't be turned off (Fable 5/5.1, Opus 5.5). `off` becomes low effort.
 * - `between_tools`: `{type: "disabled"}` is rejected; `between_tools` turns it off (Sonnet 5.5).
 * - `disable`: adaptive thinking, `{type: "disabled"}` turns it off.
 * - `budget`: pre-4.6 models take `{type: "enabled", budget_tokens}` (Haiku 4.5).
 */
export type ThinkingStyle = 'always' | 'between_tools' | 'disable' | 'budget';

export interface ClaudeModel {
  contextTokens: number;
  maxOutputTokens: number;
  costPerMTok: CostPerMTok;
  thinking: ThinkingStyle;
  /** Whether the model thinks when the request doesn't mention thinking. */
  thinksByDefault: boolean;
  /** `temperature` is rejected (400) from Opus 4.7 on. */
  sampling: boolean;
}

const MTOK_1M = 1_000_000;
const OUT_128K = 128_000;

/**
 * Current models (from the claude-api skill, cached 2026-10-06). Config `capabilities` and
 * `costPerMTok` override these; unknown models get `UNKNOWN_MODEL`.
 */
export const CLAUDE_MODELS: Readonly<Record<string, ClaudeModel>> = {
  'claude-fable-5-1': current({ input: 10, output: 50 }, 'always'),
  'claude-fable-5': current({ input: 10, output: 50 }, 'always'),
  'claude-opus-5-5': current({ input: 4, output: 20 }, 'always'),
  'claude-opus-5': current({ input: 5, output: 25 }, 'disable'),
  'claude-opus-4-8': { ...current({ input: 5, output: 25 }, 'disable'), thinksByDefault: false },
  'claude-opus-4-7': { ...current({ input: 5, output: 25 }, 'disable'), thinksByDefault: false },
  'claude-opus-4-6': {
    ...current({ input: 5, output: 25 }, 'disable'),
    thinksByDefault: false,
    sampling: true,
  },
  'claude-sonnet-5-5': current({ input: 2, output: 10 }, 'between_tools'),
  'claude-sonnet-5': current({ input: 2, output: 10 }, 'disable'),
  'claude-sonnet-4-6': {
    ...current({ input: 3, output: 15 }, 'disable'),
    thinksByDefault: false,
    sampling: true,
  },
  'claude-haiku-5-5': current({ input: 0.1, output: 0.5 }, 'disable'),
  'claude-haiku-4-5': {
    contextTokens: 200_000,
    maxOutputTokens: 64_000,
    costPerMTok: { input: 1, output: 5 },
    thinking: 'budget',
    thinksByDefault: false,
    sampling: true,
  },
};

function current(costPerMTok: CostPerMTok, thinking: ThinkingStyle): ClaudeModel {
  return {
    contextTokens: MTOK_1M,
    maxOutputTokens: OUT_128K,
    costPerMTok,
    thinking,
    thinksByDefault: true,
    sampling: false,
  };
}

/**
 * A model the table doesn't know is most likely newer than it, so it gets the newest request
 * shape (adaptive thinking that can't be disabled, no sampling parameters) with modest limits
 * and no cost. Config can say more.
 */
export const UNKNOWN_MODEL: ClaudeModel = {
  contextTokens: 200_000,
  maxOutputTokens: 64_000,
  costPerMTok: { input: 0, output: 0 },
  thinking: 'always',
  thinksByDefault: true,
  sampling: false,
};

/**
 * The table entry for a model id. Accepts a dated snapshot (`claude-haiku-4-5-20251001`) or a
 * Vertex `@` version; anything else must match exactly, so `claude-opus-5-7` is unknown rather
 * than mistaken for Opus 5.
 */
export function claudeModel(model: string): ClaudeModel | undefined {
  const base = model.replace(/(?:-\d{8}|@[\w.-]+)$/, '');
  return CLAUDE_MODELS[base];
}

export function claudeCapabilities(model: string): ModelCapabilities {
  const entry = claudeModel(model) ?? UNKNOWN_MODEL;
  return {
    streaming: true,
    toolCalls: true,
    contextTokens: entry.contextTokens,
    maxOutputTokens: entry.maxOutputTokens,
    vision: true,
  };
}

/** Thinking budgets for `budget`-style models. */
export const THINKING_BUDGET: Record<Exclude<ReasoningLevel, 'off'>, number> = {
  low: 2_048,
  medium: 8_192,
  high: 24_576,
};

export interface ThinkingParams {
  thinking?: Anthropic.ThinkingConfigParam;
  output_config?: Anthropic.OutputConfig;
  /** Thinking tokens count against `max_tokens`, so a budget raises it by this much. */
  extraMaxTokens: number;
}

/**
 * Request parameters for a reasoning level (ADR-022). Unset leaves whether the model thinks to its
 * default; for a model that thinks by default it only asks for the summarized display, so the
 * reasoning it already produces (and bills) is shown instead of arriving as empty blocks.
 */
export function thinkingParams(
  entry: ClaudeModel,
  level: ReasoningLevel | undefined,
): ThinkingParams {
  const shown: Anthropic.ThinkingConfigAdaptive = { type: 'adaptive', display: 'summarized' };
  if (level === undefined) {
    return entry.thinksByDefault && entry.thinking !== 'budget'
      ? { thinking: shown, extraMaxTokens: 0 }
      : { extraMaxTokens: 0 };
  }
  if (entry.thinking === 'budget') {
    if (level === 'off') return { extraMaxTokens: 0 };
    const budget = THINKING_BUDGET[level];
    return {
      thinking: { type: 'enabled', budget_tokens: budget, display: 'summarized' },
      extraMaxTokens: budget,
    };
  }
  if (level === 'off') {
    switch (entry.thinking) {
      case 'always':
        // Can't be disabled: the least thinking is low effort.
        return { thinking: shown, output_config: { effort: 'low' }, extraMaxTokens: 0 };
      case 'between_tools':
        return { thinking: { type: 'between_tools' }, extraMaxTokens: 0 };
      case 'disable':
        return { thinking: { type: 'disabled' }, extraMaxTokens: 0 };
    }
  }
  return { thinking: shown, output_config: { effort: level }, extraMaxTokens: 0 };
}
