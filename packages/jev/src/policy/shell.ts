/**
 * A small shell-syntax analyzer for gating. It doesn't run or fully parse shell: it recovers the
 * commands a line would execute well enough that quoting, prefixes (`sudo`, `env X=1`), wrappers
 * (`bash -c`, `eval`, `xargs`, `find -exec`) and substitutions can't hide them from the
 * deny-list. Anything it can't follow is reported (`parseError`, `substitution`) so the caller
 * can require confirmation instead of guessing.
 */

export interface Redirect {
  op: string;
  target: string;
}

export interface SimpleCommand {
  /** Words after prefix stripping. `argv[0]` is the program's basename. */
  argv: string[];
  /** Ran under `sudo` / `doas`. */
  privileged: boolean;
  redirects: Redirect[];
  /** Analyses of `$(…)`, backticks, and `<(…)` / `>(…)` that appear in this command. */
  substitutions: CommandAnalysis[];
}

export interface CommandAnalysis {
  /** Commands at this level, grouped by pipeline (`a | b` is one pipeline of two). */
  pipelines: SimpleCommand[][];
  /** Commands nested inside (`bash -c`, `eval`, `find -exec`, substitutions), analyzed recursively. */
  nested: CommandAnalysis[];
  substitution: boolean;
  backgrounded: boolean;
  parseError?: string;
}

const MAX_DEPTH = 4;

interface RawWord {
  text: string;
  substitutions: string[];
}

interface RawCommand {
  words: RawWord[];
  redirects: { op: string; target: RawWord }[];
}

type Token =
  { kind: 'word'; word: RawWord } | { kind: 'op'; op: string } | { kind: 'redirect'; op: string };

const SEPARATORS = ['&&', '||', '|&', ';;', ';', '|', '&', '\n', '(', ')'];
const REDIRECTS = ['&>>', '&>', '>>', '>|', '<<<', '<<', '>&', '<&', '>', '<'];

/** Reads a balanced `(…)` starting after the opening paren. Returns the inner text and end index. */
function readBalanced(src: string, start: number): { inner: string; end: number } | undefined {
  let depth = 1;
  let i = start;
  let quote: string | undefined;
  while (i < src.length) {
    const c = src[i];
    if (quote) {
      if (c === '\\' && quote === '"') i += 1;
      else if (c === quote) quote = undefined;
    } else if (c === '\\') {
      i += 1;
    } else if (c === "'" || c === '"' || c === '`') {
      quote = c;
    } else if (c === '(') {
      depth += 1;
    } else if (c === ')') {
      depth -= 1;
      if (depth === 0) return { inner: src.slice(start, i), end: i + 1 };
    }
    i += 1;
  }
  return undefined;
}

function tokenize(src: string): { tokens: Token[]; error?: string; substitution: boolean } {
  const tokens: Token[] = [];
  let word: RawWord | undefined;
  let substitution = false;
  const flush = (): void => {
    if (word) tokens.push({ kind: 'word', word });
    word = undefined;
  };
  const append = (s: string): void => {
    word ??= { text: '', substitutions: [] };
    word.text += s;
  };
  const sub = (inner: string): void => {
    substitution = true;
    word ??= { text: '', substitutions: [] };
    word.substitutions.push(inner);
    word.text += '$(…)';
  };

  let i = 0;
  while (i < src.length) {
    const c = src[i] ?? '';
    const rest = src.slice(i);

    if (c === '\\') {
      // Line continuation joins words; any other escaped char is literal.
      if (src[i + 1] === '\n') i += 2;
      else {
        append(src[i + 1] ?? '');
        i += 2;
      }
      continue;
    }
    if (c === "'") {
      const end = src.indexOf("'", i + 1);
      if (end < 0) return { tokens, error: 'unterminated single quote', substitution };
      append(src.slice(i + 1, end));
      word ??= { text: '', substitutions: [] };
      i = end + 1;
      continue;
    }
    if (c === '"') {
      word ??= { text: '', substitutions: [] };
      let j = i + 1;
      while (j < src.length && src[j] !== '"') {
        const d = src[j];
        if (d === '\\' && j + 1 < src.length && '"\\$`\n'.includes(src[j + 1] ?? '')) {
          append(src[j + 1] === '\n' ? '' : (src[j + 1] ?? ''));
          j += 2;
        } else if (d === '$' && src[j + 1] === '(') {
          const b = readBalanced(src, j + 2);
          if (!b) return { tokens, error: 'unterminated $(', substitution: true };
          sub(b.inner);
          j = b.end;
        } else if (d === '`') {
          const end = src.indexOf('`', j + 1);
          if (end < 0) return { tokens, error: 'unterminated backtick', substitution: true };
          sub(src.slice(j + 1, end));
          j = end + 1;
        } else {
          append(d ?? '');
          j += 1;
        }
      }
      if (j >= src.length) return { tokens, error: 'unterminated double quote', substitution };
      i = j + 1;
      continue;
    }
    if (c === '$' && src[i + 1] === '(') {
      const b = readBalanced(src, i + 2);
      if (!b) return { tokens, error: 'unterminated $(', substitution: true };
      sub(b.inner);
      i = b.end;
      continue;
    }
    if ((c === '<' || c === '>') && src[i + 1] === '(') {
      const b = readBalanced(src, i + 2);
      if (!b) return { tokens, error: 'unterminated process substitution', substitution: true };
      flush();
      sub(b.inner);
      flush();
      i = b.end;
      continue;
    }
    if (c === '`') {
      const end = src.indexOf('`', i + 1);
      if (end < 0) return { tokens, error: 'unterminated backtick', substitution: true };
      sub(src.slice(i + 1, end));
      i = end + 1;
      continue;
    }
    if (c === '#' && !word) {
      const nl = src.indexOf('\n', i);
      i = nl < 0 ? src.length : nl;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      flush();
      i += 1;
      continue;
    }
    // A word of digits right before a redirect is its file descriptor (`2>`), not an argument.
    const redirect = REDIRECTS.find((r) => rest.startsWith(r));
    if (redirect) {
      if (word && /^\d+$/.test(word.text) && word.substitutions.length === 0) word = undefined;
      flush();
      tokens.push({ kind: 'redirect', op: redirect });
      i += redirect.length;
      continue;
    }
    const sep = SEPARATORS.find((s) => rest.startsWith(s));
    if (sep) {
      flush();
      tokens.push({ kind: 'op', op: sep });
      i += sep.length;
      continue;
    }
    append(c);
    i += 1;
  }
  flush();
  return { tokens, substitution };
}

