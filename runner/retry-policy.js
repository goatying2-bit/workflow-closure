const DEFAULT_MAX_TASK_RETRIES = 1;
const DEFAULT_TRANSIENT_RECOVERY_COOLDOWN_MS = 30_000;
const MAX_TRANSIENT_RECOVERY_COOLDOWN_MS = 5 * 60_000;

export const FAILURE_TYPES = Object.freeze({
  transient: 'transient',
  executionError: 'execution-error',
  validationFailed: 'validation-failed',
  timeout: 'timeout',
  stalled: 'stalled',
  fatal: 'fatal',
  ambiguous: 'ambiguous'
});

export const RETRY_ACTIONS = Object.freeze({
  retryTask: 'retry-task',
  blockTask: 'block-task',
  createRepairEvidence: 'create-repair-evidence',
  escalate: 'escalate'
});

export function normalizeRetryPolicy(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  return {
    maxTaskRetries: normalizeNonNegativeInteger(source.maxTaskRetries, DEFAULT_MAX_TASK_RETRIES),
    retryExecutionErrors: source.retryExecutionErrors !== false,
    retryTimeouts: source.retryTimeouts !== false,
    retryStalledTasks: source.retryStalledTasks !== false,
    retryValidationFailures: source.retryValidationFailures === true
  };
}

export function classifyExecutionFailure({ error, task, policy } = {}) {
  const normalizedPolicy = normalizeRetryPolicy(policy);
  const errorMessage = error instanceof Error ? error.message : String(error || 'Task execution failed.');
  const failureType = inferExecutionFailureType(error);
  const decision = decideRetryAction({
    failureType,
    task,
    policy: normalizedPolicy
  });

  return buildClassifiedFailure({
    task,
    error: errorMessage,
    failureType,
    decision,
    reasonCode: decision.retryable ? 'runner_execution_retry' : 'runner_execution_failed',
    retryAction: 'task_retry_scheduled_by_runner',
    blockAction: 'task_runner_error',
    retryMessage: `Runner scheduled retry for task "${task?.title || 'unknown-task'}" after execution error.`,
    blockMessage: `Runner failed while executing task "${task?.title || 'unknown-task'}".`,
    policy: normalizedPolicy
  });
}

export function classifyVerifierFailure({ task, verifierResult, policy } = {}) {
  const normalizedPolicy = normalizeRetryPolicy(policy);
  const message = normalizeVerifierFailureMessage(verifierResult);
  const decision = decideRetryAction({
    failureType: FAILURE_TYPES.validationFailed,
    task,
    policy: normalizedPolicy
  });

  return buildClassifiedFailure({
    task,
    error: message,
    failureType: FAILURE_TYPES.validationFailed,
    decision,
    reasonCode: 'runner_validation_failed',
    retryAction: 'task_retry_scheduled_by_runner',
    blockAction: 'task_verification_failed',
    retryMessage: `Runner scheduled retry for task "${task?.title || 'unknown-task'}" after verifier failure.`,
    blockMessage: `Runner blocked task "${task?.title || 'unknown-task'}" after verifier failure.`,
    policy: normalizedPolicy,
    extraRecovery: {
      verifierStatus: verifierResult?.status || null,
      verifierReason: verifierResult?.reason || null
    }
  });
}

export function classifyTimeoutFailure({ task, timeoutKind, timeoutMs, policy, maxAttempts } = {}) {
  const normalizedPolicy = normalizeRetryPolicy(policy);
  const normalizedMaxAttempts = normalizeNonNegativeInteger(maxAttempts, null);
  const failureType = timeoutKind === FAILURE_TYPES.stalled ? FAILURE_TYPES.stalled : FAILURE_TYPES.timeout;
  const decision = decideRetryAction({
    failureType,
    task,
    policy: normalizedPolicy,
    maxAttempts: normalizedMaxAttempts
  });
  const reasonCode = failureType === FAILURE_TYPES.stalled
    ? 'runner_execution_stalled'
    : 'runner_execution_timeout';
  const label = failureType === FAILURE_TYPES.stalled ? 'stalled' : 'timed out';
  const suffix = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
    ? ` after ${Math.floor(Number(timeoutMs))}ms`
    : '';
  const error = `Task execution ${label}${suffix}.`;

  return buildClassifiedFailure({
    task,
    error,
    failureType,
    decision,
    reasonCode,
    retryAction: failureType === FAILURE_TYPES.stalled
      ? 'task_stalled_retry_scheduled_by_runner'
      : 'task_timeout_retry_scheduled_by_runner',
    blockAction: failureType === FAILURE_TYPES.stalled
      ? 'task_stalled_by_runner'
      : 'task_timeout_by_runner',
    retryMessage: `Runner scheduled retry for task "${task?.title || 'unknown-task'}" after execution ${label}.`,
    blockMessage: `Runner blocked task "${task?.title || 'unknown-task'}" after execution ${label}.`,
    policy: normalizedPolicy,
    extraRecovery: {
      timeoutMs: Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0 ? Math.floor(Number(timeoutMs)) : null,
      maxAttempts: normalizedMaxAttempts
    }
  });
}

