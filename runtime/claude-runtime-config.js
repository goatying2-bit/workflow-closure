import fs from 'node:fs';
import path from 'node:path';
import {
  ADMIN_SERVER_DEFAULT_HOST,
  ADMIN_SERVER_DEFAULT_PORT
} from '../server/admin-server-config.js';

export const CLAUDE_RUNTIME_ENV_KEYS = Object.freeze({
  workspacePath: 'WORKFLOW_CLOSURE_CLAUDE_WORKSPACE_PATH',
  dbPath: 'WORKFLOW_CLOSURE_CLAUDE_DB_PATH',
  adapterModule: 'WORKFLOW_CLOSURE_CLAUDE_ADAPTER_MODULE',
  agentId: 'WORKFLOW_CLOSURE_CLAUDE_AGENT_ID',
  agentName: 'WORKFLOW_CLOSURE_CLAUDE_AGENT_NAME',
  agentRole: 'WORKFLOW_CLOSURE_CLAUDE_AGENT_ROLE',
  maxConcurrency: 'WORKFLOW_CLOSURE_CLAUDE_MAX_CONCURRENCY',
  command: 'WORKFLOW_CLOSURE_CLAUDE_COMMAND',
  commandArgsJson: 'WORKFLOW_CLOSURE_CLAUDE_ARGS_JSON',
  timeoutMs: 'WORKFLOW_CLOSURE_CLAUDE_TIMEOUT_MS',
  taskExecutionTimeoutMs: 'WORKFLOW_CLOSURE_CLAUDE_TASK_EXECUTION_TIMEOUT_MS',
  maxTaskRetries: 'WORKFLOW_CLOSURE_CLAUDE_MAX_TASK_RETRIES',
  host: 'WORKFLOW_CLOSURE_CLAUDE_HOST',
  port: 'WORKFLOW_CLOSURE_CLAUDE_PORT',
  systemInstruction: 'WORKFLOW_CLOSURE_CLAUDE_SYSTEM_INSTRUCTION'
});

export const CLAUDE_RUNTIME_DEFAULTS = Object.freeze({
  agentId: 'claude-code',
  agentName: 'Claude Code',
  agentRole: 'implementation',
  agentCapabilities: Object.freeze(['claude-code', 'workflow-closure']),
  agentStatus: 'active',
  maxConcurrency: 1,
  timeoutMs: 600_000,
  taskExecutionTimeoutMs: 630_000,
  maxTaskRetries: 10,
  host: ADMIN_SERVER_DEFAULT_HOST,
  port: ADMIN_SERVER_DEFAULT_PORT,
  systemInstruction: 'You are a workflow-closure adapter. Complete the assigned task and return only the required JSON result. Never return prose or markdown outside the JSON. If the task produces a final document or file, include its content in taskOutputs or payload.outputs, include its path, and list the artifact path in handoff.artifacts.'
});

export function resolveDefaultClaudeRuntimeAdapterModule(rootDir) {
  return path.join(rootDir, 'scripts', 'claude-runtime-adapter-module.js');
}

export function resolveDefaultClaudeRuntimeCommand(env = process.env) {
  const jsEntrypoint = resolveInstalledClaudeJsEntrypoint(env);
  if (jsEntrypoint) {
    return process.execPath;
  }

  const candidates = [
    path.join(env.APPDATA || '', 'npm', 'claude.cmd'),
    path.join(env.APPDATA || '', 'npm', 'claude'),
    'claude'
  ];

  for (const candidate of candidates) {
    const text = getOptionalText(candidate);
    if (!text) {
      continue;
    }

    if (path.isAbsolute(text)) {
      if (fs.existsSync(text)) {
        return path.resolve(text);
      }
      continue;
    }

    return text;
  }

  return 'claude';
}

export function resolveDefaultClaudeRuntimeArgs(env = process.env) {
  const jsEntrypoint = resolveInstalledClaudeJsEntrypoint(env);
  if (jsEntrypoint) {
    return [jsEntrypoint, '--print'];
  }

  return ['--print'];
}

export function resolveInstalledClaudeJsEntrypoint(env = process.env) {
  const candidates = [
    path.join(env.APPDATA || '', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js')
  ];

  for (const candidate of candidates) {
    const text = getOptionalText(candidate);
    if (text && path.isAbsolute(text) && fs.existsSync(text)) {
      return path.resolve(text);
    }
  }

  return null;
}

function getOptionalText(value) {
  if (value == null || value === false) {
    return null;
  }

  const text = String(value).trim();
  return text || null;
}
