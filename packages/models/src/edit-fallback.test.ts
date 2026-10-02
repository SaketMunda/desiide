import { describe, expect, it } from 'vitest';
import { complete } from './complete.ts';
import {
  EDIT_FORMAT_PROMPT,
  buildEditPrompt,
  edit,
  editViaChat,
  parseEditBlocks,
  type EditBlockErrorCode,
  type ParseEditResult,
} from './edit-fallback.ts';
import { ModelError } from './errors.ts';
import { createFakeModelAdapter } from './testing/fake.ts';

const block = (path: string, search: string, replace: string): string =>
  `${path}\n<<<<<<< SEARCH\n${search}\n=======\n${replace}\n>>>>>>> REPLACE`;

function codes(result: ParseEditResult): EditBlockErrorCode[] {
  return result.ok ? [] : result.errors.map((e) => e.code);
}

describe('parseEditBlocks: accepted shapes', () => {
  it('parses an unfenced block', () => {
    expect(parseEditBlocks(block('src/a.ts', 'const a = 1;', 'const a = 2;'))).toEqual({
      ok: true,
      edits: [{ path: 'src/a.ts', edits: [{ search: 'const a = 1;', replace: 'const a = 2;' }] }],
    });
  });

  it('parses fenced blocks with the path inside or before the fence', () => {
    const inside = `Here you go:\n\n\`\`\`ts\n${block('src/a.ts', 'x', 'y')}\n\`\`\``;
    const before = `src/a.ts\n\`\`\`typescript\n<<<<<<< SEARCH\nx\n=======\ny\n>>>>>>> REPLACE\n\`\`\``;
    for (const text of [inside, before]) {
      expect(parseEditBlocks(text)).toEqual({
        ok: true,
        edits: [{ path: 'src/a.ts', edits: [{ search: 'x', replace: 'y' }] }],
      });
    }
  });

  it('accepts decorated path lines', () => {
    for (const decorated of [
      '`src/a.ts`',
      '**src/a.ts**',
      'src/a.ts:',
      '### src/a.ts',
      './src/a.ts',
      'File: src/a.ts',
    ]) {
      const result = parseEditBlocks(block(decorated, 'x', 'y'));
      expect(result.ok && result.edits[0]?.path, decorated).toBe('src/a.ts');
    }
  });

  it('handles CRLF output and keeps multi-line content', () => {
    const text = block('a.py', 'def f():\n    return 1', 'def f():\n    return 2').replaceAll(
      '\n',
      '\r\n',
    );
    expect(parseEditBlocks(text)).toEqual({
      ok: true,
      edits: [
        {
          path: 'a.py',
          edits: [{ search: 'def f():\n    return 1', replace: 'def f():\n    return 2' }],
        },
      ],
    });
  });

  it('converts to CRLF when the original file uses CRLF', () => {
    const files = [{ path: 'win.txt', content: 'one\r\ntwo\r\nthree\r\n' }];
    const result = parseEditBlocks(block('win.txt', 'one\ntwo', 'uno\ndos'), { files });
    expect(result).toEqual({
      ok: true,
      edits: [{ path: 'win.txt', edits: [{ search: 'one\r\ntwo', replace: 'uno\r\ndos' }] }],
    });
  });

  it('groups multiple blocks per file in order, across multiple files', () => {
    const text = [
      block('a.ts', 'a1', 'A1'),
      '',
      block('b.ts', 'b1', 'B1'),
      '```',
      '```',
      // No path line: continues b.ts because only separators follow the previous block.
      '<<<<<<< SEARCH\nb2\n=======\nB2\n>>>>>>> REPLACE',
      block('a.ts', 'a2', 'A2'),
    ].join('\n');
    expect(parseEditBlocks(text)).toEqual({
      ok: true,
      edits: [
        {
          path: 'a.ts',
          edits: [
            { search: 'a1', replace: 'A1' },
            { search: 'a2', replace: 'A2' },
          ],
        },
        {
          path: 'b.ts',
          edits: [
            { search: 'b1', replace: 'B1' },
            { search: 'b2', replace: 'B2' },
          ],
        },
      ],
    });
  });

  it('allows an empty SEARCH (create or prepend) and an empty REPLACE (delete)', () => {
    const text = `new.ts\n<<<<<<< SEARCH\n=======\nexport {};\n>>>>>>> REPLACE\n${block('old.ts', 'dead()', '')}`;
    expect(parseEditBlocks(text)).toEqual({
      ok: true,
      edits: [
        { path: 'new.ts', edits: [{ search: '', replace: 'export {};' }] },
        { path: 'old.ts', edits: [{ search: 'dead()', replace: '' }] },
      ],
    });
  });

  it('accepts marker lengths 5–9 and keeps fences inside block content verbatim', () => {
    const text =
      'README.md\n<<<<<<<<< SEARCH\n```js\nold\n```\n=========\n```js\nnew\n```\n>>>>>>>>> REPLACE';
    expect(parseEditBlocks(text)).toEqual({
      ok: true,
      edits: [
        { path: 'README.md', edits: [{ search: '```js\nold\n```', replace: '```js\nnew\n```' }] },
      ],
    });
  });

  it('attributes a pathless block to the only known file', () => {
    const files = [{ path: 'only.ts', content: 'let x = 1;' }];
    const result = parseEditBlocks(
      '<<<<<<< SEARCH\nlet x = 1;\n=======\nlet x = 2;\n>>>>>>> REPLACE',
      { files },
    );
    expect(result.ok && result.edits[0]?.path).toBe('only.ts');
  });

  it('applies blocks sequentially when checking uniqueness', () => {
    const files = [{ path: 'a.ts', content: 'foo\nbar\n' }];
    // The second block's SEARCH only exists after the first block is applied.
    const text = `${block('a.ts', 'foo', 'baz')}\n${block('a.ts', 'baz\nbar', 'qux')}`;
    expect(parseEditBlocks(text, { files }).ok).toBe(true);
  });
});

