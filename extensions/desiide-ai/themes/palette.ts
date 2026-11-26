/**
 * Desiide Midnight / Daylight (ADR-023, brand/EXPERIENCE.md): one palette per variant, one mapping to
 * VS Code theme keys. Both theme JSON files are generated from here (`pnpm -F desiide-ai themes`), so
 * the two variants can't drift apart, and `themes.test.ts` fails if a JSON file is stale.
 *
 * The fixed state mapping: lime = done/approve/primary action, violet = decision/routing,
 * cyan = running/info, amber = needs you, red = blocked/removed. Lime marks the active tab and
 * primary actions only; everything else in the chrome stays quiet ("Personality outside. Focus inside.").
 */

export interface Palette {
  name: 'Desiide Midnight' | 'Desiide Daylight';
  type: 'dark' | 'light';
  /** Title bar, activity bar, status bar: the frame. */
  chrome: string;
  /** Side bar, panel, inactive tabs. */
  side: string;
  /** Editor and active tab: the calmest, most-read surface. */
  editor: string;
  /** Widgets, inputs, menus, hover. */
  raise: string;
  /** Strong fills: inactive selection, secondary buttons. */
  raise2: string;
  raise2Hover: string;
  /** Hairlines (with alpha). */
  line: string;
  line2: string;
  fg: string;
  fg2: string;
  muted: string;
  /** Line numbers, inactive tabs, placeholder text. */
  dim: string;
  /** Primary-action fill and its text. */
  lime: string;
  limeHover: string;
  limeInk: string;
  /** Lime as a thin marker (active tab, activity bar); darker in Daylight to stay visible. */
  limeLine: string;
  violet: string;
  cyan: string;
  amber: string;
  red: string;
  /** Git "added", diff insertions, terminal green: a softer lime so it isn't read as a button. */
  green: string;
  /** Text on a violet/amber/red fill. */
  ink: string;
  syntax: {
    comment: string;
    keyword: string;
    operator: string;
    punctuation: string;
    string: string;
    regexp: string;
    number: string;
    func: string;
    type: string;
    variable: string;
    property: string;
    parameter: string;
    tag: string;
    attribute: string;
  };
  ansi: {
    black: string;
    red: string;
    green: string;
    yellow: string;
    blue: string;
    magenta: string;
    cyan: string;
    white: string;
    brightBlack: string;
    brightRed: string;
    brightGreen: string;
    brightYellow: string;
    brightBlue: string;
    brightMagenta: string;
    brightCyan: string;
    brightWhite: string;
  };
}

export const MIDNIGHT: Palette = {
  name: 'Desiide Midnight',
  type: 'dark',
  chrome: '#0A0C12',
  side: '#0E111A',
  editor: '#11141E',
  raise: '#181D2D',
  raise2: '#1F2537',
  raise2Hover: '#283048',
  line: '#ECEDE814',
  line2: '#ECEDE826',
  fg: '#ECEDE8',
  fg2: '#C9CCD6',
  muted: '#9AA1B4',
  dim: '#6B7389',
  lime: '#C6FF3D',
  limeHover: '#D4FF6B',
  limeInk: '#11140A',
  limeLine: '#C6FF3D',
  violet: '#9C8CFF',
  cyan: '#5CE1E6',
  amber: '#FFB547',
  red: '#FF6B6B',
  green: '#A8E05F',
  ink: '#0A0C12',
  syntax: {
    comment: '#7F88A0',
    keyword: '#A99BFF',
    operator: '#B4B9C8',
    punctuation: '#9AA1B4',
    string: '#FFC166',
    regexp: '#FF9EC7',
    number: '#FF9EC7',
    func: '#5CE1E6',
    type: '#7EE8C8',
    variable: '#ECEDE8',
    property: '#C9CCD6',
    parameter: '#F1D9B5',
    tag: '#A99BFF',
    attribute: '#5CE1E6',
  },
  ansi: {
    black: '#1F2537',
    red: '#FF6B6B',
    green: '#A8E05F',
    yellow: '#FFB547',
    blue: '#7AA2FF',
    magenta: '#9C8CFF',
    cyan: '#5CE1E6',
    white: '#C9CCD6',
    brightBlack: '#6B7389',
    brightRed: '#FF8A8A',
    brightGreen: '#C6FF3D',
    brightYellow: '#FFCB7A',
    brightBlue: '#9DB9FF',
    brightMagenta: '#B8ABFF',
    brightCyan: '#8BEFF2',
    brightWhite: '#ECEDE8',
  },
};

