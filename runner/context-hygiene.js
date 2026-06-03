const POLICY_VERSION = 1;

export const HYGIENE_LABELS = Object.freeze({
  authoritative: 'authoritative',
  validated: 'validated',
  workflowGenerated: 'workflow-generated',
  reference: 'reference',
  recoveryOnly: 'recovery-only',
  quarantined: 'quarantined'
});

export const SOURCE_CLASSES = Object.freeze({
  currentTask: 'current-task',
  validatedOutput: 'validated-output',
  failedValidationEvidence: 'failed-validation-evidence',
  memory: 'memory',
  relatedContext: 'related-context',
  lifecycle: 'lifecycle'
});

export function classifyTaskOutputForContext(output = {}, context = {}) {
  const metadata = output?.metadata && typeof output.metadata === 'object' ? output.metadata : {};
  const trustState = normalizeOptionalText(metadata.trustState) || 'unverified';
  const isRepairTask = Boolean(context.isRepairTask);
  const isFailedValidationEvidence = output?.kind === 'validation-result'
    && output?.name === 'validation-commands'
    && trustState === 'failed';

  if (trustState === 'validated') {
    return buildClassification({
      hygieneLabel: HYGIENE_LABELS.validated,
      sourceClass: SOURCE_CLASSES.validatedOutput,
      allowedUse: 'trusted-upstream',
      promptAllowed: true,
      trustState
    });
  }

  if (isFailedValidationEvidence && isRepairTask) {
    return buildClassification({
      hygieneLabel: HYGIENE_LABELS.recoveryOnly,
      sourceClass: SOURCE_CLASSES.failedValidationEvidence,
      allowedUse: 'repair-evidence-only',
      promptAllowed: true,
      trustState
    });
  }

  if (trustState === 'failed' || trustState === 'tainted' || trustState === 'superseded') {
    return buildClassification({
      hygieneLabel: HYGIENE_LABELS.quarantined,
      sourceClass: isFailedValidationEvidence ? SOURCE_CLASSES.failedValidationEvidence : SOURCE_CLASSES.validatedOutput,
      allowedUse: 'blocked-from-prompt',
      promptAllowed: false,
      trustState
    });
  }

  return buildClassification({
    hygieneLabel: HYGIENE_LABELS.reference,
    sourceClass: SOURCE_CLASSES.validatedOutput,
    allowedUse: 'low-trust-reference',
    promptAllowed: false,
    trustState
  });
}

export function classifyMemoryForContext(memory = {}) {
  const metadata = memory?.metadata && typeof memory.metadata === 'object' ? memory.metadata : {};
  const workflowGenerated = Boolean(metadata.workflowGenerated)
    || memory?.sourceKind === 'workflow-task'
    || memory?.sourceKind === 'workflow-assignment';
  const active = memory?.status === 'active';
  const stable = normalizeOptionalText(memory?.stability) === 'stable';
  const recalledForActiveTask = hasPromptEligibleTaskRecallMatch(memory?.matchedBy);
  const promptEligibleWorkflowMemory = workflowGenerated && active && (stable || recalledForActiveTask);

  return buildClassification({
    hygieneLabel: workflowGenerated
      ? (promptEligibleWorkflowMemory ? HYGIENE_LABELS.validated : HYGIENE_LABELS.workflowGenerated)
      : HYGIENE_LABELS.reference,
    sourceClass: workflowGenerated ? SOURCE_CLASSES.lifecycle : SOURCE_CLASSES.memory,
    allowedUse: workflowGenerated
      ? (promptEligibleWorkflowMemory ? 'validated-project-memory' : 'workflow-lifecycle-reference')
      : 'historical-reference',
    promptAllowed: workflowGenerated ? promptEligibleWorkflowMemory : active,
    workflowGenerated,
    requiresPromotion: workflowGenerated && !promptEligibleWorkflowMemory
  });
}

export function classifyContextItemForPrompt(item = {}) {
  if (item?.hygieneLabel) {
    return buildClassification({
      hygieneLabel: item.hygieneLabel,
      sourceClass: item.sourceClass,
      allowedUse: item.allowedUse,
      promptAllowed: item.promptAllowed !== false,
      trustState: item.metadata?.hygiene?.trustState,
      workflowGenerated: item.metadata?.hygiene?.workflowGenerated
    });
  }

  if (item?.authority === 'authoritative') {
    return buildClassification({
      hygieneLabel: HYGIENE_LABELS.authoritative,
      sourceClass: SOURCE_CLASSES.currentTask,
      allowedUse: 'current-task-fact',
      promptAllowed: true
    });
  }

  return buildClassification({
    hygieneLabel: item?.authority === 'reference' ? HYGIENE_LABELS.reference : HYGIENE_LABELS.workflowGenerated,
    sourceClass: SOURCE_CLASSES.relatedContext,
    allowedUse: item?.authority === 'reference' ? 'historical-reference' : 'adjacent-context',
    promptAllowed: true
  });
}

