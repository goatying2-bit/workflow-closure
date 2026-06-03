import { spawn } from 'node:child_process';
import os from 'node:os';

const TASK_BOUNDARY_REASON_CODES = {
  missingDoneSummary: 'task_boundary_missing_done_summary',
  missingRequiredArtifact: 'task_boundary_missing_required_artifact',
  forbiddenAction: 'task_boundary_forbidden_action',
  assumptionViolation: 'task_boundary_assumption_violation'
};

const DEFAULT_WORKFLOW_CLOSURE_POLICY = Object.freeze({
  closureMode: 'small_loop',
  verificationLevel: 'targeted',
  docPolicy: 'minimal',
  cleanupPolicy: 'defer'
});

export function createVerifier(handler) {
  if (typeof handler !== 'function') {
    throw new Error('Verifier handler must be a function.');
  }

  return {
    async run(input) {
      const result = await handler(input);
      return normalizeVerifierResult(result);
    }
  };
}

export function createPassThroughVerifier() {
  return createVerifier(async () => ({
    status: 'passed',
    reason: null,
    reasonCode: null,
    message: null,
    payload: null
  }));
}

export function createTaskBoundaryVerifier() {
  return createVerifier(async ({ task, result }) => {
    const contract = normalizeTaskContract(task?.contract);
    if (!contract || result?.status !== 'done') {
      return {
        status: 'passed',
        payload: {
          verifier: 'task-boundary',
          contract,
          checked: false,
          resultStatus: result?.status || null
        }
      };
    }

    const doneSummary = normalizeOptionalText(result?.doneSummary);
    if (!doneSummary) {
      return {
        status: 'failed',
        reason: '任务缺少明确的 doneSummary。',
        reasonCode: TASK_BOUNDARY_REASON_CODES.missingDoneSummary,
        payload: {
          verifier: 'task-boundary',
          contract,
          checked: true,
          failedCheck: 'doneSummary'
        }
      };
    }

    const reportedArtifacts = collectReportedArtifacts(result);
    const missingRequiredArtifacts = contract.requiredArtifacts.filter((artifact) => !reportedArtifacts.includes(artifact));
    if (missingRequiredArtifacts.length > 0) {
      return {
        status: 'failed',
        reason: `任务缺少必需交付物：${missingRequiredArtifacts.join('；')}`,
        reasonCode: TASK_BOUNDARY_REASON_CODES.missingRequiredArtifact,
        payload: {
          verifier: 'task-boundary',
          contract,
          checked: true,
          failedCheck: 'requiredArtifacts',
          requiredArtifacts: contract.requiredArtifacts,
          reportedArtifacts,
          missingRequiredArtifacts
        }
      };
    }

    const reportedForbiddenActions = collectReportedForbiddenActions(result);
    const hitForbiddenActions = contract.forbiddenActions.filter((action) => reportedForbiddenActions.includes(action));
    if (hitForbiddenActions.length > 0) {
      return {
        status: 'failed',
        reason: `任务命中了禁止动作：${hitForbiddenActions.join('；')}`,
        reasonCode: TASK_BOUNDARY_REASON_CODES.forbiddenAction,
        payload: {
          verifier: 'task-boundary',
          contract,
          checked: true,
          failedCheck: 'forbiddenActions',
          forbiddenActions: contract.forbiddenActions,
          reportedForbiddenActions,
          hitForbiddenActions
        }
      };
    }

    const assumptionSignals = collectAssumptionSignals(result);
    if (contract.assumptionsPolicy === 'block_on_missing_information' && (assumptionSignals.assumptionsMade.length > 0 || assumptionSignals.assumedMissingInformation === true)) {
      return {
        status: 'failed',
        reason: '任务在信息不足策略要求阻塞时仍做了假设。',
        reasonCode: TASK_BOUNDARY_REASON_CODES.assumptionViolation,
        payload: {
          verifier: 'task-boundary',
          contract,
          checked: true,
          failedCheck: 'assumptionsPolicy',
          assumptionsPolicy: contract.assumptionsPolicy,
          assumptionsMade: assumptionSignals.assumptionsMade,
          assumedMissingInformation: assumptionSignals.assumedMissingInformation
        }
      };
    }

    return {
      status: 'passed',
      payload: {
        verifier: 'task-boundary',
        contract,
        checked: true,
        reportedArtifacts,
        reportedForbiddenActions,
        assumptionsMade: assumptionSignals.assumptionsMade,
        assumedMissingInformation: assumptionSignals.assumedMissingInformation
      }
    };
  });
}

