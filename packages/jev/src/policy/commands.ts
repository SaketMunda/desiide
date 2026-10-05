import type { ReasonLabel } from '@desiide/protocol';
import { hasExternalEffect, isDestructiveCommand, isMigrationCommand } from '../rules/commands.ts';
import { looksLikePath, normalizeShellPath, pathScope, type Sensitivity } from './paths.ts';
import {
  allCommands,
  allPipelines,
  analyzeCommand,
  anyBackgrounded,
  type CommandAnalysis,
  type SimpleCommand,
} from './shell.ts';

export interface CommandContext {
  /** Current git branch, for force pushes without an explicit refspec. */
  branch: string | null;
  sensitive: Sensitivity;
  /** Project test/lint commands: running exactly these is allow-listed. */
  trustedCommands: readonly string[];
}

export interface CommandAssessment {
  /** `deny_list:<rule>` labels. Non-empty → block, Jev is not consulted. */
  deny: ReasonLabel[];
  /** Labels that require at least `confirm`, whatever Jev says. */
  confirm: ReasonLabel[];
  /** Every command is on the read-only allow-list (or is a trusted project command). */
  readOnly: boolean;
  analysis: CommandAnalysis;
}

const PROTECTED_BRANCHES = new Set(['main', 'master']);
const DOWNLOADERS = new Set(['curl', 'wget', 'fetch', 'aria2c', 'http', 'https', 'xh', 'iwr']);
const INTERPRETERS = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'ksh',
  'fish',
  'ash',
  'python',
  'python2',
  'python3',
  'perl',
  'ruby',
  'node',
  'deno',
  'bun',
  'php',
  'pwsh',
  'powershell',
  'source',
  '.',
  'eval',
]);

const READ_ONLY_PROGRAMS = new Set([
  'ls',
  'cat',
  'pwd',
  'head',
  'tail',
  'wc',
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'which',
  'file',
  'stat',
  'du',
  'df',
  'echo',
  'date',
  'whoami',
  'uname',
  'basename',
  'dirname',
  'realpath',
  'true',
  'diff',
  'cmp',
  'nl',
  'cut',
  'tr',
  'uniq',
  'column',
  'jq',
]);
const READ_ONLY_GIT = new Set([
  'status',
  'diff',
  'log',
  'show',
  'blame',
  'rev-parse',
  'ls-files',
  'shortlog',
  'describe',
]);
/** Flags that turn a reader into a writer, or into something that runs other programs. */
const WRITING_FLAG =
  /^(-o|--output(=.*)?|--fix|-w|--write|-i|--in-place(=.*)?|--ext-diff|--textconv|-x|--exec(=.*)?|--pre(=.*)?)$/;
/** Programs whose path arguments are written, not read. */
const WRITERS = new Set([
  'cp',
  'mv',
  'ln',
  'install',
  'rsync',
  'tee',
  'touch',
  'truncate',
  'mkdir',
  'rmdir',
  'rm',
  'unlink',
  'chmod',
  'chown',
  'chgrp',
  'dd',
  'sed',
  'scp',
]);

function hasRecursiveFlag(argv: readonly string[]): boolean {
  return argv.some((a) => a === '--recursive' || /^-[a-zA-Z]*[rR][a-zA-Z]*$/.test(a));
}

/** Arguments after the program, minus options. */
function operands(argv: readonly string[]): string[] {
  const out: string[] = [];
  let options = true;
  for (const a of argv.slice(1)) {
    if (options && a === '--') {
      options = false;
      continue;
    }
    if (options && a.startsWith('-') && a !== '-') continue;
    out.push(a);
  }
  return out;
}

function isRootish(word: string): boolean {
  const p = normalizeShellPath(word);
  return pathScope(p) === 'system' || p === '..' || p === '../' || p === '../*';
}

