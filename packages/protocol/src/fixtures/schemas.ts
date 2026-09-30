import {
  exampleCostRouteState,
  exampleRiskGateState,
  exampleWorkflowSelectState,
  riskGateDenyListedState,
  riskGateReadOnlyState,
} from './jev-examples.ts';

/**
 * Valid and invalid samples per exported schema, keyed by export name. Method params/results are
 * keyed `<method>.params` / `<method>.result`. The fixture test fails if a schema has no entry.
 */
export interface SchemaFixture {
  valid: readonly unknown[];
  invalid: readonly unknown[];
}

const ts = '2026-09-29T12:00:00.000Z';
const range = { start: { line: 3, character: 0 }, end: { line: 9, character: 12 } };
const fileMeta = { path: 'src/a.ts', sizeLines: 10, language: 'typescript', sensitive: false };
const toolCall = {
  id: 'call-1',
  tool: 'shell',
  args: { command: 'npm test' },
  sideEffect: 'external',
};
const toolResult = { callId: 'call-1', ok: true, output: 'ok', durationMs: 12 };
const blockedResult = {
  callId: 'call-2',
  ok: false,
  output: '',
  durationMs: 1,
  error: { kind: 'blocked', message: 'deny-listed', reasons: ['deny_list:rm_rf'] },
};
const fileEdit = { path: 'src/a.ts', edits: [{ search: 'let x = 1;', replace: 'const x = 1;' }] };
const proposal = { id: 'prop-1', taskId: 'task-1', files: [fileEdit] };
const capabilities = { streaming: true, toolCalls: true, contextTokens: 200_000 };
const modelInfo = {
  id: 'claude-strong',
  provider: 'anthropic',
  model: 'claude-opus-5-5',
  role: 'strong',
  capabilities,
  healthy: true,
};
const modelConfig = {
  id: 'claude-strong',
  provider: 'anthropic',
  model: 'claude-opus-5-5',
  apiKey: 'secret:anthropic',
  costPerMTok: { input: 5, output: 25 },
};
const usage = { inputTokens: 1200, outputTokens: 300, costUsd: 0.0135 };
const taskInput = { kind: 'bug_fix', instruction: 'Fix the off-by-one in cart total' };
const taskSummary = {
  id: 'task-1',
  kind: 'bug_fix',
  instruction: 'Fix the off-by-one in cart total',
  state: 'running',
  workflow: 'local-cloud-cascade',
  models: ['ollama-qwen'],
  iteration: 1,
  usage,
  createdAt: ts,
  updatedAt: ts,
};
const decision = {
  id: 'dec-1',
  taskId: 'task-1',
  pack: 'risk_gate@1',
  question: 'safe_now',
  engine: 'rules',
  stateHash: 'sha256:ab12',
  state: exampleRiskGateState,
  result: { kind: 'noul', answer: 'no', pYes: 0.05 },
  policyOutcome: 'confirm',
  reasons: ['sensitive_file', 'high_risk_area'],
  latencyMs: 2,
  ts,
};
const env = { taskId: 'task-1', seq: 4, ts };
const engineRun = {
  engine: 'rules',
  result: { kind: 'noul', answer: 'no', pYes: 0.05 },
  policyOutcome: 'confirm',
  latencyMs: 2,
};

