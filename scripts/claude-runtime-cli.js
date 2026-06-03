import path from 'node:path';
import { spawn } from 'node:child_process';
import { CLAUDE_RUNTIME_ENV_KEYS } from '../runtime/claude-runtime-config.js';
import { getClaudeRuntimeProfile } from './claude-runtime-profile.js';

export async function runClaudeRuntimeCli(command, input = {}, profile = getClaudeRuntimeProfile()) {
  const cliPath = path.join(profile.rootDir, 'cli.js');
  const payload = {
    workspacePath: profile.workspacePath,
    dbPath: profile.dbPath,
    ...input
  };
  const args = [cliPath, command, '--input', JSON.stringify(payload)];

  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: profile.rootDir,
      env: buildClaudeRuntimeChildEnv(profile),
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });

    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });

    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });

  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || `CLI command failed: ${command}`);
  }
  return JSON.parse(result.stdout);
}

function buildClaudeRuntimeChildEnv(profile) {
  const env = {
    ...process.env,
    [CLAUDE_RUNTIME_ENV_KEYS.workspacePath]: profile.workspacePath,
    [CLAUDE_RUNTIME_ENV_KEYS.dbPath]: profile.dbPath,
    [CLAUDE_RUNTIME_ENV_KEYS.adapterModule]: profile.adapterModulePath,
    [CLAUDE_RUNTIME_ENV_KEYS.command]: profile.command,
    [CLAUDE_RUNTIME_ENV_KEYS.commandArgsJson]: JSON.stringify(profile.commandArgs || []),
    [CLAUDE_RUNTIME_ENV_KEYS.timeoutMs]: String(profile.timeoutMs),
    [CLAUDE_RUNTIME_ENV_KEYS.taskExecutionTimeoutMs]: String(profile.taskExecutionTimeoutMs),
    [CLAUDE_RUNTIME_ENV_KEYS.maxTaskRetries]: String(profile.maxTaskRetries),
    [CLAUDE_RUNTIME_ENV_KEYS.systemInstruction]: profile.systemInstruction,
    [CLAUDE_RUNTIME_ENV_KEYS.host]: profile.host,
    [CLAUDE_RUNTIME_ENV_KEYS.port]: String(profile.port)
  };

  if (profile.agent?.agentId) {
    env[CLAUDE_RUNTIME_ENV_KEYS.agentId] = profile.agent.agentId;
  }
  if (profile.agent?.name) {
    env[CLAUDE_RUNTIME_ENV_KEYS.agentName] = profile.agent.name;
  }
  if (profile.agent?.role) {
    env[CLAUDE_RUNTIME_ENV_KEYS.agentRole] = profile.agent.role;
  }
  if (profile.agent?.maxConcurrency != null) {
    env[CLAUDE_RUNTIME_ENV_KEYS.maxConcurrency] = String(profile.agent.maxConcurrency);
  }

  return env;
}
