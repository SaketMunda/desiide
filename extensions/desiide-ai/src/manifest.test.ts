import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import { WALKTHROUGH_ID } from './appWelcome.ts';
import { COMMAND_IDS } from './commands.ts';
import { VIEW_TYPES } from './views/viewTypes.ts';

const Manifest = z.object({
  main: z.string(),
  engines: z.object({ vscode: z.string() }),
  activationEvents: z.array(z.string()),
  contributes: z.object({
    commands: z.array(z.object({ command: z.string() })),
    views: z.object({
      desiide: z.array(z.object({ id: z.string(), type: z.string(), name: z.string() })),
    }),
    viewsContainers: z.object({ activitybar: z.array(z.object({ id: z.string() })) }),
    walkthroughs: z.array(
      z.object({
        id: z.string(),
        steps: z.array(z.object({ id: z.string(), media: z.object({ markdown: z.string() }) })),
      }),
    ),
  }),
});

const manifest = Manifest.parse(
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')),
);

describe('package.json manifest', () => {
  it('activates lazily: only on Desiide views or commands, never at startup', () => {
    for (const event of manifest.activationEvents) {
      expect(event).toMatch(/^(onView:desiide\.|onCommand:desiide\.)/);
    }
    expect(manifest.activationEvents).not.toContain('*');
    expect(manifest.activationEvents).not.toContain('onStartupFinished');
  });

  it('contributes exactly the registered commands', () => {
    expect(manifest.contributes.commands.map((c) => c.command).sort()).toEqual(
      [...COMMAND_IDS].sort(),
    );
  });

  it('contributes the Desiide container with both webview views', () => {
    expect(manifest.contributes.viewsContainers.activitybar.map((c) => c.id)).toContain('desiide');
    expect(manifest.contributes.views.desiide).toEqual([
      { type: 'webview', id: VIEW_TYPES.panel, name: 'Desiide' },
      { type: 'webview', id: VIEW_TYPES.decisions, name: 'Decisions' },
    ]);
  });

  it('keeps the container in the activity bar (the app moves it; stock VS Code must not)', () => {
    expect(manifest.contributes.viewsContainers).not.toHaveProperty('secondarySidebar');
  });

  it('contributes the welcome walkthrough the app opens on first run', () => {
    const walkthrough = manifest.contributes.walkthroughs.find((w) => w.id === WALKTHROUGH_ID);
    expect(walkthrough?.steps.length).toBeGreaterThan(0);
    for (const step of walkthrough?.steps ?? []) {
      expect(existsSync(new URL(`../${step.media.markdown}`, import.meta.url))).toBe(true);
    }
  });

  it('points main at the bundled extension', () => {
    expect(manifest.main).toBe('./dist/extension.js');
  });
});
