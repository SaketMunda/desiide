import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import { COMMAND_IDS } from './commands.ts';
import { VIEW_TYPES } from './views/viewTypes.ts';

const Manifest = z.object({
  main: z.string(),
  engines: z.object({ vscode: z.string() }),
  activationEvents: z.array(z.string()),
  contributes: z.object({
    commands: z.array(z.object({ command: z.string() })),
    views: z.object({
      mutt: z.array(z.object({ id: z.string(), type: z.string(), name: z.string() })),
    }),
    viewsContainers: z.object({ activitybar: z.array(z.object({ id: z.string() })) }),
  }),
});

const manifest = Manifest.parse(
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')),
);

describe('package.json manifest', () => {
  it('activates lazily: only on Mutt views or commands, never at startup', () => {
    for (const event of manifest.activationEvents) {
      expect(event).toMatch(/^(onView:mutt\.|onCommand:mutt\.)/);
    }
    expect(manifest.activationEvents).not.toContain('*');
    expect(manifest.activationEvents).not.toContain('onStartupFinished');
  });

  it('contributes exactly the registered commands', () => {
    expect(manifest.contributes.commands.map((c) => c.command).sort()).toEqual(
      [...COMMAND_IDS].sort(),
    );
  });

  it('contributes the Mutt container with both webview views', () => {
    expect(manifest.contributes.viewsContainers.activitybar.map((c) => c.id)).toContain('mutt');
    expect(manifest.contributes.views.mutt).toEqual([
      { type: 'webview', id: VIEW_TYPES.panel, name: 'Mutt' },
      { type: 'webview', id: VIEW_TYPES.decisions, name: 'Decisions' },
    ]);
  });

  it('points main at the bundled extension', () => {
    expect(manifest.main).toBe('./dist/extension.js');
  });
});
