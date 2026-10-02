import { WorkspacePath, type FileEdit } from '@desiide/protocol';
import { ModelError } from './errors.ts';
import { collectTurn } from './stream.ts';
import type { DiffSpec, ModelAdapter } from './types.ts';

/**
 * Search/replace block protocol for models without a native edit API:
 *
 *     path/to/file.ts
 *     <<<<<<< SEARCH
 *     exact existing lines
 *     =======
 *     replacement lines
 *     >>>>>>> REPLACE
 *
 * Blocks may sit inside or outside a Markdown fence. An empty SEARCH creates a file or inserts at
 * its start, matching `propose_edit` (COR-3).
 */
export const EDIT_FORMAT_PROMPT = `Make the requested change by replying with SEARCH/REPLACE blocks only.

Each block is:
path/to/file.ext
<<<<<<< SEARCH
exact lines currently in the file, including indentation
=======
the lines that replace them
>>>>>>> REPLACE

Rules:
- Put the file path, relative to the workspace, alone on the line before each block.
- SEARCH must match the current file exactly and occur exactly once. Include enough surrounding lines to make it unique.
- Use several small blocks rather than one large block. Blocks for one file apply in order.
- To create a new file, use an empty SEARCH section.
- Do not explain the change.`;

export type EditBlockErrorCode =
  | 'no_blocks'
  | 'missing_path'
  | 'invalid_path'
  | 'unknown_file'
  | 'missing_divider'
  | 'multiple_dividers'
  | 'nested_block'
  | 'unterminated'
  | 'stray_marker'
  | 'search_not_found'
  | 'search_ambiguous';

export interface EditBlockError {
  code: EditBlockErrorCode;
  message: string;
  /** 0-based block index, when the error belongs to a block. */
  block?: number;
  /** 1-based line in the model output. */
  line?: number;
}

export type ParseEditResult =
  { ok: true; edits: FileEdit[] } | { ok: false; errors: EditBlockError[] };

export interface ParseEditOptions {
  /**
   * The files the model was shown. When given, a block without a path is attributed to the only
   * file, SEARCH text is checked to match exactly once (after earlier blocks are applied), and the
   * file's line endings are kept.
   */
  files?: ReadonlyArray<{ path: string; content: string }>;
}

