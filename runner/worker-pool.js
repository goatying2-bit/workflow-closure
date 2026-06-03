import { createWorkflowEngine } from '../core/workflow-engine.js';
import { createWorkflowRunner } from './workflow-runner.js';

const DEFAULT_WORKER_COUNT = 1;
const DEFAULT_MAX_ROUNDS = 100;
const DEFAULT_POLL_INTERVAL_MS = 5_000;

export async function createWorkflowWorkerPool(options = {}) {
  const engine = options.engine || await createWorkflowEngine(options);
  const poolId = normalizeId(options.poolId, 'pool');
  const workflowId = normalizeOptionalText(options.workflowId);
  const workerCount = normalizePositiveInteger(options.workerCount, DEFAULT_WORKER_COUNT, 'workerCount');
  const runnerIdPrefix = normalizeOptionalText(options.runnerIdPrefix) || poolId;
  const pollIntervalMs = normalizePositiveInteger(options.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS, 'pollIntervalMs');
  const workers = [];

  for (let index = 0; index < workerCount; index++) {
    const workerIndex = index;
    const runnerId = `${runnerIdPrefix}-worker-${workerIndex + 1}`;
    const adapter = resolveWorkerAdapter(options, { workerIndex, runnerId, poolId });
    const runner = await createWorkflowRunner({
      ...options,
      engine,
      adapter,
      workflowId,
      runnerId
    });

    workers.push({ workerIndex, runnerId, runner });
  }

  let timer = null;
  let running = false;
  let currentLoop = Promise.resolve();

  return {
    poolId,
    workflowId,
    workerCount,
    runnerIds: workers.map((worker) => worker.runnerId),
    async runOnce(input = {}) {
      return runPoolRound({ engine, poolId, workflowId, workers, input });
    },
    async drain(input = {}) {
      return drainPool({ engine, poolId, workflowId, workerCount, workers, input });
    },
    start(input = {}) {
      if (running) {
        return false;
      }

      running = true;
      scheduleNextLoop(input, 0);
      return true;
    },
    stop() {
      running = false;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      return currentLoop;
    },
    isRunning() {
      return running;
    },
    getWorkerStates() {
      return workers.map((worker) => ({
        workerIndex: worker.workerIndex,
        runnerId: worker.runnerId,
        running: worker.runner.isRunning()
      }));
    }
  };

  function scheduleNextLoop(input, delayMs) {
    if (!running) {
      return;
    }

    timer = setTimeout(() => {
      currentLoop = drainPool({ engine, poolId, workflowId, workerCount, workers, input })
        .catch((error) => {
          const errorMessage = error instanceof Error ? error.message : String(error);
          console.error(`[workflow-worker-pool] Loop error: ${errorMessage}`);
        })
        .finally(() => {
          timer = null;
          scheduleNextLoop(input, pollIntervalMs);
        });
    }, delayMs);
  }
}

async function runPoolRound({ engine, poolId, workflowId, workers, input }) {
  const startedAt = new Date().toISOString();
  const settled = await Promise.allSettled(workers.map((worker) => worker.runner.runOnce(input)));
  const results = settled.map((settledResult, index) => normalizeWorkerResult(workers[index], settledResult));
  const state = workflowId ? engine.getWorkflowState({ workflowId }) : resolveWorkflowStateFromResults(engine, results);
  const completedAt = new Date().toISOString();
  const counts = countRoundResults(results);

  return {
    status: resolveRoundStatus(counts),
    poolId,
    workflowId: state?.workflow?.workflowId || workflowId || null,
    workerCount: workers.length,
    runnerIds: workers.map((worker) => worker.runnerId),
    startedAt,
    completedAt,
    results,
    ...counts,
    releasedTaskCount: results.reduce((sum, result) => sum + (result.releasedTaskCount || 0), 0),
    workflow: state?.workflow || null,
    state
  };
}

