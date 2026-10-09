import type { ToolCallRequest } from './types.ts';

/** One streamed tool-call delta, as OpenAI-compatible servers send it. Every field is optional. */
export interface ToolCallDelta {
  index?: number;
  id?: string;
  name?: string;
  /** A fragment of the JSON arguments, or the whole object from servers that send it at once. */
  args?: string;
}

interface Pending {
  id: string;
  name: string;
  args: string;
}

/**
 * Accumulates tool-call deltas into complete calls. Servers differ: OpenAI sends the id and name
 * once and then argument fragments keyed by `index`; others send each call whole in one chunk, some
 * without an `index`. A delta joins the call with the same index, else the call with the same id,
 * else (no index, no id) the latest call. A new id on a known index starts a new call.
 */
export function createToolCallAccumulator(makeId: () => string) {
  const calls: Pending[] = [];
  const byIndex = new Map<number, Pending>();

  return {
    add(delta: ToolCallDelta): void {
      let call =
        delta.index === undefined
          ? delta.id === undefined
            ? calls.at(-1)
            : calls.find((c) => c.id === delta.id)
          : byIndex.get(delta.index);
      if (call && delta.id && call.id !== '' && call.id !== delta.id) call = undefined;
      if (!call) {
        call = { id: delta.id ?? '', name: '', args: '' };
        calls.push(call);
        if (delta.index !== undefined) byIndex.set(delta.index, call);
      } else if (delta.id && call.id === '') {
        call.id = delta.id;
      }
      if (delta.name && call.name === '') call.name = delta.name;
      if (delta.args) call.args += delta.args;
    },

    get size(): number {
      return calls.length;
    },

    /** Complete calls in arrival order. Missing or duplicate ids are replaced; empty args → `{}`. */
    finish(): ToolCallRequest[] {
      const seen = new Set<string>();
      return calls
        .filter((c) => c.name !== '')
        .map((c) => {
          let id = c.id;
          if (id === '' || seen.has(id)) id = makeId();
          seen.add(id);
          return { id, name: c.name, args: c.args.trim() === '' ? '{}' : c.args };
        });
    },
  };
}
