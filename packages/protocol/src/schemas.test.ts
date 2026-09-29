import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import * as protocol from './index.ts';
import { ClientMethods, ServerMethods } from './methods.ts';
import { schemaFixtures } from './fixtures/index.ts';

function exportedSchemas(): Record<string, z.ZodType> {
  const out: Record<string, z.ZodType> = {};
  for (const [name, value] of Object.entries(protocol)) {
    if (value instanceof z.ZodType) out[name] = value;
  }
  for (const [method, def] of Object.entries({ ...ClientMethods, ...ServerMethods })) {
    out[`${method}.params`] = def.params;
    out[`${method}.result`] = def.result;
  }
  return out;
}

const schemas = exportedSchemas();

describe('fixture coverage', () => {
  it('every exported schema and method has valid and invalid fixtures', () => {
    const missing = Object.keys(schemas).filter((name) => {
      const f = schemaFixtures[name];
      return !f || f.valid.length === 0 || f.invalid.length === 0;
    });
    expect(missing).toEqual([]);
  });

  it('has no fixtures for schemas that do not exist', () => {
    const orphans = Object.keys(schemaFixtures).filter((name) => !(name in schemas));
    expect(orphans).toEqual([]);
  });
});

describe.each(Object.entries(schemas))('%s', (name, schema) => {
  const fixture = schemaFixtures[name];
  if (!fixture) return;

  it.each(fixture.valid.map((v, i) => [i, v] as const))('accepts valid #%i', (_i, value) => {
    const result = schema.safeParse(value);
    expect(result.error?.issues).toBeUndefined();
  });

  it.each(fixture.invalid.map((v, i) => [i, v] as const))('rejects invalid #%i', (_i, value) => {
    expect(schema.safeParse(value).success).toBe(false);
  });
});