export function isContextItemAllowedInPrompt(item, promptContext = {}) {
  const classification = classifyContextItemForPrompt(item);
  if (classification.hygieneLabel === HYGIENE_LABELS.quarantined || classification.promptAllowed === false) {
    return false;
  }

  if (classification.hygieneLabel === HYGIENE_LABELS.recoveryOnly) {
    return Boolean(promptContext.isRepairTask);
  }

  return true;
}

export function shouldWriteLifecycleMemory(input = {}) {
  const verified = input.verification?.status === 'passed';
  const promotable = Boolean(input.promotable || input.task?.contract?.promotableMemory || input.task?.contract?.memoryPromotion === true);
  const done = input.kind === 'done';
  const stable = done && verified && promotable;

  return {
    shouldWrite: true,
    type: stable ? 'project' : 'feedback',
    stability: stable ? 'stable' : 'volatile',
    confidence: stable ? 0.9 : (done ? 0.7 : 0.6),
    requiresPromotion: !stable,
    workflowGenerated: true,
    hygieneLabel: stable ? HYGIENE_LABELS.validated : HYGIENE_LABELS.workflowGenerated,
    sourceClass: SOURCE_CLASSES.lifecycle,
    allowedUse: stable ? 'validated-project-memory' : 'workflow-lifecycle-reference'
  };
}

export function buildHygieneMetadata(input = {}) {
  const classification = input.classification || {};
  return {
    policyVersion: POLICY_VERSION,
    hygieneLabel: classification.hygieneLabel || input.hygieneLabel || HYGIENE_LABELS.reference,
    sourceClass: classification.sourceClass || input.sourceClass || SOURCE_CLASSES.relatedContext,
    allowedUse: classification.allowedUse || input.allowedUse || 'reference',
    promptAllowed: classification.promptAllowed !== false && input.promptAllowed !== false,
    trustState: classification.trustState || input.trustState || null,
    workflowGenerated: Boolean(classification.workflowGenerated || input.workflowGenerated),
    requiresPromotion: Boolean(classification.requiresPromotion || input.requiresPromotion),
    provenance: input.provenance || null
  };
}

export function buildContextHygieneSummary(items = [], candidateCount = null) {
  const summary = {
    policyVersion: POLICY_VERSION,
    candidateCount: Number.isInteger(candidateCount) ? candidateCount : items.length,
    includedCount: items.length,
    byLabel: {},
    quarantinedCount: 0,
    promptBlockedCount: 0
  };

  for (const item of items) {
    const label = item?.hygieneLabel || item?.metadata?.hygiene?.hygieneLabel || HYGIENE_LABELS.reference;
    summary.byLabel[label] = (summary.byLabel[label] || 0) + 1;
    if (label === HYGIENE_LABELS.quarantined) {
      summary.quarantinedCount++;
    }
    if (item?.promptAllowed === false || item?.metadata?.hygiene?.promptAllowed === false) {
      summary.promptBlockedCount++;
    }
  }

  return summary;
}

function buildClassification(input) {
  return {
    policyVersion: POLICY_VERSION,
    hygieneLabel: input.hygieneLabel,
    sourceClass: input.sourceClass,
    allowedUse: input.allowedUse,
    promptAllowed: input.promptAllowed !== false,
    trustState: input.trustState || null,
    workflowGenerated: Boolean(input.workflowGenerated),
    requiresPromotion: Boolean(input.requiresPromotion)
  };
}


function normalizeOptionalText(value) {
  if (value == null) {
    return null;
  }

  const text = String(value).trim();
  return text || null;
}

function hasPromptEligibleTaskRecallMatch(matchedBy) {
  if (!matchedBy || typeof matchedBy !== 'object' || Array.isArray(matchedBy)) {
    return false;
  }

  return matchedBy.exactSourceRef === true
    || matchedBy.structural === true
    || matchedBy.graph === true
    || matchedBy.semantic === true;
}
