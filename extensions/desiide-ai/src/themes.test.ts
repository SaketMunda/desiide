import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import { buildTheme, DAYLIGHT, MIDNIGHT, serialize, THEME_FILES } from '../themes/palette.ts';

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

const readText = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');
const read = (path: string): unknown => JSON.parse(readText(path));

const contributed = Contribution.parse(read('../package.json')).contributes.themes;
const midnight = Theme.parse(read('../themes/desiide-midnight-color-theme.json'));
const daylight = Theme.parse(read('../themes/desiide-daylight-color-theme.json'));

type Rgb = [number, number, number];
const rgba = (hex: string): [Rgb, number] => [
  [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as Rgb,
  hex.length === 9 ? parseInt(hex.slice(7, 9), 16) / 255 : 1,
];

/** Composites `hex` (maybe translucent) over the opaque `under`. */
function over(hex: string, under: string): string {
  const [fg, alpha] = rgba(hex);
  const [bg] = rgba(under);
  const mix = fg.map((c, i) => Math.round(c * alpha + (bg[i] ?? 0) * (1 - alpha)));
  return `#${mix.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

/** WCAG 2.x relative luminance of an opaque #RRGGBB color. */
function luminance(hex: string): number {
  const [r, g, b] = rgba(hex)[0].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(fg: string, bg: string): number {
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** [foreground, background, surface the background sits on if it is translucent]. */
type Pair = readonly [fg: string, bg: string, under?: string];

/** Text: WCAG AA, 4.5:1. */
const TEXT_PAIRS: readonly Pair[] = [
  ['editor.foreground', 'editor.background'],
  ['foreground', 'sideBar.background'],
  ['descriptionForeground', 'sideBar.background'],
  ['descriptionForeground', 'editor.background'],
  ['sideBar.foreground', 'sideBar.background'],
  ['sideBarTitle.foreground', 'sideBar.background'],
  ['sideBarSectionHeader.foreground', 'sideBarSectionHeader.background'],
  ['textLink.foreground', 'editor.background'],
  ['textLink.foreground', 'sideBar.background'],
  ['textPreformat.foreground', 'textCodeBlock.background'],
  ['button.foreground', 'button.background'],
  ['button.foreground', 'button.hoverBackground'],
  ['button.secondaryForeground', 'button.secondaryBackground'],
  ['button.secondaryForeground', 'button.secondaryHoverBackground'],
  ['badge.foreground', 'badge.background'],
  ['activityBarBadge.foreground', 'activityBarBadge.background'],
  ['statusBar.foreground', 'statusBar.background'],
  ['statusBar.debuggingForeground', 'statusBar.debuggingBackground'],
  ['statusBarItem.remoteForeground', 'statusBarItem.remoteBackground'],
  ['statusBarItem.errorForeground', 'statusBarItem.errorBackground'],
  ['statusBarItem.warningForeground', 'statusBarItem.warningBackground'],
  ['statusBarItem.prominentForeground', 'statusBarItem.prominentBackground'],
  ['tab.activeForeground', 'tab.activeBackground'],
  ['titleBar.activeForeground', 'titleBar.activeBackground'],
  ['commandCenter.foreground', 'commandCenter.background'],
  ['input.foreground', 'input.background'],
  ['dropdown.foreground', 'dropdown.background'],
  ['menu.foreground', 'menu.background'],
  ['menu.selectionForeground', 'menu.selectionBackground', 'menu.background'],
  ['quickInput.foreground', 'quickInput.background'],
  ['quickInputList.focusForeground', 'quickInputList.focusBackground', 'quickInput.background'],
  ['notifications.foreground', 'notifications.background'],
  ['list.activeSelectionForeground', 'list.activeSelectionBackground', 'sideBar.background'],
  ['list.inactiveSelectionForeground', 'list.inactiveSelectionBackground', 'sideBar.background'],
  ['list.hoverForeground', 'list.hoverBackground', 'sideBar.background'],
  ['list.highlightForeground', 'sideBar.background'],
  ['breadcrumb.foreground', 'breadcrumb.background'],
  ['panelTitle.activeForeground', 'panel.background'],
  ['terminal.foreground', 'terminal.background'],
  ['editorWarning.foreground', 'editor.background'],
  ['editorError.foreground', 'editor.background'],
  ['editorInfo.foreground', 'editor.background'],
  ['errorForeground', 'editor.background'],
  ['errorForeground', 'sideBar.background'],
  ['gitDecoration.addedResourceForeground', 'sideBar.background'],
  ['gitDecoration.modifiedResourceForeground', 'sideBar.background'],
  ['gitDecoration.deletedResourceForeground', 'sideBar.background'],
  ['gitDecoration.untrackedResourceForeground', 'sideBar.background'],
  ['gitDecoration.conflictingResourceForeground', 'sideBar.background'],
  ['pickerGroup.foreground', 'quickInput.background'],
  ['editorSuggestWidget.highlightForeground', 'editorSuggestWidget.background'],
  ['keybindingLabel.foreground', 'quickInput.background'],
  ['settings.headerForeground', 'editor.background'],
];

/**
 * UI glyphs and secondary text that WCAG treats as non-text or inactive (line numbers, inactive tabs,
 * placeholders, focus and active markers): 3:1.
 */
const GLYPH_PAIRS: readonly Pair[] = [
  ['editorLineNumber.foreground', 'editor.background'],
  ['editorLineNumber.activeForeground', 'editor.background'],
  ['editorCursor.foreground', 'editor.background'],
  ['tab.inactiveForeground', 'tab.inactiveBackground'],
  ['titleBar.inactiveForeground', 'titleBar.inactiveBackground'],
  ['activityBar.foreground', 'activityBar.background'],
  ['activityBar.inactiveForeground', 'activityBar.background'],
  ['activityBar.activeBorder', 'activityBar.background'],
  ['tab.activeBorder', 'tab.activeBackground'],
  ['panelTitle.activeBorder', 'panel.background'],
  ['panelTitle.inactiveForeground', 'panel.background'],
  ['input.placeholderForeground', 'input.background'],
  ['icon.foreground', 'sideBar.background'],
  ['focusBorder', 'editor.background'],
  ['focusBorder', 'sideBar.background'],
  ['disabledForeground', 'sideBar.background'],
  ['gitDecoration.ignoredResourceForeground', 'sideBar.background'],
  ['editorGutter.addedBackground', 'editor.background'],
  ['editorGutter.modifiedBackground', 'editor.background'],
  ['editorGutter.deletedBackground', 'editor.background'],
  ['progressBar.background', 'sideBar.background'],
  ['terminalCursor.foreground', 'terminal.background'],
];

const THEMES = [
  ['Desiide Midnight', midnight],
  ['Desiide Daylight', daylight],
] as const;

describe.each(THEMES)('%s theme', (name, theme: Theme) => {
  const color = (key: string): string => {
    const value = theme.colors[key];
    if (!value) throw new Error(`${name} is missing ${key}`);
    return value;
  };
  const ratio = ([fg, bg, under]: Pair): number => {
    const back = under ? over(color(bg), color(under)) : color(bg);
    expect(back.length, `${bg} must be opaque or name the surface under it`).toBe(7);
    return contrast(over(color(fg), back), back);
  };

  it('is contributed by the extension under its name', () => {
    const entry = contributed.find((t) => t.id === name);
    expect(entry).toMatchObject({ label: name, uiTheme: theme.type === 'dark' ? 'vs-dark' : 'vs' });
    expect(theme.name).toBe(name);
  });

  it.each(TEXT_PAIRS)('text: %s on %s is at least 4.5:1', (...pair) => {
    expect(ratio(pair)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(GLYPH_PAIRS)('glyph: %s on %s is at least 3:1', (...pair) => {
    expect(ratio(pair)).toBeGreaterThanOrEqual(3);
  });

  it('keeps every syntax color (comments too) at 4.5:1 on the editor background', () => {
    const bg = color('editor.background');
    const fgs = [
      ...theme.tokenColors.map((t) => [t.scope[0], t.settings.foreground] as const),
      ...Object.entries(theme.semanticTokenColors),
    ];
    expect(fgs.length).toBeGreaterThan(20);
    for (const [scope, fg] of fgs) {
      if (!fg) continue;
      expect(fg.length, `${scope} must be opaque`).toBe(7);
      expect(contrast(fg, bg), `${scope} ${fg}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('keeps every terminal ANSI color but black readable on the terminal background', () => {
    const bg = color('terminal.background');
    for (const [key, fg] of Object.entries(theme.colors)) {
      if (!key.startsWith('terminal.ansi') || /Black$/.test(key)) continue;
      // "White" in a light theme is a dim grey by convention; it only needs to be visible.
      const min = theme.type === 'light' && /White$/.test(key) ? 3 : 4.5;
      expect(contrast(fg, bg), `${key} ${fg}`).toBeGreaterThanOrEqual(min);
    }
  });
});