async function drainPool({ engine, poolId, workflowId, workerCount, workers, input }) {
  const maxRounds = normalizePositiveInteger(input.maxRounds, input.maxSteps ?? DEFAULT_MAX_ROUNDS, 'maxRounds');
  const maxTaskRuns = input.maxTaskRuns == null
    ? null
    : normalizePositiveInteger(input.maxTaskRuns, null, 'maxTaskRuns');
  const stopOnBlocked = input.stopOnBlocked !== false;
  const rounds = [];
  const steps = [];

  while (rounds.length < maxRounds) {
    const round = await runPoolRound({ engine, poolId, workflowId, workers, input });
    rounds.push(round);

    const activeSteps = round.results.filter((result) => result.status !== 'idle');
    steps.push(...activeSteps);

    if (maxTaskRuns != null && steps.length >= maxTaskRuns) {
      const finalState = getFinalState(engine, workflowId, round);
      return buildDrainResult({
        status: 'max_task_runs_exceeded',
        poolId,
        workflowId,
        workerCount,
        rounds,
        steps,
        finalState
      });
    }

    if (round.errorCount > 0) {
      const finalState = getFinalState(engine, workflowId, round);
      return buildDrainResult({ status: 'error', poolId, workflowId, workerCount, rounds, steps, finalState });
    }

    if (stopOnBlocked && round.blockedCount > 0) {
      const finalState = getFinalState(engine, workflowId, round);
      return buildDrainResult({ status: 'blocked', poolId, workflowId, workerCount, rounds, steps, finalState });
    }

    const finalState = getFinalState(engine, workflowId, round);
    if (finalState?.workflow?.status === 'done') {
      return buildDrainResult({ status: 'done', poolId, workflowId, workerCount, rounds, steps, finalState });
    }

    if (activeSteps.length === 0) {
      return buildDrainResult({ status: 'idle', poolId, workflowId, workerCount, rounds, steps, finalState });
    }
  }

  const finalRound = rounds[rounds.length - 1] || null;
  const finalState = getFinalState(engine, workflowId, finalRound);
  return buildDrainResult({ status: 'max_rounds_exceeded', poolId, workflowId, workerCount, rounds, steps, finalState });
}

function normalizeWorkerResult(worker, settledResult) {
  if (settledResult.status === 'fulfilled') {
    const value = settledResult.value || {};
    return {
      workerIndex: worker.workerIndex,
      runnerId: worker.runnerId,
      status: value.status || 'idle',
      task: value.task || null,
      workflow: value.workflow || null,
      contextSnapshot: value.contextSnapshot || null,
      releasedTaskCount: value.releasedTaskCount || 0,
      result: value,
      error: null
    };
  }

  return {
    workerIndex: worker.workerIndex,
    runnerId: worker.runnerId,
    status: 'error',
    task: null,
    workflow: null,
    contextSnapshot: null,
    releasedTaskCount: 0,
    result: null,
    error: serializeError(settledResult.reason)
  };
}

function countRoundResults(results) {
  const doneCount = results.filter((result) => result.status === 'done').length;
  const blockedCount = results.filter((result) => result.status === 'blocked').length;
  const idleCount = results.filter((result) => result.status === 'idle').length;
  const errorCount = results.filter((result) => result.status === 'error').length;
  const activeCount = results.length - idleCount - errorCount;

  return { doneCount, blockedCount, idleCount, errorCount, activeCount };
}

function resolveRoundStatus(counts) {
  if (counts.errorCount > 0) {
    return 'error';
  }

  if (counts.blockedCount > 0) {
    return counts.doneCount > 0 || counts.idleCount > 0 ? 'mixed' : 'blocked';
  }

  if (counts.activeCount === 0) {
    return 'idle';
  }

  if (counts.doneCount === counts.activeCount) {
    return 'done';
  }

  return 'mixed';
}

function buildDrainResult({ status, poolId, workflowId, workerCount, rounds, steps, finalState }) {
  return {
    status,
    poolId,
    workflowId: finalState?.workflow?.workflowId || workflowId || null,
    workerCount,
    rounds,
    steps,
    activeTaskRunCount: steps.length,
    finalState,
    workflow: finalState?.workflow || null,
    state: finalState,
    lastStep: steps.length > 0 ? steps[steps.length - 1] : null
  };
}

function getFinalState(engine, workflowId, round) {
  const resolvedWorkflowId = workflowId || round?.workflow?.workflowId || round?.results?.find((result) => result.workflow?.workflowId)?.workflow?.workflowId;
  if (!resolvedWorkflowId) {
    return round?.state || null;
  }

  return engine.getWorkflowState({ workflowId: resolvedWorkflowId });
}

function resolveWorkflowStateFromResults(engine, results) {
  const workflowId = results.find((result) => result.workflow?.workflowId)?.workflow?.workflowId
    || results.find((result) => result.task?.workflowId)?.task?.workflowId;

  return workflowId ? engine.getWorkflowState({ workflowId }) : null;
}

function resolveWorkerAdapter(options, context) {
  if (typeof options.resolveWorkerAdapter === 'function') {
    const adapter = options.resolveWorkerAdapter(context);
    if (adapter) {
      return adapter;
    }
  }

  if (options.adapters && typeof options.adapters === 'object') {
    return options.adapters[context.runnerId] || options.adapters[context.workerIndex] || options.adapter;
  }

  return options.adapter;
}

function normalizeId(value, prefix) {
  const text = normalizeOptionalText(value);
  return text || `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeOptionalText(value) {
  if (value == null) {
    return null;
  }

  const text = String(value).trim();
  return text || null;
}

function normalizePositiveInteger(value, fallback, label) {
  if (value == null) {
    return fallback;
  }

  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`${label} must be a positive number.`);
  }

  return Math.floor(number);
}

function serializeError(error) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack
    };
  }

  return {
    name: 'Error',
    message: String(error)
  };
}