export const DAYLIGHT: Palette = {
  name: 'Desiide Daylight',
  type: 'light',
  chrome: '#E8E9E2',
  side: '#F0F1EB',
  editor: '#FAFAF7',
  raise: '#FFFFFF',
  raise2: '#E2E3DB',
  raise2Hover: '#D6D8CE',
  line: '#13131317',
  line2: '#1313132B',
  fg: '#16181F',
  fg2: '#2E3240',
  muted: '#545A6B',
  dim: '#767B8A',
  lime: '#C6FF3D',
  limeHover: '#B8F22A',
  limeInk: '#11140A',
  limeLine: '#4F7A00',
  violet: '#5B45E0',
  cyan: '#00707A',
  amber: '#8F5300',
  red: '#C0302F',
  green: '#3D7A00',
  ink: '#FFFFFF',
  syntax: {
    comment: '#646A7C',
    keyword: '#5B45E0',
    operator: '#454A5A',
    punctuation: '#545A6B',
    string: '#8F5300',
    regexp: '#A8336A',
    number: '#A8336A',
    func: '#00707A',
    type: '#00704F',
    variable: '#16181F',
    property: '#2E3240',
    parameter: '#7A4A1C',
    tag: '#5B45E0',
    attribute: '#00707A',
  },
  ansi: {
    black: '#16181F',
    red: '#C0302F',
    green: '#3D7A00',
    yellow: '#8F5300',
    blue: '#2F5BD8',
    magenta: '#5B45E0',
    cyan: '#00707A',
    white: '#767B8A',
    brightBlack: '#545A6B',
    brightRed: '#B3261E',
    brightGreen: '#467000',
    brightYellow: '#995800',
    brightBlue: '#2C57CF',
    brightMagenta: '#6650E6',
    brightCyan: '#006A74',
    brightWhite: '#2E3240',
  },
};

/** `#RRGGBB` + a two-digit hex alpha. */
const a = (hex: string, alpha: string): string => `${hex.slice(0, 7)}${alpha}`;