export const schemaFixtures: Record<string, SchemaFixture> = {
  // common
  Id: { valid: ['task-1'], invalid: ['', 42] },
  IsoDateTime: { valid: [ts, '2026-09-29T12:00:00+02:00'], invalid: ['2026-09-29', 'yesterday'] },
  WorkspacePath: {
    valid: ['src/a.ts', 'README.md'],
    invalid: ['', '/etc/passwd', 'C:\\Windows', '../outside.ts', 'src/../../x'],
  },
  Position: { valid: [{ line: 0, character: 0 }], invalid: [{ line: -1, character: 0 }] },
  Range: { valid: [range], invalid: [{ start: { line: 0, character: 0 } }] },
  SecretRef: { valid: ['secret:anthropic'], invalid: ['sk-live-123', 'secret:', 'secret:a b'] },
  Ack: { valid: [{ ok: true }], invalid: [{ ok: false }] },
  Empty: { valid: [{}], invalid: [{ extra: 1 }] },
  SemVer: { valid: ['1.0.0'], invalid: ['1.0', 'v1.0.0'] },

  // context
  ContextRef: {
    valid: [
      { type: 'file', path: 'src/a.ts' },
      { type: 'folder', path: 'src' },
      { type: 'selection', path: 'src/a.ts', range },
      { type: 'diff', scope: 'working' },
    ],
    invalid: [
      { type: 'url', path: 'https://x' },
      { type: 'file', path: '/abs' },
    ],
  },
  FileMeta: {
    valid: [fileMeta],
    invalid: [
      { ...fileMeta, contents: 'secret code' },
      { ...fileMeta, sizeLines: -1 },
    ],
  },

  // tools
  ToolName: { valid: ['read_file', 'git_read'], invalid: ['rm', 'read'] },
  SideEffect: { valid: ['none', 'workspace', 'external'], invalid: ['network'] },
  ToolCall: {
    valid: [toolCall],
    invalid: [
      { ...toolCall, tool: 'exec' },
      { ...toolCall, args: 'npm test' },
    ],
  },
  ToolErrorKind: { valid: ['blocked'], invalid: ['oops'] },
  ToolResult: {
    valid: [toolResult, blockedResult],
    invalid: [{ ...toolResult, durationMs: -5 }, { callId: 'c' }],
  },

  // edits
  SearchReplace: { valid: [{ search: 'a', replace: 'b' }], invalid: [{ search: 'a' }] },
  FileEdit: { valid: [fileEdit], invalid: [{ path: 'src/a.ts', edits: [] }] },
  Critique: {
    valid: [{ verdict: 'revise', issues: ['missing null check'] }],
    invalid: [{ verdict: 'maybe', issues: [] }],
  },
  EditProposal: {
    valid: [proposal, { ...proposal, critique: { verdict: 'approve', issues: [] } }],
    invalid: [{ ...proposal, files: [] }],
  },
  FileApplyStatus: { valid: ['applied', 'rejected', 'stale'], invalid: ['partial'] },
  FileApplyResult: {
    valid: [{ path: 'src/a.ts', status: 'stale' }],
    invalid: [{ path: 'src/a.ts', status: 'applied', extra: true }],
  },

  // models
  ModelProvider: { valid: ['ollama'], invalid: ['gemini'] },
  ModelRole: { valid: ['cheap', 'strong', 'reviewer'], invalid: ['fast'] },
  ModelCapabilities: {
    valid: [capabilities],
    invalid: [{ ...capabilities, contextTokens: 0 }],
  },
  ModelInfo: { valid: [modelInfo], invalid: [{ ...modelInfo, provider: 'gemini' }] },
  CostPerMTok: { valid: [{ input: 0, output: 0 }], invalid: [{ input: -1, output: 1 }] },
  ModelConfig: {
    valid: [
      modelConfig,
      { id: 'local', provider: 'ollama', model: 'qwen', baseUrl: 'http://localhost:11434/v1' },
    ],
    invalid: [
      { ...modelConfig, apiKey: 'sk-ant-raw-key' },
      { ...modelConfig, baseUrl: 'not a url' },
    ],
  },
  ModelErrorKind: { valid: ['rate_limit'], invalid: ['boom'] },

  // config
  ProjectConfig: {
    valid: [{}, { testCommand: 'pnpm test', sensitiveGlobs: ['src/billing/**'], extra: 1 }],
    invalid: [{ testCommand: '' }, { sensitiveGlobs: 'src/**' }],
  },
  RolesConfig: { valid: [{ cheap: 'local', strong: 'claude' }], invalid: [{ fast: 'x' }] },
  JevConfig: {
    valid: [{}, { enabled: true, endpoint: 'https://jev.example.com', apiKey: 'secret:jev' }],
    invalid: [{ apiKey: 'raw-key' }],
  },
  GatingConfig: {
    valid: [{}, { mode: 'strict', thresholds: { safeNowAuto: 0.95 } }],
    invalid: [{ mode: 'permissive' }],
  },
  DesiideConfig: {
    valid: [{}, { models: [modelConfig], roles: { strong: 'claude-strong' } }],
    invalid: [{ models: [{ id: 'x' }] }, { telemetry: true }],
  },

  // task
  TaskKind: { valid: ['bug_fix'], invalid: ['deploy'] },
  Preference: { valid: ['balance'], invalid: ['fast'] },
  WorkflowOption: { valid: ['local-cloud-cascade'], invalid: ['cascade'] },
  TaskContext: {
    valid: [{}, { refs: [{ type: 'file', path: 'src/a.ts' }], openEditors: ['src/b.ts'] }],
    invalid: [{ refs: [{ type: 'file', path: '../x' }] }],
  },
  SuccessCriteria: { valid: [{}, { testsPass: true }], invalid: [{ testsPass: 'yes' }] },
  Budget: { valid: [{}, { maxIterations: 3 }], invalid: [{ maxIterations: 0 }] },
  TaskInput: {
    valid: [taskInput, { ...taskInput, preference: 'quality', allowedTools: ['read_file'] }],
    invalid: [
      { ...taskInput, instruction: '   ' },
      { ...taskInput, id: 'client-chosen' },
      { ...taskInput, allowedTools: [] },
    ],
  },
  Task: {
    valid: [{ id: 'task-1', ...taskInput }],
    invalid: [taskInput],
  },
  TaskState: { valid: ['awaiting_approval'], invalid: ['paused'] },
  Usage: { valid: [usage], invalid: [{ inputTokens: 1 }] },
  TaskSummary: { valid: [taskSummary], invalid: [{ ...taskSummary, state: 'paused' }] },

  // reasons + jev
  PolicyOutcome: { valid: ['auto', 'confirm', 'block'], invalid: ['allow'] },
  ReasonLabel: {
    valid: ['sensitive_file', 'deny_list:rm_rf', 'policy_override:cost_route@1'],
    invalid: ['', 'Sensitive File', 'has spaces:x'],
  },
  JevEngineKind: { valid: ['jev', 'rules'], invalid: ['llm'] },
  PackId: { valid: ['risk_gate@1', 'risk_gate@2'], invalid: ['risk_gate', 'risk_gate@v1'] },
  KnownPack: { valid: ['cost_route@1'], invalid: ['cost_route@2'] },
  CostTier: { valid: ['free'], invalid: ['cheap'] },
  RiskActionType: { valid: ['git_push'], invalid: ['deploy'] },
  WorkflowSelectState: {
    valid: [exampleWorkflowSelectState],
    invalid: [
      { ...exampleWorkflowSelectState, filesTouched: Array(51).fill(fileMeta) },
      { ...exampleWorkflowSelectState, fileContents: 'const x = 1' },
    ],
  },
  RiskGateState: {
    valid: [exampleRiskGateState, riskGateReadOnlyState, riskGateDenyListedState],
    invalid: [
      { ...exampleRiskGateState, command: 'x'.repeat(501) },
      { ...exampleRiskGateState, pack: 'risk_gate@2' },
    ],
  },
  CostRouteState: {
    valid: [exampleCostRouteState],
    invalid: [{ ...exampleCostRouteState, recentFailures: -1 }],
  },
  JevPackState: {
    valid: [exampleWorkflowSelectState, exampleRiskGateState, exampleCostRouteState],
    invalid: [{ pack: 'unknown@1' }],
  },
  JevResult: {
    valid: [
      {
        kind: 'choice',
        selected: 'cloud-single',
        probs: { 'cloud-single': 0.7, 'local-single': 0.3 },
      },
      { kind: 'score', score: 3, probs: [0.05, 0.1, 0.15, 0.5, 0.2] },
      { kind: 'noul', answer: 'unknown', pYes: 0.5 },
    ],
    invalid: [
      { kind: 'score', score: 5 },
      { kind: 'noul', answer: 'yes', pYes: 1.2 },
      { kind: 'score', score: 2, probs: [0.5, 0.5] },
    ],
  },
  DecisionRecord: {
    valid: [decision, { ...decision, taskId: null, pack: 'risk_gate@2' }],
    invalid: [
      { ...decision, reasons: ['Bad Label'] },
      { ...decision, ts: 'now' },
    ],
  },

  // events
  StateChangedEvent: {
    valid: [{ ...env, type: 'state_changed', from: null, to: 'queued' }],
    invalid: [{ ...env, type: 'state_changed', from: 'queued', to: 'paused' }],
  },
  TextDeltaEvent: {
    valid: [{ ...env, type: 'text_delta', messageId: 'm1', delta: 'Hel' }],
    invalid: [{ ...env, type: 'text_delta', delta: 'Hel' }],
  },
  ToolCallStartedEvent: {
    valid: [{ ...env, type: 'tool_call_started', call: toolCall }],
    invalid: [{ ...env, type: 'tool_call_started' }],
  },
  ToolCallFinishedEvent: {
    valid: [{ ...env, type: 'tool_call_finished', result: blockedResult }],
    invalid: [{ ...env, type: 'tool_call_finished', result: {} }],
  },
  EditProposedEvent: {
    valid: [{ ...env, type: 'edit_proposed', proposal, files: [fileMeta] }],
    invalid: [{ ...env, type: 'edit_proposed', proposal: { ...proposal, files: [] } }],
  },
  ApprovalRequiredEvent: {
    valid: [
      {
        ...env,
        type: 'approval_required',
        approvalId: 'appr-1',
        call: toolCall,
        outcome: 'confirm',
        reasons: ['jev_uncertain'],
        decisionId: 'dec-1',
      },
    ],
    invalid: [
      {
        ...env,
        type: 'approval_required',
        approvalId: 'appr-1',
        call: toolCall,
        outcome: 'block',
        reasons: [],
      },
    ],
  },
  DecisionMadeEvent: {
    valid: [{ ...env, type: 'decision_made', decision }],
    invalid: [{ ...env, type: 'decision_made', decision: { id: 'x' } }],
  },
  UsageEvent: {
    valid: [{ ...env, type: 'usage', modelId: 'claude-strong', usage }],
    invalid: [{ ...env, type: 'usage', usage }],
  },
  ErrorEvent: {
    valid: [
      {
        ...env,
        type: 'error',
        kind: 'rate_limit',
        message: '429',
        retryable: true,
        retryAfterMs: 2000,
      },
      { ...env, type: 'error', kind: 'budget_exceeded', message: 'maxIterations' },
    ],
    invalid: [{ ...env, type: 'error', kind: '', message: 'x' }],
  },
  TaskEvent: {
    valid: [{ ...env, type: 'state_changed', from: 'running', to: 'done', futureField: 1 }],
    invalid: [
      { ...env, type: 'future_event' },
      { type: 'text_delta', delta: 'x' },
    ],
  },
  LogNotification: {
    valid: [{ level: 'info', message: 'orchestrator ready', ts }],
    invalid: [{ level: 'trace', message: 'x', ts }],
  },

  // methods
  'initialize.params': {
    valid: [
      {
        protocolVersion: '1.0.0',
        client: { name: 'desiide-ai', version: '0.1.0' },
        workspaceRoots: ['/Users/dev/project'],
      },
    ],
    invalid: [
      {
        protocolVersion: '1',
        client: { name: 'desiide-ai', version: '0.1.0' },
        workspaceRoots: [],
      },
    ],
  },
  'initialize.result': {
    valid: [
      { protocolVersion: '1.0.0', server: { name: 'desiide-orchestrator', version: '0.1.0' } },
    ],
    invalid: [{ protocolVersion: 'x', server: {} }],
  },
  'task.create.params': { valid: [taskInput], invalid: [{ ...taskInput, kind: 'deploy' }] },
  'task.create.result': { valid: [{ task: taskSummary }], invalid: [{ task: {} }] },
  'task.cancel.params': {
    valid: [{ taskId: 'task-1' }],
    invalid: [{ taskId: 'task-1', force: true }],
  },
  'task.cancel.result': { valid: [{ cancelled: true }], invalid: [{}] },
  'task.list.params': { valid: [{}], invalid: [{ state: 'running' }] },
  'task.list.result': { valid: [{ tasks: [taskSummary] }], invalid: [{ tasks: [{}] }] },
  'task.approve.params': {
    valid: [{ taskId: 'task-1', approvalId: 'appr-1', scope: 'task' }],
    invalid: [{ taskId: 'task-1', approvalId: 'appr-1', scope: 'forever' }],
  },
  'task.approve.result': { valid: [{ ok: true }], invalid: [{ ok: false }] },
  'task.reject.params': {
    valid: [{ taskId: 'task-1', approvalId: 'appr-1', reason: 'too risky' }],
    invalid: [{ taskId: 'task-1' }],
  },
  'task.reject.result': { valid: [{ ok: true }], invalid: [{}] },
  'edits.report.params': {
    valid: [
      {
        taskId: 'task-1',
        proposalId: 'prop-1',
        files: [
          { path: 'src/a.ts', status: 'applied' },
          { path: 'src/b.ts', status: 'rejected', reason: 'not needed' },
        ],
      },
    ],
    invalid: [{ taskId: 'task-1', proposalId: 'prop-1', files: [] }],
  },
  'edits.report.result': { valid: [{ ok: true }], invalid: [{ ok: 'yes' }] },
  'models.list.params': { valid: [{}, { discover: true }], invalid: [{ discover: 'yes' }] },
  'models.list.result': {
    valid: [
      { models: [modelInfo] },
      { models: [], discovered: [{ ...modelInfo, provider: 'ollama' }] },
    ],
    invalid: [{ models: [{ id: 'x' }] }],
  },
  'models.test.params': { valid: [{ modelId: 'claude-strong' }], invalid: [{}] },
  'models.test.result': {
    valid: [
      { ok: true, latencyMs: 350 },
      { ok: false, error: { kind: 'auth', message: '401', hint: 'Check your key in Settings' } },
    ],
    invalid: [{ ok: false, error: { kind: 'weird', message: 'x' } }],
  },
  'jev.test.params': { valid: [{}], invalid: [{ endpoint: 'x' }] },
  'jev.test.result': { valid: [{ ok: true, latencyMs: 90 }], invalid: [{ latencyMs: 90 }] },
  'jev.preview.params': { valid: [{ pack: 'risk_gate@1' }], invalid: [{ pack: 'risk_gate@9' }] },
  'jev.preview.result': {
    valid: [{ state: exampleRiskGateState }],
    invalid: [{ state: { ...exampleRiskGateState, fileContents: 'x' } }],
  },
  'decisions.list.params': {
    valid: [{}, { taskId: 'task-1', pack: 'risk_gate@1', outcome: 'block', limit: 20 }],
    invalid: [{ limit: 10_000 }],
  },
  'decisions.list.result': {
    valid: [{ decisions: [decision], nextCursor: 'abc' }],
    invalid: [{ decisions: [{}] }],
  },
  'decisions.replay.params': { valid: [{ id: 'dec-1' }], invalid: [{ id: '' }] },
  'decisions.replay.result': {
    valid: [
      { record: decision, rules: engineRun, differs: false },
      {
        record: decision,
        rules: engineRun,
        jev: { ...engineRun, engine: 'jev', result: { kind: 'noul', answer: 'yes', pYes: 0.9 } },
        differs: true,
      },
    ],
    invalid: [{ record: decision, differs: false }],
  },
  'config.update.params': {
    valid: [{ models: [modelConfig] }],
    invalid: [{ models: [{ ...modelConfig, apiKey: 'sk-raw' }] }],
  },
  'config.update.result': { valid: [{ ok: true }], invalid: [null] },
  'health.ping.params': { valid: [{}], invalid: [{ verbose: true }] },
  'health.ping.result': { valid: [{ ok: true, uptimeMs: 1200 }], invalid: [{ ok: true }] },
  'secrets.get.params': { valid: [{ ref: 'secret:anthropic' }], invalid: [{ ref: 'anthropic' }] },
  'secrets.get.result': {
    valid: [{ value: 'sk-test' }, { value: null }],
    invalid: [{}],
  },
};
