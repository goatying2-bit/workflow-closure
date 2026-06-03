import { spawn } from 'node:child_process';

export function createCheckpointSink(handler) {
  if (typeof handler !== 'function') {
    throw new Error('Checkpoint sink handler must be a function.');
  }

  return {
    async write(input) {
      const result = await handler(input);
      return normalizeCheckpointSinkResult(result);
    }
  };
}

export function createGitCheckpointSink(options = {}) {
  return createCheckpointSink(async (input) => {
    const resultStatus = normalizeOptionalText(input?.result?.status);
    const shouldWrite = resolveShouldWriteOption(options.shouldWrite, input);

    if (shouldWrite === false || resultStatus !== 'done') {
      return {
        status: 'skipped',
        summary: resultStatus === 'done'
          ? 'Git checkpoint skipped by sink policy.'
          : 'Git checkpoint skipped because the task did not finish as done.',
        metadata: {
          checkpointSink: 'git',
          cwd: resolveWorkingDirectory(options, input),
          resultStatus
        },
        payload: null
      };
    }

    const cwd = resolveWorkingDirectory(options, input);
    const repoRootResult = await runGitCommand({
      cwd,
      args: ['rev-parse', '--show-toplevel']
    });

    if (repoRootResult.exitCode !== 0) {
      return {
        status: 'skipped',
        summary: `Git checkpoint skipped because ${cwd} is not a git repository.`,
        metadata: {
          checkpointSink: 'git',
          cwd,
          resultStatus
        },
        payload: {
          exitCode: repoRootResult.exitCode,
          stderr: repoRootResult.stderr,
          stdout: repoRootResult.stdout
        }
      };
    }

    const repoPath = repoRootResult.stdout.trim() || cwd;
    const statusResult = await runGitCommand({
      cwd: repoPath,
      args: ['status', '--porcelain', '-uall']
    });

    if (statusResult.exitCode !== 0) {
      return {
        status: 'failed',
        summary: `Git checkpoint failed while checking repository status for ${repoPath}.`,
        metadata: {
          checkpointSink: 'git',
          cwd: repoPath,
          resultStatus
        },
        payload: {
          step: 'status',
          exitCode: statusResult.exitCode,
          stderr: statusResult.stderr,
          stdout: statusResult.stdout
        }
      };
    }

    if (!statusResult.stdout.trim()) {
      return {
        status: 'skipped',
        summary: 'Git checkpoint skipped because there are no working tree changes to commit.',
        metadata: {
          checkpointSink: 'git',
          cwd: repoPath,
          resultStatus
        },
        payload: null
      };
    }

    const trackedFiles = statusResult.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 3)
      .map((line) => {
        const statusCode = line.slice(0, 2);
        const filePath = line.slice(3).trim();
        // Handle rename entries: "R  old -> new"
        if (statusCode.includes('R') && filePath.includes(' -> ')) {
          return filePath.split(' -> ').pop().trim();
        }
        return filePath;
      })
      .filter(Boolean);

    if (trackedFiles.length === 0) {
      return {
        status: 'skipped',
        summary: 'Git checkpoint skipped because there are no tracked file changes to commit.',
        metadata: {
          checkpointSink: 'git',
          cwd: repoPath,
          resultStatus
        },
        payload: null
      };
    }

    const addResult = await runGitCommand({
      cwd: repoPath,
      args: ['add', '--', ...trackedFiles]
    });

    if (addResult.exitCode !== 0) {
      return {
        status: 'failed',
        summary: `Git checkpoint failed while staging changes in ${repoPath}.`,
        metadata: {
          checkpointSink: 'git',
          cwd: repoPath,
          resultStatus
        },
        payload: {
          step: 'add',
          exitCode: addResult.exitCode,
          stderr: addResult.stderr,
          stdout: addResult.stdout
        }
      };
    }

    const commitMessage = resolveCommitMessage(options.commitMessage, input);
    const commitResult = await runGitCommand({
      cwd: repoPath,
      args: ['commit', '-m', commitMessage],
      env: buildGitIdentityEnv(options, input)
    });

    if (commitResult.exitCode !== 0) {
      return {
        status: 'failed',
        summary: `Git checkpoint failed while creating commit in ${repoPath}.`,
        metadata: {
          checkpointSink: 'git',
          cwd: repoPath,
          resultStatus,
          commitMessage
        },
        payload: {
          step: 'commit',
          exitCode: commitResult.exitCode,
          stderr: commitResult.stderr,
          stdout: commitResult.stdout
        }
      };
    }

    const headResult = await runGitCommand({
      cwd: repoPath,
      args: ['rev-parse', 'HEAD']
    });

    if (headResult.exitCode !== 0) {
      return {
        status: 'failed',
        summary: `Git checkpoint wrote a commit in ${repoPath} but failed to resolve HEAD.`,
        metadata: {
          checkpointSink: 'git',
          cwd: repoPath,
          resultStatus,
          commitMessage
        },
        payload: {
          step: 'rev-parse',
          exitCode: headResult.exitCode,
          stderr: headResult.stderr,
          stdout: headResult.stdout
        }
      };
    }

    const commitSha = headResult.stdout.trim() || null;

    return {
      status: 'written',
      summary: `Git checkpoint committed task changes at ${commitSha || 'unknown-commit'}.`,
      artifactRef: commitSha ? `git:${commitSha}` : null,
      metadata: {
        checkpointSink: 'git',
        cwd: repoPath,
        resultStatus,
        commitSha,
        commitMessage
      },
      payload: {
        statusBeforeCommit: statusResult.stdout,
        commitStdout: commitResult.stdout,
        commitStderr: commitResult.stderr
      }
    };
  });
}

export function normalizeCheckpointSinkResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error('Checkpoint sink must return an object result.');
  }

  const status = normalizeOptionalText(result.status);
  if (status !== 'written' && status !== 'skipped' && status !== 'failed') {
    throw new Error('Checkpoint sink result status must be "written", "skipped", or "failed".');
  }

  return {
    status,
    summary: normalizeOptionalText(result.summary) || defaultSummaryForStatus(status),
    artifactRef: normalizeOptionalText(result.artifactRef),
    metadata: normalizeMetadata(result.metadata),
    payload: result.payload ?? null
  };
}

export function resolveCheckpointSink(checkpointSink) {
  if (!checkpointSink) {
    return createCheckpointSink(async () => ({
      status: 'skipped',
      summary: 'No checkpoint sink configured.',
      metadata: {
        checkpointSink: 'none'
      },
      payload: null
    }));
  }

  if (typeof checkpointSink?.write === 'function') {
    return {
      async write(input) {
        return normalizeCheckpointSinkResult(await checkpointSink.write(input));
      }
    };
  }

  if (typeof checkpointSink === 'function') {
    return createCheckpointSink(checkpointSink);
  }

  throw new Error('Checkpoint sink must be a function or an object with a write() method.');
}

const GIT_COMMAND_TIMEOUT_MS = 30_000;

async function runGitCommand({ cwd, args, env }) {
  return runCommand({
    command: 'git',
    args,
    cwd,
    env,
    timeoutMs: GIT_COMMAND_TIMEOUT_MS
  });
}

async function runCommand({ command, args, cwd, env, timeoutMs = 0 }) {
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
    let stdoutTruncated = false;
    let stderrTruncated = false;

    child.stdout?.on('data', (chunk) => {
      if (stdout.length < MAX_OUTPUT_SIZE) {
        stdout += String(chunk);
      } else {
        stdoutTruncated = true;
      }
    });

    child.stderr?.on('data', (chunk) => {
      if (stderr.length < MAX_OUTPUT_SIZE) {
        stderr += String(chunk);
      } else {
        stderrTruncated = true;
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
        timedOut: killedByTimeout,
        stdoutTruncated,
        stderrTruncated
      });
    });
  });
}

function resolveWorkingDirectory(options, input) {
  return normalizeOptionalText(
    resolveOptionValue(options.cwd, input)
    ?? resolveOptionValue(options.repoPath, input)
    ?? input?.cwd
    ?? input?.repoPath
    ?? process.cwd()
  ) || process.cwd();
}

function resolveShouldWriteOption(value, input) {
  const resolved = resolveOptionValue(value, input);
  if (resolved == null) {
    return true;
  }

  return Boolean(resolved);
}

function resolveCommitMessage(value, input) {
  return normalizeOptionalText(resolveOptionValue(value, input)) || buildDefaultCommitMessage(input);
}

function buildDefaultCommitMessage(input) {
  const taskTitle = normalizeOptionalText(input?.task?.title) || 'workflow task';
  const workflowId = normalizeOptionalText(input?.workflow?.workflowId) || 'unknown-workflow';
  const taskId = normalizeOptionalText(input?.task?.taskId) || 'unknown-task';
  return `checkpoint: ${taskTitle} [${workflowId}/${taskId}]`;
}

function buildGitIdentityEnv(options, input) {
  const authorName = normalizeOptionalText(
    resolveOptionValue(options.authorName, input)
    ?? input?.authorName
  );
  const authorEmail = normalizeOptionalText(
    resolveOptionValue(options.authorEmail, input)
    ?? input?.authorEmail
  );

  if (!authorName || !authorEmail) {
    return null;
  }

  return {
    GIT_AUTHOR_NAME: authorName,
    GIT_AUTHOR_EMAIL: authorEmail,
    GIT_COMMITTER_NAME: authorName,
    GIT_COMMITTER_EMAIL: authorEmail
  };
}

function normalizeMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return { ...value };
}

function defaultSummaryForStatus(status) {
  if (status === 'written') {
    return 'Checkpoint written.';
  }

  if (status === 'failed') {
    return 'Checkpoint failed.';
  }

  return 'Checkpoint skipped.';
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
