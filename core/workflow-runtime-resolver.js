import { selectValidationCommands } from './validation-selector.js';
import { resolvePollutionBoundary } from '../runner/pollution-boundary.js';

const RUNTIME_RESOLVER_VERSION = 1;
const WORKFLOW_MODES = new Set(['workflow', 'coding-workflow', 'chain', 'coordinator']);
const TASK_SCALES = new Set(['small', 'medium', 'large']);
const RISK_LEVELS = new Set(['low', 'medium', 'high']);
const LARGE_LOOP_PATTERN = /\b(cross-cutting|cross cutting|system-wide|end-to-end|e2e|integration|migration|schema|api contract|breaking change|multi-stage|multi agent|coordinator)\b|跨模块|跨边界|全链路|端到端|迁移|数据库|协议|多阶段|多 agent|多Agent|协调/i;
const CODING_PATTERN = /\b(fix|bug|feature|refactor|test|code|coding|implement|change|modify|patch|validation)\b|修复|代码|实现|改造|重构|测试|验证|变更/i;
const COORDINATOR_PATTERN = /\b(multi-agent|multi agent|coordinator|assign|role|capability)\b|多 agent|多Agent|协调|分配|角色|能力/i;
const CHAIN_PATTERN = /\b(chain|stage|multi-stage|pipeline|end-to-end|e2e|migration)\b|链路|阶段|多阶段|全链路|端到端|迁移/i;

export function resolveWorkflowRuntime(input = {}) {
  const normalized = normalizeInput(input);
  const validation = selectValidationCommands({
    changedFiles: normalized.changedFiles,
    targetFiles: normalized.targetFiles,
    task: normalized.task,
    workflow: normalized.workflow,
    cwd: normalized.cwd || normalized.workspacePath,
    packageScripts: normalized.packageScripts,
    packageJson: normalized.packageJson,
    packageManager: normalized.packageManager,
    profile: normalized.validationProfile
  });
  const workflowMode = selectWorkflowMode(normalized, validation);
  const closureMode = selectClosureMode(normalized, validation, workflowMode);
  const boundary = resolvePollutionBoundary({
    projectKey: normalized.projectKey,
    dbProfile: normalized.dbProfile,
    profile: normalized.profile,
    dbPath: normalized.dbPath,
    workspacePath: normalized.workspacePath,
    sessionId: normalized.sessionId,
    scope: normalized.scope,
    dataClass: normalized.dataClass,
    retention: normalized.retention,
    generatedBy: normalized.generatedBy || 'workflow-runtime-resolver',
    temporary: normalized.temporary,
    ephemeral: normalized.ephemeral,
    memoryLimit: normalized.memoryLimit,
    contextLimit: normalized.contextLimit,
    memory: normalized.memory,
    context: normalized.context
  });
  const warnings = buildWarnings(normalized, boundary, validation, workflowMode, closureMode);
  const runtimePolicy = buildRuntimePolicy({ normalized, boundary, validation, workflowMode, closureMode });

  return {
    version: RUNTIME_RESOLVER_VERSION,
    workflowMode,
    closureMode,
    boundary,
    validation,
    runtimePolicy,
    runnerOptions: buildRunnerOptions(normalized, boundary, validation, runtimePolicy),
    coordinatorOptions: buildCoordinatorOptions(normalized, boundary, runtimePolicy),
    chainOptions: buildChainOptions(normalized, boundary, runtimePolicy),
    createOptions: buildCreateOptions(normalized, boundary, validation, workflowMode, closureMode),
    recommendations: buildRecommendations({ normalized, boundary, validation, workflowMode, closureMode, runtimePolicy }),
    warnings
  };
}

