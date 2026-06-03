#!/usr/bin/env node
import { getAgentStore } from '../index.js';
import { applyClaudeRuntimeWorkingDirectory, getClaudeRuntimeProfile } from './claude-runtime-profile.js';
import { ensureClaudeRuntimeAgent } from './claude-runtime-agent.js';
import { runClaudeRuntimeCli } from './claude-runtime-cli.js';

async function main() {
  const profile = applyClaudeRuntimeWorkingDirectory(getClaudeRuntimeProfile());
  const flags = parseFlags(process.argv.slice(2));

  await ensureClaudeRuntimeAgent(profile);

  const result = await runCoordinatorLoop(flags, profile);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function runCoordinatorLoop(flags, profile) {
  const maxCoordinatorLoops = Number.isFinite(Number(flags.maxCoordinatorLoops)) && Number(flags.maxCoordinatorLoops) > 0
    ? Math.floor(Number(flags.maxCoordinatorLoops))
    : 8;
  const cooldownPollMs = Number.isFinite(Number(flags.cooldownPollMs)) && Number(flags.cooldownPollMs) >= 0
    ? Math.floor(Number(flags.cooldownPollMs))
    : 1000;

  let lastResult = null;
  for (let attempt = 0; attempt < maxCoordinatorLoops; attempt += 1) {
    const isResumeCommand = flags.resume === true || (attempt > 0 && shouldResumeFromPreviousResult(lastResult));
    const command = isResumeCommand ? 'resume-assigned-work' : 'run-next-assignment';
    const input = buildCommandInput(flags, profile, lastResult, isResumeCommand);
    const result = await runClaudeRuntimeCli(command, input, profile);

    result.loop = {
      attempt: attempt + 1,
      maxAttempts: maxCoordinatorLoops,
      autoResumed: attempt > 0 && isResumeCommand
    };

    if (result.status === 'cooldown') {
      return result;
    }

    if (result.status === 'blocked' && shouldResumeFromPreviousResult(result)) {
      lastResult = result;
      continue;
    }

    return result;
  }

  return lastResult;
}

function buildCommandInput(flags, profile, lastResult = null, isResumeCommand = false) {
  const input = {
    agentId: profile.agent.agentId,
    adapterModule: profile.adapterModulePath,
    taskExecutionTimeoutMs: profile.taskExecutionTimeoutMs,
    maxTaskRetries: profile.maxTaskRetries,
    ...(flags.assignmentId ? { assignmentId: flags.assignmentId } : {}),
    ...(flags.targetType ? { targetType: flags.targetType } : {}),
    ...(flags.workflowId ? { workflowId: flags.workflowId } : {}),
    ...(flags.chainId ? { chainId: flags.chainId } : {}),
    ...(flags.taskId ? { taskId: flags.taskId } : {}),
    ...(flags.stageId ? { stageId: flags.stageId } : {}),
    ...(flags.mode ? { mode: flags.mode } : {}),
    ...(flags.message ? { message: flags.message } : {}),
    ...(flags.reason ? { reason: flags.reason } : {}),
    ...(flags.payload ? { payload: flags.payload } : {}),
    ...(flags.maxStages != null ? { maxStages: flags.maxStages } : {}),
    ...(flags.maxWorkflowSteps != null ? { maxWorkflowSteps: flags.maxWorkflowSteps } : {}),
    ...(flags.maxTaskRetries != null ? { maxTaskRetries: flags.maxTaskRetries } : {}),
    ...(flags.taskExecutionTimeoutMs != null ? { taskExecutionTimeoutMs: flags.taskExecutionTimeoutMs } : {}),
    ...(isResumeCommand ? { runNow: true } : {})
  };

  if (isResumeCommand) {
    applyResumeTarget(input, profile, flags, lastResult);
  }

  return input;
}

function applyResumeTarget(input, profile, flags, lastResult = null) {
  if (flags.assignmentId) {
    applyResumeTargetFromAssignment(input, profile, flags.assignmentId);
    return;
  }

  const target = lastResult?.target || null;
  if (!target || typeof target !== 'object') {
    return;
  }

  if (!input.targetType && target.targetType) {
    input.targetType = target.targetType;
  }
  if (!input.workflowId && target.workflowId) {
    input.workflowId = target.workflowId;
  }
  if (!input.chainId && target.chainId) {
    input.chainId = target.chainId;
  }
  if (!input.stageId && target.stageId) {
    input.stageId = target.stageId;
  }
  if (!input.taskId && target.taskId) {
    input.taskId = target.taskId;
  }
}

function shouldResumeFromPreviousResult(result) {
  if (!result || result.status !== 'blocked') {
    return false;
  }

  if (result.nextAction === 'wait_for_recovery') {
    return true;
  }

  const recoveryStatus = result.recoveryStatus;
  return recoveryStatus?.phase === 'cooldown';
}

function normalizeWaitMs(waitMs, fallbackMs) {
  const value = Number(waitMs);
  if (Number.isFinite(value) && value > 0) {
    return Math.min(Math.max(Math.floor(value), 50), 5_000);
  }
  return Math.max(fallbackMs, 50);
}

function applyResumeTargetFromAssignment(input, profile, assignmentId) {
  const agentStore = getAgentStore({ dbPath: profile.dbPath });
  const assignment = agentStore.getAssignment(assignmentId);
  if (!assignment) {
    throw new Error(`Assignment not found: ${assignmentId}`);
  }

  if (!input.targetType && assignment.targetType) {
    input.targetType = assignment.targetType;
  }

  if (!input.workflowId && assignment.workflowId) {
    input.workflowId = assignment.workflowId;
  }

  if (!input.chainId && assignment.chainId) {
    input.chainId = assignment.chainId;
  }

  if (assignment.targetType === 'stage') {
    if (!input.stageId && (assignment.stageId || assignment.targetId)) {
      input.stageId = assignment.stageId || assignment.targetId;
    }
  }

  if (assignment.targetType === 'task') {
    if (!input.taskId && assignment.targetId) {
      input.taskId = assignment.targetId;
    }
  }
}

function parseFlags(argv) {
  const flags = {};
  const args = [...argv];

  while (args.length > 0) {
    const token = String(args.shift());
    if (!token.startsWith('--')) {
      throw new Error(`Unexpected positional argument: ${token}`);
    }

    if (token === '--resume') {
      flags.resume = true;
      continue;
    }

    const key = toCamelCase(token.slice(2));
    const value = args.shift();
    if (value == null || String(value).startsWith('--')) {
      throw new Error(`Missing value for ${token}`);
    }

    if (key === 'payloadJson') {
      flags.payload = parseJsonObject(value, token);
      continue;
    }

    if (key === 'maxStages' || key === 'maxWorkflowSteps' || key === 'maxTaskRetries' || key === 'taskExecutionTimeoutMs' || key === 'maxCoordinatorLoops' || key === 'cooldownPollMs') {
      const number = Number(value);
      if (!Number.isFinite(number)) {
        throw new Error(`${token} must be a number.`);
      }
      flags[key] = number;
      continue;
    }

    flags[key] = String(value);
  }

  return flags;
}

function parseJsonObject(source, label) {
  let value;
  try {
    value = JSON.parse(String(source));
  } catch (error) {
    throw new Error(`Failed to parse ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }

  return value;
}

function toCamelCase(value) {
  return String(value).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
