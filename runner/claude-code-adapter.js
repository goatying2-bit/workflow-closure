import fs from 'node:fs/promises';
import { createAgentAdapter } from './agent-adapter.js';
import { createSubprocessAdapter } from './subprocess-adapter.js';

const DEFAULT_CLAUDE_COMMAND = 'claude';
const DEFAULT_SYSTEM_INSTRUCTION = 'You are running as a workflow-closure task adapter. Complete the assigned task when possible. If you cannot safely or correctly complete it, report blocked. Never return prose or markdown outside the required JSON. If the task produces a document or file, put the content in taskOutputs or payload.outputs and put the artifact path in handoff.artifacts.';
const CLAUDE_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  required: ['status'],
  properties: {
    status: {
      type: 'string',
      enum: ['done', 'blocked']
    },
    doneSummary: {
      type: 'string'
    },
    blockedReason: {
      type: 'string'
    },
    message: {
      type: 'string'
    },
    payload: {
      type: 'object'
    },
    taskOutputs: {
      type: 'array'
    },
    handoff: {
      type: 'object',
      additionalProperties: true,
      properties: {
        summary: { type: 'string' },
        artifacts: {
          type: 'array',
          items: { type: 'string' }
        },
        decisions: {
          type: 'array',
          items: { type: 'string' }
        },
        openQuestions: {
          type: 'array',
          items: { type: 'string' }
        },
        risks: {
          type: 'array',
          items: { type: 'string' }
        },
        recommendedNextRole: {
          anyOf: [
            { type: 'string' },
            { type: 'null' }
          ]
        }
      }
    }
  },
  allOf: [
    {
      if: {
        properties: { status: { const: 'done' } },
        required: ['status']
      },
      then: {
        required: ['doneSummary']
      }
    },
    {
      if: {
        properties: { status: { const: 'blocked' } },
        required: ['status']
      },
      then: {
        required: ['blockedReason']
      }
    }
  ]
};

export function createClaudeCodeAdapter(options = {}) {
  const command = options.command ?? DEFAULT_CLAUDE_COMMAND;
  const subprocessAdapter = createSubprocessAdapter({
    command,
    args(input) {
      return buildClaudeArgs(options, input);
    },
    cwd: options.cwd,
    env: options.env,
    timeoutMs: options.timeoutMs,
    transientExitClassifier: classifyClaudeTransientExit,
    stdoutMode: 'json',
    stdoutTransformer: unwrapClaudeJsonResult
  });

  return createAgentAdapter(async (input) => {
    const bypass = buildSimpleCoordinatorBypassResult(options, input);
    if (bypass) {
      return bypass;
    }

    const preflight = await runClaudeAdapterPreflight(options, input, command);
    if (preflight) {
      return preflight;
    }

    return subprocessAdapter.run(input);
  });
}


function buildSimpleCoordinatorBypassResult(options, input) {
  if (options.simpleCoordinatorBypass !== true) {
    return null;
  }

  const task = input?.task || {};
  const taskType = normalizeOptionalText(task.type || task.contract?.taskType)?.toLowerCase();
  const text = `${task.title || ''}\n${task.description || ''}`.toLowerCase();
  const typeHintPatterns = [
    /runtime[_\s-]?confirmation/,
    /coordination/,
    /handoff/,
    /确认/,
    /协调/,
    /交接/
  ];
  if (!['runtime_confirmation', 'coordination', 'handoff'].includes(taskType) && !typeHintPatterns.some((pattern) => pattern.test(text))) {
    return null;
  }

  const role = normalizeOptionalText(input?.agentIdentity?.role || task.preferredRole || input?.runnerId)?.toLowerCase();
  if (role !== 'coordinator' && !role?.includes('coordinator')) {
    return null;
  }

  const safeIntentPatterns = [
    /confirm/,
    /confirmation/,
    /runtime/,
    /scope/,
    /status/,
    /handoff/,
    /coordination/,
    /确认/,
    /运行/,
    /范围/,
    /状态/,
    /交接/,
    /协调/
  ];
  if (!safeIntentPatterns.some((pattern) => pattern.test(text))) {
    return null;
  }

  const title = task.title || 'unknown-task';
  return {
    status: 'done',
    doneSummary: `Simple coordinator task completed without launching Claude: ${title}`,
    payload: {
      adapter: 'claude-code',
      bypass: 'simple-coordinator',
      taskId: task.taskId || null,
      taskTitle: task.title || null,
      taskType: task.type || task.contract?.taskType || null,
      role
    },
    handoff: {
      summary: `Coordinator confirmed simple task: ${title}`,
      artifacts: [],
      decisions: ['Used simple coordinator bypass for a low-risk bookkeeping task.'],
      openQuestions: [],
      risks: [],
      recommendedNextRole: null
    }
  };
}

