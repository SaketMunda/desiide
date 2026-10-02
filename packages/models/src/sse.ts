export interface SseEvent {
  /** `event:` field; absent means the default "message". */
  event?: string;
  data: string;
  id?: string;
}

export interface ParseSseOptions {
  /** Stop at a `data: [DONE]` sentinel (OpenAI style). Default true. */
  stopAtDone?: boolean;
}

/**
 * Server-sent events parser (WHATWG rules). Chunks may split anywhere: mid-line, between `\r` and
 * `\n`, or inside a multi-byte UTF-8 character. Comment lines (`:`) are skipped, multiple `data:`
 * lines join with `\n`, and a final event without a trailing blank line is still delivered.
 */
export async function* parseSse(
  chunks: AsyncIterable<Uint8Array | string>,
  options: ParseSseOptions = {},
): AsyncGenerator<SseEvent> {
  const stopAtDone = options.stopAtDone ?? true;
  const decoder = new TextDecoder();
  let buffer = '';
  let data: string[] = [];
  let event: string | undefined;
  let id: string | undefined;
  // A chunk ending in `\r` may be followed by `\n` in the next chunk; that `\n` is not a new line.
  let skipLeadingLf = false;

  const dispatch = (): SseEvent | undefined => {
    const result =
      data.length === 0
        ? undefined
        : {
            data: data.join('\n'),
            ...(event === undefined ? {} : { event }),
            ...(id === undefined ? {} : { id }),
          };
    data = [];
    event = undefined;
    return result;
  };

  const processLine = (line: string): SseEvent | 'blank' | undefined => {
    if (line === '') return 'blank';
    if (line.startsWith(':')) return undefined;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') data.push(value);
    else if (field === 'event') event = value;
    else if (field === 'id' && !value.includes('\0')) id = value;
    return undefined;
  };

  function* drain(final: boolean): Generator<SseEvent | 'stop'> {
    if (skipLeadingLf && buffer.startsWith('\n')) buffer = buffer.slice(1);
    skipLeadingLf = false;
    for (;;) {
      const match = /\r\n|\r|\n/.exec(buffer);
      if (!match) break;
      // A trailing lone `\r` might be the first half of `\r\n`; wait for more input.
      if (match[0] === '\r' && match.index === buffer.length - 1 && !final) {
        const line = buffer.slice(0, match.index);
        buffer = '';
        skipLeadingLf = true;
        yield* handle(line);
        return;
      }
      const line = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      yield* handle(line);
    }
    if (final) {
      if (buffer !== '') yield* handle(buffer);
      buffer = '';
      const last = dispatch();
      if (last) yield* emit(last);
    }
  }

  function* handle(line: string): Generator<SseEvent | 'stop'> {
    if (processLine(line) !== 'blank') return;
    const next = dispatch();
    if (next) yield* emit(next);
  }

  function* emit(next: SseEvent): Generator<SseEvent | 'stop'> {
    if (stopAtDone && next.data.trim() === '[DONE]') yield 'stop';
    else yield next;
  }

  for await (const chunk of chunks) {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    for (const item of drain(false)) {
      if (item === 'stop') return;
      yield item;
    }
  }
  buffer += decoder.decode();
  for (const item of drain(true)) {
    if (item === 'stop') return;
    yield item;
  }
}
