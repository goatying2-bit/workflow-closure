import { spawn } from 'node:child_process';
import { createAgentAdapter, normalizeAdapterResult } from './agent-adapter.js';
import { FAILURE_TYPES } from './retry-policy.js';

const SUBPROCESS_PROTOCOL_VERSION = 'workflow-closure-subprocess-adapter/v1';

export function createSubprocessAdapter(options = {}) {
  return createAgentAdapter(async (input) => {
    let command = null;
    let args = [];
    let cwd = null;
    let env = null;
    let timeoutMs = 0;
    let stdoutMode = 'json';
    let stdoutTransformer = null;

    try {
      command = resolveCommandText(options.command, input);
      args = resolveCommandArgs(options.args, input);
      cwd = resolveOptionalTextOption(options.cwd, input);
      env = resolveEnvOption(options.env, input);
      timeoutMs = resolveTimeoutOption(options.timeoutMs, input);
      stdoutMode = resolveStdoutMode(options.stdoutMode, input);
      stdoutTransformer = resolveStdoutTransformer(options.stdoutTransformer);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return buildBlockedResult({
        input,
        blockedReason: `Subprocess adapter configuration failed for task "${input?.task?.title || 'unknown-task'}".`,
        message,
        payload: {
          adapter: 'subprocess',
          command,
          args,
          cwd,
          stdoutMode,
          error: message,
          timedOut: false
        }
      });
    }

    const stdinText = JSON.stringify({
      protocolVersion: SUBPROCESS_PROTOCOL_VERSION,
      input
    });

    const MAX_STDIN_SIZE = 10 * 1024 * 1024;
    if (stdinText.length > MAX_STDIN_SIZE) {
      return buildBlockedResult({
        input,
        blockedReason: `Subprocess adapter input exceeds maximum size for task "${input?.task?.title || 'unknown-task'}".`,
        message: `Input JSON is ${stdinText.length} bytes, exceeding the ${MAX_STDIN_SIZE} byte limit.`,
        payload: {
          adapter: 'subprocess',
          command,
          args,
          cwd,
          stdoutMode,
          error: 'input-too-large',
          timedOut: false
        }
      });
    }

    let result;
    try {
      result = await runCommand({
        command,
        args,
        cwd,
        env,
        timeoutMs,
        stdinText
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return buildBlockedResult({
        input,
        blockedReason: `Subprocess adapter failed to start for task "${input?.task?.title || 'unknown-task'}".`,
        message: `Subprocess adapter could not spawn command "${command}".`,
        payload: {
          adapter: 'subprocess',
          command,
          args,
          cwd,
          stdoutMode,
          error: message,
          timedOut: false
        }
      });
    }

    if (result.exitCode !== 0) {
      const transientFailure = buildTransientExitFailure(options, input, result, {
        command,
        args,
        cwd,
        stdoutMode,
        timeoutMs
      });
      if (transientFailure) {
        throw transientFailure;
      }

      return buildBlockedResult({
        input,
        blockedReason: buildExitBlockedReason(input, result),
        message: buildExitMessage(result, timeoutMs),
        payload: {
          adapter: 'subprocess',
          command,
          args,
          cwd,
          stdoutMode,
          ...result
        }
      });
    }

    let transformedStdout = result.stdout;
    let transformedParsed;
    let transformedHasParsed = false;

    try {
      const transformed = await transformStdoutResult(stdoutTransformer, result.stdout, {
        input,
        command,
        args,
        cwd,
        env,
        timeoutMs,
        stdoutMode,
        result
      });
      transformedStdout = transformed.stdout;
      transformedParsed = transformed.parsed;
      transformedHasParsed = transformed.hasParsed;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return buildBlockedResult({
        input,
        blockedReason: `Subprocess adapter stdout transformation failed for task "${input?.task?.title || 'unknown-task'}".`,
        message,
        payload: {
          adapter: 'subprocess',
          command,
          args,
          cwd,
          stdoutMode,
          error: message,
          ...result
        }
      });
    }

    if (stdoutMode === 'text') {
      return {
        status: 'done',
        doneSummary: transformedStdout || 'Subprocess adapter completed successfully.',
        payload: {
          adapter: 'subprocess',
          command,
          args,
          cwd,
          stdoutMode,
          ...(transformedStdout !== result.stdout ? { transformedStdout } : {}),
          ...result
        }
      };
    }

    let parsed;
    try {
      if (transformedHasParsed) {
        parsed = transformedParsed;
      } else {
        if (!transformedStdout) {
          throw new Error('Subprocess returned empty stdout.');
        }
        parsed = JSON.parse(transformedStdout);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return buildBlockedResult({
        input,
        blockedReason: `Subprocess adapter returned invalid JSON for task "${input?.task?.title || 'unknown-task'}".`,
        message: 'Subprocess adapter stdout could not be parsed as JSON.',
        payload: {
          adapter: 'subprocess',
          command,
          args,
          cwd,
          stdoutMode,
          parseError: message,
          ...(transformedStdout !== result.stdout ? { transformedStdout } : {}),
          ...result
        }
      });
    }

    try {
      const normalized = normalizeAdapterResult(parsed);
      return {
        ...normalized,
        payload: {
          adapter: 'subprocess',
          command,
          args,
          cwd,
          stdoutMode,
          ...(transformedStdout !== result.stdout ? { transformedStdout } : {}),
          outputs: normalized.payload?.outputs ?? [],
          process: {
            exitCode: result.exitCode,
            signal: result.signal,
            stdout: result.stdout,
            stderr: result.stderr,
            timedOut: result.timedOut
          },
          workerPayload: normalized.payload ?? null
        }
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return buildBlockedResult({
        input,
        blockedReason: `Subprocess adapter returned invalid adapter result for task "${input?.task?.title || 'unknown-task'}".`,
        message: 'Subprocess adapter stdout JSON did not satisfy the adapter result contract.',
        payload: {
          adapter: 'subprocess',
          command,
          args,
          cwd,
          stdoutMode,
          parseError: message,
          ...result
        }
      });
    }

  });
}

async function runCommand({ command, args, cwd, env, timeoutMs, stdinText }) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let killedByTimeout = false;

    const child = spawn(command, args, {
      cwd: cwd || undefined,
      env: env ? { ...process.env, ...env } : process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(shouldUseCommandShell(command) ? { shell: true } : {})
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

    child.stdin?.on('error', () => {});
    child.stdin?.end(stdinText, 'utf8');
  });
}

function shouldUseCommandShell(command) {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(String(command || '').trim());
}

function buildBlockedResult({ input, blockedReason, message, payload }) {
  return {
    status: 'blocked',
    blockedReason: blockedReason || `Subprocess adapter blocked task "${input?.task?.title || 'unknown-task'}".`,
    message,
    payload
  };
}

function buildExitBlockedReason(input, result) {
  const taskTitle = input?.task?.title || 'unknown-task';
  if (result.timedOut) {
    return `Subprocess adapter timed out for task "${taskTitle}".`;
  }
  if (result.signal) {
    return `Subprocess adapter terminated with signal ${result.signal} for task "${taskTitle}".`;
  }
  return `Subprocess adapter exited with code ${result.exitCode} for task "${taskTitle}".`;
}

function buildExitMessage(result, timeoutMs) {
  if (result.timedOut) {
    return timeoutMs > 0
      ? `Subprocess adapter timed out after ${timeoutMs}ms.`
      : 'Subprocess adapter timed out.';
  }
  if (result.signal) {
    return `Subprocess adapter terminated with signal ${result.signal}.`;
  }
  return `Subprocess adapter exited with code ${result.exitCode}.`;
}

function buildTransientExitFailure(options, input, result, runtime) {
  const classifier = resolveTransientExitClassifier(options.transientExitClassifier);
  if (!classifier) {
    return null;
  }

  const classification = classifier({
    input,
    result,
    ...runtime
  });
  if (!classification) {
    return null;
  }

  const failure = classification instanceof Error
    ? classification
    : new Error(normalizeOptionalText(classification.message) || buildExitMessage(result, runtime.timeoutMs));
  if (!failure.failureType) {
    failure.failureType = FAILURE_TYPES.transient;
  }
  if (failure.retryable == null) {
    failure.retryable = true;
  }
  if (!failure.transientReason && classification && typeof classification === 'object' && !(classification instanceof Error)) {
    failure.transientReason = normalizeOptionalText(classification.reason) || null;
  }
  failure.adapterPayload = {
    adapter: 'subprocess',
    command: runtime.command,
    args: runtime.args,
    cwd: runtime.cwd,
    stdoutMode: runtime.stdoutMode,
    transientReason: failure.transientReason || null,
    ...result
  };
  return failure;
}

function resolveTransientExitClassifier(value) {
  if (value == null) {
    return null;
  }

  if (typeof value !== 'function') {
    throw new Error('Subprocess adapter transientExitClassifier must be a function.');
  }

  return value;
}

function resolveCommandText(value, input) {
  const resolved = resolveOptionValue(value, input);
  const text = normalizeOptionalText(resolved);
  if (!text) {
    throw new Error('Subprocess adapter requires a non-empty command.');
  }
  return text;
}

function resolveCommandArgs(value, input) {
  const resolved = resolveOptionValue(value, input);
  if (resolved == null) {
    return [];
  }

  if (!Array.isArray(resolved)) {
    throw new Error('Subprocess adapter args must resolve to an array.');
  }

  return resolved.map((item) => String(item));
}

function resolveEnvOption(value, input) {
  const resolved = resolveOptionValue(value, input);
  if (resolved == null) {
    return null;
  }

  if (!resolved || typeof resolved !== 'object' || Array.isArray(resolved)) {
    throw new Error('Subprocess adapter env must resolve to an object.');
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
    throw new Error('Subprocess adapter timeoutMs must be a non-negative number.');
  }

  return timeoutMs;
}

function resolveStdoutMode(value, input) {
  const mode = normalizeOptionalText(resolveOptionValue(value, input)) || 'json';
  if (mode !== 'json' && mode !== 'text') {
    throw new Error('Subprocess adapter stdoutMode must be "json" or "text".');
  }
  return mode;
}

function resolveStdoutTransformer(value) {
  if (value == null) {
    return null;
  }

  if (typeof value !== 'function') {
    throw new Error('Subprocess adapter stdoutTransformer must be a function.');
  }

  return value;
}

async function transformStdoutResult(transformer, stdout, context) {
  if (typeof transformer !== 'function') {
    return {
      stdout,
      parsed: undefined,
      hasParsed: false
    };
  }

  const transformed = await transformer(stdout, context);
  if (transformed == null) {
    return {
      stdout,
      parsed: undefined,
      hasParsed: false
    };
  }

  if (typeof transformed === 'string') {
    return {
      stdout: normalizeTransformedStdout(transformed),
      parsed: undefined,
      hasParsed: false
    };
  }

  if (typeof transformed === 'object') {
    if (Object.prototype.hasOwnProperty.call(transformed, 'stdout') || Object.prototype.hasOwnProperty.call(transformed, 'parsed')) {
      return {
        stdout: Object.prototype.hasOwnProperty.call(transformed, 'stdout')
          ? normalizeTransformedStdout(transformed.stdout)
          : stdout,
        parsed: transformed.parsed,
        hasParsed: Object.prototype.hasOwnProperty.call(transformed, 'parsed')
      };
    }

    return {
      stdout,
      parsed: transformed,
      hasParsed: true
    };
  }

  return {
    stdout: normalizeTransformedStdout(transformed),
    parsed: undefined,
    hasParsed: false
  };
}

function normalizeTransformedStdout(value) {
  if (value == null) {
    return '';
  }

  return String(value).trim();
}

function resolveOptionalTextOption(value, input) {
  return normalizeOptionalText(resolveOptionValue(value, input));
}

function resolveOptionValue(value, input) {
  return typeof value === 'function'
    ? value(input)
    : value;
}

function normalizeOptionalText(value) {
  if (value == null) {
    return null;
  }

  const text = String(value).trim();
  return text || null;
}
