import {
  createEngineSelector,
  createPathRedactor,
  createPolicyGate,
  createRuleJevEngine,
  resolveThresholds,
  type GatingMode,
  type GitInfo,
  type JevEngine,
  type PathRedactor,
  type PolicyGate,
  type ProjectPolicy,
  type ReplayOptions,
  type Thresholds,
} from '@desiide/jev';
import type { DecisionRecord, DesiideConfig, Task } from '@desiide/protocol';
import type { ConfigListener } from '../config/handler.ts';
import type { Host } from '../host/host.ts';
import { SAFE_GIT } from '../tools/commands.ts';
import { createWorkspace } from '../tools/paths.ts';
import { runProcess } from '../tools/process.ts';
import { loadProjectConfig } from '../tools/projectConfig.ts';
import type { TaskLogger } from '../tasks/taskManager.ts';

export interface WorkspacePolicyOptions {
  logger?: TaskLogger & { debug?(obj: object, msg?: string): void };
  newId(): string;
  /** Decision sink (JEV-4 persists, UI-5 shows). Defaults to a debug log line. */
  onDecision?(record: DecisionRecord): void;
}

export interface WorkspacePolicy {
  gate: PolicyGate;
  /** The engine behind the gate (rules, or Jev once JEV-3 lands); COR-5 routes tasks with it. */
  engine: JevEngine;
  /** The decision sink the gate uses (JEV-4 log + task stream), for COR-5 workflow decisions. */
  onDecision(record: DecisionRecord): void;
  /** Subscribe to `config.update`: gating mode, thresholds, Jev settings. */
  onConfig: ConfigListener;
  /** Engines and current settings for `decisions.replay` (JEV-4). */
  replayOptions(): ReplayOptions;
  /** Set while `jev.redactPaths` is on and a valid salt was configured. */
  redactor(): PathRedactor | undefined;
  /** What `jev.test` reports on: the Jev settings from the last `config.update`. */
  jevSettings(): JevSettings;
  /** The project's sensitive globs and check commands (`.desiide/project.json`). */
  loadProject(): Promise<ProjectPolicy>;
  /** The current branch, for risk_gate state. */
  git(signal: AbortSignal): Promise<GitInfo>;
}

export interface JevSettings {
  enabled: boolean;
  endpoint?: string;
  redactPaths: boolean;
}

const MAX_CACHED_PROJECTS = 32;

/**
 * JEV-2's `PolicyGate` bound to this orchestrator: the rules engine behind an engine selector
 * (JEV-3 plugs the real Jev in there), settings from `config.update`, the project's
 * sensitive globs and check commands, and the current branch for force-push rules.
 */
export function createWorkspacePolicy(host: Host, opts: WorkspacePolicyOptions): WorkspacePolicy {
  const rules = createRuleJevEngine();
  const engine = createEngineSelector({
    rules,
    config: { enabled: false },
  });
  let mode: GatingMode = 'conservative';
  let thresholds: Thresholds = resolveThresholds().thresholds;
  let redactor: PathRedactor | undefined;
  let jev: JevSettings = { enabled: false, redactPaths: false };
  // One project config read per task: the gate runs on every tool call.
  const projects = new Map<string, Promise<ProjectPolicy>>();

  const loadProject = async (): Promise<ProjectPolicy> => {
    const roots = host.session?.workspaceRoots;
    if (!roots?.length) return {};
    const loaded = await loadProjectConfig(await createWorkspace(roots));
    const { sensitiveGlobs, testCommand, lintCommand } = loaded.config;
    return {
      ...(sensitiveGlobs ? { sensitiveGlobs } : {}),
      ...(testCommand ? { testCommand } : {}),
      ...(lintCommand ? { lintCommand } : {}),
    };
  };

  const project = (task: Task): Promise<ProjectPolicy> => {
    let p = projects.get(task.id);
    if (!p) {
      p = loadProject().catch((err: unknown) => {
        opts.logger?.warn({ err, taskId: task.id }, 'project config unavailable for policy');
        return {};
      });
      projects.set(task.id, p);
      if (projects.size > MAX_CACHED_PROJECTS) {
        const oldest = projects.keys().next().value;
        if (oldest !== undefined) projects.delete(oldest);
      }
    }
    return p;
  };

  const git = async (signal: AbortSignal): Promise<GitInfo> => {
    const root = host.session?.workspaceRoots[0];
    if (!root) return { branch: null, hasPendingMigrations: false };
    const r = await runProcess(
      { kind: 'exec', file: 'git', args: [...SAFE_GIT, 'rev-parse', '--abbrev-ref', 'HEAD'] },
      { cwd: root, env: process.env, timeoutMs: 5_000, signal },
    );
    const branch = r.exitCode === 0 ? r.output.trim() : '';
    // Unknown branch: force-push rules then rely on explicit refspecs, and force pushes still
    // need confirmation through the destructive floor.
    return { branch: branch && branch !== 'HEAD' ? branch : null, hasPendingMigrations: false };
  };

  const gate = createPolicyGate({
    engine,
    settings: () => ({ mode, thresholds, ...(redactor ? { redactor } : {}) }),
    project,
    git,
    newId: opts.newId,
    onDecision:
      opts.onDecision ??
      ((r) =>
        opts.logger?.debug?.(
          {
            decisionId: r.id,
            taskId: r.taskId,
            question: r.question,
            outcome: r.policyOutcome,
            reasons: r.reasons,
          },
          'policy decision',
        )),
  });

  const onConfig: ConfigListener = (config: DesiideConfig) => {
    mode = config.gating.mode;
    const resolved = resolveThresholds(config.gating.thresholds);
    thresholds = resolved.thresholds;
    jev = {
      enabled: config.jev.enabled,
      ...(config.jev.endpoint ? { endpoint: config.jev.endpoint } : {}),
      redactPaths: config.jev.redactPaths,
    };
    redactor = undefined;
    if (config.jev.redactPaths) {
      if (config.jev.redactSalt) {
        redactor = createPathRedactor({ salt: config.jev.redactSalt });
      } else {
        // Never fall back to a guessable salt: without one, paths stay unredacted and we say so.
        const warning =
          'desiide.jev.redactPaths is on, but no redaction salt was sent, so paths are not redacted.';
        opts.logger?.warn({ warning }, 'path redaction unavailable');
        host
          .notify('log', { level: 'warn', message: warning, ts: new Date().toISOString() })
          .catch(() => {});
      }
    }
    engine.update({
      config: {
        enabled: config.jev.enabled,
        ...(config.jev.endpoint ? { endpoint: config.jev.endpoint } : {}),
      },
    });
    for (const warning of resolved.warnings) {
      opts.logger?.warn({ warning }, 'gating override rejected');
      // Visible to the user: the extension shows `log` warnings in the Desiide output channel.
      host
        .notify('log', { level: 'warn', message: warning, ts: new Date().toISOString() })
        .catch(() => {});
    }
  };

  // JEV-3 adds the HTTP engine here once it exists; until then replay runs rules only.
  const replayOptions = (): ReplayOptions => ({ rules, settings: { mode, thresholds } });

  return {
    gate,
    engine,
    onDecision: (record) => {
      try {
        opts.onDecision?.(record);
      } catch (err) {
        opts.logger?.warn({ err }, 'decision sink failed');
      }
    },
    onConfig,
    replayOptions,
    redactor: () => redactor,
    jevSettings: () => jev,
    loadProject: () =>
      loadProject().catch((err: unknown) => {
        opts.logger?.warn({ err }, 'project config unavailable');
        return {};
      }),
    git,
  };
}
