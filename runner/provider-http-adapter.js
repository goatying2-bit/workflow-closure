import { createAgentAdapter, normalizeAdapterResult } from './agent-adapter.js';

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_SYSTEM_INSTRUCTION = 'You are running as a workflow-closure AI provider adapter. Complete the assigned task when possible. If you cannot safely or correctly complete it, report blocked.';

export function createProviderHttpAdapter({
  provider,
  buildRequest,
  extractCompletionText
}) {
  if (!normalizeOptionalText(provider)) {
    throw new Error('Provider adapter requires a non-empty provider name.');
  }

  if (typeof buildRequest !== 'function') {
    throw new Error('Provider adapter buildRequest must be a function.');
  }

  if (typeof extractCompletionText !== 'function') {
    throw new Error('Provider adapter extractCompletionText must be a function.');
  }

  return createAgentAdapter(async (input) => {
    let request;
    try {
      request = await buildRequest({
        input,
        prompt: buildProviderPrompt(input),
        systemInstruction: DEFAULT_SYSTEM_INSTRUCTION
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return buildBlockedResult({
        input,
        provider,
        blockedReason: `${provider} adapter configuration failed for task "${input?.task?.title || 'unknown-task'}".`,
        message,
        payload: {
          adapter: 'provider-http',
          provider,
          error: message,
          timedOut: false
        }
      });
    }

    let response;
    try {
      response = await executeJsonRequest(request);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return buildBlockedResult({
        input,
        provider,
        blockedReason: `${provider} adapter failed to reach the provider API for task "${input?.task?.title || 'unknown-task'}".`,
        message,
        payload: {
          adapter: 'provider-http',
          provider,
          endpoint: request?.url || null,
          model: request?.model || null,
          request: request?.requestMeta || null,
          error: message,
          timedOut: error?.timedOut === true
        }
      });
    }

    if (!response.ok) {
      return buildBlockedResult({
        input,
        provider,
        blockedReason: `${provider} adapter received HTTP ${response.status} for task "${input?.task?.title || 'unknown-task'}".`,
        message: `${provider} adapter request failed with HTTP ${response.status}.`,
        payload: buildResponsePayload({
          provider,
          request,
          response,
          extra: {
            error: extractProviderError(response.json) || response.text || `http-${response.status}`,
            outputs: []
          }
        })
      });
    }

    if (response.parseError) {
      return buildBlockedResult({
        input,
        provider,
        blockedReason: `${provider} adapter returned invalid JSON response for task "${input?.task?.title || 'unknown-task'}".`,
        message: 'Provider API response body could not be parsed as JSON.',
        payload: buildResponsePayload({
          provider,
          request,
          response,
          extra: {
            error: response.parseError,
            outputs: []
          }
        })
      });
    }

    let completionText;
    try {
      completionText = extractCompletionText(response.json);
      if (!normalizeOptionalText(completionText)) {
        throw new Error('Provider completion text was empty.');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return buildBlockedResult({
        input,
        provider,
        blockedReason: `${provider} adapter returned an unexpected response shape for task "${input?.task?.title || 'unknown-task'}".`,
        message,
        payload: buildResponsePayload({
          provider,
          request,
          response,
          extra: {
            error: message,
            outputs: []
          }
        })
      });
    }

    let parsed;
    try {
      parsed = JSON.parse(completionText);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return buildBlockedResult({
        input,
        provider,
        blockedReason: `${provider} adapter returned invalid JSON adapter output for task "${input?.task?.title || 'unknown-task'}".`,
        message: 'Provider completion text could not be parsed as an adapter result JSON object.',
        payload: buildResponsePayload({
          provider,
          request,
          response,
          extra: {
            parseError: message,
            rawText: completionText,
            outputs: []
          }
        })
      });
    }

    try {
      const normalized = normalizeAdapterResult(parsed);
      return {
        ...normalized,
        payload: buildResponsePayload({
          provider,
          request,
          response,
          extra: {
            outputs: normalized.payload?.outputs ?? [],
            rawText: completionText,
            workerPayload: normalized.payload ?? null
          }
        })
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return buildBlockedResult({
        input,
        provider,
        blockedReason: `${provider} adapter returned invalid adapter result for task "${input?.task?.title || 'unknown-task'}".`,
        message: 'Provider completion JSON did not satisfy the adapter result contract.',
        payload: buildResponsePayload({
          provider,
          request,
          response,
          extra: {
            parseError: message,
            rawText: completionText,
            outputs: []
          }
        })
      });
    }
  });
}

async function executeJsonRequest(request) {
  const fetchImpl = resolveFetchImplementation(request?.fetchImpl);
  const timeoutMs = resolveTimeoutMs(request?.timeoutMs);
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller && timeoutMs > 0
    ? setTimeout(() => controller.abort(), timeoutMs)
    : null;

  try {
    const response = await fetchImpl(request.url, {
      method: request.method || 'POST',
      headers: request.headers,
      body: request.body == null ? undefined : JSON.stringify(request.body),
      signal: controller?.signal
    });

    const text = await response.text();
    const json = text ? safeJsonParse(text) : { ok: true, value: null };

    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      headers: sanitizeResponseHeaders(response.headers),
      text,
      json: json.ok ? json.value : null,
      parseError: json.ok ? null : json.error,
      timedOut: false
    };
  } catch (error) {
    const timedOut = isAbortError(error) && timeoutMs > 0;
    const wrapped = new Error(timedOut ? `Provider request timed out after ${timeoutMs}ms.` : (error instanceof Error ? error.message : String(error)));
    wrapped.cause = error;
    wrapped.timedOut = timedOut;
    throw wrapped;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function buildProviderPrompt(input) {
  const task = input?.task || {};
  const workflow = input?.workflow || {};
  const assignment = input?.assignment || null;
  const context = input?.context || null;
  const rules = input?.rules || null;
  const prompt = normalizeOptionalText(input?.prompt);

  return [
    '## Workflow',
    `Workflow ID: ${workflow.workflowId || 'unknown'}`,
    `Instruction: ${workflow.instruction || 'none'}`,
    '',
    '## Task',
    `Task ID: ${task.taskId || 'unknown'}`,
    `Title: ${task.title || 'Untitled task'}`,
    `Description: ${task.description || 'none'}`,
    `Type: ${task.type || 'unspecified'}`,
    '',
    assignment ? `## Assignment\n${JSON.stringify(assignment, null, 2)}\n` : null,
    context ? `## Context\n${JSON.stringify(context, null, 2)}\n` : null,
    rules ? `## Rules\n${JSON.stringify(rules, null, 2)}\n` : null,
    prompt ? `## Existing Prompt\n${prompt}\n` : null,
    '## Required output',
    'Return only valid JSON. Do not wrap it in markdown. Use this shape:',
    JSON.stringify({
      status: 'done | blocked',
      doneSummary: 'Required when status is done.',
      blockedReason: 'Required when status is blocked.',
      payload: {},
      handoff: {
        summary: 'Short handoff summary.',
        artifacts: [],
        decisions: [],
        openQuestions: [],
        risks: [],
        recommendedNextRole: null
      }
    }, null, 2)
  ].filter(Boolean).join('\n');
}

function buildBlockedResult({ input, provider, blockedReason, message, payload }) {
  return {
    status: 'blocked',
    blockedReason: blockedReason || `${provider} adapter blocked task "${input?.task?.title || 'unknown-task'}".`,
    message,
    payload
  };
}

function buildResponsePayload({ provider, request, response, extra }) {
  return {
    adapter: 'provider-http',
    provider,
    endpoint: request?.url || null,
    model: request?.model || null,
    request: request?.requestMeta || null,
    http: response
      ? {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
          timedOut: response.timedOut
        }
      : null,
    responseBody: response?.json ?? response?.text ?? null,
    ...extra
  };
}

function extractProviderError(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const direct = normalizeOptionalText(value.error?.message)
    || normalizeOptionalText(value.message)
    || normalizeOptionalText(value.error);

  return direct || null;
}

function resolveFetchImplementation(fetchImpl) {
  if (typeof fetchImpl === 'function') {
    return fetchImpl;
  }

  if (typeof globalThis.fetch === 'function') {
    return globalThis.fetch.bind(globalThis);
  }

  throw new Error('Global fetch is not available. Provide options.fetchImpl when creating the provider adapter.');
}

function resolveTimeoutMs(timeoutMs) {
  if (timeoutMs == null) {
    return DEFAULT_TIMEOUT_MS;
  }

  const value = Number(timeoutMs);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error('Provider adapter timeoutMs must be a non-negative number.');
  }

  return value;
}

function safeJsonParse(text) {
  try {
    return {
      ok: true,
      value: JSON.parse(text)
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function sanitizeResponseHeaders(headers) {
  if (!headers || typeof headers.entries !== 'function') {
    return {};
  }

  return Object.fromEntries(Array.from(headers.entries()));
}

function isAbortError(error) {
  return error?.name === 'AbortError';
}

export function resolveRequiredTextOption(value, input, label, envName) {
  const resolved = resolveOptionValue(value, input) ?? (envName ? process.env[envName] : null);
  const text = normalizeOptionalText(resolved);
  if (!text) {
    throw new Error(label);
  }
  return text;
}

export function resolveOptionalTextOption(value, input) {
  return normalizeOptionalText(resolveOptionValue(value, input));
}

export function resolveOptionalNumberOption(value, input, label) {
  const resolved = resolveOptionValue(value, input);
  if (resolved == null) {
    return null;
  }

  const number = Number(resolved);
  if (!Number.isFinite(number)) {
    throw new Error(label);
  }

  return number;
}

export function resolveOptionalObjectOption(value, input, label) {
  const resolved = resolveOptionValue(value, input);
  if (resolved == null) {
    return null;
  }

  if (typeof resolved !== 'object' || Array.isArray(resolved)) {
    throw new Error(label);
  }

  return { ...resolved };
}

export function resolveHeadersOption(value, input, label) {
  const headers = resolveOptionalObjectOption(value, input, label);
  if (!headers) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(headers).map(([key, item]) => [key, String(item)])
  );
}

export function resolveTimeoutOption(value, input) {
  const timeoutMs = resolveOptionValue(value, input);
  return resolveTimeoutMs(timeoutMs);
}

export function resolveUrlOption({ url, baseUrl, defaultPath }, input, label) {
  const explicitUrl = resolveOptionalTextOption(url, input);
  if (explicitUrl) {
    return explicitUrl;
  }

  const base = normalizeOptionalText(resolveOptionValue(baseUrl, input));
  if (!base) {
    throw new Error(label);
  }

  return new URL(defaultPath, ensureTrailingSlash(base)).toString();
}

export function resolvePromptBuilder(options, input) {
  if (typeof options?.promptBuilder === 'function') {
    const prompt = options.promptBuilder(input);
    const text = normalizeOptionalText(prompt);
    if (!text) {
      throw new Error('Provider adapter promptBuilder must return a non-empty prompt.');
    }
    return text;
  }

  return buildProviderPrompt(input);
}

export function resolveSystemInstruction(options, input) {
  const custom = resolveOptionValue(options?.systemInstruction, input);
  return normalizeOptionalText(custom) || DEFAULT_SYSTEM_INSTRUCTION;
}

export function normalizeOptionalText(value) {
  if (value == null) {
    return null;
  }

  const text = String(value).trim();
  return text || null;
}

function resolveOptionValue(value, input) {
  return typeof value === 'function'
    ? value(input)
    : value;
}

function ensureTrailingSlash(text) {
  return String(text).endsWith('/') ? String(text) : `${text}/`;
}
