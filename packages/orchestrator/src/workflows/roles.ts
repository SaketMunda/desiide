import type { ModelAdapter } from '@desiide/models';
import type { ModelRole, WorkflowOption } from '@desiide/protocol';

/** The models behind each role (ADR-007); a role is absent when nothing is assigned to it. */
export type RoleModels = Partial<Record<ModelRole, ModelAdapter>>;

/**
 * Workflows runnable in this build. `cloud-with-critique` arrives with the critique workflow
 * (COR-5 Beta); until then it's never offered, so the quality floor lands on `cloud-single`.
 */
export const SUPPORTED_WORKFLOWS: readonly WorkflowOption[] = [
  'local-single',
  'local-cloud-cascade',
  'cloud-single',
];

/** Each role's model, or nothing for a role the registry can't resolve. */
export function resolveRoles(forRole: (role: ModelRole) => ModelAdapter): RoleModels {
  const roles: RoleModels = {};
  for (const role of ['cheap', 'strong', 'reviewer'] as const) {
    try {
      roles[role] = forRole(role);
    } catch {
      // Unassigned: the options needing it are dropped before Jev is asked.
    }
  }
  return roles;
}

/** The plan for one workflow option: the model to start with, and the one to escalate to. */
export interface WorkflowPlan {
  workflow: WorkflowOption;
  first: ModelAdapter;
  escalateTo?: ModelAdapter;
}

/**
 * Options map to roles, never to model ids (ADR-007): `local-single` → cheap, `cloud-single` →
 * strong, `local-cloud-cascade` → cheap then strong. A cascade between one and the same model
 * would only repeat the work, so it needs two different models.
 */
export function planFor(option: WorkflowOption, roles: RoleModels): WorkflowPlan | undefined {
  const { cheap, strong } = roles;
  switch (option) {
    case 'local-single':
      return cheap ? { workflow: option, first: cheap } : undefined;
    case 'cloud-single':
      return strong ? { workflow: option, first: strong } : undefined;
    case 'local-cloud-cascade':
      return cheap && strong && cheap.id !== strong.id
        ? { workflow: option, first: cheap, escalateTo: strong }
        : undefined;
    case 'cloud-with-critique':
      return undefined;
  }
}

/** What can run with the configured roles, in `SUPPORTED_WORKFLOWS` order. */
export function runnableOptions(roles: RoleModels): WorkflowOption[] {
  return SUPPORTED_WORKFLOWS.filter((o) => planFor(o, roles) !== undefined);
}