function normalizeInput(input) {
  const value = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const workflowMode = normalizeWorkflowMode(value.workflowMode || value.mode);
  const taskScale = normalizeEnum(value.taskScale || value.scale, TASK_SCALES, 'taskScale');
  const riskLevel = normalizeEnum(value.riskLevel || value.risk, RISK_LEVELS, 'riskLevel');

  return {
    ...value,
    instruction: normalizeOptionalText(value.instruction),
    goal: normalizeOptionalText(value.goal),
    workflowMode,
    taskScale,
    riskLevel,
    workspacePath: normalizeOptionalText(value.workspacePath),
    projectKey: normalizeOptionalText(value.projectKey),
    sessionId: normalizeOptionalText(value.sessionId),
    dbProfile: normalizeOptionalText(value.dbProfile),
    profile: normalizeOptionalText(value.profile),
    dbPath: normalizeOptionalText(value.dbPath),
    scope: normalizeOptionalText(value.scope),
    dataClass: normalizeOptionalText(value.dataClass),
    retention: normalizeOptionalText(value.retention),
    generatedBy: normalizeOptionalText(value.generatedBy),
    cwd: normalizeOptionalText(value.cwd),
    packageManager: normalizeOptionalText(value.packageManager),
    validationProfile: normalizeOptionalText(value.validationProfile),
    runnerId: normalizeOptionalText(value.runnerId),
    ownerAgentId: normalizeOptionalText(value.ownerAgentId),
    preferredRole: normalizeOptionalText(value.preferredRole || value.requiredRole),
    assignmentStatus: normalizeOptionalText(value.assignmentStatus),
    changedFiles: normalizeStringArray(value.changedFiles),
    targetFiles: normalizeStringArray(value.targetFiles),
    agentPool: normalizeArray(value.agentPool),
    stageCount: normalizeOptionalPositiveInteger(value.stageCount),
    requiresCoordination: normalizeOptionalBoolean(value.requiresCoordination),
    temporary: value.temporary === true || value.ephemeral === true,
    ephemeral: value.ephemeral === true,
    memoryLimit: normalizeOptionalPositiveInteger(value.memoryLimit),
    contextLimit: normalizeOptionalPositiveInteger(value.contextLimit),
    memory: normalizeOptionalObject(value.memory),
    context: normalizeOptionalObject(value.context),
    packageScripts: normalizeOptionalPackageScripts(value.packageScripts),
    packageJson: normalizeOptionalObject(value.packageJson),
    task: normalizeOptionalObject(value.task),
    workflow: normalizeOptionalObject(value.workflow),
    leaseMs: normalizeOptionalPositiveInteger(value.leaseMs),
    maxTaskRetries: normalizeOptionalPositiveInteger(value.maxTaskRetries),
    taskExecutionTimeoutMs: normalizeOptionalPositiveInteger(value.taskExecutionTimeoutMs),
    timeoutSweepMaxExecutionMs: normalizeOptionalPositiveInteger(value.timeoutSweepMaxExecutionMs),
    timeoutSweepStalledMs: normalizeOptionalPositiveInteger(value.timeoutSweepStalledMs),
    timeoutSweepMaxAttempts: normalizeOptionalPositiveInteger(value.timeoutSweepMaxAttempts),
    timeoutSweepIntervalMs: normalizeOptionalPositiveInteger(value.timeoutSweepIntervalMs),
    timeoutSweepReason: normalizeOptionalText(value.timeoutSweepReason)
  };
}

function selectWorkflowMode(input, validation) {
  if (input.workflowMode) {
    return input.workflowMode;
  }

  const text = input.instruction || input.goal || '';
  if (input.requiresCoordination || input.agentPool.length > 1 || COORDINATOR_PATTERN.test(text)) {
    return 'coordinator';
  }

  if ((input.stageCount || 0) > 1 || input.taskScale === 'large' || input.riskLevel === 'high' || CHAIN_PATTERN.test(text)) {
    return 'chain';
  }

  if (input.changedFiles.length > 0 || input.targetFiles.length > 0 || hasPackageScripts(input) || validation.commands.length > 0 || CODING_PATTERN.test(text)) {
    return 'coding-workflow';
  }

  return 'workflow';
}

function selectClosureMode(input, validation, workflowMode) {
  const text = input.instruction || input.goal || '';
  const files = dedupeStrings([...input.changedFiles, ...input.targetFiles]);
  if (workflowMode === 'chain' || workflowMode === 'coordinator') {
    return 'large_loop';
  }
  if (input.taskScale === 'large' || input.riskLevel === 'high' || (input.stageCount || 0) > 1) {
    return 'large_loop';
  }
  if (/\brefactor\b|重构/.test(text.toLowerCase())) {
    return 'large_loop';
  }
  if (files.length >= 4 || validation.commands.length >= 3 || validation.warnings.length >= 2) {
    return 'large_loop';
  }
  if (LARGE_LOOP_PATTERN.test(text)) {
    return 'large_loop';
  }
  return 'small_loop';
}

