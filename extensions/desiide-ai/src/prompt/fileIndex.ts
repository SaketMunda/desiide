import type { MentionItem } from '../../shared/messages.ts';
import { rankBy } from './fuzzy.ts';

/** Lists workspace-relative POSIX file paths. Implemented with `workspace.findFiles` in the host. */
export type ListFiles = (signal: AbortSignal) => Promise<string[]>;

export const MAX_FILE_RESULTS = 50;
export const MAX_FOLDER_RESULTS = 10;

/**
 * In-memory list of workspace files for @-mentions. `findFiles` can't fuzzy-match, and calling it
 * per keystroke is slow on big workspaces, so the list is fetched once and filtered in memory.
 * `invalidate()` (on file create/delete/rename) makes the next search refetch.
 */
export class FileIndex {
  private files: string[] | undefined;
  private folders: string[] | undefined;
  private loading: Promise<string[]> | undefined;
  private generation = 0;

  constructor(private readonly list: ListFiles) {}

  invalidate(): void {
    this.generation++;
    this.files = undefined;
    this.folders = undefined;
    this.loading = undefined;
  }

  async search(query: string, signal: AbortSignal): Promise<MentionItem[]> {
    const files = await this.load(signal);
    signal.throwIfAborted();
    const folders = (this.folders ??= foldersOf(files));
    const q = query.trim();
    const fileHits = rankBy(files, q, (p) => p, MAX_FILE_RESULTS).map((path): MentionItem => ({
      kind: 'file',
      label: basename(path),
      detail: path,
      path,
    }));
    const folderHits =
      q.length === 0
        ? []
        : rankBy(folders, q, (p) => p, MAX_FOLDER_RESULTS).map((path): MentionItem => ({
            kind: 'folder',
            label: `${basename(path)}/`,
            detail: path,
            path,
          }));
    return [...fileHits, ...folderHits];
  }

  private async load(signal: AbortSignal): Promise<string[]> {
    if (this.files) return this.files;
    const generation = this.generation;
    // Shared across concurrent searches; one caller aborting must not fail the others.
    this.loading ??= this.list(new AbortController().signal).catch((err: unknown) => {
      if (generation === this.generation) this.loading = undefined; // let the next search retry
      throw err;
    });
    const files = await raceAbort(this.loading, signal);
    if (generation === this.generation) this.files = files;
    return files;
  }
}

function foldersOf(files: readonly string[]): string[] {
  const set = new Set<string>();
  for (const f of files) {
    let i = f.lastIndexOf('/');
    while (i > 0) {
      const dir = f.slice(0, i);
      if (set.has(dir)) break;
      set.add(dir);
      i = dir.lastIndexOf('/');
    }
  }
  return [...set].sort();
}

export function basename(path: string): string {
  const trimmed = path.replace(/\/$/, '');
  return trimmed.slice(trimmed.lastIndexOf('/') + 1);
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}