export function createCompositeVerifier(entries = []) {
  const normalizedEntries = Array.isArray(entries)
    ? entries
      .filter((entry) => entry?.verifier)
      .map((entry, index) => ({
        name: normalizeOptionalText(entry.name) || `verifier-${index + 1}`,
        verifier: resolveVerifier(entry.verifier)
      }))
    : [];

  if (normalizedEntries.length === 0) {
    return createPassThroughVerifier();
  }

  if (normalizedEntries.length === 1) {
    return normalizedEntries[0].verifier;
  }

  return createVerifier(async (input) => {
    const workflowClosurePolicy = resolveWorkflowClosurePolicy(input?.workflowClosurePolicy, input?.workflow?.initialPlan?.metadata);
    const verificationInput = {
      ...input,
      workflowClosurePolicy
    };
    const results = [];

    for (const entry of normalizedEntries) {
      const result = await entry.verifier.run(verificationInput);
      results.push({
        name: entry.name,
        ...result
      });
    }

    const failed = results.find((item) => item.status === 'failed') || null;

    return {
      status: failed ? 'failed' : 'passed',
      reason: failed?.reason || null,
      reasonCode: failed?.reasonCode || null,
      message: failed?.message || null,
      payload: {
        workflowClosurePolicy,
        results,
        byName: Object.fromEntries(results.map((item) => [item.name, {
          status: item.status,
          reason: item.reason,
          reasonCode: item.reasonCode,
          message: item.message,
          payload: item.payload
        }]))
      }
    };
  });
}

export function createNodeTestVerifier(options = {}) {
  return createVerifier(async (input) => {
    const args = resolveCommandArgs(options.args, input, ['--test']);
    const cwd = resolveOptionalTextOption(options.cwd, input);
    const env = resolveEnvOption(options.env, input);
    const timeoutMs = resolveTimeoutOption(options.timeoutMs, input);
    const result = await runCommand({
      command: process.execPath,
      args,
      cwd,
      env,
      timeoutMs
    });

    if (result.exitCode === 0) {
      return {
        status: 'passed',
        payload: {
          verifier: 'node-test',
          command: process.execPath,
          args,
          cwd,
          ...result
        }
      };
    }

    return {
      status: 'failed',
      reason: buildFailureReason(options.failureReason, input, `Node verifier failed with exit code ${result.exitCode}.`),
      payload: {
        verifier: 'node-test',
        command: process.execPath,
        args,
        cwd,
        ...result
      }
    };
  });
}

