import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as z from 'zod';

const HexColor = z.string().regex(/^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/);

const Theme = z.object({
  name: z.string(),
  type: z.enum(['dark', 'light']),
  colors: z.record(z.string(), HexColor),
  tokenColors: z.array(
    z.object({
      scope: z.array(z.string()),
      settings: z.object({ foreground: HexColor.optional(), fontStyle: z.string().optional() }),
    }),
  ),
  semanticTokenColors: z.record(z.string(), HexColor),
});
type Theme = z.infer<typeof Theme>;

const Contribution = z.object({
  contributes: z.object({
    themes: z.array(
      z.object({ id: z.string(), label: z.string(), uiTheme: z.string(), path: z.string() }),
    ),
  }),
});

const read = (path: string): unknown =>
  JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));

const contributed = Contribution.parse(read('../package.json')).contributes.themes;
const dark = Theme.parse(read('../themes/desiide-dark-color-theme.json'));
const light = Theme.parse(read('../themes/desiide-light-color-theme.json'));

/** WCAG 2.x relative luminance of an opaque #RRGGBB color. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(fg: string, bg: string): number {
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Text/background pairs that must meet WCAG AA (4.5:1) in both themes. */
const TEXT_PAIRS: readonly (readonly [fg: string, bg: string])[] = [
  ['editor.foreground', 'editor.background'],
  ['foreground', 'sideBar.background'],
  ['descriptionForeground', 'sideBar.background'],
  ['sideBar.foreground', 'sideBar.background'],
  ['textLink.foreground', 'editor.background'],
  ['button.foreground', 'button.background'],
  ['button.secondaryForeground', 'button.secondaryBackground'],
  ['badge.foreground', 'badge.background'],
  ['activityBarBadge.foreground', 'activityBarBadge.background'],
  ['statusBar.foreground', 'statusBar.background'],
  ['statusBar.debuggingForeground', 'statusBar.debuggingBackground'],
  ['statusBarItem.remoteForeground', 'statusBarItem.remoteBackground'],
  ['tab.activeForeground', 'tab.activeBackground'],
  ['titleBar.activeForeground', 'titleBar.activeBackground'],
  ['input.foreground', 'input.background'],
  ['terminal.foreground', 'terminal.background'],
  ['editorWarning.foreground', 'editor.background'],
  ['errorForeground', 'editor.background'],
];

describe.each([
  ['Desiide Dark', dark],
  ['Desiide Light', light],
] as const)('%s theme', (name, theme: Theme) => {
  const color = (key: string): string => {
    const value = theme.colors[key];
    if (!value) throw new Error(`${name} is missing ${key}`);
    return value;
  };

  it('is contributed by the extension under its name', () => {
    const entry = contributed.find((t) => t.id === name);
    expect(entry).toMatchObject({ label: name, uiTheme: theme.type === 'dark' ? 'vs-dark' : 'vs' });
    expect(theme.name).toBe(name);
  });

  it.each(TEXT_PAIRS)('%s on %s meets WCAG AA', (fg, bg) => {
    expect(contrast(color(fg), color(bg))).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps every syntax color readable on the editor background', () => {
    const bg = color('editor.background');
    const fgs = [
      ...theme.tokenColors.map((t) => [t.scope[0], t.settings.foreground] as const),
      ...Object.entries(theme.semanticTokenColors),
    ];
    for (const [scope, fg] of fgs) {
      if (!fg || fg.length !== 7) continue;
      // Comments are deliberately quiet; WCAG's 3:1 for non-essential text applies to them.
      const min = scope === 'comment' ? 3 : 4.5;
      expect(contrast(fg, bg), `${scope} ${fg}`).toBeGreaterThanOrEqual(min);
    }
  });
});

describe('Desiide Dark and Desiide Light', () => {
  it('define the same workbench colors and syntax scopes', () => {
    expect(Object.keys(light.colors).sort()).toEqual(Object.keys(dark.colors).sort());
    expect(light.tokenColors.map((t) => t.scope)).toEqual(dark.tokenColors.map((t) => t.scope));
    expect(Object.keys(light.semanticTokenColors)).toEqual(Object.keys(dark.semanticTokenColors));
  });

  it('share the brand accents: teal primary, amber for Jev', () => {
    expect(dark.colors['focusBorder']).toBe('#2BB3A3');
    expect(dark.colors['charts.orange']).toBe('#F2A33A');
    expect(light.colors['focusBorder']).toBe('#0E8074');
    expect(light.colors['badge.background']).toBe('#F2A33A');
  });

  it('keep warnings visually distinct from the Jev amber', () => {
    for (const theme of [dark, light]) {
      expect(theme.colors['editorWarning.foreground']).not.toBe(theme.colors['charts.orange']);
      expect(theme.colors['editorWarning.foreground']).not.toBe(theme.colors['badge.background']);
    }
  });
});