export function decideRetryAction({ failureType, task, policy, maxAttempts } = {}) {
  const normalizedPolicy = normalizeRetryPolicy(policy);
  const attemptCount = normalizeAttemptCount(task?.attemptCount);
  const timeoutAttemptLimit = (failureType === FAILURE_TYPES.timeout || failureType === FAILURE_TYPES.stalled)
    ? normalizeNonNegativeInteger(maxAttempts, null)
    : null;
  const canRetry = timeoutAttemptLimit != null
    ? attemptCount < timeoutAttemptLimit
    : attemptCount <= normalizedPolicy.maxTaskRetries;

  if (!canRetry) {
    return {
      action: RETRY_ACTIONS.blockTask,
      retryable: false,
      nextStatus: 'blocked',
      attemptCount,
      maxTaskRetries: normalizedPolicy.maxTaskRetries,
      maxAttempts: timeoutAttemptLimit
    };
  }

  if (failureType === FAILURE_TYPES.validationFailed && !normalizedPolicy.retryValidationFailures) {
    return {
      action: RETRY_ACTIONS.createRepairEvidence,
      retryable: false,
      nextStatus: 'blocked',
      attemptCount,
      maxTaskRetries: normalizedPolicy.maxTaskRetries,
      maxAttempts: timeoutAttemptLimit
    };
  }

  if (failureType === FAILURE_TYPES.timeout && !normalizedPolicy.retryTimeouts) {
    return nonRetryableDecision(attemptCount, normalizedPolicy.maxTaskRetries, timeoutAttemptLimit);
  }

  if (failureType === FAILURE_TYPES.stalled && !normalizedPolicy.retryStalledTasks) {
    return nonRetryableDecision(attemptCount, normalizedPolicy.maxTaskRetries, timeoutAttemptLimit);
  }

  if (failureType === FAILURE_TYPES.executionError && !normalizedPolicy.retryExecutionErrors) {
    return nonRetryableDecision(attemptCount, normalizedPolicy.maxTaskRetries, timeoutAttemptLimit);
  }

  if (failureType === FAILURE_TYPES.fatal) {
    return nonRetryableDecision(attemptCount, normalizedPolicy.maxTaskRetries, timeoutAttemptLimit);
  }

  return {
    action: RETRY_ACTIONS.retryTask,
    retryable: true,
    nextStatus: 'ready',
    attemptCount,
    maxTaskRetries: normalizedPolicy.maxTaskRetries,
    maxAttempts: timeoutAttemptLimit
  };
}

export function buildFailureRecoveryMetadata(input = {}) {
  const extra = normalizeObject(input.extra);
  return {
    recoveryClass: input.recoveryClass || extra.recoveryClass || null,
    recoverySource: input.recoverySource || extra.recoverySource || null,
    cooldownMs: input.cooldownMs ?? extra.cooldownMs ?? null,
    recoveryRecordedAt: input.recoveryRecordedAt || extra.recoveryRecordedAt || null,
    nextEligibleRetryAt: input.nextEligibleRetryAt || extra.nextEligibleRetryAt || null,
    retryBudget: normalizeObject(input.retryBudget) || normalizeObject(extra.retryBudget) || null,
    ...extra,
    reasonCode: input.reasonCode || null,
    retryable: Boolean(input.retryable),
    retryAction: input.retryAction || extra.retryAction || null,
    failureType: input.failureType || FAILURE_TYPES.ambiguous,
    trustState: 'failed',
    recoveryOnly: true,
    attemptCount: normalizeAttemptCount(input.attemptCount),
    maxTaskRetries: normalizeNonNegativeInteger(input.maxTaskRetries, DEFAULT_MAX_TASK_RETRIES),
    maxAttempts: normalizeNonNegativeInteger(input.maxAttempts, null),
    error: input.error || null
  };
}

