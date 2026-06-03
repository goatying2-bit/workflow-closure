const DATA_CLASSES = new Set(['real', 'test', 'debug', 'unknown']);
const RETENTION_CLASSES = new Set(['keep', 'ephemeral', 'ttl', 'unknown']);
const TEST_DEBUG_PATTERN = /\b(test|smoke|debug|fixture|admin-ui|benchmark)\b/i;

export function classifyWorkflow(workflow = {}) {
  const metadata = normalizeObject(workflow?.initialPlan?.metadata);
  const dataClass = normalizeDataClass(metadata.dataClass);
  const retention = normalizeRetention(metadata.retention);
  const archivedAt = normalizeOptionalText(metadata.archivedAt);
  const archiveReason = normalizeOptionalText(metadata.archiveReason);
  const generatedBy = normalizeOptionalText(metadata.generatedBy);
  const heuristicReasons = inferWorkflowHeuristicReasons(workflow);

  return {
    dataClass,
    retention,
    generatedBy,
    archived: Boolean(archivedAt),
    archivedAt: archivedAt || null,
    archiveReason: archiveReason || null,
    heuristicReasons
  };
}

export function isWorkflowVisibleByDefault(workflow = {}) {
  const hygiene = classifyWorkflow(workflow);
  return !hygiene.archived
    && hygiene.dataClass !== 'test'
    && hygiene.dataClass !== 'debug'
    && hygiene.heuristicReasons.length === 0;
}

export function shouldIncludeWorkflowForHygiene(workflow = {}, query = {}) {
  const includeTestData = query.includeTestData === true;
  const includeArchived = query.includeArchived === true || includeTestData;
  const requestedDataClass = normalizeOptionalText(query.dataClass);
  const hygiene = classifyWorkflow(workflow);

  if (requestedDataClass && hygiene.dataClass !== requestedDataClass) {
    return false;
  }

  if (!includeArchived && hygiene.archived) {
    return false;
  }

  if (!includeTestData && (hygiene.dataClass === 'test' || hygiene.dataClass === 'debug' || hygiene.heuristicReasons.length > 0)) {
    return false;
  }

  return true;
}

export function mergeWorkflowHygieneMetadata(plan = {}, metadata = {}) {
  const currentMetadata = normalizeObject(plan.metadata);
  return {
    ...plan,
    metadata: {
      ...currentMetadata,
      ...normalizeObject(metadata)
    }
  };
}

export function markWorkflowPlanArchived(plan = {}, input = {}) {
  const now = normalizeOptionalText(input.archivedAt) || new Date().toISOString();
  return mergeWorkflowHygieneMetadata(plan, {
    dataClass: normalizeDataClass(input.dataClass || 'test'),
    retention: normalizeRetention(input.retention || 'ephemeral'),
    generatedBy: normalizeOptionalText(input.generatedBy) || 'data-hygiene',
    archivedAt: now,
    archiveReason: normalizeOptionalText(input.archiveReason) || normalizeOptionalText(input.reason) || 'Marked by data hygiene.'
  });
}

function inferWorkflowHeuristicReasons(workflow = {}) {
  const candidates = [
    ['workflowId', workflow.workflowId],
    ['goal', workflow.goal],
    ['instruction', workflow.instruction]
  ];

  return candidates
    .filter(([, value]) => TEST_DEBUG_PATTERN.test(normalizeOptionalText(value)))
    .map(([field]) => `${field} matches test/debug pattern`);
}

function normalizeDataClass(value) {
  const text = normalizeOptionalText(value).toLowerCase();
  return DATA_CLASSES.has(text) ? text : 'unknown';
}

function normalizeRetention(value) {
  const text = normalizeOptionalText(value).toLowerCase();
  return RETENTION_CLASSES.has(text) ? text : 'unknown';
}

function normalizeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalizeOptionalText(value) {
  if (value == null) {
    return '';
  }

  return String(value).trim();
}
