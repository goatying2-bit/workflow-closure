import { createWorkflowTaskSourceRef } from './memory-system.js';

export function resolveResultHandoff(result) {
  if (!result || typeof result !== 'object') {
    return null;
  }

  return result.handoff
    ?? result.payload?.handoff
    ?? result.payload?.workerPayload?.handoff
    ?? null;
}

export function mergeTaskHandoff(existing, incoming, task, result) {
  const previous = normalizeStructuredHandoff(existing);
  const next = normalizeStructuredHandoff(incoming);
  const fallbackSummary = normalizeOptionalText(next?.summary)
    || normalizeOptionalText(result?.blockedReason)
    || normalizeOptionalText(result?.doneSummary)
    || normalizeOptionalText(previous?.summary)
    || normalizeOptionalText(task?.blockedReason)
    || normalizeOptionalText(task?.doneSummary)
    || normalizeOptionalText(task?.title);

  if (!previous && !next && !fallbackSummary) {
    return null;
  }

  return normalizeStructuredHandoff({
    summary: fallbackSummary,
    artifacts: mergeStringArrays(previous?.artifacts, next?.artifacts),
    decisions: mergeStringArrays(previous?.decisions, next?.decisions),
    openQuestions: mergeStringArrays(previous?.openQuestions, next?.openQuestions),
    risks: mergeStringArrays(previous?.risks, next?.risks),
    recommendedNextRole: normalizeOptionalText(next?.recommendedNextRole)
      || normalizeOptionalText(previous?.recommendedNextRole)
      || null,
    sourceRef: normalizeOptionalText(next?.sourceRef)
      || normalizeOptionalText(previous?.sourceRef)
      || (task?.workflowId && task?.taskId ? createWorkflowTaskSourceRef(task.workflowId, task.taskId) : null)
  });
}

export function buildTaskOutputSpecs(result, context = {}) {
  const outputs = buildTaskOutputs(result, context);
  return outputs.map((output) => ({
    kind: output.kind,
    name: output.name,
    content: output.content,
    path: output.path,
    workspacePath: context.workspacePath,
    metadata: output.metadata
  }));
}

export function buildTaskOutputs(result, context = {}) {
  const outputs = [buildDefaultTaskOutput(result, context)];

  outputs.push(...buildStructuredTaskOutputs(result, context));

  for (const collection of collectResultOutputCollections(result)) {
    for (const output of normalizePayloadOutputs(collection)) {
      outputs.push(output);
    }
  }

  outputs.push(...normalizeMemoryOutputs(result?.memory, context));
  outputs.push(...normalizeMemoryOutputs(result?.memories, context));
  outputs.push(...normalizeMemoryOutputs(result?.payload?.memory, context));
  outputs.push(...normalizeMemoryOutputs(result?.payload?.memories, context));

  return dedupeTaskOutputs(outputs).filter(hasTaskOutputContent);
}

export function normalizeStructuredHandoff(value, options = {}) {
  const fallbackSummary = normalizeOptionalText(options.fallbackSummary);
  const fallbackSourceRef = normalizeOptionalText(options.sourceRef);

  if (!value || typeof value !== 'object') {
    return fallbackSummary
      ? {
          summary: fallbackSummary,
          artifacts: [],
          decisions: [],
          openQuestions: [],
          risks: [],
          recommendedNextRole: null,
          sourceRef: fallbackSourceRef
        }
      : null;
  }

  const handoff = {
    summary: normalizeOptionalText(value.summary) || fallbackSummary,
    artifacts: normalizeOptionalStringArray(value.artifacts),
    decisions: normalizeOptionalStringArray(value.decisions),
    openQuestions: normalizeOptionalStringArray(value.openQuestions),
    risks: normalizeOptionalStringArray(value.risks),
    recommendedNextRole: normalizeOptionalText(value.recommendedNextRole),
    sourceRef: normalizeOptionalText(value.sourceRef) || fallbackSourceRef
  };

  return handoff.summary
    || handoff.artifacts.length > 0
    || handoff.decisions.length > 0
    || handoff.openQuestions.length > 0
    || handoff.risks.length > 0
    || handoff.recommendedNextRole
    || handoff.sourceRef
    ? handoff
    : null;
}

export function normalizePayloadOutputs(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item) => item && typeof item === 'object' && !Array.isArray(item))
    .map((item) => ({
      kind: normalizeOptionalText(item.kind) || 'result',
      name: normalizeOptionalText(item.name),
      content: item.contentText ?? item.content ?? null,
      path: normalizeOptionalText(item.path),
      metadata: item.metadata ?? null
    }));
}

export function mergeStringArrays(...groups) {
  return [...new Set(groups.flatMap((group) => normalizeOptionalStringArray(group)))];
}