async function runClaudeAdapterPreflight(options, input, command) {
  const commandText = normalizeOptionalText(typeof command === 'function' ? command(input) : command);
  if (!commandText) {
    return buildClaudeBlockedResult({
      input,
      blockedReason: `Claude Code adapter command is not configured for task "${input?.task?.title || 'unknown-task'}".`,
      message: 'Claude Code adapter requires a non-empty command before spawning Claude.',
      payload: buildClaudeDiagnosticPayload(options, input, {
        error: 'missing-command',
        command: commandText
      })
    });
  }

  const cwd = resolveTextOption(options.cwd, input);
  if (cwd) {
    try {
      const stat = await fs.stat(cwd);
      if (!stat.isDirectory()) {
        return buildClaudeBlockedResult({
          input,
          blockedReason: `Claude Code adapter cwd is not a directory for task "${input?.task?.title || 'unknown-task'}".`,
          message: `Configured cwd is not a directory: ${cwd}`,
          payload: buildClaudeDiagnosticPayload(options, input, {
            error: 'cwd-not-directory',
            command: commandText,
            cwd
          })
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return buildClaudeBlockedResult({
        input,
        blockedReason: `Claude Code adapter cwd is not available for task "${input?.task?.title || 'unknown-task'}".`,
        message,
        payload: buildClaudeDiagnosticPayload(options, input, {
          error: 'cwd-unavailable',
          command: commandText,
          cwd
        })
      });
    }
  }

  return null;
}

function buildClaudeBlockedResult({ input, blockedReason, message, payload }) {
  return {
    status: 'blocked',
    blockedReason: blockedReason || `Claude Code adapter blocked task "${input?.task?.title || 'unknown-task'}".`,
    message,
    payload
  };
}

function buildClaudeDiagnosticPayload(options, input, extra = {}) {
  const env = resolveEnvOption(options.env, input);
  return {
    adapter: 'claude-code',
    phase: 'preflight',
    taskId: input?.task?.taskId || null,
    taskTitle: input?.task?.title || null,
    taskType: input?.task?.type || null,
    envWorkspacePath: env?.WORKFLOW_CLOSURE_CLAUDE_WORKSPACE_PATH || null,
    envDbPath: env?.WORKFLOW_CLOSURE_CLAUDE_DB_PATH || null,
    ...extra
  };
}

function resolveTextOption(value, input) {
  return normalizeOptionalText(typeof value === 'function' ? value(input) : value);
}

function resolveEnvOption(value, input) {
  const resolved = typeof value === 'function' ? value(input) : value;
  return resolved && typeof resolved === 'object' && !Array.isArray(resolved)
    ? resolved
    : null;
}

function buildClaudeArgs(options, input) {
  const baseArgs = resolveArgsOption(options.args, input, []);
  const extraArgs = resolveArgsOption(options.extraArgs, input, []);
  const prompt = buildClaudePrompt(options, input);
  const args = ensureClaudeStructuredOutputArgs([...baseArgs, ...extraArgs]);
  return [
    ...args,
    prompt
  ];
}

function ensureClaudeStructuredOutputArgs(args) {
  const nextArgs = [...args];

  if (!hasFlag(nextArgs, '--print')) {
    nextArgs.push('--print');
  }

  if (!hasFlag(nextArgs, '--output-format')) {
    nextArgs.push('--output-format', 'json');
  }

  if (!hasFlag(nextArgs, '--json-schema')) {
    nextArgs.push('--json-schema', JSON.stringify(CLAUDE_JSON_SCHEMA));
  }

  return nextArgs;
}

function hasFlag(args, flag) {
  return Array.isArray(args) && args.includes(flag);
}

function buildClaudePrompt(options, input) {
  if (typeof options.promptBuilder === 'function') {
    const prompt = options.promptBuilder(input);
    const text = normalizeOptionalText(prompt);
    if (!text) {
      throw new Error('Claude Code adapter promptBuilder must return a non-empty prompt.');
    }
    return text;
  }

  const systemInstruction = normalizeOptionalText(options.systemInstruction) || DEFAULT_SYSTEM_INSTRUCTION;
  const task = input?.task || {};
  const workflow = input?.workflow || {};
  const assignment = input?.assignment || null;
  const context = input?.context || null;
  const rules = input?.rules || null;
  const prompt = normalizeOptionalText(input?.prompt);

  return [
    systemInstruction,
    '',
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
    'Return only valid JSON. Do not wrap it in markdown.',
    'If the task delivers a final document or file, put the content in taskOutputs or payload.outputs, include the path on that output object, and list the artifact path in handoff.artifacts.',
    'Use this shape:',
    JSON.stringify({
      status: 'done | blocked',
      doneSummary: 'Required when status is done.',
      blockedReason: 'Required when status is blocked.',
      payload: {
        outputs: [
          {
            kind: 'artifact | result',
            name: 'optional-output-name',
            contentText: 'file or result content',
            path: 'optional/output/path',
            metadata: {}
          }
        ]
      },
      taskOutputs: [
        {
          kind: 'artifact | result',
          name: 'optional-output-name',
          contentText: 'file or result content',
          path: 'optional/output/path',
          metadata: {}
        }
      ],
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

function unwrapClaudeJsonResult(stdout) {
  if (!stdout) {
    return { stdout };
  }

  let parsedEnvelope;
  try {
    parsedEnvelope = JSON.parse(stdout);
  } catch {
    return { stdout };
  }

  if (parsedEnvelope && typeof parsedEnvelope === 'object') {
    if (parsedEnvelope.structured_output && typeof parsedEnvelope.structured_output === 'object') {
      return { parsed: parsedEnvelope.structured_output, stdout: JSON.stringify(parsedEnvelope.structured_output) };
    }

    if (typeof parsedEnvelope.result === 'string') {
      try {
        const parsedResult = JSON.parse(parsedEnvelope.result);
        return { parsed: parsedResult, stdout: parsedEnvelope.result };
      } catch {
        return { stdout: parsedEnvelope.result };
      }
    }
  }

  return { parsed: parsedEnvelope, stdout };
}

function classifyClaudeTransientExit({ result }) {
  const stderr = normalizeOptionalText(result?.stderr)?.toLowerCase() || '';
  const stdout = normalizeOptionalText(result?.stdout)?.toLowerCase() || '';
  const combined = `${stderr}\n${stdout}`;

  if (!combined) {
    return null;
  }

  const transientPatterns = [
    /overloaded/i,
    /rate limit/i,
    /temporar(?:y|ily) unavailable/i,
    /connection reset/i,
    /econnreset/i,
    /etimedout/i,
    /timed out while/i,
    /network error/i,
    /socket hang up/i,
    /try again later/i,
    /api error:\s*50\d/i,
    /upstream request failed/i,
    /upstream_error/i,
    /bad gateway/i,
    /gateway timeout/i
  ];

  if (!transientPatterns.some((pattern) => pattern.test(combined))) {
    return null;
  }

  return {
    reason: 'claude-transient-subprocess-exit',
    message: `Claude subprocess exited transiently: ${result?.stderr || result?.stdout || `code ${result?.exitCode}`}`
  };
}

function resolveArgsOption(value, input, fallback) {
  const resolved = typeof value === 'function' ? value(input) : value;
  if (resolved == null) {
    return fallback;
  }

  if (!Array.isArray(resolved)) {
    throw new Error('Claude Code adapter args must resolve to an array.');
  }

  return resolved.map((item) => String(item));
}

function normalizeOptionalText(value) {
  if (value == null) {
    return null;
  }

  const text = String(value).trim();
  return text || null;
}