const SEARCH = /^\s*<{5,9} ?SEARCH\s*$/;
const DIVIDER = /^\s*={5,9}\s*$/;
const REPLACE = /^\s*>{5,9} ?REPLACE\s*$/;
const FENCE = /^\s*(`{3,}|~{3,})/;

interface RawBlock {
  path: string | undefined;
  search: string;
  replace: string;
  index: number;
  line: number;
}

/** Strips decoration models put around a path line: backticks, bold, a trailing colon, `# `. */
function cleanPath(line: string): string | undefined {
  let s = line.trim();
  s = s.replace(/^#+\s*/, '').replace(/^(?:file(?:name)?|path)\s*:\s*/i, '');
  s = s.replace(/^\*\*(.*)\*\*$/, '$1').replace(/^`(.*)`$/, '$1');
  s = s.replace(/:$/, '').trim();
  if (s === '' || /\s/.test(s)) return undefined;
  return s.replace(/^\.\//, '');
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + 1)) count++;
  return count;
}

/**
 * Parses search/replace blocks from model output into `FileEdit[]`. Tolerant of fences, CRLF and
 * decorated path lines; strict about anything ambiguous. Any error rejects the whole reply, so a
 * half-applied edit is never proposed.
 */
export function parseEditBlocks(output: string, options: ParseEditOptions = {}): ParseEditResult {
  const lines = output.replace(/\r\n?/g, '\n').split('\n');
  const errors: EditBlockError[] = [];
  const blocks: RawBlock[] = [];
  const known = options.files;

  // The last path-looking line outside a block, and whether only blank/fence lines followed it.
  let pendingPath: string | undefined;
  let lastBlockPath: string | undefined;
  let onlySeparatorsSinceBlock = false;
  let blockCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (SEARCH.test(line)) {
      const startLine = i + 1;
      const index = blockCount++;
      const search: string[] = [];
      const replace: string[] = [];
      let section: 'search' | 'replace' = 'search';
      let problem: EditBlockError | undefined;
      let closed = false;
      for (i = i + 1; i < lines.length; i++) {
        const inner = lines[i] ?? '';
        if (REPLACE.test(inner)) {
          if (section === 'search') {
            problem ??= {
              code: 'missing_divider',
              message: 'Block has no ======= divider',
              block: index,
              line: startLine,
            };
          }
          closed = true;
          break;
        }
        if (DIVIDER.test(inner)) {
          if (section === 'replace') {
            problem ??= {
              code: 'multiple_dividers',
              message: 'Block has more than one ======= divider, so the split is ambiguous',
              block: index,
              line: i + 1,
            };
          }
          section = 'replace';
          continue;
        }
        if (SEARCH.test(inner)) {
          problem ??= {
            code: 'nested_block',
            message: 'A new SEARCH marker appears before the previous block ended',
            block: index,
            line: i + 1,
          };
          i--;
          break;
        }
        (section === 'search' ? search : replace).push(inner);
      }
      if (!closed && !problem) {
        problem = {
          code: 'unterminated',
          message: 'Block is missing its >>>>>>> REPLACE marker',
          block: index,
          line: startLine,
        };
      }

      let path = pendingPath;
      if (path === undefined && onlySeparatorsSinceBlock) path = lastBlockPath;
      if (path === undefined && known?.length === 1) path = known[0]?.path;

      if (problem) errors.push(problem);
      else
        blocks.push({
          path,
          search: search.join('\n'),
          replace: replace.join('\n'),
          index,
          line: startLine,
        });

      lastBlockPath = path;
      pendingPath = undefined;
      onlySeparatorsSinceBlock = true;
      continue;
    }
    if (DIVIDER.test(line) || REPLACE.test(line)) {
      errors.push({
        code: 'stray_marker',
        message: `Marker "${line.trim()}" outside a block`,
        line: i + 1,
      });
      continue;
    }
    if (line.trim() === '' || FENCE.test(line)) continue;
    pendingPath = cleanPath(line);
    onlySeparatorsSinceBlock = false;
  }

  if (blocks.length === 0 && errors.length === 0) {
    errors.push({ code: 'no_blocks', message: 'The reply contains no SEARCH/REPLACE blocks' });
  }

  const byPath = new Map<string, FileEdit>();
  const current = new Map(known?.map((f) => [f.path, f.content]));
  for (const block of blocks) {
    const at = { block: block.index, line: block.line };
    if (block.path === undefined) {
      errors.push({
        code: 'missing_path',
        message: 'Block has no file path line before it',
        ...at,
      });
      continue;
    }
    if (!WorkspacePath.safeParse(block.path).success) {
      errors.push({
        code: 'invalid_path',
        message: `"${block.path}" is not a workspace-relative path`,
        ...at,
      });
      continue;
    }
    let { search, replace } = block;
    const content = current.get(block.path);
    if (known) {
      if (content === undefined && search !== '') {
        errors.push({
          code: 'unknown_file',
          message: `${block.path} was not provided, so SEARCH cannot be checked`,
          ...at,
        });
        continue;
      }
      if (content !== undefined) {
        if (content.includes('\r\n')) {
          search = search.replaceAll('\n', '\r\n');
          replace = replace.replaceAll('\n', '\r\n');
        }
        if (search !== '') {
          const count = countOccurrences(content, search);
          if (count === 0) {
            errors.push({
              code: 'search_not_found',
              message: `SEARCH text not found in ${block.path}`,
              ...at,
            });
            continue;
          }
          if (count > 1) {
            errors.push({
              code: 'search_ambiguous',
              message: `SEARCH text occurs ${count} times in ${block.path}`,
              ...at,
            });
            continue;
          }
          current.set(
            block.path,
            content.replace(search, () => replace),
          );
        } else {
          current.set(block.path, replace + content);
        }
      } else {
        current.set(block.path, replace);
      }
    }
    const edit = byPath.get(block.path) ?? { path: block.path, edits: [] };
    edit.edits.push({ search, replace });
    byPath.set(block.path, edit);
  }

  if (errors.length > 0) {
    return { ok: false, errors: errors.sort((a, b) => (a.line ?? 0) - (b.line ?? 0)) };
  }
  return { ok: true, edits: [...byPath.values()] };
}

/** A fence longer than any backtick run in the content, so file text can't close it early. */
function fenceFor(content: string): string {
  const longest = Math.max(2, ...[...content.matchAll(/`+/g)].map((m) => m[0].length));
  return '`'.repeat(longest + 1);
}

export function buildEditPrompt(spec: DiffSpec): string {
  const files = spec.files
    .map((f) => {
      const fence = fenceFor(f.content);
      return `${f.path}\n${fence}\n${f.content}\n${fence}`;
    })
    .join('\n\n');
  return `${files}\n\nTask: ${spec.instruction}`;
}

/** `ModelAdapter.edit` for adapters without a native edit API. */
export async function editViaChat(
  adapter: ModelAdapter,
  spec: DiffSpec,
  signal: AbortSignal,
): Promise<FileEdit[]> {
  const system = spec.system ? `${spec.system}\n\n${EDIT_FORMAT_PROMPT}` : EDIT_FORMAT_PROMPT;
  const turn = await collectTurn(
    adapter.chat({ system, messages: [{ role: 'user', content: buildEditPrompt(spec) }] }, signal),
  );
  const result = parseEditBlocks(turn.text, { files: spec.files });
  if (!result.ok) {
    const problems = result.errors.map((e) => `- ${e.message}`).join('\n');
    throw new ModelError('unknown', `The model's edit could not be used:\n${problems}`, {
      hint: 'Retry, or use a stronger model for this edit.',
    });
  }
  return result.edits;
}

/** Native edit when the adapter has one, otherwise search/replace blocks over `chat`. */
export function edit(
  adapter: ModelAdapter,
  spec: DiffSpec,
  signal: AbortSignal,
): Promise<FileEdit[]> {
  return adapter.edit ? adapter.edit(spec, signal) : editViaChat(adapter, spec, signal);
}