function buildClassifiedFailure({ task, error, failureType, decision, reasonCode, retryAction, blockAction, retryMessage, blockMessage, policy, extraRecovery } = {}) {
  const retryable = decision?.retryable === true;
  return {
    error,
    retryable,
    nextStatus: retryable ? 'ready' : 'blocked',
    retryAction: decision?.action || null,
    action: retryable ? retryAction : blockAction,
    message: retryable ? retryMessage : blockMessage,
    recovery: buildFailureRecoveryMetadata(buildRecoveryContext({
      task,
      error,
      failureType,
      decision,
      reasonCode,
      policy,
      extraRecovery
    }))
  };
}

function buildRecoveryContext({ task, error, failureType, decision, reasonCode, policy, extraRecovery } = {}) {
  const attemptCount = decision?.attemptCount ?? task?.attemptCount;
  const recoveryClass = failureType === FAILURE_TYPES.transient
    ? 'transient_upstream'
    : null;
  const cooldownMs = recoveryClass ? computeTransientRecoveryCooldownMs(attemptCount) : null;
  const recordedAt = recoveryClass ? new Date().toISOString() : null;
  const nextEligibleRetryAt = recordedAt && cooldownMs != null
    ? new Date(Date.parse(recordedAt) + cooldownMs).toISOString()
    : null;

  return {
    reasonCode,
    retryable: decision?.retryable === true,
    retryAction: decision?.action || null,
    failureType,
    attemptCount,
    maxTaskRetries: policy?.maxTaskRetries,
    maxAttempts: decision?.maxAttempts,
    error,
    extra: {
      recoveryClass,
      recoverySource: recoveryClass ? 'claude_runtime' : null,
      cooldownMs,
      recoveryRecordedAt: recordedAt,
      nextEligibleRetryAt,
      retryBudget: buildRetryBudgetSnapshot({
        attemptCount,
        maxTaskRetries: policy?.maxTaskRetries,
        maxAttempts: decision?.maxAttempts
      }),
      ...normalizeObject(extraRecovery)
    }
  };
}

function buildRetryBudgetSnapshot({ attemptCount, maxTaskRetries, maxAttempts } = {}) {
  const normalizedAttemptCount = normalizeAttemptCount(attemptCount);
  const normalizedMaxTaskRetries = normalizeNonNegativeInteger(maxTaskRetries, DEFAULT_MAX_TASK_RETRIES);
  const normalizedMaxAttempts = normalizeNonNegativeInteger(maxAttempts, null);
  const limit = normalizedMaxAttempts ?? normalizedMaxTaskRetries;

  return {
    attemptCount: normalizedAttemptCount,
    maxTaskRetries: normalizedMaxTaskRetries,
    maxAttempts: normalizedMaxAttempts,
    remainingRetries: Math.max(limit - normalizedAttemptCount, 0)
  };
}

function computeTransientRecoveryCooldownMs(attemptCount) {
  const normalizedAttemptCount = normalizeAttemptCount(attemptCount);
  return Math.min(
    DEFAULT_TRANSIENT_RECOVERY_COOLDOWN_MS * Math.pow(2, Math.max(normalizedAttemptCount, 0)),
    MAX_TRANSIENT_RECOVERY_COOLDOWN_MS
  );
}

function inferExecutionFailureType(error) {
  if (error?.failureType && Object.values(FAILURE_TYPES).includes(error.failureType)) {
    return error.failureType;
  }

  if (error?.fatal === true) {
    return FAILURE_TYPES.fatal;
  }

  return FAILURE_TYPES.executionError;
}

function normalizeVerifierFailureMessage(verifierResult) {
  if (verifierResult?.reason) {
    return String(verifierResult.reason);
  }

  if (Array.isArray(verifierResult?.errors) && verifierResult.errors.length > 0) {
    return verifierResult.errors.map((item) => String(item)).join('; ');
  }

  return 'Task verifier failed.';
}

function nonRetryableDecision(attemptCount, maxTaskRetries, maxAttempts = null) {
  return {
    action: RETRY_ACTIONS.blockTask,
    retryable: false,
    nextStatus: 'blocked',
    attemptCount,
    maxTaskRetries,
    maxAttempts
  };
}

function normalizeAttemptCount(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function normalizeNonNegativeInteger(value, fallback) {
  if (value == null) {
    return fallback;
  }

  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    return fallback;
  }

  return Math.floor(number);
}

function normalizeObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return value;
}
