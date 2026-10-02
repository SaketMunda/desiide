import type { RiskGateState } from '@desiide/protocol';
import type { NoulResult } from '../types.ts';
import { noul, type Ruled } from './answers.ts';
import {
  hasExternalEffect,
  isDestructiveCommand,
  isMigrationCommand,
  isReadOnlyCommand,
  mentionsHighRiskArea,
} from './commands.ts';

const PROTECTED_BRANCHES = new Set(['main', 'master', 'production', 'prod', 'release']);

interface Facts {
  state: RiskGateState;
  hasCommand: boolean;
  readOnly: boolean;
  destructive: boolean;
  migration: boolean;
  riskArea: boolean;
  external: boolean;
  sensitive: boolean;
  protectedBranch: boolean;
}

function facts(state: RiskGateState): Facts {
  const cmd = state.command ?? '';
  return {
    state,
    hasCommand: cmd.trim() !== '',
    readOnly: cmd !== '' && isReadOnlyCommand(cmd),
    destructive: isDestructiveCommand(cmd),
    migration: isMigrationCommand(cmd),
    riskArea: mentionsHighRiskArea(cmd),
    external: state.actionType === 'git_push' || hasExternalEffect(cmd),
    sensitive: state.filesTouched.some((f) => f.sensitive),
    protectedBranch: state.context.branch !== null && PROTECTED_BRANCHES.has(state.context.branch),
  };
}

// Rules are ordered; the first match wins. Each one is a fixed, explainable answer.

function safeNow(f: Facts): Ruled<NoulResult> {
  const { actionType } = f.state;
  if (f.destructive) return noul('no', 0.03, 'destructive_command');
  if (f.migration) return noul('no', 0.1, 'migration_command');
  if (f.external && f.protectedBranch) return noul('no', 0.1, 'protected_branch');
  if (actionType === 'delete_file') return noul('unknown', 0.3, 'delete_file');
  if (f.sensitive) return noul('unknown', 0.35, 'sensitive_file');
  if (f.external) return noul('unknown', 0.4, 'external_effect');
  switch (actionType) {
    case 'run_command':
      return f.readOnly
        ? noul('yes', 0.95, 'read_only_command')
        : noul('unknown', 0.5, f.hasCommand ? 'unclassified_command' : 'missing_command');
    case 'run_tests':
    case 'lint':
      return noul('yes', 0.9, 'verification_command');
    case 'apply_edit':
      return (f.state.editFileCount ?? 1) <= 1
        ? noul('yes', 0.9, 'single_file_edit')
        : noul('yes', 0.8, 'multi_file_edit');
    case 'git_commit':
      return noul('yes', 0.85, 'local_commit');
    case 'install_dependency':
      return noul('unknown', 0.5, 'install_dependency');
    default:
      return noul('unknown', 0.5, 'unclassified_action');
  }
}

function reversible(f: Facts): Ruled<NoulResult> {
  const { actionType } = f.state;
  if (f.destructive) return noul('no', 0.03, 'destructive_command');
  if (f.migration) return noul('no', 0.1, 'migration_command');
  if (f.external) return noul('no', 0.1, 'external_effect');
  if (actionType === 'delete_file') return noul('unknown', 0.4, 'delete_file');
  switch (actionType) {
    case 'run_command':
      return f.readOnly
        ? noul('yes', 0.98, 'read_only_command')
        : noul('unknown', 0.4, f.hasCommand ? 'unclassified_command' : 'missing_command');
    case 'apply_edit':
      return noul('yes', 0.9, 'workspace_edit_undo');
    case 'git_commit':
      return noul('yes', 0.85, 'local_commit');
    case 'run_tests':
    case 'lint':
      return noul('yes', 0.8, 'verification_command');
    case 'install_dependency':
      return noul('unknown', 0.5, 'install_dependency');
    default:
      return noul('unknown', 0.4, 'unclassified_action');
  }
}

function highRiskArea(f: Facts): Ruled<NoulResult> {
  if (f.sensitive) return noul('yes', 0.95, 'sensitive_file');
  if (f.migration) return noul('yes', 0.9, 'migration_command');
  if (f.riskArea) return noul('yes', 0.75, 'risk_area_keyword');
  return noul('no', 0.05, 'no_risk_signal');
}

const QUESTIONS: Record<string, (f: Facts) => Ruled<NoulResult>> = {
  safe_now: safeNow,
  reversible,
  high_risk_area: highRiskArea,
};

export function riskGateNoul(
  state: RiskGateState,
  question: string,
): Ruled<NoulResult> | undefined {
  const rule = Object.hasOwn(QUESTIONS, question) ? QUESTIONS[question] : undefined;
  return rule?.(facts(state));
}
