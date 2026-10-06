import type { ReasonLabel } from '@desiide/protocol';

/**
 * Human text for reason labels, for UI-4's approval cards and UI-5's decision panel. Labels are
 * `label` or `label:detail`; unknown ones get a generic rendering instead of being hidden.
 */
export const REASON_TEXT: Readonly<Record<string, string>> = {
  deny_list: 'Blocked: this command is on the deny-list',
  read_only_allow: 'Read-only, so it runs without asking',
  sensitive_file: 'Touches a sensitive file (secrets, keys, credentials)',
  multi_file_edit: 'Edits more than one file',
  destructive_action: 'Deletes or overwrites data',
  high_risk_area: 'Touches a high-risk area (auth, billing, migrations, deploys)',
  irreversible: "Can't be undone automatically",
  not_safe_now: 'Not judged safe to run right now',
  jev_confident: 'Jev is confident this is safe',
  jev_uncertain: "Jev isn't confident enough to run this unasked",
  jev_unavailable: 'Jev was unavailable, so Desiide asks to be safe',
  policy_override: 'Adjusted by policy',
  approved_for_task: 'You allowed this exact action for the task',
  user_rejected: 'You rejected this',
  outside_workspace: 'Reaches outside the workspace',
  command_substitution: 'Runs a nested command ($(…) or backticks)',
  privileged: 'Runs with elevated privileges (sudo)',
  background_process: 'Starts a background process',
  unparsable_command: "Desiide couldn't fully read this command",
  inline_code: "Runs code Desiide can't inspect (inline script or piped into an interpreter)",
  tool_not_allowed: "This tool isn't allowed for the task",
  gate_error: 'The policy check failed, so Desiide asks to be safe',
  no_models_configured: 'No model is configured for any workflow',
  option_unavailable: 'The requested option needs a model that isn’t configured',
};

const DENY_RULE_TEXT: Readonly<Record<string, string>> = {
  rm_rf: 'recursive delete of the system, home, or parent directory',
  mkfs: 'formats or erases a disk',
  dd_device: 'writes directly to a device',
  fork_bomb: 'fork bomb',
  curl_pipe_sh: 'runs a downloaded script',
  force_push_protected: 'force-pushes or deletes main/master',
  chmod_system: 'changes permissions of system files',
  chown_system: 'changes ownership of system files',
  chgrp_system: 'changes the group of system files',
  find_delete_system: 'deletes files across the system or home directory',
  system_write: 'writes to system files or shell start-up files',
  shutdown: 'shuts down or reboots the machine',
};

const OVERRIDE_TEXT: Readonly<Record<string, string>> = {
  strict_mode: 'strict gating mode asks before every side effect',
  user_choice: 'you picked this workflow',
  cheap_success: 'a local model is likely to succeed',
  complexity_floor: 'the task is complex, so a stronger model is used',
  sensitive_floor: 'sensitive files are involved, so a stronger model is used',
  option_unavailable: "the chosen workflow wasn't available",
};

export function describeReason(label: ReasonLabel): string {
  const colon = label.indexOf(':');
  const head = colon < 0 ? label : label.slice(0, colon);
  const detail = colon < 0 ? undefined : label.slice(colon + 1);
  const base = Object.hasOwn(REASON_TEXT, head) ? REASON_TEXT[head] : undefined;
  if (head === 'deny_list' && detail) {
    const rule = Object.hasOwn(DENY_RULE_TEXT, detail) ? DENY_RULE_TEXT[detail] : detail;
    return `Blocked: ${rule}`;
  }
  if (head === 'policy_override' && detail) {
    const why = Object.hasOwn(OVERRIDE_TEXT, detail) ? OVERRIDE_TEXT[detail] : detail;
    return `Adjusted by policy: ${why}`;
  }
  if (base) return detail ? `${base} (${detail})` : base;
  return label.replace(/[_:]/g, ' ');
}