function buildRuntimePolicy({ normalized, boundary, validation, workflowMode, closureMode }) {
  const verificationLevel = closureMode === 'large_loop' ? 'broad' : 'targeted';
  const docPolicy = closureMode === 'large_loop' ? 'required' : 'minimal';
  const cleanupPolicy = boundary.cleanupPolicy?.retention === 'keep' ? 'explicit_only' : 'defer';
  const recoveryPolicy = boundary.db?.recoverySelector && Object.keys(boundary.db.recoverySelector).length > 0 ? 'selector_required' : 'default_selector';

  return {
    workflowMode,
    closureMode,
    verificationLevel,
    validationCommandCount: validation.commands.length,
    docPolicy,
    cleanupPolicy,
    recoveryPolicy,
    dataClass: boundary.workflowHygieneMetadata?.dataClass || 'unknown',
    retention: boundary.workflowHygieneMetadata?.retention || 'unknown',
    temporary: boundary.temporary,
    dbScopeLabel: boundary.db?.dbScopeLabel || null,
    artifactCleanable: boundary.artifactPolicy?.cleanable === true,
    nextAction: selectNextAction(workflowMode),
    allowedNextCommands: selectAllowedNextCommands(workflowMode)
  };
}

function buildRunnerOptions(input, boundary, validation, runtimePolicy) {
  return removeNullish({
    dbPath: boundary.db?.dbPath,
    workflowId: normalizeOptionalText(input.workflowId),
    workspacePath: boundary.workspacePath,
    memory: boundary.memory,
    context: boundary.context,
    runnerId: input.runnerId,
    ownerAgentId: input.ownerAgentId,
    preferredRole: input.preferredRole,
    assignmentStatus: input.assignmentStatus,
    leaseMs: input.leaseMs,
    maxTaskRetries: input.maxTaskRetries,
    taskExecutionTimeoutMs: input.taskExecutionTimeoutMs,
    timeoutSweepMaxExecutionMs: input.timeoutSweepMaxExecutionMs,
    timeoutSweepStalledMs: input.timeoutSweepStalledMs,
    timeoutSweepMaxAttempts: input.timeoutSweepMaxAttempts,
    timeoutSweepIntervalMs: input.timeoutSweepIntervalMs,
    timeoutSweepReason: input.timeoutSweepReason,
    validationCommands: validation.commands,
    runtimePolicy
  });
}

function buildCoordinatorOptions(input, boundary, runtimePolicy) {
  return removeNullish({
    dbPath: boundary.db?.dbPath,
    workspacePath: boundary.workspacePath,
    memory: boundary.memory,
    context: boundary.context,
    workflowHygieneMetadata: boundary.workflowHygieneMetadata,
    agentId: normalizeOptionalText(input.agentId),
    runnerId: input.runnerId,
    ownerAgentId: input.ownerAgentId,
    preferredRole: input.preferredRole,
    maxTaskRetries: input.maxTaskRetries,
    taskExecutionTimeoutMs: input.taskExecutionTimeoutMs,
    runtimePolicy
  });
}

function buildChainOptions(input, boundary, runtimePolicy) {
  return removeNullish({
    dbPath: boundary.db?.dbPath,
    workspacePath: boundary.workspacePath,
    memory: boundary.memory,
    context: boundary.context,
    workflowHygieneMetadata: boundary.workflowHygieneMetadata,
    runnerId: input.runnerId,
    ownerAgentId: input.ownerAgentId,
    stageCount: input.stageCount,
    runtimePolicy
  });
}

function buildCreateOptions(input, boundary, validation, workflowMode, closureMode) {
  const metadata = {
    ...boundary.workflowHygieneMetadata,
    runtimeResolver: {
      version: RUNTIME_RESOLVER_VERSION,
      workflowMode,
      closureMode,
      validationProfile: validation.profile
    }
  };

  return removeNullish({
    instruction: input.instruction,
    goal: input.goal,
    workspacePath: boundary.workspacePath,
    dbPath: boundary.db?.dbPath,
    workflowHygieneMetadata: metadata,
    planMetadata: metadata,
    validationCommands: validation.commands
  });
}

function buildWarnings(input, boundary, validation, workflowMode, closureMode) {
  const warnings = [...validation.warnings];
  const dataClass = boundary.workflowHygieneMetadata?.dataClass;
  const retention = boundary.workflowHygieneMetadata?.retention;

  if ((dataClass === 'real' || retention === 'keep') && !input.dbProfile && !input.dbPath) {
    warnings.push('Real/keep workflow data should use dbProfile or explicit dbPath for recovery isolation.');
  }
  if (workflowMode === 'coordinator' && input.agentPool.length === 0 && !input.requiresCoordination) {
    warnings.push('Coordinator mode selected without agentPool; register or provide agents before assignment.');
  }
  if (closureMode === 'large_loop' && validation.commands.length === 0) {
    warnings.push('Large-loop workflow has no selected validation commands; provide changedFiles/packageScripts or explicit validation policy.');
  }
  if (!input.instruction && !input.goal) {
    warnings.push('No instruction or goal was provided; resolver can only use structural hints.');
  }

  return dedupeStrings(warnings);
}

