import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDbPath, resolveWorkspaceIdentity } from '../storage/db.js';
import {
  CLAUDE_RUNTIME_DEFAULTS,
  CLAUDE_RUNTIME_ENV_KEYS,
  resolveDefaultClaudeRuntimeAdapterModule,
  resolveDefaultClaudeRuntimeArgs,
  resolveDefaultClaudeRuntimeCommand
} from '../runtime/claude-runtime-config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.dirname(__dirname);

export function getClaudeRuntimeProfile(options = {}) {
  const env = getObject(options.env) || process.env;
  const workspacePath = resolveAbsolutePath(
    options.workspacePath,
    env[CLAUDE_RUNTIME_ENV_KEYS.workspacePath],
    rootDir
  );
  const workspaceIdentity = resolveWorkspaceIdentity({ workspacePath });
  const dbPath = resolveDbPath({
    dbPath: getOptionalText(options.dbPath) || getOptionalText(env[CLAUDE_RUNTIME_ENV_KEYS.dbPath]),
    workspacePath
  });
  const adapterModulePath = resolveAbsolutePath(
    options.adapterModulePath,
    env[CLAUDE_RUNTIME_ENV_KEYS.adapterModule],
    resolveDefaultClaudeRuntimeAdapterModule(rootDir)
  );
  const agentId = getOptionalText(options.agentId)
    || getOptionalText(env[CLAUDE_RUNTIME_ENV_KEYS.agentId])
    || CLAUDE_RUNTIME_DEFAULTS.agentId;
  const agentName = getOptionalText(options.agentName)
    || getOptionalText(env[CLAUDE_RUNTIME_ENV_KEYS.agentName])
    || CLAUDE_RUNTIME_DEFAULTS.agentName;
  const agentRole = getOptionalText(options.agentRole)
    || getOptionalText(env[CLAUDE_RUNTIME_ENV_KEYS.agentRole])
    || CLAUDE_RUNTIME_DEFAULTS.agentRole;
  const maxConcurrency = getPositiveInteger(
    options.maxConcurrency,
    env[CLAUDE_RUNTIME_ENV_KEYS.maxConcurrency],
    CLAUDE_RUNTIME_DEFAULTS.maxConcurrency
  );
  const command = getOptionalText(options.command)
    || getOptionalText(env[CLAUDE_RUNTIME_ENV_KEYS.command])
    || resolveDefaultClaudeRuntimeCommand(env);
  const commandArgs = getStringArray(
    options.commandArgs,
    parseJsonStringArray(env[CLAUDE_RUNTIME_ENV_KEYS.commandArgsJson], CLAUDE_RUNTIME_ENV_KEYS.commandArgsJson),
    resolveDefaultClaudeRuntimeArgs(env)
  );
  const timeoutMs = getPositiveInteger(
    options.timeoutMs,
    env[CLAUDE_RUNTIME_ENV_KEYS.timeoutMs],
    CLAUDE_RUNTIME_DEFAULTS.timeoutMs
  );
  const taskExecutionTimeoutMs = getPositiveInteger(
    options.taskExecutionTimeoutMs,
    env[CLAUDE_RUNTIME_ENV_KEYS.taskExecutionTimeoutMs],
    CLAUDE_RUNTIME_DEFAULTS.taskExecutionTimeoutMs
  );
  const maxTaskRetries = getNonNegativeInteger(
    options.maxTaskRetries,
    env[CLAUDE_RUNTIME_ENV_KEYS.maxTaskRetries],
    CLAUDE_RUNTIME_DEFAULTS.maxTaskRetries
  );
  const host = getOptionalText(options.host)
    || getOptionalText(env[CLAUDE_RUNTIME_ENV_KEYS.host])
    || CLAUDE_RUNTIME_DEFAULTS.host;
  const port = getPositiveInteger(options.port, env[CLAUDE_RUNTIME_ENV_KEYS.port], CLAUDE_RUNTIME_DEFAULTS.port);
  const systemInstruction = getOptionalText(options.systemInstruction)
    || getOptionalText(env[CLAUDE_RUNTIME_ENV_KEYS.systemInstruction])
    || CLAUDE_RUNTIME_DEFAULTS.systemInstruction;

  return {
    rootDir,
    workspacePath,
    canonicalWorkspacePath: workspaceIdentity.workspacePath,
    workspaceKey: workspaceIdentity.workspaceKey,
    dbPath,
    adapterModulePath,
    command,
    commandArgs,
    timeoutMs,
    taskExecutionTimeoutMs,
    maxTaskRetries,
    systemInstruction,
    host,
    port,
    agent: {
      agentId,
      name: agentName,
      role: agentRole,
      capabilities: [...CLAUDE_RUNTIME_DEFAULTS.agentCapabilities],
      adapterModule: adapterModulePath,
      maxConcurrency,
      status: CLAUDE_RUNTIME_DEFAULTS.agentStatus
    }
  };
}

export function buildClaudeRuntimeRegisterAgentInput(profile = getClaudeRuntimeProfile()) {
  return {
    agentId: profile.agent.agentId,
    name: profile.agent.name,
    role: profile.agent.role,
    capabilities: [...profile.agent.capabilities],
    adapterModule: profile.agent.adapterModule,
    maxConcurrency: profile.agent.maxConcurrency,
    status: profile.agent.status
  };
}

export function applyClaudeRuntimeWorkingDirectory(profile = getClaudeRuntimeProfile()) {
  if (path.resolve(process.cwd()) !== path.resolve(profile.rootDir)) {
    process.chdir(profile.rootDir);
  }
  return profile;
}

function resolveAbsolutePath(...candidates) {
  for (const candidate of candidates) {
    const text = getOptionalText(candidate);
    if (text) {
      return path.resolve(text);
    }
  }

  return path.resolve(rootDir);
}

function parseJsonStringArray(value, envKey) {
  const text = getOptionalText(value);
  if (!text) {
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${envKey} must be valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  return getStringArray(parsed, null, null);
}

function getStringArray(...candidates) {
  for (const candidate of candidates) {
    if (candidate == null) {
      continue;
    }

    if (!Array.isArray(candidate)) {
      throw new Error('Claude runtime command args must be an array of strings.');
    }

    return candidate.map((item) => String(item));
  }

  return [];
}

function getPositiveInteger(...candidates) {
  for (const candidate of candidates) {
    if (candidate == null || candidate === '') {
      continue;
    }

    const number = Number(candidate);
    if (!Number.isInteger(number) || number <= 0) {
      throw new Error('Claude runtime numeric settings must be positive integers.');
    }

    return number;
  }

  return undefined;
}

function getNonNegativeInteger(...candidates) {
  for (const candidate of candidates) {
    if (candidate == null || candidate === '') {
      continue;
    }

    const number = Number(candidate);
    if (!Number.isInteger(number) || number < 0) {
      throw new Error('Claude runtime retry settings must be non-negative integers.');
    }

    return number;
  }

  return undefined;
}

function getObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value;
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
