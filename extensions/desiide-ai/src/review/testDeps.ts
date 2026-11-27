import type { FileApplyResult } from '@desiide/protocol';
import type { FileChange, ReviewRpc, ReviewWorkspace } from './service.ts';

/**
 * An editor stand-in for tests: files on "disk" plus open buffers (which win, dirty or not), and
 * every `apply` recorded. Like VS Code, applying writes the buffer, not the disk.
 */
export class FakeWorkspace implements ReviewWorkspace {
  readonly disk = new Map<string, string>();
  readonly buffers = new Map<string, string>();
  readonly applied: { changes: FileChange[]; label: string }[] = [];
  /** Runs between `read` and `apply` once, e.g. to simulate the user typing. */
  beforeApply: (() => void) | undefined;
  refuse = false;

  constructor(files: Record<string, string> = {}) {
    for (const [p, t] of Object.entries(files)) this.disk.set(p, t);
  }

  text(path: string): string | null {
    return this.buffers.get(path) ?? this.disk.get(path) ?? null;
  }

  read(paths: readonly string[]): Promise<Map<string, string | null>> {
    return Promise.resolve(new Map(paths.map((p) => [p, this.text(p)])));
  }

  apply(changes: readonly FileChange[], label: string) {
    const hook = this.beforeApply;
    this.beforeApply = undefined;
    hook?.();
    if (this.refuse) return Promise.resolve({ applied: false, conflicts: [] });
    const conflicts = changes.filter((c) => this.text(c.path) !== c.before).map((c) => c.path);
    if (conflicts.length > 0) return Promise.resolve({ applied: false, conflicts });
    this.applied.push({ changes: [...changes], label });
    for (const c of changes) this.buffers.set(c.path, c.after);
    return Promise.resolve({ applied: true, conflicts: [] });
  }
}

export class FakeRpc implements ReviewRpc {
  readonly calls: unknown[][] = [];
  fail: Error | undefined;

  private record(...args: unknown[]): Promise<void> {
    this.calls.push(args);
    return this.fail ? Promise.reject(this.fail) : Promise.resolve();
  }

  report(taskId: string, proposalId: string, files: FileApplyResult[]) {
    return this.record('report', taskId, proposalId, files);
  }
  approve(taskId: string, approvalId: string, scope: 'once' | 'task') {
    return this.record('approve', taskId, approvalId, scope);
  }
  reject(taskId: string, approvalId: string, reason?: string) {
    return this.record('reject', taskId, approvalId, reason);
  }
}