function workbench(p: Palette): Record<string, string> {
  const dark = p.type === 'dark';
  return {
    foreground: p.fg2,
    descriptionForeground: p.muted,
    disabledForeground: p.dim,
    errorForeground: p.red,
    focusBorder: a(p.violet, 'CC'),
    contrastBorder: '#00000000',
    'icon.foreground': p.muted,
    'widget.border': p.line2,
    'widget.shadow': dark ? '#00000080' : '#1313131F',
    'selection.background': a(p.violet, '55'),
    'textLink.foreground': p.cyan,
    'textLink.activeForeground': dark ? '#8BEFF2' : '#005A62',
    'textPreformat.foreground': p.syntax.string,
    'textBlockQuote.background': p.raise,
    'textBlockQuote.border': a(p.violet, '80'),
    'textCodeBlock.background': p.side,
    'textSeparator.foreground': p.line2,

    'button.background': p.lime,
    'button.foreground': p.limeInk,
    'button.hoverBackground': p.limeHover,
    'button.border': '#00000000',
    'button.separator': a(p.limeInk, '40'),
    'button.secondaryBackground': p.raise2,
    'button.secondaryForeground': p.fg,
    'button.secondaryHoverBackground': p.raise2Hover,
    'badge.background': p.raise2,
    'badge.foreground': p.fg,
    'progressBar.background': p.cyan,

    'input.background': dark ? p.chrome : p.raise,
    'input.foreground': p.fg,
    'input.border': p.line2,
    'input.placeholderForeground': p.dim,
    'inputOption.activeBorder': a(p.violet, 'CC'),
    'inputOption.activeBackground': a(p.violet, '33'),
    'inputOption.activeForeground': p.fg,
    'inputValidation.errorBorder': p.red,
    'inputValidation.errorBackground': p.raise,
    'inputValidation.warningBorder': p.amber,
    'inputValidation.warningBackground': p.raise,
    'inputValidation.infoBorder': p.cyan,
    'inputValidation.infoBackground': p.raise,
    'dropdown.background': p.raise,
    'dropdown.listBackground': p.raise,
    'dropdown.border': p.line2,
    'dropdown.foreground': p.fg,
    'checkbox.background': dark ? p.chrome : p.raise,
    'checkbox.border': p.line2,
    'checkbox.foreground': p.fg,

    'titleBar.activeBackground': p.chrome,
    'titleBar.activeForeground': p.fg2,
    'titleBar.inactiveBackground': p.chrome,
    'titleBar.inactiveForeground': p.dim,
    'titleBar.border': p.line,
    'commandCenter.background': p.side,
    'commandCenter.foreground': p.muted,
    'commandCenter.border': p.line2,
    'commandCenter.activeBackground': p.raise,
    'commandCenter.activeForeground': p.fg,

    'activityBar.background': p.chrome,
    'activityBar.foreground': p.fg,
    'activityBar.inactiveForeground': p.dim,
    'activityBar.activeBorder': p.limeLine,
    'activityBar.activeBackground': '#00000000',
    'activityBar.border': p.line,
    'activityBarBadge.background': p.violet,
    'activityBarBadge.foreground': p.ink,
    'activityBarTop.foreground': p.fg,
    'activityBarTop.inactiveForeground': p.dim,
    'activityBarTop.activeBorder': p.limeLine,

    'sideBar.background': p.side,
    'sideBar.foreground': p.fg2,
    'sideBar.border': p.line,
    'sideBarTitle.foreground': p.muted,
    'sideBarSectionHeader.background': p.side,
    'sideBarSectionHeader.foreground': p.muted,
    'sideBarSectionHeader.border': p.line,
    'sideBarActivityBarTop.border': p.line,

    'list.activeSelectionBackground': a(p.violet, dark ? '2E' : '24'),
    'list.activeSelectionForeground': p.fg,
    'list.activeSelectionIconForeground': p.fg,
    'list.inactiveSelectionBackground': a(p.violet, dark ? '1A' : '14'),
    'list.inactiveSelectionForeground': p.fg,
    'list.hoverBackground': a(p.fg, dark ? '0A' : '0A'),
    'list.hoverForeground': p.fg,
    'list.focusOutline': a(p.violet, '99'),
    'list.focusAndSelectionOutline': a(p.violet, 'CC'),
    'list.dropBackground': a(p.violet, '26'),
    'list.highlightForeground': p.cyan,
    'list.focusHighlightForeground': p.cyan,
    'list.warningForeground': p.amber,
    'list.errorForeground': p.red,
    'tree.indentGuidesStroke': p.line2,
    'tree.inactiveIndentGuidesStroke': p.line,
    'scrollbar.shadow': '#00000000',
    'scrollbarSlider.background': a(p.muted, '26'),
    'scrollbarSlider.hoverBackground': a(p.muted, '40'),
    'scrollbarSlider.activeBackground': a(p.muted, '59'),

    'editor.background': p.editor,
    'editor.foreground': p.fg,
    'editorLineNumber.foreground': p.dim,
    'editorLineNumber.activeForeground': p.fg2,
    'editorCursor.foreground': p.limeLine,
    'editor.selectionBackground': a(p.violet, dark ? '4D' : '38'),
    'editor.inactiveSelectionBackground': a(p.violet, dark ? '26' : '1C'),
    'editor.selectionHighlightBackground': a(p.violet, dark ? '26' : '1C'),
    'editor.wordHighlightBackground': a(p.fg, dark ? '14' : '12'),
    'editor.wordHighlightStrongBackground': a(p.cyan, dark ? '24' : '1C'),
    'editor.findMatchBackground': a(p.amber, dark ? '59' : '4D'),
    'editor.findMatchBorder': p.amber,
    'editor.findMatchHighlightBackground': a(p.amber, dark ? '26' : '24'),
    'editor.lineHighlightBackground': a(p.fg, dark ? '06' : '08'),
    'editor.lineHighlightBorder': '#00000000',
    'editorIndentGuide.background1': p.line,
    'editorIndentGuide.activeBackground1': p.line2,
    'editorWhitespace.foreground': p.line2,
    'editorRuler.foreground': p.line,
    'editorBracketMatch.background': a(p.violet, '26'),
    'editorBracketMatch.border': a(p.violet, '80'),
    'editorBracketHighlight.foreground1': p.syntax.keyword,
    'editorBracketHighlight.foreground2': p.cyan,
    'editorBracketHighlight.foreground3': p.syntax.string,
    'editorError.foreground': p.red,
    'editorWarning.foreground': p.amber,
    'editorInfo.foreground': p.cyan,
    'editorHint.foreground': p.muted,
    'editorGutter.addedBackground': p.green,
    'editorGutter.modifiedBackground': p.amber,
    'editorGutter.deletedBackground': p.red,
    'editorOverviewRuler.border': '#00000000',
    'editorWidget.background': p.raise,
    'editorWidget.border': p.line2,
    'editorHoverWidget.background': p.raise,
    'editorHoverWidget.border': p.line2,
    'editorSuggestWidget.background': p.raise,
    'editorSuggestWidget.border': p.line2,
    'editorSuggestWidget.selectedBackground': a(p.violet, dark ? '33' : '24'),
    'editorSuggestWidget.highlightForeground': p.cyan,
    'editorStickyScroll.background': p.editor,
    'editorStickyScroll.shadow': dark ? '#00000066' : '#13131314',
    'diffEditor.insertedTextBackground': a(p.green, dark ? '2E' : '33'),
    'diffEditor.removedTextBackground': a(p.red, dark ? '2E' : '26'),
    'diffEditor.insertedLineBackground': a(p.green, dark ? '14' : '17'),
    'diffEditor.removedLineBackground': a(p.red, dark ? '14' : '12'),

    'editorGroup.border': p.line,
    'editorGroupHeader.tabsBackground': p.side,
    'editorGroupHeader.tabsBorder': p.line,
    'editorGroupHeader.noTabsBackground': p.side,
    'tab.activeBackground': p.editor,
    'tab.activeForeground': p.fg,
    'tab.activeBorder': p.limeLine,
    'tab.activeBorderTop': '#00000000',
    'tab.unfocusedActiveBorder': a(p.limeLine, '55'),
    'tab.unfocusedActiveForeground': p.fg2,
    'tab.inactiveBackground': p.side,
    'tab.inactiveForeground': p.dim,
    'tab.unfocusedInactiveForeground': p.dim,
    'tab.border': p.line,
    'tab.hoverBackground': p.editor,
    'tab.hoverForeground': p.fg2,
    'tab.lastPinnedBorder': p.line2,
    'breadcrumb.foreground': p.muted,
    'breadcrumb.focusForeground': p.fg,
    'breadcrumb.activeSelectionForeground': p.fg,
    'breadcrumb.background': p.editor,

    'panel.background': p.side,
    'panel.border': p.line,
    'panelTitle.activeForeground': p.fg,
    'panelTitle.activeBorder': p.limeLine,
    'panelTitle.inactiveForeground': p.dim,
    'panelSection.border': p.line,
    'panelSectionHeader.background': p.side,

    'terminal.background': p.side,
    'terminal.foreground': p.fg2,
    'terminalCursor.foreground': p.limeLine,
    'terminal.selectionBackground': a(p.violet, '4D'),
    'terminal.ansiBlack': p.ansi.black,
    'terminal.ansiRed': p.ansi.red,
    'terminal.ansiGreen': p.ansi.green,
    'terminal.ansiYellow': p.ansi.yellow,
    'terminal.ansiBlue': p.ansi.blue,
    'terminal.ansiMagenta': p.ansi.magenta,
    'terminal.ansiCyan': p.ansi.cyan,
    'terminal.ansiWhite': p.ansi.white,
    'terminal.ansiBrightBlack': p.ansi.brightBlack,
    'terminal.ansiBrightRed': p.ansi.brightRed,
    'terminal.ansiBrightGreen': p.ansi.brightGreen,
    'terminal.ansiBrightYellow': p.ansi.brightYellow,
    'terminal.ansiBrightBlue': p.ansi.brightBlue,
    'terminal.ansiBrightMagenta': p.ansi.brightMagenta,
    'terminal.ansiBrightCyan': p.ansi.brightCyan,
    'terminal.ansiBrightWhite': p.ansi.brightWhite,

    'statusBar.background': p.chrome,
    'statusBar.foreground': p.muted,
    'statusBar.border': p.line,
    'statusBar.focusBorder': a(p.violet, 'CC'),
    'statusBar.noFolderBackground': p.chrome,
    'statusBar.noFolderForeground': p.muted,
    'statusBar.debuggingBackground': p.amber,
    'statusBar.debuggingForeground': dark ? p.ink : '#FFFFFF',
    'statusBarItem.remoteBackground': p.violet,
    'statusBarItem.remoteForeground': p.ink,
    'statusBarItem.hoverBackground': a(p.fg, '14'),
    'statusBarItem.hoverForeground': p.fg,
    'statusBarItem.prominentBackground': p.raise2,
    'statusBarItem.prominentForeground': p.fg,
    'statusBarItem.errorBackground': p.red,
    'statusBarItem.errorForeground': p.ink,
    'statusBarItem.warningBackground': p.amber,
    'statusBarItem.warningForeground': dark ? p.ink : '#FFFFFF',

    'notifications.background': p.raise,
    'notifications.foreground': p.fg,
    'notifications.border': p.line2,
    'notificationCenterHeader.background': p.raise,
    'notificationsWarningIcon.foreground': p.amber,
    'notificationsErrorIcon.foreground': p.red,
    'notificationsInfoIcon.foreground': p.cyan,
    'quickInput.background': p.raise,
    'quickInput.foreground': p.fg,
    'quickInputList.focusBackground': a(p.violet, dark ? '33' : '24'),
    'quickInputList.focusForeground': p.fg,
    'quickInputTitle.background': p.raise,
    'menu.background': p.raise,
    'menu.foreground': p.fg,
    'menu.selectionBackground': a(p.violet, dark ? '33' : '24'),
    'menu.selectionForeground': p.fg,
    'menu.separatorBackground': p.line2,
    'menu.border': p.line2,
    'pickerGroup.foreground': p.cyan,
    'pickerGroup.border': p.line,
    'keybindingLabel.foreground': p.fg2,
    'keybindingLabel.background': a(p.fg, '0F'),
    'keybindingLabel.border': p.line2,
    'keybindingLabel.bottomBorder': p.line2,

    'gitDecoration.addedResourceForeground': p.green,
    'gitDecoration.modifiedResourceForeground': p.amber,
    'gitDecoration.deletedResourceForeground': p.red,
    'gitDecoration.untrackedResourceForeground': p.cyan,
    'gitDecoration.ignoredResourceForeground': p.dim,
    'gitDecoration.conflictingResourceForeground': p.violet,

    'charts.foreground': p.fg2,
    'charts.lines': p.line2,
    'charts.red': p.red,
    'charts.blue': p.cyan,
    'charts.yellow': p.amber,
    'charts.orange': p.amber,
    'charts.green': p.green,
    'charts.purple': p.violet,
    'testing.iconPassed': p.green,
    'testing.iconFailed': p.red,
    'testing.iconQueued': p.amber,
    'debugTokenExpression.name': p.syntax.keyword,
    'debugTokenExpression.value': p.fg2,
    'debugTokenExpression.string': p.syntax.string,
    'debugTokenExpression.number': p.syntax.number,
    'debugTokenExpression.boolean': p.syntax.number,
    'debugTokenExpression.error': p.red,
    'symbolIcon.functionForeground': p.syntax.func,
    'symbolIcon.methodForeground': p.syntax.func,
    'symbolIcon.classForeground': p.syntax.type,
    'symbolIcon.interfaceForeground': p.syntax.type,
    'symbolIcon.variableForeground': p.fg2,
    'welcomePage.background': p.editor,
    'welcomePage.tileBackground': p.side,
    'welcomePage.tileHoverBackground': p.raise,
    'welcomePage.tileBorder': p.line,
    'walkThrough.embeddedEditorBackground': p.side,
    'settings.headerForeground': p.fg,
    'settings.modifiedItemIndicator': p.amber,
    'sash.hoverBorder': a(p.violet, '99'),
    'minimap.background': p.editor,
    'minimapSlider.background': a(p.muted, '1A'),
  };
}