describe('parseEditBlocks: rejections', () => {
  it('rejects text without blocks', () => {
    expect(codes(parseEditBlocks('I changed it for you.'))).toEqual(['no_blocks']);
  });

  it('rejects a block with two dividers (ambiguous split)', () => {
    const text = 'a.ts\n<<<<<<< SEARCH\nx\n=======\ny\n=======\nz\n>>>>>>> REPLACE';
    expect(codes(parseEditBlocks(text))).toEqual(['multiple_dividers']);
  });

  it('rejects a missing divider, an unterminated block, and a nested SEARCH', () => {
    expect(codes(parseEditBlocks('a.ts\n<<<<<<< SEARCH\nx\n>>>>>>> REPLACE'))).toEqual([
      'missing_divider',
    ]);
    expect(codes(parseEditBlocks('a.ts\n<<<<<<< SEARCH\nx\n=======\ny'))).toEqual(['unterminated']);
    const nested = `a.ts\n<<<<<<< SEARCH\nx\n${block('b.ts', 'p', 'q')}`;
    expect(codes(parseEditBlocks(nested))).toContain('nested_block');
  });

  it('rejects stray markers outside blocks', () => {
    expect(codes(parseEditBlocks(`${block('a.ts', 'x', 'y')}\n>>>>>>> REPLACE`))).toEqual([
      'stray_marker',
    ]);
  });

  it('rejects a block whose file is ambiguous', () => {
    const files = [
      { path: 'a.ts', content: 'x' },
      { path: 'b.ts', content: 'x' },
    ];
    expect(
      codes(
        parseEditBlocks('Change this:\n<<<<<<< SEARCH\nx\n=======\ny\n>>>>>>> REPLACE', { files }),
      ),
    ).toEqual(['missing_path']);
    // Prose between blocks breaks the "continues the previous file" rule.
    const text = `${block('a.ts', 'x', 'y')}\nAnd also:\n<<<<<<< SEARCH\nx\n=======\nz\n>>>>>>> REPLACE`;
    expect(codes(parseEditBlocks(text))).toEqual(['missing_path']);
  });

  it('rejects SEARCH text that matches more than once or not at all', () => {
    const files = [{ path: 'a.ts', content: 'log();\nlog();\n' }];
    expect(codes(parseEditBlocks(block('a.ts', 'log();', 'x'), { files }))).toEqual([
      'search_ambiguous',
    ]);
    expect(codes(parseEditBlocks(block('a.ts', 'missing', 'x'), { files }))).toEqual([
      'search_not_found',
    ]);
  });

  it('rejects unsafe paths and SEARCH in files the model was not shown', () => {
    expect(codes(parseEditBlocks(block('../etc/passwd', '', 'x')))).toEqual(['invalid_path']);
    expect(codes(parseEditBlocks(block('/etc/passwd', '', 'x')))).toEqual(['invalid_path']);
    const files = [{ path: 'a.ts', content: 'x' }];
    expect(codes(parseEditBlocks(block('b.ts', 'x', 'y'), { files }))).toEqual(['unknown_file']);
  });

  it('rejects the whole reply when any block is bad, reporting every problem', () => {
    const files = [{ path: 'a.ts', content: 'one two' }];
    const text = [
      block('a.ts', 'one', '1'),
      block('a.ts', 'nope', '2'),
      block('../x', '', 'y'),
    ].join('\n');
    const result = parseEditBlocks(text, { files });
    expect(result.ok).toBe(false);
    expect(codes(result)).toEqual(['search_not_found', 'invalid_path']);
    if (!result.ok) expect(result.errors[0]).toMatchObject({ block: 1, line: 8 });
  });
});