/** The deny-list. Each rule names one way to do irreversible damage outside the task. */
function denyRules(c: SimpleCommand, ctx: CommandContext): string[] {
  const [program = '', ...args] = c.argv;
  const hits: string[] = [];
  const ops = operands(c.argv);

  if (program === 'rm' && (hasRecursiveFlag(c.argv) || args.includes('--no-preserve-root'))) {
    if (args.includes('--no-preserve-root') || ops.some(isRootish)) hits.push('rm_rf');
  }
  if (
    /^mkfs(\..+)?$/.test(program) ||
    program === 'wipefs' ||
    (program === 'diskutil' && /^erase|^zero|^randomDisk|^secureErase/i.test(args[0] ?? ''))
  ) {
    hits.push('mkfs');
  }
  if (program === 'dd' && args.some((a) => /^of=\/dev\//.test(a))) hits.push('dd_device');
  if (
    ['shutdown', 'reboot', 'halt', 'poweroff'].includes(program) ||
    (program === 'systemctl' && /^(poweroff|reboot|halt|kexec)$/.test(args[0] ?? '')) ||
    (program === 'init' && /^[06]$/.test(args[0] ?? ''))
  ) {
    hits.push('shutdown');
  }
  // The first operand is the mode or owner.
  if (['chmod', 'chown', 'chgrp'].includes(program) && ops.slice(1).some(isRootish)) {
    hits.push(`${program}_system`);
  }
  if (
    program === 'find' &&
    (args.includes('-delete') || args.some((a) => a.startsWith('-exec'))) &&
    args.some((a) => !a.startsWith('-') && isRootish(a))
  ) {
    hits.push('find_delete_system');
  }
  if (program === 'git' && args[0] === 'push') {
    const push = args.slice(1);
    const force =
      push.some(
        (a) =>
          a === '--force' || a.startsWith('--force-with-lease') || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(a),
      ) || push.some((a) => a.startsWith('+'));
    const deleting =
      push.includes('--delete') || push.includes('-d') || push.some((a) => a.startsWith(':'));
    const refs = push.filter((a) => !a.startsWith('-')).slice(1);
    const branchOf = (ref: string): string => ref.replace(/^\+/, '').split(':').pop() ?? '';
    const targetsProtected =
      refs.some((r) => PROTECTED_BRANCHES.has(branchOf(r).replace(/^refs\/heads\//, ''))) ||
      push.includes('--all') ||
      push.includes('--mirror') ||
      ((refs.length === 0 || refs.every((r) => branchOf(r) === 'HEAD')) &&
        ctx.branch !== null &&
        PROTECTED_BRANCHES.has(ctx.branch));
    if ((force || deleting) && targetsProtected) hits.push('force_push_protected');
  }
  // Writes into system locations, whether by redirect or by a writing program.
  const redirected = c.redirects
    .filter((r) => r.op === '&>' || r.op === '&>>' || (r.op.includes('>') && !r.op.includes('&')))
    .map((r) => r.target);
  const inPlace =
    program !== 'sed' || args.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith('--in-place'));
  const writes = [...redirected, ...(WRITERS.has(program) && inPlace ? ops : [])];
  if (writes.some((w) => pathScope(w) === 'system')) hits.push('system_write');
  return hits;
}

function pipelineRules(pipeline: readonly SimpleCommand[]): string[] {
  const download = pipeline.findIndex((c) => DOWNLOADERS.has(c.argv[0] ?? ''));
  if (
    download >= 0 &&
    pipeline.slice(download + 1).some((c) => INTERPRETERS.has(c.argv[0] ?? ''))
  ) {
    return ['curl_pipe_sh'];
  }
  return [];
}

/** `bash <(curl …)`, `sh -c "$(curl …)"`, `eval "$(wget …)"`: a download run as code. */
function substitutionRules(c: SimpleCommand): string[] {
  if (!INTERPRETERS.has(c.argv[0] ?? '')) return [];
  const downloads = c.substitutions.some((s) =>
    allCommands(s).some((x) => DOWNLOADERS.has(x.argv[0] ?? '')),
  );
  return downloads ? ['curl_pipe_sh'] : [];
}

/**
 * Backstop on the raw text with quotes and escapes removed, for anything the analyzer can't
 * follow. Only patterns that are never legitimate in a task.
 */
const RAW_DENY: Array<[string, RegExp]> = [
  ['fork_bomb', /(\w+|:)\(\)\{\1\|\1&\};?\1/],
  ['rm_rf', /\brm(-[a-z]*[rf][a-z]*|--recursive|--force)+(\/|~|\$\{?home\}?)(\*|\/)?($|[;&|])/i],
  ['rm_rf', /--no-preserve-root/],
  ['curl_pipe_sh', /\b(curl|wget)\b[^|]*\|(sudo)?(ba|z|da|k)?sh\b/],
  ['mkfs', /\bmkfs(\.\w+)?\b/],
  ['dd_device', /\bdd\b.*\bof=\/dev\//],
];

function rawDeny(command: string): string[] {
  const squashed = command.replace(/['"\\]/g, '').replace(/\s+/g, '');
  return RAW_DENY.filter(([, re]) => re.test(squashed)).map(([rule]) => rule);
}

function isReadOnlyCommand(c: SimpleCommand): boolean {
  const [program = '', ...args] = c.argv;
  if (c.privileged || c.substitutions.length > 0) return false;
  // Input redirects and fd duplication are fine; output only to /dev/null.
  const writesOut = (r: { op: string; target: string }): boolean =>
    r.op !== '<' && r.op !== '<&' && r.op !== '>&' && r.target !== '/dev/null';
  if (c.redirects.some(writesOut)) return false;
  if (args.some((a) => WRITING_FLAG.test(a))) return false;
  if (program === 'git') return READ_ONLY_GIT.has(args[0] ?? '');
  if (program === 'echo') return true;
  return READ_ONLY_PROGRAMS.has(program);
}

const INLINE_CODE_FLAG = /^-[a-zA-Z]*[ceE]$|^--(eval|command|exec)(=.*)?$|^-r$/;
const DELETERS = new Set(['rm', 'unlink', 'rmdir', 'shred', 'srm', 'trash']);

/**
 * Signals that force at least `confirm` whatever Jev says: Jev may make a decision stricter,
 * never looser, so these can't be talked into `auto`.
 */
function floorRules(c: SimpleCommand, pipelineIndex: number): ReasonLabel[] {
  const [program = '', ...args] = c.argv;
  const line = c.argv.join(' ');
  const out: ReasonLabel[] = [];
  if (DELETERS.has(program) || isDestructiveCommand(line)) out.push('destructive_action');
  if (
    program === 'git' &&
    ['reset', 'clean', 'checkout', 'restore', 'rebase', 'filter-branch'].includes(args[0] ?? '')
  ) {
    out.push('destructive_action');
  }
  if (hasExternalEffect(line) || (program === 'git' && args[0] === 'push'))
    out.push('irreversible');
  if (isMigrationCommand(line)) out.push('high_risk_area');
  // Code that arrives as an argument or on stdin can't be inspected: `python -c`, `| sh`.
  if (
    INTERPRETERS.has(program) &&
    (pipelineIndex > 0 || args.some((a) => INLINE_CODE_FLAG.test(a)))
  ) {
    out.push('inline_code');
  }
  return out;
}

function normalize(command: string): string {
  return command.trim().replace(/\s+/g, ' ');
}

/** Analyzes a shell command for the gate: deny-list, minimum-confirm signals, allow-list. */
export function assessCommand(command: string, ctx: CommandContext): CommandAssessment {
  const analysis = analyzeCommand(command);
  const commands = allCommands(analysis);
  const deny = new Set<string>(rawDeny(command));
  for (const c of commands)
    for (const rule of [...denyRules(c, ctx), ...substitutionRules(c)]) deny.add(rule);
  for (const p of allPipelines(analysis)) for (const rule of pipelineRules(p)) deny.add(rule);

  const confirm = new Set<ReasonLabel>();
  if (analysis.parseError) confirm.add('unparsable_command');
  if (analysis.substitution) confirm.add('command_substitution');
  if (commands.some((c) => c.privileged)) confirm.add('privileged');
  if (anyBackgrounded(analysis)) confirm.add('background_process');
  for (const p of allPipelines(analysis)) {
    p.forEach((c, i) => {
      for (const label of floorRules(c, i)) confirm.add(label);
    });
  }
  const words = commands.flatMap((c) => [...c.argv.slice(1), ...c.redirects.map((r) => r.target)]);
  for (const w of words) {
    // `--file=.env` style options carry paths too.
    const value = w.startsWith('-') && w.includes('=') ? w.slice(w.indexOf('=') + 1) : w;
    if (!looksLikePath(value)) continue;
    if (pathScope(value) !== 'workspace') confirm.add('outside_workspace');
    else if (ctx.sensitive(value)) confirm.add('sensitive_file');
  }

  const trusted = ctx.trustedCommands.map(normalize).includes(normalize(command));
  const readOnly =
    trusted || (commands.length > 0 && confirm.size === 0 && commands.every(isReadOnlyCommand));

  return {
    deny: [...deny].map((rule) => `deny_list:${rule}`),
    confirm: [...confirm],
    readOnly: readOnly && deny.size === 0,
    analysis,
  };
}
