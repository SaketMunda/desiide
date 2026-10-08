/**
 * Newline-delimited JSON (Ollama's native stream). Chunks may split anywhere, including inside a
 * multi-byte UTF-8 character. Blank lines are skipped, a final line without `\n` is delivered, and
 * a line that isn't JSON comes back as `{ invalid }` so the caller decides what it means.
 */
export async function* parseNdjson(
  chunks: AsyncIterable<Uint8Array | string>,
): AsyncGenerator<{ value: unknown } | { invalid: string }> {
  const decoder = new TextDecoder();
  let buffer = '';

  const parse = (line: string): { value: unknown } | { invalid: string } => {
    try {
      return { value: JSON.parse(line) as unknown };
    } catch {
      return { invalid: line };
    }
  };

  for await (const chunk of chunks) {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line !== '') yield parse(line);
      newline = buffer.indexOf('\n');
    }
  }
  buffer += decoder.decode();
  const last = buffer.trim();
  if (last !== '') yield parse(last);
}
