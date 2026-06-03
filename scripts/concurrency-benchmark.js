import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.dirname(__dirname);
const cliPath = path.join(rootDir, 'cli.js');

const DEFAULT_CONCURRENCY = 8;
const DEFAULT_ROUNDS = 5;
const DEFAULT_LEASE_MS = 60_000;

async function runCli(command, input = {}) {
  const startedAt = performance.now();
  const args = [cliPath, command, '--input', JSON.stringify(input)];

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: rootDir,
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
      const durationMs = performance.now() - startedAt;
      if (code !== 0) {
        resolve({ success: false, code, durationMs, error: (stderr || stdout).trim() });
        return;
      }

      try {
        resolve({ success: true, code, durationMs, data: JSON.parse(stdout) });
      } catch (error) {
        resolve({
          success: false,
          code,
          durationMs,
          error: `Failed to parse CLI JSON output: ${error instanceof Error ? error.message : String(error)}`
        });
      }
    });
  });
}

async function createWorkflow(dbPath, index, stepCount = 1) {
  const steps = [];
  const dependencies = [];
  for (let i = 0; i < stepCount; i++) {
    const key = `s${i + 1}`;
    steps.push({
      key,
      title: `任务 ${index + 1}-${i + 1}`,
      type: 'implement'
    });
    if (i > 0) {
      dependencies.push({ from: `s${i}`, to: key });
    }
  }

  const result = await runCli('create-workflow', {
    dbPath,
    workflowId: `bench-workflow-${index + 1}`,
    instruction: `并发基准 workflow ${index + 1}`,
    plan: {
      goal: `并发基准 workflow ${index + 1}`,
      steps,
      dependencies
    }
  });

  if (!result.success) {
    throw new Error(`创建 workflow 失败: ${result.error}`);
  }

  return result.data.workflow;
}

function percentile(sortedValues, ratio) {
  if (sortedValues.length === 0) {
    return 0;
  }

  const index = Math.min(sortedValues.length - 1, Math.max(0, Math.ceil(sortedValues.length * ratio) - 1));
  return sortedValues[index];
}

function round(value) {
  return Number(value.toFixed(2));
}

function summarizeDurations(name, durations, wallMs, extra = {}) {
  const sorted = [...durations].sort((a, b) => a - b);
  const count = sorted.length;
  const total = sorted.reduce((sum, value) => sum + value, 0);
  const avg = count > 0 ? total / count : 0;
  return {
    scenario: name,
    operations: count,
    wallMs: round(wallMs),
    avgMs: round(avg),
    minMs: round(sorted[0] || 0),
    p50Ms: round(percentile(sorted, 0.5)),
    p95Ms: round(percentile(sorted, 0.95)),
    p99Ms: round(percentile(sorted, 0.99)),
    maxMs: round(sorted[count - 1] || 0),
    throughputOpsPerSec: wallMs > 0 ? round((count / wallMs) * 1000) : 0,
    ...extra
  };
}

function printSummary(summary) {
  console.log(`\n[${summary.scenario}]`);
  console.log(`  operations: ${summary.operations}`);
  console.log(`  wallMs: ${summary.wallMs}`);
  console.log(`  avgMs: ${summary.avgMs}`);
  console.log(`  p50/p95/p99: ${summary.p50Ms} / ${summary.p95Ms} / ${summary.p99Ms}`);
  console.log(`  min/max: ${summary.minMs} / ${summary.maxMs}`);
  console.log(`  throughput: ${summary.throughputOpsPerSec} ops/s`);
  for (const [key, value] of Object.entries(summary)) {
    if (['scenario', 'operations', 'wallMs', 'avgMs', 'p50Ms', 'p95Ms', 'p99Ms', 'minMs', 'maxMs', 'throughputOpsPerSec'].includes(key)) {
      continue;
    }
    console.log(`  ${key}: ${value}`);
  }
}

function parseArgs(argv) {
  const options = {
    concurrency: DEFAULT_CONCURRENCY,
    rounds: DEFAULT_ROUNDS,
    compact: false
  };

  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    const value = argv[index + 1];
    if (token === '--concurrency' && value) {
      options.concurrency = Number(value);
      index++;
      continue;
    }
    if (token === '--rounds' && value) {
      options.rounds = Number(value);
      index++;
      continue;
    }
    if (token === '--compact') {
      options.compact = true;
    }
  }

  if (!Number.isInteger(options.concurrency) || options.concurrency <= 0) {
    throw new Error('--concurrency 必须是正整数');
  }
  if (!Number.isInteger(options.rounds) || options.rounds <= 0) {
    throw new Error('--rounds 必须是正整数');
  }

  return options;
}

function withResponseMode(input, compact) {
  return compact ? { ...input, compact: true } : input;
}

async function benchmarkConcurrentClaim(dbPath, concurrency, rounds, compact) {
  const durations = [];
  let claimedCount = 0;
  let totalWallMs = 0;

  for (let roundIndex = 0; roundIndex < rounds; roundIndex++) {
    await fs.rm(dbPath, { force: true });
    await Promise.all(Array.from({ length: concurrency }, (_, index) => createWorkflow(dbPath, roundIndex * concurrency + index)));

    const startedAt = performance.now();
    const results = await Promise.all(Array.from({ length: concurrency }, (_, index) => (
      runCli('claim-next-ready-task', withResponseMode({
        dbPath,
        leaseOwner: `claim-runner-${roundIndex + 1}-${index + 1}`,
        leaseMs: DEFAULT_LEASE_MS
      }, compact))
    )));
    const wallMs = performance.now() - startedAt;
    totalWallMs += wallMs;

    for (const result of results) {
      if (!result.success) {
        throw new Error(`claim benchmark 失败: ${result.error}`);
      }
      if (result.data?.status !== 'claimed') {
        throw new Error(`claim benchmark 返回异常状态: ${result.data?.status || 'unknown'}`);
      }
      durations.push(result.durationMs);
      claimedCount++;
    }
  }

  return summarizeDurations('claim-next-ready-task', durations, totalWallMs, {
    concurrency,
    rounds,
    claimedCount
  });
}