describe('Desiide Midnight and Desiide Daylight', () => {
  it('are generated from themes/palette.ts and up to date (pnpm -F desiide-ai themes)', () => {
    for (const { palette, file } of THEME_FILES) {
      expect(readText(`../themes/${file}`), file).toBe(serialize(buildTheme(palette)));
    }
  });

  it('define the same workbench colors and syntax scopes', () => {
    expect(Object.keys(daylight.colors).sort()).toEqual(Object.keys(midnight.colors).sort());
    expect(daylight.tokenColors.map((t) => t.scope)).toEqual(
      midnight.tokenColors.map((t) => t.scope),
    );
    expect(Object.keys(daylight.semanticTokenColors)).toEqual(
      Object.keys(midnight.semanticTokenColors),
    );
  });

  it('use the ADR-023 palette: midnight surfaces, lime primary, violet keywords, cyan functions, amber strings', () => {
    expect(MIDNIGHT.chrome).toBe('#0A0C12');
    expect(MIDNIGHT.raise2).toBe('#1F2537');
    expect(MIDNIGHT.lime).toBe('#C6FF3D');
    expect(MIDNIGHT.violet).toBe('#9C8CFF');
    expect(MIDNIGHT.cyan).toBe('#5CE1E6');
    expect(MIDNIGHT.amber).toBe('#FFB547');
    expect(midnight.colors['button.background']).toBe('#C6FF3D');
    expect(midnight.colors['tab.activeBorder']).toBe('#C6FF3D');
    expect(midnight.colors['activityBar.activeBorder']).toBe('#C6FF3D');
    // Lime marks the active tab and primary actions only.
    const lime = Object.entries(midnight.colors)
      .filter(([, v]) => v.toUpperCase().startsWith('#C6FF3D'))
      .map(([k]) => k)
      .sort();
    expect(lime).toEqual(
      [
        'activityBar.activeBorder',
        'activityBarTop.activeBorder',
        'button.background',
        'editorCursor.foreground',
        'panelTitle.activeBorder',
        'tab.activeBorder',
        'tab.unfocusedActiveBorder',
        'terminal.ansiBrightGreen',
        'terminalCursor.foreground',
      ].sort(),
    );
    const scope = (s: string) => midnight.tokenColors.find((t) => t.scope.includes(s))?.settings;
    expect(scope('keyword')?.foreground).toBe(MIDNIGHT.syntax.keyword);
    expect(scope('entity.name.function')?.foreground).toBe(MIDNIGHT.cyan);
    expect(scope('string')?.foreground).toBe(MIDNIGHT.syntax.string);
    expect(scope('comment')?.fontStyle).toBe('italic');
    expect(DAYLIGHT.lime).toBe(MIDNIGHT.lime);
  });

  it('keep warnings (amber) apart from errors and decisions', () => {
    for (const theme of [midnight, daylight]) {
      const c = theme.colors;
      expect(c['editorWarning.foreground']).not.toBe(c['editorError.foreground']);
      expect(c['editorWarning.foreground']).not.toBe(c['charts.purple']);
    }
  });
});
