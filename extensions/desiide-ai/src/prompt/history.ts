import * as z from 'zod';
import { PromptDraft } from '../../shared/messages.ts';

export const MAX_HISTORY = 50;

/** Newest last. Consecutive duplicates collapse; the oldest entries fall off at `MAX_HISTORY`. */
export function pushHistory(history: readonly string[], entry: string): string[] {
  const text = entry.trim();
  if (text.length === 0) return [...history];
  const next = history.at(-1) === text ? [...history] : [...history, text];
  return next.slice(-MAX_HISTORY);
}

const StoredHistory = z.array(z.string().max(20_000)).max(MAX_HISTORY);

/** `workspaceState` can hold anything an older version wrote; fall back to empty. */
export function readHistory(raw: unknown): string[] {
  const parsed = StoredHistory.safeParse(raw);
  return parsed.success ? parsed.data : [];
}

export const EMPTY_DRAFT: PromptDraft = { text: '', chips: [] };

export function readDraft(raw: unknown): PromptDraft {
  const parsed = PromptDraft.safeParse(raw);
  return parsed.success ? parsed.data : EMPTY_DRAFT;
}