function buildStructuredTaskOutputs(result, context = {}) {
  const outputs = [];
  const status = normalizeOptionalText(result?.status);
  const summary = normalizeOptionalText(result?.doneSummary)
    || normalizeOptionalText(result?.message);
  const error = normalizeOptionalText(result?.blockedReason)
    || (status === 'blocked' ? normalizeOptionalText(result?.message) : null);
  const handoff = normalizeStructuredHandoff(context.nextHandoff);

  if (summary && status === 'done') {
    outputs.push({
      kind: 'summary',
      name: 'task-summary',
      content: summary,
      metadata: buildStructuredOutputMetadata('summary', context)
    });
  }

  if (error) {
    outputs.push({
      kind: 'error',
      name: 'task-error',
      content: error,
      metadata: buildStructuredOutputMetadata('error', context, {
        status,
        reasonCode: context.verification?.reasonCode || null
      })
    });
  }

  if (handoff) {
    outputs.push({
      kind: 'handoff',
      name: 'task-handoff',
      content: JSON.stringify(handoff, null, 2),
      metadata: buildStructuredOutputMetadata('handoff', context, {
        summary: handoff.summary,
        artifactCount: handoff.artifacts.length,
        decisionCount: handoff.decisions.length,
        openQuestionCount: handoff.openQuestions.length,
        riskCount: handoff.risks.length,
        recommendedNextRole: handoff.recommendedNextRole,
        sourceRef: handoff.sourceRef
      })
    });

    for (const [index, decision] of handoff.decisions.entries()) {
      outputs.push({
        kind: 'decision',
        name: handoff.decisions.length === 1 ? 'task-decision' : `task-decision-${index + 1}`,
        content: decision,
        metadata: buildStructuredOutputMetadata('decision', context, {
          index,
          sourceRef: handoff.sourceRef
        })
      });
    }
  }

  return outputs;
}

function buildStructuredOutputMetadata(kind, context = {}, extra = {}) {
  return {
    runnerId: context.runnerId || null,
    workerId: context.workerId || null,
    outputRoute: kind,
    workflowClosurePolicy: summarizeWorkflowClosurePolicy(context.workflowClosurePolicy),
    checkpointSummary: summarizeCheckpoint(context.checkpoint),
    captureSource: context.captureSource || null,
    ...extra
  };
}

function collectResultOutputCollections(result) {
  return [
    result?.taskOutputs,
    result?.payload?.outputs,
    result?.payload?.workerPayload?.outputs
  ];
}

function buildDefaultTaskOutput(result, context = {}) {
  return {
    kind: 'result',
    name: context.defaultOutputName || 'runner-result',
    content: normalizeOptionalText(result?.doneSummary)
      || normalizeOptionalText(result?.blockedReason)
      || normalizeOptionalText(result?.message)
      || null,
    metadata: {
      runnerId: context.runnerId || null,
      workerId: context.workerId || null,
      workflowClosurePolicy: summarizeWorkflowClosurePolicy(context.workflowClosurePolicy),
      routingSignal: result?.payload?.routingSignal ?? null,
      handoffSummary: normalizeOptionalText(context.nextHandoff?.summary),
      verificationSummary: summarizeVerification(context.verification),
      checkpointSummary: summarizeCheckpoint(context.checkpoint),
      payloadMetadata: summarizeResultPayload(result?.payload),
      captureSource: context.captureSource || null
    }
  };
}

function normalizeMemoryOutputs(value, context = {}) {
  if (value == null) {
    return [];
  }

  const items = Array.isArray(value) ? value : [value];
  return items
    .map((item, index) => normalizeMemoryOutput(item, index, context))
    .filter(Boolean);
}

function normalizeMemoryOutput(value, index, context = {}) {
  if (value == null) {
    return null;
  }

  if (typeof value !== 'object' || Array.isArray(value)) {
    const content = normalizeOptionalText(value);
    return content
      ? {
          kind: 'summary',
          name: index === 0 ? 'task-memory' : `task-memory-${index + 1}`,
          content,
          metadata: buildStructuredOutputMetadata('memory', context, { index })
        }
      : null;
  }

  const content = value.contentText ?? value.content ?? value.summary ?? null;
  return {
    kind: normalizeOptionalText(value.kind) || 'summary',
    name: normalizeOptionalText(value.name) || (index === 0 ? 'task-memory' : `task-memory-${index + 1}`),
    content,
    path: normalizeOptionalText(value.path),
    metadata: {
      ...(value.metadata && typeof value.metadata === 'object' && !Array.isArray(value.metadata) ? value.metadata : {}),
      ...buildStructuredOutputMetadata('memory', context, { index, title: normalizeOptionalText(value.title) })
    }
  };
}

function dedupeTaskOutputs(outputs) {
  const seen = new Set();
  const deduped = [];

  for (const output of outputs) {
    const key = JSON.stringify({
      kind: output?.kind ?? null,
      name: output?.name ?? null,
      content: output?.content ?? null,
      path: output?.path ?? null,
      metadata: output?.metadata ?? null
    });

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(output);
  }

  return deduped;
}

function hasTaskOutputContent(output) {
  return Boolean(output && (output.content != null || output.path));
}

function summarizeVerification(value) {
  if (!value) {
    return null;
  }

  return {
    status: value.status || null,
    reason: value.reason || null,
    reasonCode: value.reasonCode || null
  };
}

function summarizeCheckpoint(value) {
  if (!value) {
    return null;
  }

  return {
    status: value.status || null,
    summary: value.summary || null,
    artifactRef: value.artifactRef || null
  };
}

function summarizeResultPayload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const keys = Object.keys(value).filter((key) => key !== 'outputs');
  return {
    keys,
    outputCount: Array.isArray(value.outputs) ? value.outputs.length : 0
  };
}

function summarizeWorkflowClosurePolicy(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  return {
    closureMode: normalizeOptionalText(value.closureMode),
    verificationLevel: normalizeOptionalText(value.verificationLevel),
    docPolicy: normalizeOptionalText(value.docPolicy),
    cleanupPolicy: normalizeOptionalText(value.cleanupPolicy)
  };
}

function normalizeOptionalStringArray(value) {
  if (value == null) {
    return [];
  }

  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => normalizeOptionalText(item))
    .filter(Boolean);
}

function normalizeOptionalText(value) {
  if (value == null) {
    return null;
  }

  const text = String(value).trim();
  return text || null;
}
