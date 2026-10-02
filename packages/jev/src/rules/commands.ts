/**
 * Coarse command heuristics for the rules engine's answers. This is *not* the deny-list or
 * the read-only allow-list (JEV-2 owns those); it only shapes risk_gate answers, and errs
 * towards "not read-only" whenever a command is ambiguous.
 */

/** Anything that chains, substitutes, or redirects makes a command non-trivial. */
const SHELL_META = /[;&|`$<>(){}\n\\]/;

const READ_ONLY_PROGRAMS = new Set([
  'ls',
  'cat',
  'pwd',
  'head',
  'tail',
  'wc',
  'grep',
  'rg',
  'which',
  'file',
  'stat',
  'tree',
  'du',
  'df',
]);

const READ_ONLY_GIT = new Set(['status', 'diff', 'log', 'show', 'blame']);

/** Flags that turn an otherwise read-only program into a writer. */
const WRITING_FLAGS = /(^|\s)(-o|--output|--fix|-w|--write)(\s|=|$)/;

export function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, ' ');
}

export function isReadOnlyCommand(command: string): boolean {
  const cmd = normalizeCommand(command);
  if (cmd === '' || SHELL_META.test(cmd) || WRITING_FLAGS.test(cmd)) return false;
  const [program = '', sub] = cmd.split(' ');
  if (program === 'git') return sub !== undefined && READ_ONLY_GIT.has(sub);
  return READ_ONLY_PROGRAMS.has(program);
}

const DESTRUCTIVE: readonly RegExp[] = [
  /\brm\s+(-\S*\s+)*-\S*[rf]/i,
  /\bgit\s+push\b.*(\s--force(-with-lease)?\b|\s-f\b)/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\s+-\S*f/,
  /\bgit\s+(branch|tag)\s+-D\b/,
  /\bdrop\s+(table|database|schema)\b/i,
  /\btruncate\s+table\b/i,
  /\b(mkfs|shred|wipefs)\b/,
  /\bdd\b.*\bof=/,
  /\bchmod\s+-R\b/,
  /\bchown\s+-R\b/,
  /\bterraform\s+(apply|destroy)\b/,
  /\bkubectl\s+(apply|delete|replace)\b/,
  /\bdb:(drop|reset|wipe)\b/,
  /\b(curl|wget)\b.*\|\s*(ba|z)?sh\b/,
];

export function isDestructiveCommand(command: string): boolean {
  const cmd = normalizeCommand(command);
  return DESTRUCTIVE.some((re) => re.test(cmd));
}

const MIGRATION = /\b(migrat\w*|db:push|db:seed|prisma\s+db\s+push|alembic\s+upgrade|flyway)\b/i;

export function isMigrationCommand(command: string): boolean {
  return MIGRATION.test(command);
}

const RISK_AREA =
  /\b(auth\w*|login|oauth|jwt|passwords?|secrets?|credentials?|billing|payments?|invoices?|stripe|migrat\w*|deploy\w*|prod(uction)?)\b/i;

export function mentionsHighRiskArea(command: string): boolean {
  return RISK_AREA.test(command);
}

/** Writes to a remote or shared target (pushes, publishes, deploys). */
const EXTERNAL =
  /\b(git\s+push|npm\s+publish|pnpm\s+publish|yarn\s+publish|docker\s+push|deploy)\b/;

export function hasExternalEffect(command: string): boolean {
  return EXTERNAL.test(normalizeCommand(command));
}
