export function createAgentAdapter(handler) {
  if (typeof handler !== 'function') {
    throw new Error('Agent adapter handler must be a function.');
  }

  return {
    async run(input) {
      const result = await handler(input);
      return normalizeAdapterResult(result);
    }
  };
}

export function normalizeAdapterResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error('Agent adapter must return an object result.');
  }

  const status = String(result.status || '').trim();
  if (status !== 'done' && status !== 'blocked') {
    throw new Error('Agent adapter result status must be "done" or "blocked".');
  }

  const payload = normalizePayload(result.payload, 'payload');
  const handoff = normalizeStructuredHandoff(
    result.handoff !== undefined ? result.handoff : payload?.handoff,
    result.handoff !== undefined ? 'handoff' : 'payload.handoff'
  );
  const taskOutputs = normalizeTaskOutputs(result.taskOutputs, 'taskOutputs');
  const message = normalizeOptionalText(result.message);

  if (status === 'done') {
    const doneSummary = normalizeRequiredText(result.doneSummary, 'doneSummary');
    return {
      status,
      doneSummary,
      blockedReason: null,
      payload,
      handoff,
      taskOutputs,
      message
    };
  }

  const blockedReason = normalizeRequiredText(result.blockedReason, 'blockedReason');
  return {
    status,
    doneSummary: null,
    blockedReason,
    payload,
    handoff,
    taskOutputs,
    message
  };
}

function normalizePayload(value, label) {
  if (value == null) {
    return null;
  }

  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Agent adapter ${label} must be an object when provided.`);
  }

  const normalized = { ...value };

  if (Object.prototype.hasOwnProperty.call(normalized, 'handoff')) {
    normalized.handoff = normalizeStructuredHandoff(normalized.handoff, `${label}.handoff`);
  }

  if (Object.prototype.hasOwnProperty.call(normalized, 'outputs')) {
    normalized.outputs = normalizeTaskOutputs(normalized.outputs, `${label}.outputs`);
  }

  return normalized;
}

function normalizeStructuredHandoff(value, label) {
  if (value == null) {
    return null;
  }

  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Agent adapter ${label} must be an object when provided.`);
  }

  const handoff = {
    summary: normalizeOptionalText(value.summary),
    artifacts: normalizeTextArray(value.artifacts, `${label}.artifacts`),
    decisions: normalizeTextArray(value.decisions, `${label}.decisions`),
    openQuestions: normalizeTextArray(value.openQuestions, `${label}.openQuestions`),
    risks: normalizeTextArray(value.risks, `${label}.risks`),
    recommendedNextRole: normalizeOptionalText(value.recommendedNextRole),
    sourceRef: normalizeOptionalText(value.sourceRef)
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

function normalizeOptionalText(value) {
  if (value == null) {
    return null;
  }

  const text = String(value).trim();
  return text || null;
}

function normalizeRequiredText(value, label) {
  const text = normalizeOptionalText(value);
  if (!text) {
    throw new Error(`Agent adapter result ${label} is required.`);
  }
  return text;
}

function normalizeTaskOutputs(value, label = 'taskOutputs') {
  if (value == null) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new Error(`Agent adapter ${label} must be an array when provided.`);
  }

  return value.map((item, index) => normalizeTaskOutput(item, `${label}[${index}]`));
}

function normalizeTaskOutput(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Agent adapter ${label} must be an object.`);
  }

  const content = value.contentText ?? value.content ?? null;
  const metadata = normalizeOptionalObject(value.metadata, `${label}.metadata`);

  return {
    kind: normalizeOptionalText(value.kind) || 'result',
    name: normalizeOptionalText(value.name),
    contentText: content == null ? null : String(content),
    path: normalizeOptionalText(value.path),
    metadata
  };
}

function normalizeOptionalObject(value, label) {
  if (value == null) {
    return null;
  }

  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Agent adapter ${label} must be an object when provided.`);
  }

  return { ...value };
}

function normalizeTextArray(value, label) {
  if (value == null) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new Error(`Agent adapter ${label} must be an array when provided.`);
  }

  return value.map((item, index) => {
    const text = normalizeOptionalText(item);
    if (!text) {
      throw new Error(`Agent adapter ${label}[${index}] must be a non-empty string.`);
    }
    return text;
  });
}