export function createBashCommandVerifier(options = {}) {
  return createVerifier(async (input) => {
    const command = resolveCommandText(options.command, input);
    const shellPath = resolveOptionalTextOption(options.shellPath, input) || getDefaultShell();
    const cwd = resolveOptionalTextOption(options.cwd, input);
    const env = resolveEnvOption(options.env, input);
    const timeoutMs = resolveTimeoutOption(options.timeoutMs, input);

    if (/[;&|<>$`\n\r]/.test(command)) {
      throw new Error('Bash command verifier command contains potentially unsafe shell metacharacters.');
    }

    const shellConfig = getShellArgs(shellPath, command);
    const result = await runCommand({
      command: shellPath,
      args: shellConfig.args,
      cwd,
      env,
      timeoutMs
    });

    if (result.exitCode === 0) {
      return {
        status: 'passed',
        payload: {
          verifier: 'bash-command',
          shellPath,
          command,
          cwd,
          ...result
        }
      };
    }

    return {
      status: 'failed',
      reason: buildFailureReason(options.failureReason, input, `Bash verifier failed with exit code ${result.exitCode}.`),
      payload: {
        verifier: 'bash-command',
        shellPath,
        command,
        cwd,
        ...result
      }
    };
  });
}

export function createValidationCommandsVerifier(options = {}) {
  return createVerifier(async (input) => {
    const workflowClosurePolicy = resolveWorkflowClosurePolicy(input?.workflowClosurePolicy, input?.workflow?.initialPlan?.metadata);
    const commands = resolveValidationCommands(options.commands, input);
    const env = resolveEnvOption(options.env, input);
    const results = [];

    for (const commandConfig of commands) {
      const result = await runCommand({
        command: commandConfig.command,
        args: commandConfig.args,
        cwd: commandConfig.cwd,
        env,
        timeoutMs: commandConfig.timeoutMs
      });
      const commandResult = {
        id: commandConfig.id,
        command: commandConfig.command,
        args: commandConfig.args,
        script: commandConfig.script,
        cwd: commandConfig.cwd,
        reason: commandConfig.reason,
        required: commandConfig.required,
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut,
        stdout: excerptText(result.stdout, 2000),
        stderr: excerptText(result.stderr, 2000)
      };
      results.push(commandResult);

      if (commandConfig.required && result.exitCode !== 0) {
        return {
          status: 'failed',
          reason: `Validation command failed: ${commandConfig.id}.`,
          reasonCode: 'validation_command_failed',
          payload: {
            verifier: 'validation-commands',
            workflowClosurePolicy,
            verificationLevel: workflowClosurePolicy.verificationLevel,
            failedCommand: commandResult,
            results
          }
        };
      }
    }

    return {
      status: 'passed',
      payload: {
        verifier: 'validation-commands',
        workflowClosurePolicy,
        verificationLevel: workflowClosurePolicy.verificationLevel,
        checked: commands.length > 0,
        results
      }
    };
  });
}

export function normalizeVerifierResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error('Verifier must return an object result.');
  }

  const status = normalizeOptionalText(result.status);
  if (status !== 'passed' && status !== 'failed') {
    throw new Error('Verifier result status must be "passed" or "failed".');
  }

  return {
    status,
    reason: normalizeOptionalText(result.reason),
    reasonCode: normalizeOptionalText(result.reasonCode),
    message: normalizeOptionalText(result.message),
    payload: result.payload ?? null
  };
}

export function resolveVerifier(verifier) {
  if (!verifier) {
    return createPassThroughVerifier();
  }

  if (typeof verifier.run === 'function') {
    return {
      async run(input) {
        return normalizeVerifierResult(await verifier.run(input));
      }
    };
  }

  if (typeof verifier === 'function') {
    return createVerifier(verifier);
  }

  throw new Error('Verifier must be a function or an object with a run() method.');
}

async function runCommand({ command, args, cwd, env, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let killedByTimeout = false;

    const child = spawn(command, args, {
      cwd: cwd || undefined,
      env: env ? { ...process.env, ...env } : process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    const SIGKILL_DELAY_MS = 5_000;
    let sigkillTimer = null;
    const timer = timeoutMs > 0
      ? setTimeout(() => {
        killedByTimeout = true;
        child.kill('SIGTERM');
        sigkillTimer = setTimeout(() => {
          child.kill('SIGKILL');
        }, SIGKILL_DELAY_MS);
      }, timeoutMs)
      : null;

    const MAX_OUTPUT_SIZE = 10 * 1024 * 1024;

    child.stdout?.on('data', (chunk) => {
      if (stdout.length < MAX_OUTPUT_SIZE) {
        stdout += String(chunk);
      }
    });

    child.stderr?.on('data', (chunk) => {
      if (stderr.length < MAX_OUTPUT_SIZE) {
        stderr += String(chunk);
      }
    });

    child.on('error', (error) => {
      if (timer) {
        clearTimeout(timer);
      }
      if (sigkillTimer) {
        clearTimeout(sigkillTimer);
      }
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    });

    child.on('close', (code, signal) => {
      if (timer) {
        clearTimeout(timer);
      }
      if (sigkillTimer) {
        clearTimeout(sigkillTimer);
      }
      if (settled) {
        return;
      }
      settled = true;
      resolve({
        exitCode: Number.isInteger(code) ? code : null,
        signal: signal || null,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        timedOut: killedByTimeout
      });
    });
  });
}

function collectReportedArtifacts(result) {
  const rawHandoff = resolveVerifierResultHandoff(result);
  return dedupeStrings([
    ...normalizeStringArray(rawHandoff?.artifacts),
    ...normalizeStringArray(result?.payload?.artifacts),
    ...normalizeStringArray(result?.payload?.workerPayload?.artifacts)
  ]);
}

function collectReportedForbiddenActions(result) {
  const rawHandoff = resolveVerifierResultHandoff(result);
  return dedupeStrings([
    ...normalizeStringArray(result?.payload?.forbiddenActions),
    ...normalizeStringArray(result?.payload?.metadata?.forbiddenActions),
    ...normalizeStringArray(result?.payload?.workerPayload?.forbiddenActions),
    ...normalizeStringArray(result?.payload?.workerPayload?.metadata?.forbiddenActions),
    ...normalizeStringArray(rawHandoff?.forbiddenActions),
    ...normalizeStringArray(rawHandoff?.metadata?.forbiddenActions)
  ]);
}

function collectAssumptionSignals(result) {
  const rawHandoff = resolveVerifierResultHandoff(result);
  const assumptionsMade = dedupeStrings([
    ...normalizeStringArray(result?.payload?.assumptionsMade),
    ...normalizeStringArray(result?.payload?.metadata?.assumptionsMade),
    ...normalizeStringArray(result?.payload?.workerPayload?.assumptionsMade),
    ...normalizeStringArray(result?.payload?.workerPayload?.metadata?.assumptionsMade),
    ...normalizeStringArray(rawHandoff?.assumptionsMade),
    ...normalizeStringArray(rawHandoff?.metadata?.assumptionsMade)
  ]);
  const assumedMissingInformation = [
    result?.payload?.assumedMissingInformation,
    result?.payload?.metadata?.assumedMissingInformation,
    result?.payload?.workerPayload?.assumedMissingInformation,
    result?.payload?.workerPayload?.metadata?.assumedMissingInformation,
    rawHandoff?.assumedMissingInformation,
    rawHandoff?.metadata?.assumedMissingInformation
  ].some((item) => item === true);

  return {
    assumptionsMade,
    assumedMissingInformation
  };
}

function resolveVerifierResultHandoff(result) {
  return result?.handoff
    ?? result?.payload?.handoff
    ?? result?.payload?.workerPayload?.handoff
    ?? null;
}

function resolveWorkflowClosurePolicy(explicit, metadata) {
  const source = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? metadata
    : explicit && typeof explicit === 'object' && !Array.isArray(explicit)
      ? explicit
      : null;

  return {
    closureMode: normalizeWorkflowClosureMode(source?.closureMode),
    verificationLevel: normalizeWorkflowVerificationLevel(source?.verificationLevel),
    docPolicy: normalizeWorkflowDocPolicy(source?.docPolicy),
    cleanupPolicy: normalizeWorkflowCleanupPolicy(source?.cleanupPolicy)
  };
}

function normalizeWorkflowClosureMode(value) {
  return value === 'large_loop' ? 'large_loop' : DEFAULT_WORKFLOW_CLOSURE_POLICY.closureMode;
}

function normalizeWorkflowVerificationLevel(value) {
  return value === 'broad' ? 'broad' : DEFAULT_WORKFLOW_CLOSURE_POLICY.verificationLevel;
}

function normalizeWorkflowDocPolicy(value) {
  return value === 'required' ? 'required' : DEFAULT_WORKFLOW_CLOSURE_POLICY.docPolicy;
}

function normalizeWorkflowCleanupPolicy(value) {
  return value === 'explicit_only' ? 'explicit_only' : DEFAULT_WORKFLOW_CLOSURE_POLICY.cleanupPolicy;
}

function normalizeTaskContract(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const contract = {
    successCriteria: normalizeStringArray(value.successCriteria),
    requiredArtifacts: normalizeStringArray(value.requiredArtifacts),
    forbiddenActions: normalizeStringArray(value.forbiddenActions),
    assumptionsPolicy: normalizeAssumptionsPolicy(value.assumptionsPolicy),
    validationCommands: normalizeValidationCommands(value.validationCommands)
  };

  return contract.successCriteria.length > 0
    || contract.requiredArtifacts.length > 0
    || contract.forbiddenActions.length > 0
    || contract.assumptionsPolicy
    || contract.validationCommands.length > 0
    ? contract
    : null;
}

function resolveValidationCommands(value, input) {
  const explicit = resolveOptionValue(value, input);
  const commands = explicit ?? input?.task?.contract?.validationCommands ?? [];
  return normalizeValidationCommands(commands);
}

function normalizeValidationCommands(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((item) => normalizeValidationCommand(item));
}

function normalizeValidationCommand(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Validation command must be an object.');
  }

  const command = normalizeOptionalText(value.command);
  if (!command) {
    throw new Error('Validation command requires command.');
  }

  const args = normalizeStringArray(value.args);
  return {
    id: normalizeOptionalText(value.id) || [command, ...args].join('-'),
    command,
    args,
    script: normalizeOptionalText(value.script),
    cwd: normalizeOptionalText(value.cwd),
    required: value.required !== false,
    timeoutMs: normalizeValidationTimeout(value.timeoutMs),
    reason: normalizeOptionalText(value.reason)
  };
}

function normalizeValidationTimeout(value) {
  if (value == null) {
    return 0;
  }

  const timeoutMs = Number(value);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new Error('Validation command timeoutMs must be a non-negative number.');
  }
  return Math.floor(timeoutMs);
}

function normalizeAssumptionsPolicy(value) {
  if (value == null) {
    return null;
  }

  const normalized = String(value).trim();
  if (!normalized) {
    return null;
  }

  return normalized === 'block_on_missing_information' || normalized === 'allow_reasonable_assumptions'
    ? normalized
    : null;
}

function normalizeStringArray(value) {
  if (value == null) {
    return [];
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => normalizeOptionalText(item))
      .filter(Boolean);
  }

  const text = normalizeOptionalText(value);
  return text ? [text] : [];
}

function dedupeStrings(items) {
  const seen = new Set();
  const output = [];

  for (const item of items) {
    const normalized = normalizeOptionalText(item);
    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    output.push(normalized);
  }

  return output;
}

function resolveCommandText(value, input) {
  const resolved = resolveOptionValue(value, input);
  const text = normalizeOptionalText(resolved);
  if (!text) {
    throw new Error('Bash command verifier requires a non-empty command.');
  }
  return text;
}

function resolveCommandArgs(value, input, fallback) {
  const resolved = resolveOptionValue(value, input);
  if (resolved == null) {
    return [...fallback];
  }

  if (!Array.isArray(resolved)) {
    throw new Error('Verifier args must resolve to an array.');
  }

  return resolved.map((item) => String(item));
}

function resolveEnvOption(value, input) {
  const resolved = resolveOptionValue(value, input);
  if (resolved == null) {
    return null;
  }

  if (!resolved || typeof resolved !== 'object' || Array.isArray(resolved)) {
    throw new Error('Verifier env must resolve to an object.');
  }

  return Object.fromEntries(
    Object.entries(resolved).map(([key, item]) => [key, String(item)])
  );
}

function resolveTimeoutOption(value, input) {
  const resolved = resolveOptionValue(value, input);
  if (resolved == null) {
    return 0;
  }

  const timeoutMs = Number(resolved);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new Error('Verifier timeoutMs must be a non-negative number.');
  }

  return timeoutMs;
}

function resolveOptionalTextOption(value, input) {
  return normalizeOptionalText(resolveOptionValue(value, input));
}

function buildFailureReason(value, input, fallback) {
  return normalizeOptionalText(resolveOptionValue(value, input)) || fallback;
}

function resolveOptionValue(value, input) {
  return typeof value === 'function'
    ? value(input)
    : value;
}

function excerptText(value, maxLength) {
  const text = normalizeOptionalText(value) || '';
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 3)}...`;
}

function getDefaultShell() {
  return os.platform() === 'win32' ? 'powershell' : 'bash';
}

function getShellArgs(shellPath, command) {
  const shell = shellPath.toLowerCase();
  if (shell.includes('powershell') || shell.includes('pwsh')) {
    // PowerShell does not propagate native command exit codes by default.
    // We wrap the command and explicitly exit with $LASTEXITCODE.
    const wrapped = `${command}; exit $LASTEXITCODE`;
    return { args: ['-Command', wrapped] };
  }
  if (shell.includes('cmd')) {
    return { args: ['/c', command] };
  }
  // Default to bash-compatible shells (bash, sh, zsh, etc.)
  return { args: ['-lc', command] };
}

function normalizeOptionalText(value) {
  if (value == null) {
    return null;
  }

  const text = String(value).trim();
  return text || null;
}
