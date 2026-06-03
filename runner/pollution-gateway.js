import { HYGIENE_LABELS } from './context-hygiene.js';

const UPSTREAM_DIAGNOSTIC_SUMMARY = 'Raw Claude/upstream transient diagnostics were quarantined before persistence.';
const UPSTREAM_ERROR_SUMMARY = 'Claude upstream 502/upstream_error; treated as transient runtime failure. Raw adapter payload quarantined from task outputs/context/memory.';

export function sanitizeAdapterPayloadForPersistence(payload, context = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return payload ?? null;
  }

  if (!isTransientUpstreamDiagnostic({ ...context, payload })) {
    return payload;
  }

  const recovery = context.classifiedFailure?.recovery || context.recovery || null;
  const diagnosticFields = pickDiagnosticPayloadFields(payload);
  return pruneNullish({
    quarantined: true,
    hygieneLabel: HYGIENE_LABELS.quarantined,
    adapter: payload.adapter,
    command: payload.command,
    cwd: payload.cwd,
    exitCode: payload.exitCode,
    timedOut: payload.timedOut,
    reasonCode: recovery?.reasonCode || context.reasonCode || payload.reasonCode,
    failureType: context.error?.failureType || payload.failureType,
    transientReason: recovery?.transientReason || recovery?.reason || payload.transientReason,
    errorKind: payload.errorKind || payload.error || payload.kind,
    promptHasExecutionContext: diagnosticFields?.promptHasExecutionContext,
    contextHasExecutionTools: diagnosticFields?.contextHasExecutionTools,
    promptHasToolsContext: diagnosticFields?.promptHasToolsContext,
    contextHasExecutionMemory: diagnosticFields?.contextHasExecutionMemory,
    summary: UPSTREAM_DIAGNOSTIC_SUMMARY
  });
}

export function sanitizeExecutionErrorForPersistence(error, context = {}) {
  const classifiedFailure = context.classifiedFailure || context;
  if (!isTransientUpstreamDiagnostic({ error, classifiedFailure, payload: context.adapterPayload })) {
    return classifiedFailure.error || (error instanceof Error ? error.message : String(error || 'Runner execution failed.'));
  }

  return UPSTREAM_ERROR_SUMMARY;
}

export function sanitizeRecoveryForPersistence(recovery, context = {}) {
  if (!recovery || typeof recovery !== 'object' || Array.isArray(recovery)) {
    return recovery ?? null;
  }

  const adapterPayload = context.adapterPayload || null;
  if (!adapterPayload?.quarantined) {
    return recovery;
  }

  const sanitizedError = sanitizeDiagnosticText(context.error || recovery.error || null);
  return {
    ...sanitizeKnownRawDiagnosticObject(recovery),
    error: sanitizedError,
    extra: {
      ...(sanitizeKnownRawDiagnosticObject(recovery.extra) || {}),
      adapterPayload,
      rawAdapterPayloadQuarantined: true
    }
  };
}

export function getPersistentAdapterPayload(input = {}) {
  return sanitizeAdapterPayloadForPersistence(input.result?.payload ?? null, input);
}

export function sanitizeTaskOutputSpecsForPersistence(outputs, context = {}) {
  if (!Array.isArray(outputs)) {
    return outputs;
  }

  if (!isTransientUpstreamDiagnostic(context) && !outputs.some((output) => isTransientTaskOutputDiagnostic(output))) {
    return outputs;
  }

  return outputs.map((output) => sanitizeTaskOutputSpec(output));
}

export function sanitizeRunLogPayloadForPersistence(payload, context = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return payload ?? null;
  }

  if (!containsRawUpstreamDiagnostic(payload) && !isTransientUpstreamDiagnostic({ ...context, payload })) {
    return payload;
  }

  return sanitizeKnownRawDiagnosticObject(payload);
}

export function sanitizeCheckpointInputForPersistence(input, context = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return input ?? null;
  }

  if (!isTransientUpstreamDiagnostic({ ...context, payload: input.adapterPayload || input.result?.payload })) {
    return input;
  }

  return {
    ...input,
    result: input.result && typeof input.result === 'object' && !Array.isArray(input.result)
      ? {
          ...input.result,
          payload: sanitizeAdapterPayloadForPersistence(input.result.payload, context),
          blockedReason: sanitizeDiagnosticText(input.result.blockedReason),
          message: sanitizeDiagnosticText(input.result.message)
        }
      : input.result,
    error: sanitizeDiagnosticText(input.error),
    adapterPayload: sanitizeAdapterPayloadForPersistence(input.adapterPayload, context),
    recovery: sanitizeRecoveryForPersistence(input.recovery, {
      ...context,
      error: sanitizeDiagnosticText(input.error),
      adapterPayload: sanitizeAdapterPayloadForPersistence(input.adapterPayload, context)
    })
  };
}

