// 内部 API - 仅供高级用户使用
// 这些 API 可能会在未来版本中变更，使用时请谨慎

// 核心内部 API
export {
  createTaskSource,
  createFileTaskSource,
  createJsonTaskSource,
  normalizeTaskSourceResult
} from './core/task-source.js';

export {
  createCheckpointSink,
  createGitCheckpointSink,
  normalizeCheckpointSinkResult,
  resolveCheckpointSink
} from './core/checkpoint-sink.js';

export {
  createRuleProvider,
  createJsonlRuleProvider,
  normalizeRuleProviderResult,
  resolveRuleProvider
} from './core/rule-provider.js';

export {
  normalizeValidationCommand
} from './core/validation-selector.js';

export {
  resolveWorkflowRuntime
} from './core/workflow-runtime-resolver.js';

export {
  addTask,
  addTasksFromPlan,
  linkDependency,
  advanceTaskStatus,
  addTaskOutput,
  listTaskOutputs,
  listWorkflowReruns,
  listTaskRevisions,
  listDescendantTaskIds,
  listPredecessorTaskOutputs,
  restartFromTask,
  claimNextReadyTask,
  peekNextReadyTask,
  heartbeatTaskLease,
  releaseExpiredTaskLeases,
  sweepTimedOutTasks,
  getNextTask
} from './core/workflow-engine.js';

// Runner 内部 API
export {
  createPassThroughVerifier,
  createValidationCommandsVerifier,
  normalizeVerifierResult
} from './runner/verifier.js';

export {
  normalizeAdapterResult
} from './runner/agent-adapter.js';

export {
  createWorkflowTaskSourceRef,
  createWorkflowAssignmentSourceRef,
  createChainStageSourceRef
} from './runner/memory-system.js';
export {
  resolvePollutionBoundary
} from './runner/pollution-boundary.js';

export {
  POLLUTION_POLICY_VERSION,
  POLLUTION_POLICY_LAYERS,
  listPollutionPolicyLayers,
  getPollutionPolicyLayer
} from './runner/pollution-policy.js';

export {
  getDb,
  normalizeWorkspacePath,
  resolveDbPath
} from './storage/db.js';