interface TokenRule {
  scope: string[];
  settings: { foreground?: string; fontStyle?: string };
}

function tokenColors(p: Palette): TokenRule[] {
  const s = p.syntax;
  return [
    {
      scope: ['comment', 'punctuation.definition.comment'],
      settings: { foreground: s.comment, fontStyle: 'italic' },
    },
    {
      scope: ['keyword', 'storage.type', 'storage.modifier', 'keyword.control'],
      settings: { foreground: s.keyword },
    },
    {
      scope: ['keyword.operator', 'punctuation.separator', 'punctuation.terminator'],
      settings: { foreground: s.operator },
    },
    { scope: ['string', 'string.quoted', 'string.template'], settings: { foreground: s.string } },
    { scope: ['string.regexp'], settings: { foreground: s.regexp } },
    {
      scope: ['constant.numeric', 'constant.language', 'constant.character', 'support.constant'],
      settings: { foreground: s.number },
    },
    {
      scope: ['entity.name.function', 'support.function', 'meta.function-call'],
      settings: { foreground: s.func },
    },
    {
      scope: [
        'entity.name.type',
        'entity.name.class',
        'support.class',
        'support.type',
        'entity.other.inherited-class',
      ],
      settings: { foreground: s.type },
    },
    {
      scope: ['variable', 'variable.other.readwrite', 'meta.definition.variable'],
      settings: { foreground: s.variable },
    },
    { scope: ['variable.parameter'], settings: { foreground: s.parameter, fontStyle: 'italic' } },
    {
      scope: ['variable.other.property', 'variable.other.object.property', 'support.variable.property'],
      settings: { foreground: s.property },
    },
    { scope: ['variable.language'], settings: { foreground: s.keyword, fontStyle: 'italic' } },
    { scope: ['entity.name.tag'], settings: { foreground: s.tag } },
    { scope: ['entity.other.attribute-name'], settings: { foreground: s.attribute } },
    { scope: ['punctuation', 'meta.brace'], settings: { foreground: s.punctuation } },
    { scope: ['markup.heading'], settings: { foreground: s.keyword, fontStyle: 'bold' } },
    { scope: ['markup.bold'], settings: { fontStyle: 'bold' } },
    { scope: ['markup.italic'], settings: { fontStyle: 'italic' } },
    { scope: ['markup.inline.raw'], settings: { foreground: s.string } },
    { scope: ['markup.inserted'], settings: { foreground: p.green } },
    { scope: ['markup.deleted'], settings: { foreground: p.red } },
    { scope: ['invalid'], settings: { foreground: p.red } },
  ];
}

function semanticTokenColors(p: Palette): Record<string, string> {
  const s = p.syntax;
  return {
    parameter: s.parameter,
    property: s.property,
    enumMember: s.number,
    type: s.type,
    class: s.type,
    interface: s.type,
    function: s.func,
    method: s.func,
    namespace: s.type,
    keyword: s.keyword,
  };
}

export interface ThemeJson {
  $schema: string;
  name: string;
  type: 'dark' | 'light';
  semanticHighlighting: true;
  colors: Record<string, string>;
  tokenColors: TokenRule[];
  semanticTokenColors: Record<string, string>;
}

export function buildTheme(p: Palette): ThemeJson {
  return {
    $schema: 'vscode://schemas/color-theme',
    name: p.name,
    type: p.type,
    semanticHighlighting: true,
    colors: workbench(p),
    tokenColors: tokenColors(p),
    semanticTokenColors: semanticTokenColors(p),
  };
}

export const THEME_FILES = [
  { palette: MIDNIGHT, file: 'desiide-midnight-color-theme.json' },
  { palette: DAYLIGHT, file: 'desiide-daylight-color-theme.json' },
] as const;

export const serialize = (t: ThemeJson): string => `${JSON.stringify(t, null, 2)}\n`;
