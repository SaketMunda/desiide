import { ToolName } from '@desiide/protocol';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TOOLS, toolSpecs } from './registry.ts';
import { executeToolCall } from './runner.ts';
import { makeTestWorkspace, type TestWorkspace } from './testWorkspace.ts';
import type { ToolSpec } from './types.ts';

const ajv = new Ajv2020({ strict: true, allErrors: true });

/**
 * Stand-in for a provider: it only sees the specs as wire JSON, refuses calls whose arguments
 * don't match a spec (like strict tool-use modes), and returns arguments as a JSON string.
 * MOD-1's FakeModelAdapter replaces this once it lands.
 */
class FakeModel {
  private readonly specs: Map<string, ToolSpec>;
  constructor(
    wireSpecs: string,
    private readonly script: { name: string; args: unknown }[],
  ) {
    const parsed = JSON.parse(wireSpecs) as ToolSpec[];
    this.specs = new Map(parsed.map((s) => [s.name, s]));
  }
  *turns(): Generator<{ id: string; name: string; arguments: string }> {
    let i = 0;
    for (const step of this.script) {
      const spec = this.specs.get(step.name);
      if (!spec) throw new Error(`model called undeclared tool ${step.name}`);
      const validate = ajv.compile(spec.inputSchema);
      if (!validate(step.args)) {
        throw new Error(`${step.name} args violate spec: ${ajv.errorsText(validate.errors)}`);
      }
      yield { id: `call_${i++}`, name: step.name, arguments: JSON.stringify(step.args) };
    }
  }
}

// One valid and one invalid argument object per tool. Spec (ajv) and argsSchema (zod) must agree.
const samples: Record<ToolName, { valid: unknown[]; invalid: unknown[] }> = {
  read_file: {
    valid: [{ path: 'src/a.ts' }, { path: 'a', startLine: 1, endLine: 20 }],
    invalid: [{}, { path: 'a', startLine: 0 }, { path: 'a', startLine: 1.5 }, { path: 'a', x: 1 }],
  },
  list_files: {
    valid: [{}, { path: 'src', depth: 2, limit: 10 }],
    invalid: [{ depth: 0 }, { depth: 11 }, { limit: 5000 }, { recursive: true }],
  },
  search: {
    valid: [
      { query: 'TODO' },
      { query: 'a.b', regex: true, glob: '*.ts', caseSensitive: false, maxResults: 5 },
    ],
    invalid: [{}, { query: '' }, { query: 'x', maxResults: 0 }, { query: 'x', regex: 'yes' }],
  },
  propose_edit: {
    valid: [{ files: [{ path: 'a.ts', edits: [{ search: 'x', replace: 'y' }] }] }],
    invalid: [
      { files: [] },
      { files: [{ path: 'a.ts', edits: [] }] },
      { files: [{ path: 'a.ts', edits: [{ search: 'x' }] }] },
      { path: 'a.ts', edits: [{ search: 'x', replace: 'y' }] },
    ],
  },
  shell: {
    valid: [{ command: 'ls' }, { command: 'npm test', timeoutMs: 60_000 }],
    invalid: [{}, { command: '' }, { command: 'ls', timeoutMs: 10 }, { command: 'ls', cwd: '/' }],
  },
  run_tests: { valid: [{}], invalid: [{ filter: 'x' }] },
  lint: { valid: [{}], invalid: [{ fix: true }] },
  git_read: {
    valid: [
      { command: 'status' },
      { command: 'diff', staged: true, path: 'src' },
      { command: 'log', maxCount: 5 },
      { command: 'show', ref: 'HEAD~1' },
    ],
    invalid: [
      { command: 'push' },
      { command: 'show' },
      { command: 'show', ref: '--output=x' },
      { command: 'log', maxCount: 1000 },
      { command: 'status', path: 'x' },
    ],
  },
};

