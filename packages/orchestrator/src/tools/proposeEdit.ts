import { EditProposal, type FileEdit } from '@desiide/protocol';
import * as z from 'zod';
import { PathError, resolveWorkspacePath } from './paths.ts';
import { readTextFile } from './readFile.ts';
import { PathArg, defineTool } from './types.ts';

export type EditErrorCode =
  | 'invalid_path'
  | 'protected_path'
  | 'duplicate_path'
  | 'not_a_text_file'
  | 'file_not_found'
  | 'search_not_found'
  | 'search_ambiguous';

/** One problem with a proposed edit, precise enough for the model to fix and retry. */
export interface EditError {
  path: string;
  /** 0-based index into that file's `edits`, when the problem is a single block. */
  editIndex?: number;
  code: EditErrorCode;
  message: string;
}

const SearchReplaceArg = z.strictObject({
  search: z
    .string()
    .max(100_000)
    .describe(
      'Exact text currently in the file, including whitespace and indentation. Must match exactly ' +
        'once. Empty string: insert `replace` at the start of the file (or create a new file).',
    ),
  replace: z.string().max(100_000).describe('Text that replaces `search`.'),
});

const ProposeEditArgs = z.strictObject({
  files: z
    .array(
      z.strictObject({
        path: PathArg,
        edits: z.array(SearchReplaceArg).min(1).max(50),
      }),
    )
    .min(1)
    .max(20)
    .describe(
      'Files to change. Edits within a file apply in order, each to the result of the previous.',
    ),
});

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  for (
    let i = haystack.indexOf(needle);
    i !== -1;
    i = haystack.indexOf(needle, i + needle.length)
  ) {
    count++;
  }
  return count;
}

const squash = (s: string): string => s.replace(/\s+/g, ' ').trim();

function notFoundMessage(content: string, search: string): string {
  const base = 'search text not found in the current file.';
  if (squash(search) !== '' && squash(content).includes(squash(search))) {
    return `${base} It matches if whitespace is ignored: copy the exact indentation and line breaks from read_file.`;
  }
  return `${base} Re-read the file and copy the text exactly.`;
}

/** Applies blocks in order to an in-memory copy; collects every problem instead of stopping at the first. */
export function checkEdits(
  path: string,
  content: string | null,
  edits: readonly { search: string; replace: string }[],
): EditError[] {
  const errors: EditError[] = [];
  let current = content ?? '';
  edits.forEach((edit, editIndex) => {
    if (edit.search === '') {
      current = edit.replace + current;
      return;
    }
    if (content === null) {
      errors.push({
        path,
        editIndex,
        code: 'file_not_found',
        message: 'file does not exist; to create it, use a single edit with an empty search',
      });
      return;
    }
    const n = countOccurrences(current, edit.search);
    if (n === 0) {
      errors.push({
        path,
        editIndex,
        code: 'search_not_found',
        message: notFoundMessage(current, edit.search),
      });
    } else if (n > 1) {
      errors.push({
        path,
        editIndex,
        code: 'search_ambiguous',
        message: `search text matches ${n} times; include more surrounding lines so it matches once`,
      });
    } else {
      current = current.replace(edit.search, () => edit.replace);
    }
  });
  return errors;
}

function formatErrors(errors: EditError[]): string {
  const lines = errors.map(
    (e) =>
      `- ${e.path}${e.editIndex !== undefined ? ` edit #${e.editIndex}` : ''} [${e.code}]: ${e.message}`,
  );
  return [
    'propose_edit rejected: nothing was proposed. Fix these and call propose_edit again with all edits:',
    ...lines,
    JSON.stringify({ error: 'edit_validation_failed', problems: errors }),
  ].join('\n');
}

export const proposeEditTool = defineTool({
  name: 'propose_edit',
  description:
    'Propose search/replace edits for the user to review. Nothing is written until the user ' +
    'approves. Each search block must match the current file exactly once. Create a new file with ' +
    'one edit whose search is empty.',
  argsSchema: ProposeEditArgs,
  sideEffect: 'workspace',
  async run(args, ctx) {
    const errors: EditError[] = [];
    const files: FileEdit[] = [];
    const seen = new Set<string>();

    for (const file of args.files) {
      let rel: string;
      let abs: string;
      let exists: boolean;
      try {
        ({ rel, abs, exists } = await resolveWorkspacePath(ctx.workspace, file.path));
      } catch (err) {
        if (!(err instanceof PathError)) throw err;
        errors.push({ path: file.path, code: 'invalid_path', message: err.message });
        continue;
      }
      // Writing into .git (hooks, config) would be code execution on the next git command.
      if (rel === '.git' || rel.startsWith('.git/') || rel === '.') {
        errors.push({
          path: rel,
          code: 'protected_path',
          message: 'edits to this path are not allowed',
        });
        continue;
      }
      if (seen.has(rel)) {
        errors.push({
          path: rel,
          code: 'duplicate_path',
          message: 'list each file once with all its edits',
        });
        continue;
      }
      seen.add(rel);

      let content: string | null = null;
      if (exists) {
        const read = await readTextFile(abs);
        if ('error' in read) {
          errors.push({ path: rel, code: 'not_a_text_file', message: read.error });
          continue;
        }
        content = read.text;
      }
      const fileErrors = checkEdits(rel, content, file.edits);
      errors.push(...fileErrors);
      if (fileErrors.length === 0) files.push({ path: rel, edits: file.edits });
    }

    if (errors.length > 0) {
      const output = formatErrors(errors);
      return {
        ok: false,
        output,
        error: { kind: 'failed', message: `${errors.length} edit problem(s)` },
        editErrors: errors,
      };
    }
    const proposal = EditProposal.parse({ id: ctx.newId(), taskId: ctx.taskId, files });
    const summary = files.map(
      (f) => `- ${f.path} (${f.edits.length} edit${f.edits.length > 1 ? 's' : ''})`,
    );
    return {
      ok: true,
      output: [`Proposed edits to ${files.length} file(s), pending user review:`, ...summary].join(
        '\n',
      ),
      proposal,
    };
  },
});