export function sanitizeLifecycleInputForPersistence(input, context = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return input ?? null;
  }

  const adapterPayload = sanitizeAdapterPayloadForPersistence(input.result?.payload ?? null, context);
  return {
    ...input,
    result: input.result && typeof input.result === 'object' && !Array.isArray(input.result)
      ? { ...input.result, payload: adapterPayload }
      : input.result,
    error: sanitizeDiagnosticText(input.error)
  };
}

export function isTransientUpstreamDiagnostic(input = {}) {
  const diagnosticPayload = pickDiagnosticPayloadFields(input.payload);
  const text = [
    input.classifiedFailure?.error,
    input.error instanceof Error ? input.error.message : input.error,
    diagnosticPayload ? safeJson(diagnosticPayload) : null
  ].filter(Boolean).join(' ').toLowerCase();

  return text.includes('api error: 502')
    || text.includes('upstream_error')
    || text.includes('upstream request failed');
}

function isTransientTaskOutputDiagnostic(output) {
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    return false;
  }

  return containsRawUpstreamDiagnostic(output.content) || containsRawUpstreamDiagnostic(output.metadata);
}

function sanitizeTaskOutputSpec(output) {
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    return output;
  }

  return {
    ...output,
    content: sanitizeDiagnosticText(output.content),
    metadata: sanitizeKnownRawDiagnosticObject(output.metadata)
  };
}

function sanitizeKnownRawDiagnosticObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value ?? null;
  }

  const next = Array.isArray(value) ? [] : {};
  for (const [key, entry] of Object.entries(value)) {
    if (['stdout', 'stderr', 'transformedStdout', 'args'].includes(key) && containsRawUpstreamDiagnostic(entry)) {
      next[key] = UPSTREAM_DIAGNOSTIC_SUMMARY;
      continue;
    }

    if (typeof entry === 'string') {
      next[key] = sanitizeDiagnosticText(entry);
      continue;
    }

    next[key] = entry && typeof entry === 'object' && !Array.isArray(entry)
      ? sanitizeKnownRawDiagnosticObject(entry)
      : entry;
  }

  return next;
}

function sanitizeDiagnosticText(value) {
  if (typeof value !== 'string') {
    return value ?? null;
  }

  return containsRawUpstreamDiagnostic(value)
    ? value
      .replace(/API Error:\s*502/gi, 'Claude upstream 502')
      .replace(/\{\s*"error"\s*:\s*\{[^\n]*?"type"\s*:\s*"upstream_error"\s*}\s*}/gi, 'upstream_error')
      .replace(/Upstream request failed(?: repeatedly)?/gi, 'upstream request failed')
    : value;
}

function containsRawUpstreamDiagnostic(value) {
  const text = typeof value === 'string' ? value : safeJson(value);
  const lower = text.toLowerCase();
  return lower.includes('api error: 502')
    || lower.includes('upstream request failed');
}

function pickDiagnosticPayloadFields(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }

  return pruneNullish({
    error: payload.error,
    errorKind: payload.errorKind,
    kind: payload.kind,
    failureType: payload.failureType,
    transientReason: payload.transientReason,
    stdout: payload.stdout,
    stderr: payload.stderr,
    transformedStdout: payload.transformedStdout,
    result: payload.result,
    message: payload.message,
    promptHasExecutionContext: payload.promptHasExecutionContext,
    contextHasExecutionTools: payload.contextHasExecutionTools,
    promptHasToolsContext: payload.promptHasToolsContext,
    contextHasExecutionMemory: payload.contextHasExecutionMemory,
    process: payload.process && typeof payload.process === 'object' && !Array.isArray(payload.process)
      ? {
          stdout: payload.process.stdout,
          stderr: payload.process.stderr,
          exitCode: payload.process.exitCode,
          timedOut: payload.process.timedOut
        }
      : null
  });
}

function pruneNullish(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry != null && entry !== ''));
}

function safeJson(value) {
  return value == null ? 'null' : JSON.stringify(value);
}
