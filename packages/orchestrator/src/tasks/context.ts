import type { FileMeta, Task, WorkspacePath } from '@desiide/protocol';

/** What the first model turn sees about the task's context. */
export interface GatheredContext {
  /** Text appended to the user's instruction in the first message. */
  text: string;
  /** Guidance appended to the system prompt, e.g. how to read the gathered context. */
  system?: string;
}

export interface GatherOptions {
  /** The model's context window, which sizes the context budget. Unknown when absent. */
  modelContextTokens?: number;
}

/**
 * Context gathering (COR-4) plugs in here. The task engine only needs text for the first turn and
 * file metadata for edit proposals.
 */
export interface ContextProvider {
  gather(task: Task, signal: AbortSignal, options?: GatherOptions): Promise<GatheredContext>;
  /** Metadata only, never contents (ADR-005). */
  describeFiles(paths: WorkspacePath[], signal: AbortSignal): Promise<FileMeta[]>;
}

function describeRef(ref: Task['context']['refs'][number]): string {
  switch (ref.type) {
    case 'file':
      return `- file: ${ref.path}`;
    case 'folder':
      return `- folder: ${ref.path}`;
    case 'selection': {
      const { start, end } = ref.range;
      return `- selection: ${ref.path} lines ${start.line + 1}-${end.line + 1}`;
    }
    case 'diff':
      return `- ${ref.scope} diff${ref.path ? ` of ${ref.path}` : ''}`;
  }
}

/**
 * The trivial default until COR-4: lists what the user pointed at by path. The model reads the
 * contents itself with `read_file` / `git_read`, so nothing is read here.
 */
export const pathOnlyContext: ContextProvider = {
  gather(task) {
    const lines: string[] = [];
    if (task.context.refs.length > 0) {
      lines.push('Context the user attached:', ...task.context.refs.map(describeRef));
    }
    if (task.context.openEditors.length > 0) {
      lines.push(
        'Open editors (most recent first):',
        ...task.context.openEditors.map((p) => `- ${p}`),
      );
    }
    if (task.context.tests.length > 0) {
      lines.push('Relevant tests:', ...task.context.tests.map((p) => `- ${p}`));
    }
    return Promise.resolve({ text: lines.join('\n') });
  },
  describeFiles: () => Promise.resolve([]),
};
