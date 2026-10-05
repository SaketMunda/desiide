import {
  CostRouteState,
  JevPackState,
  KnownPack,
  RiskGateState,
  WorkflowOption,
  WorkflowSelectState,
} from '@desiide/protocol';
import type * as z from 'zod';
import { JevRequestError, type QuestionType } from '../types.ts';

export interface QuestionTemplate {
  id: string;
  type: QuestionType;
  /** Natural-language question as sent to Jev. */
  text: string;
  /** Choice questions only: every option the pack defines. */
  options?: readonly string[];
}

export interface PackDefinition<S extends JevPackState = JevPackState> {
  id: S['pack'];
  name: string;
  version: number;
  /** The protocol's versioned state schema (FND-2), registered rather than redefined. */
  schema: z.ZodType<S>;
  questions: Readonly<Record<string, QuestionTemplate>>;
}

const WORKFLOW_OPTIONS = WorkflowOption.options;

export const workflowSelectPack: PackDefinition<WorkflowSelectState> = {
  id: 'workflow_select@1',
  name: 'workflow_select',
  version: 1,
  schema: WorkflowSelectState,
  questions: {
    workflow: {
      id: 'workflow',
      type: 'choice',
      text: 'Which workflow should handle this task?',
      options: WORKFLOW_OPTIONS,
    },
    complexity: {
      id: 'complexity',
      type: 'score',
      text: 'How complex is this task, from 0 (trivial) to 4 (very complex)?',
    },
    escalation_need: {
      id: 'escalation_need',
      type: 'score',
      text: 'How likely is it that a draft from a cheap model will need escalation, from 0 to 4?',
    },
  },
};

export const riskGatePack: PackDefinition<RiskGateState> = {
  id: 'risk_gate@1',
  name: 'risk_gate',
  version: 1,
  schema: RiskGateState,
  questions: {
    safe_now: {
      id: 'safe_now',
      type: 'noul',
      text: 'Is it safe to run this action in the current context?',
    },
    reversible: {
      id: 'reversible',
      type: 'noul',
      text: 'Is this action reversible without human intervention?',
    },
    high_risk_area: {
      id: 'high_risk_area',
      type: 'noul',
      text: 'Does this touch security, auth, billing, or data-migration code?',
    },
  },
};

export const costRoutePack: PackDefinition<CostRouteState> = {
  id: 'cost_route@1',
  name: 'cost_route',
  version: 1,
  schema: CostRouteState,
  questions: {
    cheap_success: {
      id: 'cheap_success',
      type: 'score',
      text: 'How likely will a cheap/local model succeed without escalation, from 0 to 4?',
    },
  },
};

const PACKS: Readonly<Record<KnownPack, PackDefinition>> = {
  'workflow_select@1': workflowSelectPack as PackDefinition,
  'risk_gate@1': riskGatePack as PackDefinition,
  'cost_route@1': costRoutePack as PackDefinition,
};

export function listPacks(): PackDefinition[] {
  return Object.values(PACKS);
}

export function getPack(id: string): PackDefinition {
  const parsed = KnownPack.safeParse(id);
  if (!parsed.success) throw new JevRequestError('unknown_pack', `Unknown pack "${id}"`, id);
  return PACKS[parsed.data];
}

/** Validates any external state (RPC, replayed log) against its versioned pack schema. */
export function parsePackState(input: unknown): JevPackState {
  const parsed = JevPackState.safeParse(input);
  if (!parsed.success) {
    const pack =
      typeof input === 'object' && input !== null && 'pack' in input
        ? String((input as { pack: unknown }).pack)
        : undefined;
    throw new JevRequestError(
      'invalid_state',
      `Invalid pack state: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`,
      pack,
    );
  }
  return parsed.data;
}

/** Looks up a question and checks it has the expected type. */
export function getQuestion(pack: string, id: string, type: QuestionType): QuestionTemplate {
  const def = getPack(pack);
  const question = Object.hasOwn(def.questions, id) ? def.questions[id] : undefined;
  if (!question) {
    throw new JevRequestError('unknown_question', `Pack ${pack} has no question "${id}"`, pack);
  }
  if (question.type !== type) {
    throw new JevRequestError(
      'wrong_question_type',
      `Question ${pack}/${id} is a ${question.type} question, not ${type}`,
      pack,
    );
  }
  return question;
}

/** Local or cloud. States from before `locality` existed fall back to `free` cost tier = local. */
export function isLocalModel(model: WorkflowSelectState['availableModels'][number]): boolean {
  return model.locality ? model.locality === 'local' : model.costTier === 'free';
}

/** Workflow options whose models are configured. */
export function allowedWorkflowOptions(state: WorkflowSelectState): WorkflowOption[] {
  const hasLocal = state.availableModels.some(isLocalModel);
  const hasCloud = state.availableModels.some((m) => !isLocalModel(m));
  return WORKFLOW_OPTIONS.filter((option) => {
    switch (option) {
      case 'local-single':
        return hasLocal;
      case 'cloud-single':
      case 'cloud-with-critique':
        return hasCloud;
      case 'local-cloud-cascade':
        return hasLocal && hasCloud;
    }
  });
}

/** Resolves and validates the options for a choice request. */
export function resolveChoiceOptions(
  state: JevPackState,
  question: QuestionTemplate,
  requested: readonly string[] | undefined,
): string[] {
  const defined = question.options ?? [];
  const defaults =
    state.pack === 'workflow_select@1' && question.id === 'workflow'
      ? allowedWorkflowOptions(state)
      : [...defined];
  const options = requested ? [...new Set(requested)] : defaults;
  const unknown = options.filter((o) => !defined.includes(o));
  if (unknown.length > 0) {
    throw new JevRequestError(
      'invalid_options',
      `Options not defined by ${state.pack}/${question.id}: ${unknown.join(', ')}`,
      state.pack,
    );
  }
  if (options.length === 0) {
    throw new JevRequestError(
      'invalid_options',
      `No options available for ${state.pack}/${question.id} (are any models configured?)`,
      state.pack,
    );
  }
  return options;
}