function buildRecommendations({ boundary, validation, workflowMode, closureMode, runtimePolicy }) {
  const recommendations = [
    `Use ${workflowMode} for this request.`,
    `Treat execution as ${closureMode} with ${runtimePolicy.verificationLevel} verification.`,
    'Pass boundary.db.dbPath, boundary.memory, and boundary.context into runner/coordinator calls.',
    'Persist boundary.workflowHygieneMetadata into workflow plan metadata.'
  ];

  if (validation.commands.length > 0) {
    recommendations.push('Run selected validation commands after implementation or before final closure.');
  }
  if (boundary.db?.recoverySelector && Object.keys(boundary.db.recoverySelector).length > 0) {
    recommendations.push('Preserve boundary.db.recoverySelector when resuming in a new session.');
  }
  if (boundary.cleanupPolicy?.autoCleanCandidates?.length > 0) {
    recommendations.push('Audit autoCleanCandidates with data hygiene before deleting runtime artifacts.');
  }

  return recommendations;
}

function selectNextAction(workflowMode) {
  if (workflowMode === 'coding-workflow') {
    return 'create_coding_workflow';
  }
  if (workflowMode === 'chain') {
    return 'create_chain';
  }
  if (workflowMode === 'coordinator') {
    return 'register_or_assign_agent';
  }
  return 'create_workflow';
}

function selectAllowedNextCommands(workflowMode) {
  if (workflowMode === 'coding-workflow') {
    return ['create-coding-workflow', 'select-validation'];
  }
  if (workflowMode === 'chain') {
    return ['create-chain', 'run-next-stage'];
  }
  if (workflowMode === 'coordinator') {
    return ['register-agent', 'assign-next-work', 'run-next-assignment'];
  }
  return ['create-workflow'];
}

function normalizeWorkflowMode(value) {
  const text = normalizeOptionalText(value);
  if (!text) {
    return null;
  }
  const normalized = text.replace(/_/g, '-').toLowerCase();
  const aliases = {
    coding: 'coding-workflow',
    codingworkflow: 'coding-workflow',
    workflowchain: 'chain',
    multiagent: 'coordinator',
    'multi-agent': 'coordinator'
  };
  const mode = aliases[normalized] || normalized;
  if (!WORKFLOW_MODES.has(mode)) {
    throw new Error(`Unsupported workflowMode: ${value}`);
  }
  return mode;
}

function normalizeEnum(value, allowed, label) {
  const text = normalizeOptionalText(value)?.toLowerCase();
  if (!text) {
    return null;
  }
  if (!allowed.has(text)) {
    throw new Error(`Unsupported ${label}: ${value}`);
  }
  return text;
}

function normalizeOptionalText(value) {
  if (value == null || value === false) {
    return null;
  }
  const text = String(value).trim();
  return text || null;
}

function normalizeStringArray(value) {
  return dedupeStrings(normalizeArray(value).map((item) => normalizeOptionalText(item)).filter(Boolean));
}

function normalizeArray(value) {
  if (value == null || value === false) {
    return [];
  }
  if (Array.isArray(value)) {
    return value;
  }
  return [value];
}

function normalizeOptionalObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function normalizeOptionalPackageScripts(value) {
  if (value == null || value === false) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return normalizeStringArray(value);
  }
  if (typeof value === 'object') {
    return value;
  }
  throw new Error('packageScripts must be an object or array when provided.');
}

function normalizeOptionalBoolean(value) {
  if (value == null || value === '') {
    return undefined;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  const text = String(value).trim().toLowerCase();
  if (text === 'true' || text === '1' || text === 'yes') {
    return true;
  }
  if (text === 'false' || text === '0' || text === 'no') {
    return false;
  }
  throw new Error(`Expected boolean: ${value}`);
}

function normalizeOptionalPositiveInteger(value) {
  if (value == null || value === '') {
    return null;
  }
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`Expected positive integer: ${value}`);
  }
  return number;
}

function hasPackageScripts(input) {
  if (Array.isArray(input.packageScripts)) {
    return input.packageScripts.length > 0;
  }
  return input.packageScripts && typeof input.packageScripts === 'object' && Object.keys(input.packageScripts).length > 0;
}

function dedupeStrings(values) {
  return [...new Set(values.filter(Boolean))];
}

function removeNullish(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry != null));
}
