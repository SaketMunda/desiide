import { DecisionRecord, type PackId, type PolicyOutcome } from '@desiide/protocol';
import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** `.desiide/logs` under the workspace root. */
export const DECISION_LOG_DIR = join('.desiide', 'logs');
export const DECISION_LOG_FILE = 'decisions.jsonl';
export const DEFAULT_DECISION_LOG_MAX_BYTES = 10 * 1024 * 1024;
export const DEFAULT_DECISION_LOG_KEEP = 3;

export interface DecisionLogOptions {
  /** Directory holding `decisions.jsonl` and its rotations (`decisions.jsonl.1` is the newest). */
  dir: string;
  maxBytes?: number;
  /** Rotated files kept besides the active one. */
  keep?: number;
  /** Called for lines that don't parse as a `DecisionRecord` (e.g. torn by a crash). */
  onInvalidLine?(file: string, line: number): void;
}

export interface DecisionQuery {
  taskId?: string;
  pack?: PackId;
  outcome?: PolicyOutcome;
  limit: number;
  /** Opaque, from a previous page's `nextCursor`. */
  cursor?: string;
}

export interface DecisionPage {
  decisions: DecisionRecord[];
  nextCursor?: string;
}

export interface DecisionLog {
  readonly path: string;
  /** Resolves once the record is on disk. Appends are serialized, so lines never interleave. */
  append(record: DecisionRecord): Promise<void>;
  /** Newest first, across the active and rotated files. */
  list(query: DecisionQuery): Promise<DecisionPage>;
  get(id: string): Promise<DecisionRecord | undefined>;
  /** Resolves when every append issued so far has finished. */
  flush(): Promise<void>;
}

export class InvalidCursorError extends Error {
  override readonly name = 'InvalidCursorError';
  constructor() {
    super('Invalid decisions.list cursor');
  }
}

const encodeCursor = (id: string): string => Buffer.from(id, 'utf8').toString('base64url');

function decodeCursor(cursor: string): string {
  const id = Buffer.from(cursor, 'base64url').toString('utf8');
  if (id === '' || encodeCursor(id) !== cursor) throw new InvalidCursorError();
  return id;
}

const isMissing = (err: unknown): boolean =>
  err instanceof Error && 'code' in err && err.code === 'ENOENT';

/**
 * Append-only JSONL decision log with size-based rotation. Every append goes through one
 * promise chain and is written with a single `appendFile` call, so concurrent tasks can't
 * interleave lines and rotation never races a write.
 */
export function createDecisionLog(opts: DecisionLogOptions): DecisionLog {
  const maxBytes = opts.maxBytes ?? DEFAULT_DECISION_LOG_MAX_BYTES;
  const keep = opts.keep ?? DEFAULT_DECISION_LOG_KEEP;
  const path = join(opts.dir, DECISION_LOG_FILE);
  let size: number | undefined;
  let tail: Promise<void> = Promise.resolve();

  const init = async (): Promise<number> => {
    await mkdir(opts.dir, { recursive: true });
    // Keeps the logs out of the user's repo without touching their .gitignore.
    await writeFile(join(opts.dir, '.gitignore'), '*\n', { flag: 'wx' }).catch((err: unknown) => {
      if (!(err instanceof Error && 'code' in err && err.code === 'EEXIST')) throw err;
    });
    try {
      return (await stat(path)).size;
    } catch (err) {
      if (isMissing(err)) return 0;
      throw err;
    }
  };

  const rotate = async (): Promise<void> => {
    await rm(`${path}.${keep}`, { force: true });
    for (let i = keep - 1; i >= 1; i--) {
      await rename(`${path}.${i}`, `${path}.${i + 1}`).catch((err: unknown) => {
        if (!isMissing(err)) throw err;
      });
    }
    if (keep > 0) await rename(path, `${path}.1`);
    else await rm(path, { force: true });
  };

  const write = async (line: string): Promise<void> => {
    size ??= await init();
    const bytes = Buffer.byteLength(line);
    if (size > 0 && size + bytes > maxBytes) {
      await rotate();
      size = 0;
    }
    await appendFile(path, line, { mode: 0o600 });
    size += bytes;
  };

  /** Files newest first: the active one, then `.1`, `.2`, … */
  const files = (): string[] => [
    path,
    ...Array.from({ length: keep }, (_, i) => `${path}.${i + 1}`),
  ];

  const readRecords = async (file: string): Promise<DecisionRecord[]> => {
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch (err) {
      if (isMissing(err)) return [];
      throw err;
    }
    const out: DecisionRecord[] = [];
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      if (line.trim() === '') return;
      let json: unknown;
      try {
        json = JSON.parse(line);
      } catch {
        opts.onInvalidLine?.(file, i + 1);
        return;
      }
      const parsed = DecisionRecord.safeParse(json);
      if (parsed.success) out.push(parsed.data);
      else opts.onInvalidLine?.(file, i + 1);
    });
    return out.reverse();
  };

  /** Newest-first records, one file at a time so a first page reads only the active file. */
  async function* newestFirst(): AsyncGenerator<DecisionRecord> {
    // Pending appends first, so a list right after a decision includes it.
    await tail;
    for (const file of files()) yield* await readRecords(file);
  }

  const matches = (r: DecisionRecord, q: DecisionQuery): boolean =>
    (q.taskId === undefined || r.taskId === q.taskId) &&
    (q.pack === undefined || r.pack === q.pack) &&
    (q.outcome === undefined || r.policyOutcome === q.outcome);

  return {
    path,
    append(record) {
      const parsed = DecisionRecord.safeParse(record);
      if (!parsed.success) return Promise.reject(parsed.error);
      const line = `${JSON.stringify(parsed.data)}\n`;
      const next = tail.then(() => write(line));
      // A failed write must not wedge the chain for later records.
      tail = next.catch(() => {});
      return next;
    },
    async list(query) {
      // A cursor names the last record returned. Rotation only drops the oldest records, so if
      // it has rotated away, everything older has too, and the page is empty.
      let after = query.cursor === undefined ? undefined : decodeCursor(query.cursor);
      const page: DecisionRecord[] = [];
      for await (const r of newestFirst()) {
        if (after !== undefined) {
          if (r.id === after) after = undefined;
          continue;
        }
        if (!matches(r, query)) continue;
        if (page.length === query.limit) {
          const last = page[page.length - 1] as DecisionRecord;
          return { decisions: page, nextCursor: encodeCursor(last.id) };
        }
        page.push(r);
      }
      return { decisions: page };
    },
    async get(id) {
      for await (const r of newestFirst()) if (r.id === id) return r;
      return undefined;
    },
    flush: () => tail,
  };
}
