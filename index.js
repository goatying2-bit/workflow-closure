// ============================================
// 公共 API - 稳定版本，推荐所有用户使用
// ============================================

// 核心工作流引擎 API
export {
  createWorkflowEngine,
  createWorkflowFromInstruction,
  createWorkflowFromTaskSource,
  createWorkflowDefinition,
  getWorkflowDefinition,
  listWorkflowDefinitions,
  createWorkflowFromDefinition,
  listWorkflows,
  getWorkflowState,
  peekNextReadyTask
} from './core/workflow-engine.js';

// 编码计划 API
export {
  draftCodingPlan
} from './core/coding-planner.js';

export {
  selectValidationCommands
} from './core/validation-selector.js';

export {
  resolveWorkflowRuntime
} from './core/workflow-runtime-resolver.js';

export {
  createTaskSource,
  createFileTaskSource,
  createJsonTaskSource
} from './core/task-source.js';

export {
  createRuleProvider,
  createJsonlRuleProvider
} from './core/rule-provider.js';

// 工作流计划 API
export {
  draftInitialPlan
} from './core/workflow-engine.js';

// 工作流执行 API
export {
  createWorkflowRunner
} from './runner/workflow-runner.js';

export {
  createWorkflowWorkerPool
} from './runner/worker-pool.js';

export {
  createAgentWorkflowWrapper
} from './runner/workflow-wrapper.js';

export {
  buildTaskPrompt
} from './runner/prompt-builder.js';

// 工作流链 API
export {
  createAgentWorkflowChain
} from './runner/workflow-chain.js';

// 多Agent协调 API
export {
  createMultiAgentCoordinator
} from './runner/multi-agent-coordinator.js';

export {
  buildCoordinatorSummary,
  buildCoordinatorStateView,
  buildSharedRuntimeOptions,
  buildCoordinatorRuntimeOptions,
  buildCoordinatorStateInput,
  buildCoordinatorAssignmentInput,
  buildCoordinatorExecutionInput,
  buildCoordinatorResumeInput,
  getAllowedNextCommandsForCoordinatorResult,
  getAllowedNextCommandsForCoordinatorState,
  inferNextActionFromCoordinatorResult,
  inferNextActionFromCoordinatorState
} from './runner/coordinator-ops.js';

// 验证器 API
export {
  createVerifier,
  createTaskBoundaryVerifier,
  createCompositeVerifier,
  createNodeTestVerifier,
  createBashCommandVerifier,
  createValidationCommandsVerifier
} from './runner/verifier.js';

// 适配器 API
export {
  createAgentAdapter
} from './runner/agent-adapter.js';

export {
  createSubprocessAdapter
} from './runner/subprocess-adapter.js';

export {
  createClaudeCodeAdapter
} from './runner/claude-code-adapter.js';

export {
  createAnthropicMessagesAdapter
} from './runner/anthropic-messages-adapter.js';

export {
  createOpenAIChatCompletionsAdapter
} from './runner/openai-chat-adapter.js';

export {
  resolvePollutionBoundary
} from './runner/pollution-boundary.js';

// Checkpoint API
export {
  createCheckpointSink,
  createGitCheckpointSink
} from './core/checkpoint-sink.js';

// 上下文系统 API
export {
  createAgentContextSystem
} from './runner/context-system.js';

// 内存系统 API
export {
  createAgentMemorySystem
} from './runner/memory-system.js';

// 存储初始化 API（仅用于高级用户）
export {
  initializeWorkflowStore,
  getWorkflowStore
} from './storage/workflows.js';
export {
  initializeChainStore,
  getChainStore
} from './storage/chains.js';
export {
  initializeAgentStore,
  getAgentStore
} from './storage/agents.js';
export {
  initializeContextStore,
  getContextStore
} from './storage/contexts.js';
export {
  initializeMemoryStore,
  getMemoryStore
} from './storage/memories.js';

// ============================================
// 内部 API 说明
// ============================================
// 如需访问内部 API，请使用以下导入方式：
// import { ... } from 'workflow-closure/internal.js'
//
// 注意：内部 API 可能会在未来版本中变更，使用时请谨慎
// 建议仅在必要时使用，并关注版本更新日志