/** Groups tokens into pipelines of raw commands. */
function group(tokens: Token[]): {
  pipelines: RawCommand[][];
  backgrounded: boolean;
  error?: string;
} {
  const pipelines: RawCommand[][] = [];
  let pipeline: RawCommand[] = [];
  let cmd: RawCommand = { words: [], redirects: [] };
  let backgrounded = false;
  const endCommand = (): void => {
    if (cmd.words.length > 0 || cmd.redirects.length > 0) pipeline.push(cmd);
    cmd = { words: [], redirects: [] };
  };
  const endPipeline = (): void => {
    endCommand();
    if (pipeline.length > 0) pipelines.push(pipeline);
    pipeline = [];
  };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t) continue;
    if (t.kind === 'word') cmd.words.push(t.word);
    else if (t.kind === 'redirect') {
      const next = tokens[i + 1];
      if (next?.kind !== 'word')
        return { pipelines, backgrounded, error: `redirect ${t.op} without a target` };
      cmd.redirects.push({ op: t.op, target: next.word });
      i += 1;
    } else if (t.op === '|' || t.op === '|&') {
      endCommand();
    } else {
      if (t.op === '&') backgrounded = true;
      endPipeline();
    }
  }
  endPipeline();
  return { pipelines, backgrounded };
}

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'ash', 'csh', 'tcsh']);

/** Options that take a value, per prefix command, so the value isn't mistaken for the program. */
const PREFIXES: Record<string, { valueOpts: string[]; stopAtNumber?: boolean }> = {
  sudo: { valueOpts: ['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-U', '-T', '-R'] },
  doas: { valueOpts: ['-u', '-C'] },
  env: { valueOpts: ['-u', '-C', '-S'] },
  command: { valueOpts: [] },
  builtin: { valueOpts: [] },
  exec: { valueOpts: ['-a'] },
  nohup: { valueOpts: [] },
  time: { valueOpts: ['-f', '-o'] },
  nice: { valueOpts: ['-n'] },
  ionice: { valueOpts: ['-c', '-n', '-p'] },
  timeout: { valueOpts: ['-s', '-k', '--signal', '--kill-after'], stopAtNumber: true },
  stdbuf: { valueOpts: ['-i', '-o', '-e'] },
  xargs: { valueOpts: ['-I', '-i', '-n', '-P', '-L', '-l', '-s', '-d', '-E', '-a'] },
  caffeinate: { valueOpts: ['-t', '-w'] },
  chronic: { valueOpts: [] },
  watch: { valueOpts: ['-n', '-d'] },
};
const KEYWORDS = new Set([
  '!',
  '{',
  '}',
  'then',
  'do',
  'else',
  'elif',
  'if',
  'while',
  'until',
  'fi',
  'done',
]);

export function basename(program: string): string {
  const slash = program.lastIndexOf('/');
  return slash >= 0 ? program.slice(slash + 1) : program;
}

interface Built {
  command: SimpleCommand;
  nested: string[];
}