describe('editViaChat / edit / complete', () => {
  const spec = {
    instruction: 'Rename a to b',
    files: [{ path: 'src/a.ts', content: 'const a = 1;\n' }],
  };

  it('sends the format prompt and file contents, and returns FileEdit[]', async () => {
    const fake = createFakeModelAdapter({
      turns: [{ text: ['```ts\n', block('src/a.ts', 'const a = 1;', 'const b = 1;'), '\n```'] }],
    });
    const edits = await edit(fake, spec, new AbortController().signal);
    expect(edits).toEqual([
      { path: 'src/a.ts', edits: [{ search: 'const a = 1;', replace: 'const b = 1;' }] },
    ]);
    expect(fake.calls[0]?.system).toContain(EDIT_FORMAT_PROMPT);
    expect(fake.calls[0]?.messages[0]?.content).toBe(buildEditPrompt(spec));
    expect(buildEditPrompt(spec)).toContain('const a = 1;');
  });

  it('uses a fence longer than any backtick run in the file', () => {
    const prompt = buildEditPrompt({
      instruction: 'x',
      files: [{ path: 'r.md', content: '````md\nhi\n````' }],
    });
    expect(prompt).toContain('`````\n````md');
  });

  it('throws a ModelError listing the problems when the reply is unusable', async () => {
    const fake = createFakeModelAdapter({ turns: [{ text: block('src/a.ts', 'nope', 'x') }] });
    await expect(editViaChat(fake, spec, new AbortController().signal)).rejects.toThrow(
      /SEARCH text not found/,
    );
  });

  it('propagates stream errors as ModelError', async () => {
    const fake = createFakeModelAdapter({ turns: [{ error: { kind: 'rate_limit' } }] });
    const error = await editViaChat(fake, spec, new AbortController().signal).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ModelError);
    expect((error as ModelError).kind).toBe('rate_limit');
  });

  it('prefers a native edit when the adapter has one', async () => {
    const native = [{ path: 'src/a.ts', edits: [{ search: 'a', replace: 'b' }] }];
    const fake = { ...createFakeModelAdapter(), edit: () => Promise.resolve(native) };
    expect(await edit(fake, spec, new AbortController().signal)).toBe(native);
  });

  it('complete() falls back to a chat turn', async () => {
    const fake = createFakeModelAdapter({ turns: [{ text: ['return ', 'x;'] }] });
    const text = await complete(
      fake,
      { codeContext: 'function f(x) {', instruction: 'finish it', maxTokens: 50 },
      new AbortController().signal,
    );
    expect(text).toBe('return x;');
    expect(fake.calls[0]).toMatchObject({ maxTokens: 50, messages: [{ role: 'user' }] });
    expect(fake.calls[0]?.tools).toBeUndefined();
  });
});
