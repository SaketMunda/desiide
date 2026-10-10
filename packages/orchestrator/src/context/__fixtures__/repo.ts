// Test-only: a small repo with every kind of file the context engine must include, flag, or skip.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeTestWorkspace, type TestWorkspace } from '../../tools/testWorkspace.ts';

/** Never allowed into the model's context. */
export const SECRET_SENTINEL = 'sk-fixture-SENTINEL-do-not-leak';

const parser = Array.from({ length: 400 }, (_, i) =>
  i === 199 ? 'export function parseHeader(input: string): Header {' : `// parser line ${i + 1}`,
).join('\n');

const committed: Record<string, string> = {
  '.gitignore': 'dist/\n*.log\n',
  'README.md': '# Fixture\n\nA small service used by the context engine tests.\n',
  'package.json': '{\n  "name": "fixture",\n  "scripts": { "test": "vitest run" }\n}\n',
  'package-lock.json': '{\n  "lockfileVersion": 3,\n  "packages": {}\n}\n',
  'src/app.ts': [
    "import { parseHeader } from './parser';",
    '',
    'export function main(raw: string): string {',
    '  const header = parseHeader(raw);',
    '  return header.name;',
    '}',
    '',
  ].join('\n'),
  'src/parser.ts': `${parser}\n`,
  'src/auth/session.ts': 'export const SESSION_TTL_S = 3600;\n',
  'src/billing/invoice.ts':
    'export function total(lines: number[]): number {\n  return lines.reduce((a, b) => a + b, 0);\n}\n',
  'src/billing/tax.ts': 'export const VAT = 0.21;\n',
  'src/payments-api/charge.ts': 'export async function charge(): Promise<void> {}\n',
  'db/migrations/001_init.sql': 'CREATE TABLE users (id serial primary key);\n',
  'infra/main.tf': 'resource "aws_s3_bucket" "b" {\n  bucket = "fixture"\n}\n',
  Dockerfile: 'FROM node:24-alpine\nCOPY . .\n',
  '.github/workflows/ci.yml': 'on: push\njobs: {}\n',
  'config/secrets/prod.json': `{ "token": "${SECRET_SENTINEL}" }\n`,
  '.env': `API_KEY=${SECRET_SENTINEL}\n`,
  '.env.example': 'API_KEY=\n',
};

/**
 * The fixture as a git repo with uncommitted changes: a working-tree edit to `src/app.ts`, plus
 * changes to `.env` and the lockfile that must not show in the diff, a staged edit to
 * `src/auth/session.ts`, and gitignored and binary files.
 */
export async function makeFixtureRepo(): Promise<TestWorkspace> {
  const ws = await makeTestWorkspace(committed, { git: true });
  await ws.write(
    'src/app.ts',
    committed['src/app.ts']?.replace('return header.name;', 'return header.name.trim();') ?? '',
  );
  await ws.write('.env', `API_KEY=${SECRET_SENTINEL}\nDEBUG=1\n`);
  await ws.write('package-lock.json', '{\n  "lockfileVersion": 3,\n  "packages": { "": {} }\n}\n');
  await ws.write('src/auth/session.ts', 'export const SESSION_TTL_S = 1800;\n');
  ws.git('add', 'src/auth/session.ts');
  await ws.write('dist/bundle.js', `console.log("${SECRET_SENTINEL}");\n`);
  await ws.write('debug.log', `${SECRET_SENTINEL}\n`);
  await writeFile(
    join(ws.root, 'assets-logo.png'),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 1, 2]),
  );
  await writeFile(join(ws.root, 'data.bin.txt'), Buffer.from([0x61, 0, 0x62]));
  return ws;
}
