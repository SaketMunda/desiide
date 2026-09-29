import type { CostRouteState, RiskGateState, WorkflowSelectState } from '../jev.ts';

/**
 * The three example Jev states, one per pack. JEV-1 validates them against its pack schemas,
 * JEV-2 uses them as golden inputs, UI-5 renders the resulting decisions.
 */
export const exampleWorkflowSelectState = {
  pack: 'workflow_select@1',
  taskType: 'bug_fix',
  filesTouched: [
    { path: 'src/cart/total.ts', sizeLines: 180, language: 'typescript', sensitive: false },
    { path: 'src/cart/total.test.ts', sizeLines: 95, language: 'typescript', sensitive: false },
  ],
  estimatedDiffSize: 24,
  lastRunStatus: 'none',
  userPreference: 'balance',
  availableModels: [
    { id: 'ollama-qwen', contextTokens: 32_768, latencyMs: 400, costTier: 'free' },
    { id: 'claude-strong', contextTokens: 200_000, latencyMs: 1_200, costTier: 'high' },
  ],
} as const satisfies WorkflowSelectState;

/** Migration command next to a sensitive billing file: must never auto-run. */
export const exampleRiskGateState = {
  pack: 'risk_gate@1',
  actionType: 'run_command',
  command: 'npm run migrate',
  context: { branch: 'main', env: 'local', hasPendingMigrations: true },
  filesTouched: [
    { path: 'src/billing/invoice.ts', sensitive: true },
    { path: 'db/migrations/0042_add_invoice_tax.sql', sensitive: true },
  ],
} as const satisfies RiskGateState;

export const exampleCostRouteState = {
  pack: 'cost_route@1',
  taskType: 'refactor',
  filesTouchedCount: 1,
  projectSizeLines: 42_000,
  userCostBias: 'cheap',
  recentFailures: 0,
} as const satisfies CostRouteState;

export const jevExampleStates = [
  exampleWorkflowSelectState,
  exampleRiskGateState,
  exampleCostRouteState,
] as const;

/** Extra risk_gate cases for JEV-2 goldens: a read-only command and a deny-listed one. */
export const riskGateReadOnlyState = {
  pack: 'risk_gate@1',
  actionType: 'run_command',
  command: 'git status',
  context: { branch: 'feature/cart-fix', env: 'local', hasPendingMigrations: false },
  filesTouched: [],
} as const satisfies RiskGateState;

export const riskGateDenyListedState = {
  pack: 'risk_gate@1',
  actionType: 'git_push',
  command: 'git push --force origin main',
  context: { branch: 'main', env: 'local', hasPendingMigrations: false },
  filesTouched: [],
} as const satisfies RiskGateState;