describe('tool specs', () => {
  it('cover every protocol ToolName', () => {
    expect(Object.keys(TOOLS).sort()).toEqual([...ToolName.options].sort());
    for (const [name, tool] of Object.entries(TOOLS)) expect(tool.name).toBe(name);
  });

  it.each(ToolName.options)('%s: spec is a valid JSON Schema object with a description', (name) => {
    const { spec } = TOOLS[name];
    expect(spec.name).toBe(name);
    expect(spec.description.length).toBeGreaterThan(20);
    expect(spec.inputSchema).not.toHaveProperty('$schema');
    expect(ajv.validateSchema({ ...spec.inputSchema })).toBe(true);
    expect(() => ajv.compile(spec.inputSchema)).not.toThrow();
    // Providers require an object at the top level.
    const top = spec.inputSchema as { type?: string; oneOf?: unknown; anyOf?: unknown };
    expect(top.type === 'object' || Array.isArray(top.oneOf) || Array.isArray(top.anyOf)).toBe(
      true,
    );
  });

  it.each(ToolName.options)('%s: JSON Schema and zod agree on sample args', (name) => {
    const validate = ajv.compile(TOOLS[name].spec.inputSchema);
    for (const args of samples[name].valid) {
      expect(validate(args), `${name} spec should accept ${JSON.stringify(args)}`).toBe(true);
      expect(TOOLS[name].argsSchema.safeParse(args).success).toBe(true);
    }
    for (const args of samples[name].invalid) {
      expect(
        TOOLS[name].argsSchema.safeParse(args).success,
        `zod should reject ${JSON.stringify(args)}`,
      ).toBe(false);
      // Every rule zod enforces on the shape of args must also be in the spec the model sees.
      expect(validate(args), `${name} spec should reject ${JSON.stringify(args)}`).toBe(false);
    }
  });

  it('toolSpecs filters by allowedTools in a stable order', () => {
    expect(toolSpecs(['shell', 'read_file']).map((s) => s.name)).toEqual(['read_file', 'shell']);
    expect(toolSpecs([])).toEqual([]);
  });
});

describe('round-trip through a fake model', () => {
  let tw: TestWorkspace;
  beforeAll(async () => {
    tw = await makeTestWorkspace(
      { 'src/a.ts': 'export const a = 1;\n' },
      { git: true, projectConfig: { testCommand: 'echo "1 passed"', lintCommand: 'true' } },
    );
  });
  afterAll(async () => {
    await tw.dispose();
  });

  it('every tool: spec → model → JSON args → executeToolCall succeeds', async () => {
    const wire = JSON.stringify(toolSpecs(ToolName.options));
    const model = new FakeModel(wire, [
      { name: 'list_files', args: { depth: 2 } },
      { name: 'read_file', args: { path: 'src/a.ts', startLine: 1 } },
      { name: 'search', args: { query: 'const a' } },
      { name: 'git_read', args: { command: 'log', maxCount: 1 } },
      {
        name: 'propose_edit',
        args: { files: [{ path: 'src/a.ts', edits: [{ search: '= 1', replace: '= 2' }] }] },
      },
      { name: 'shell', args: { command: 'echo hi' } },
      { name: 'run_tests', args: {} },
      { name: 'lint', args: {} },
    ]);
    const seen: string[] = [];
    for (const call of model.turns()) {
      const exec = await executeToolCall(
        { id: call.id, tool: call.name, args: JSON.parse(call.arguments) as unknown },
        tw.ctx,
        new AbortController().signal,
      );
      expect(exec.result.ok, `${call.name}: ${exec.result.output}`).toBe(true);
      expect(exec.result.callId).toBe(call.id);
      seen.push(call.name);
    }
    expect(seen.sort()).toEqual([...ToolName.options].sort());
  });

  it('the fake model refuses args its spec forbids, before anything runs', () => {
    const model = new FakeModel(JSON.stringify(toolSpecs(['git_read'])), [
      { name: 'git_read', args: { command: 'push' } },
    ]);
    expect(() => [...model.turns()]).toThrow(/violate spec/);
  });
});