function build(raw: RawCommand): Built {
  const words = raw.words.map((w) => w.text);
  const subs = raw.words.flatMap((w) => w.substitutions);
  const nested: string[] = [];
  let privileged = false;
  let i = 0;
  // Strip assignments, keywords, and wrapper commands until the real program.
  for (;;) {
    const w = words[i];
    if (w === undefined) break;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) || KEYWORDS.has(w)) {
      i += 1;
      continue;
    }
    const name = basename(w);
    const prefix = Object.hasOwn(PREFIXES, name) ? PREFIXES[name] : undefined;
    if (!prefix) break;
    if (name === 'sudo' || name === 'doas') privileged = true;
    i += 1;
    while (i < words.length) {
      const opt = words[i] ?? '';
      if (opt === '--') {
        i += 1;
        break;
      }
      if (name === 'env' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(opt)) {
        i += 1;
        continue;
      }
      if (prefix.stopAtNumber && /^\d+(\.\d+)?[smhd]?$/.test(opt)) {
        i += 1;
        break;
      }
      if (!opt.startsWith('-') || opt === '-') break;
      if (name === 'env' && opt.startsWith('-S')) {
        // `env -S "rm -rf /"` splits its argument into a command line.
        const value = opt.length > 2 ? opt.slice(2) : (words[i + 1] ?? '');
        nested.push(value);
        i += opt.length > 2 ? 1 : 2;
        continue;
      }
      i += prefix.valueOpts.includes(opt) ? 2 : 1;
    }
  }
  const argv = words.slice(i);
  if (argv[0] !== undefined) argv[0] = basename(argv[0]);
  const program = argv[0] ?? '';

  if (SHELLS.has(program)) {
    // `bash -c 'cmd'`, `bash -lc 'cmd'`, `sh -e -c 'cmd'`: the first non-option after -c.
    const c = argv.findIndex((a, k) => k > 0 && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a));
    const script = c > 0 ? argv.slice(c + 1).find((a) => !a.startsWith('-')) : undefined;
    if (script !== undefined) nested.push(script);
  } else if (program === 'eval') {
    nested.push(argv.slice(1).join(' '));
  } else if (program === 'find') {
    for (let k = 1; k < argv.length; k++) {
      if (['-exec', '-execdir', '-ok', '-okdir'].includes(argv[k] ?? '')) {
        const end = argv.findIndex((a, m) => m > k && (a === ';' || a === '+'));
        const inner = argv.slice(k + 1, end < 0 ? undefined : end);
        nested.push(inner.map(quote).join(' '));
      }
    }
  }
  return {
    command: {
      argv,
      privileged,
      redirects: raw.redirects.map((r) => ({ op: r.op, target: r.target.text })),
      substitutions: [],
    },
    nested: [...nested, ...subs.map((s) => `\u0000${s}`)],
  };
}

function quote(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

/** Analyzes a shell command line. Never throws. */
export function analyzeCommand(command: string, depth = 0): CommandAnalysis {
  if (depth > MAX_DEPTH) {
    return {
      pipelines: [],
      nested: [],
      substitution: false,
      backgrounded: false,
      parseError: 'nested too deeply',
    };
  }
  const lexed = tokenize(command);
  const grouped = group(lexed.tokens);
  const analysis: CommandAnalysis = {
    pipelines: [],
    nested: [],
    substitution: lexed.substitution,
    backgrounded: grouped.backgrounded,
  };
  const error = lexed.error ?? grouped.error;
  if (error) analysis.parseError = error;

  for (const raw of grouped.pipelines) {
    const pipeline: SimpleCommand[] = [];
    for (const rawCommand of raw) {
      const built = build(rawCommand);
      for (const n of built.nested) {
        const isSubstitution = n.startsWith('\u0000');
        const inner = analyzeCommand(isSubstitution ? n.slice(1) : n, depth + 1);
        if (isSubstitution) built.command.substitutions.push(inner);
        analysis.nested.push(inner);
      }
      // Substitutions in redirect targets run too (`> "$(…)"`).
      for (const r of rawCommand.redirects) {
        for (const s of r.target.substitutions) {
          const inner = analyzeCommand(s, depth + 1);
          built.command.substitutions.push(inner);
          analysis.nested.push(inner);
        }
      }
      pipeline.push(built.command);
    }
    analysis.pipelines.push(pipeline);
  }
  for (const n of analysis.nested) {
    if (n.parseError && !analysis.parseError) analysis.parseError = n.parseError;
    if (n.substitution) analysis.substitution = true;
  }
  return analysis;
}

/** Every simple command at every level, outermost first. */
export function allCommands(analysis: CommandAnalysis): SimpleCommand[] {
  return [...analysis.pipelines.flat(), ...analysis.nested.flatMap((n) => allCommands(n))];
}

/** Every pipeline at every level. */
export function allPipelines(analysis: CommandAnalysis): SimpleCommand[][] {
  return [...analysis.pipelines, ...analysis.nested.flatMap((n) => allPipelines(n))];
}

export function anyPrivileged(analysis: CommandAnalysis): boolean {
  return allCommands(analysis).some((c) => c.privileged);
}

export function anyBackgrounded(analysis: CommandAnalysis): boolean {
  return analysis.backgrounded || analysis.nested.some(anyBackgrounded);
}