async function benchmarkConcurrentHeartbeat(dbPath, concurrency, rounds, compact) {
  const durations = [];
  let renewedCount = 0;
  let totalWallMs = 0;

  for (let roundIndex = 0; roundIndex < rounds; roundIndex++) {
    await fs.rm(dbPath, { force: true });
    const workflow = await createWorkflow(dbPath, roundIndex);
    const claim = await runCli('claim-next-ready-task', withResponseMode({
      dbPath,
      leaseOwner: `heartbeat-runner-${roundIndex + 1}`,
      leaseMs: DEFAULT_LEASE_MS
    }, compact));

    if (!claim.success || claim.data?.status !== 'claimed') {
      throw new Error(`heartbeat benchmark claim 失败: ${claim.error || claim.data?.status || 'unknown'}`);
    }

    const task = claim.data.task;
    const startedAt = performance.now();
    const results = await Promise.all(Array.from({ length: concurrency }, () => (
      runCli('heartbeat-task-lease', withResponseMode({
        dbPath,
        workflowId: workflow.workflowId,
        taskId: task.taskId,
        leaseOwner: `heartbeat-runner-${roundIndex + 1}`,
        leaseMs: DEFAULT_LEASE_MS
      }, compact))
    )));
    const wallMs = performance.now() - startedAt;
    totalWallMs += wallMs;

    for (const result of results) {
      if (!result.success) {
        throw new Error(`heartbeat benchmark 失败: ${result.error}`);
      }
      if (result.data?.status !== 'renewed') {
        throw new Error(`heartbeat benchmark 返回异常状态: ${result.data?.status || 'unknown'}`);
      }
      durations.push(result.durationMs);
      renewedCount++;
    }
  }

  return summarizeDurations('heartbeat-task-lease', durations, totalWallMs, {
    concurrency,
    rounds,
    renewedCount
  });
}

async function benchmarkConcurrentFinalize(dbPath, concurrency, rounds, compact) {
  const durations = [];
  let completedCount = 0;
  let totalWallMs = 0;

  for (let roundIndex = 0; roundIndex < rounds; roundIndex++) {
    await fs.rm(dbPath, { force: true });
    const workflows = await Promise.all(Array.from({ length: concurrency }, (_, index) => createWorkflow(dbPath, roundIndex * concurrency + index)));
    const claims = await Promise.all(workflows.map((workflow, index) => (
      runCli('claim-next-ready-task', withResponseMode({
        dbPath,
        leaseOwner: `finalize-runner-${roundIndex + 1}-${index + 1}`,
        leaseMs: DEFAULT_LEASE_MS,
        reason: workflow.workflowId
      }, compact))
    )));

    const tasks = claims.map((claim, index) => {
      if (!claim.success || claim.data?.status !== 'claimed') {
        throw new Error(`finalize benchmark claim 失败: ${claim.error || claim.data?.status || 'unknown'}`);
      }
      return {
        workflowId: claim.data.task.workflowId,
        taskId: claim.data.task.taskId,
        leaseOwner: `finalize-runner-${roundIndex + 1}-${index + 1}`
      };
    });

    const startedAt = performance.now();
    const results = await Promise.all(tasks.map((task, index) => (
      runCli('complete-task', withResponseMode({
        dbPath,
        workflowId: task.workflowId,
        taskId: task.taskId,
        leaseOwner: task.leaseOwner,
        doneSummary: `benchmark done ${roundIndex + 1}-${index + 1}`
      }, compact))
    )));
    const wallMs = performance.now() - startedAt;
    totalWallMs += wallMs;

    for (const result of results) {
      if (!result.success) {
        throw new Error(`finalize benchmark 失败: ${result.error}`);
      }
      if (result.data?.status !== 'updated') {
        throw new Error(`finalize benchmark 返回异常状态: ${result.data?.status || 'unknown'}`);
      }
      durations.push(result.durationMs);
      completedCount++;
    }
  }

  return summarizeDurations('complete-task', durations, totalWallMs, {
    concurrency,
    rounds,
    completedCount
  });
}

async function main() {
  const { concurrency, rounds, compact } = parseArgs(process.argv.slice(2));
  const dbPath = path.join(__dirname, 'concurrency-benchmark.db');

  await fs.rm(dbPath, { force: true }).catch(() => {});

  const results = [];
  results.push(await benchmarkConcurrentClaim(dbPath, concurrency, rounds, compact));
  results.push(await benchmarkConcurrentHeartbeat(dbPath, concurrency, rounds, compact));
  results.push(await benchmarkConcurrentFinalize(dbPath, concurrency, rounds, compact));

  console.log('\n========== 并发基准结果 ==========' );
  for (const summary of results) {
    printSummary(summary);
  }

  console.log('\nJSON Summary:');
  console.log(JSON.stringify({ concurrency, rounds, compact, results }, null, 2));
}

main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
