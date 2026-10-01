import { open, stat } from 'node:fs/promises';
import * as z from 'zod';
import { resolveWorkspacePath } from './paths.ts';
import { PathArg, defineTool, failure } from './types.ts';

export const MAX_LINES_PER_READ = 2000;
const MAX_LINE_CHARS = 2000;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const BINARY_SNIFF_BYTES = 8192;

export function looksBinary(buf: Buffer): boolean {
  return buf.subarray(0, BINARY_SNIFF_BYTES).includes(0);
}

export async function readTextFile(abs: string): Promise<{ text: string } | { error: string }> {
  const st = await stat(abs);
  if (st.isDirectory()) return { error: 'is a directory; use list_files' };
  if (!st.isFile()) return { error: 'not a regular file' };
  if (st.size > MAX_FILE_BYTES) {
    return { error: `file is too large (${st.size} bytes); use search to find the relevant part` };
  }
  const fh = await open(abs, 'r');
  try {
    const buf = await fh.readFile();
    if (looksBinary(buf)) return { error: 'binary file; not shown' };
    return { text: buf.toString('utf8') };
  } finally {
    await fh.close();
  }
}

const ReadFileArgs = z.strictObject({
  path: PathArg,
  startLine: z.int().min(1).optional().describe('First line to read, 1-based. Default 1.'),
  endLine: z
    .int()
    .min(1)
    .optional()
    .describe(`Last line to read, inclusive. At most ${MAX_LINES_PER_READ} lines per call.`),
});

export const readFileTool = defineTool({
  name: 'read_file',
  description:
    `Read a text file from the workspace. Lines are prefixed with their 1-based number and a tab; ` +
    `the prefix is not part of the file. At most ${MAX_LINES_PER_READ} lines per call: page ` +
    `through longer files with startLine/endLine.`,
  argsSchema: ReadFileArgs,
  sideEffect: 'none',
  async run(args, ctx) {
    const resolved = await resolveWorkspacePath(ctx.workspace, args.path, { mustExist: true });
    const read = await readTextFile(resolved.abs);
    if ('error' in read) return failure('failed', `${resolved.rel}: ${read.error}`);

    const lines = read.text.split(/\r?\n/);
    if (lines.length > 1 && lines.at(-1) === '') lines.pop();
    const total = read.text === '' ? 0 : lines.length;
    const start = args.startLine ?? 1;
    if (start > Math.max(total, 1)) {
      return failure(
        'invalid_args',
        `${resolved.rel} has ${total} lines; startLine ${start} is past the end`,
      );
    }
    if (args.endLine !== undefined && args.endLine < start) {
      return failure('invalid_args', 'endLine must be >= startLine');
    }
    const requestedEnd = Math.min(args.endLine ?? total, total);
    const end = Math.min(requestedEnd, start + MAX_LINES_PER_READ - 1);

    const body = lines
      .slice(start - 1, end)
      .map((line, i) => {
        const shown =
          line.length > MAX_LINE_CHARS
            ? `${line.slice(0, MAX_LINE_CHARS)} [… line truncated]`
            : line;
        return `${String(start + i).padStart(6)}\t${shown}`;
      })
      .join('\n');
    const truncated = end < requestedEnd;
    const header =
      total === 0
        ? `${resolved.rel} (empty file)`
        : `${resolved.rel} (lines ${start}-${end} of ${total})`;
    const more = truncated
      ? `\n[… ${total - end} more lines; continue with startLine ${end + 1}]`
      : '';
    return { ok: true, output: `${header}\n${body}${more}`, truncated };
  },
});
