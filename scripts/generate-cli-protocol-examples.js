import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const PROTOCOL_VERSION = 'workflow-closure-cli/v1';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.dirname(__dirname);
// Match rootDir case-insensitively and across both path separators so the
// OS-normalized (lowercased) workspace path is also redacted to <project-root>.
const rootDirRegex = new RegExp(
  rootDir
    .replace(/[.*+?^${}()|[\]]/g, '\\$&')
    .replace(/[\\/]+/g, '[\\\\/]+'),
  'gi'
);
const cliPath = path.join(rootDir, 'cli.js');
const dbPath = path.join(__dirname, 'cli-protocol-examples.db');
const outputPath = path.join(rootDir, 'cli-protocol-examples.json');
const coordinatorAdapterModule = path.join(__dirname, 'cli-coordinator-smoke-adapter.js');

async function main() {
  await fs.rm(dbPath, { force: true });

  const examples = [];

  examples.push(await captureExample('draft-plan', {
    instruction: '为 agent 工作流 CLI 制定接入方案'
  }));

  const created = await captureExample('create-workflow', {
    dbPath,
    instruction: '实现一个可给通用 agent 使用的工作流 CLI'
  });
  examples.push(created);

  const workflowId = created.response.workflow.workflowId;

  const claimed = await captureExample('claim-next-ready-task', {
    dbPath,
    leaseOwner: 'protocol-demo-runner',
    leaseMs: 60000
  });
  examples.push(claimed);

  const taskId = claimed.response.task.taskId;

  examples.push(await captureExample('block-task', {
    dbPath,
    workflowId,
    taskId,
    blockedReason: '等待人工确认 CLI 流程。',
    leaseOwner: 'protocol-demo-runner'
  }));

  examples.push(await captureExample('get-workflow-state', {
    dbPath,
    workflowId
  }));

  examples.push(await captureExample('resume-task', {
    dbPath,
    workflowId,
    taskId,
    payload: {
      source: 'protocol-examples'
    }
  }));

  const reclaimed = await captureExample('claim-next-ready-task', {
    dbPath,
    leaseOwner: 'protocol-demo-runner',
    leaseMs: 60000
  });
  examples.push(reclaimed);

  examples.push(await captureExample('complete-task', {
    dbPath,
    workflowId,
    taskId,
    doneSummary: '人工确认已经完成。',
    leaseOwner: 'protocol-demo-runner'
  }));

  while (true) {
    const nextClaim = await runCli('claim-next-ready-task', {
      dbPath,
      leaseOwner: 'protocol-demo-runner',
      leaseMs: 60000
    });

    if (nextClaim.response.status === 'idle') {
      break;
    }

    await runCli('complete-task', {
      dbPath,
      workflowId: nextClaim.response.task.workflowId,
      taskId: nextClaim.response.task.taskId,
      doneSummary: `自动完成：${nextClaim.response.task.title}`,
      leaseOwner: 'protocol-demo-runner'
    });
  }

  examples.push(await captureExample('get-workflow-state', {
    dbPath,
    workflowId
  }, { exampleName: 'get-workflow-state.done' }));

  const leaseCreated = await runCli('create-workflow', {
    dbPath,
    instruction: '调研 CLI lease 回收流程'
  });
  const leaseWorkflowId = leaseCreated.response.workflow.workflowId;
  const leaseClaim = await runCli('claim-next-ready-task', {
    dbPath,
    leaseOwner: 'lease-demo-runner',
    leaseMs: 5
  });

  examples.push(await captureExample('release-expired-leases', {
    dbPath,
    now: new Date(Date.now() + 10000).toISOString(),
    reason: 'Lease expired in protocol example.'
  }));

  examples.push(await captureExample('heartbeat-task-lease', {
    dbPath,
    workflowId: leaseClaim.response.task.workflowId,
    taskId: leaseClaim.response.task.taskId,
    leaseOwner: 'lease-demo-runner',
    leaseMs: 60000
  }, {
    allowFailure: true,
    exampleName: 'heartbeat-task-lease.failure'
  }));


  examples.push(await captureExample('get-workflow-state', {
    dbPath,
    workflowId: leaseWorkflowId
  }, { exampleName: 'get-workflow-state.released-lease' }));

  const coordinatorNoAgentCreated = await runCli('create-workflow', {
    dbPath,
    instruction: 'coordinator protocol example without agent',
    plan: {
      goal: '展示 coordinator 在无 agent 时的 idle 响应',
      steps: [
        {
          key: 'no-agent-task',
          title: '等待可用 agent',
          description: '在没有注册 agent 时尝试执行 ready task。',
          type: 'implement'
        }
      ],
      dependencies: []
    }
  });

  examples.push(await captureExample('run-next-assignment', {
    dbPath,
    workflowId: coordinatorNoAgentCreated.response.workflow.workflowId,
    targetType: 'task',
    taskId: coordinatorNoAgentCreated.response.task.taskId,
    assignmentLimit: 20,
    handoffLimit: 20,
    maxWorkflowSteps: 20
  }, { exampleName: 'run-next-assignment.idle-no-agent' }));

  examples.push(await captureExample('register-agent', {
    dbPath,
    name: 'Protocol Coordinator Agent',
    role: 'implementer',
    capabilities: ['implement'],
    adapterModule: coordinatorAdapterModule,
    status: 'active',
    assignmentLimit: 20,
    handoffLimit: 20
  }));

  const coordinatorHappyCreated = await runCli('create-workflow', {
    dbPath,
    instruction: 'coordinator protocol example happy path',
    plan: {
      goal: '展示 coordinator 直接执行 ready task 的成功响应',
      steps: [
        {
          key: 'direct-run',
          title: '直接执行任务',
          description: '注册 agent 后直接通过 coordinator 执行 ready task。',
          type: 'implement'
        }
      ],
      dependencies: []
    }
  });

  examples.push(await captureExample('run-next-assignment', {
    dbPath,
    workflowId: coordinatorHappyCreated.response.workflow.workflowId,
    targetType: 'task',
    taskId: coordinatorHappyCreated.response.task.taskId,
    assignmentLimit: 20,
    handoffLimit: 20,
    maxWorkflowSteps: 20
  }, { exampleName: 'run-next-assignment.done' }));

  const coordinatorBlockedCreated = await runCli('create-workflow', {
    dbPath,
    instruction: 'coordinator protocol example 需要阻塞恢复',
    plan: {
      goal: '展示 coordinator 阻塞与恢复后的响应',
      steps: [
        {
          key: 'blocked-run',
          title: '实现阻塞恢复场景',
          description: '先阻塞再恢复任务，验证 coordinator CLI 的 assign/resume 协议。',
          type: 'implement'
        }
      ],
      dependencies: []
    }
  });

  examples.push(await captureExample('run-next-assignment', {
    dbPath,
    workflowId: coordinatorBlockedCreated.response.workflow.workflowId,
    targetType: 'task',
    taskId: coordinatorBlockedCreated.response.task.taskId,
    assignmentLimit: 20,
    handoffLimit: 20,
    maxWorkflowSteps: 20
  }, { exampleName: 'run-next-assignment.blocked' }));


  const coordinatorCooldownCreated = await runCli('create-workflow', {
    dbPath,
    workflowId: 'coordinator-protocol-example-transient-cooldown',
    instruction: 'coordinator protocol example 瞬时上游恢复冷却',
    plan: {
      goal: '展示 coordinator transient cooldown 响应',
      steps: [
        {
          key: 'transient-cooldown-run',
          title: '触发 transient cooldown',
          description: '持续上游 502 直到 runner 用尽即时重试，然后验证 coordinator cooldown 协议。',
          type: 'implement',
          requiredCapabilities: ['implement']
        }
      ],
      dependencies: []
    }
  });

  examples.push(await captureExample('run-next-assignment', {
    dbPath,
    workflowId: coordinatorCooldownCreated.response.workflow.workflowId,
    targetType: 'task',
    taskId: coordinatorCooldownCreated.response.task.taskId,
    assignmentLimit: 20,
    handoffLimit: 20,
    maxWorkflowSteps: 20,
    maxTaskRetries: 0
  }, { exampleName: 'run-next-assignment.blocked-transient-cooldown' }));

  examples.push(await captureExample('resume-assigned-work', {
    dbPath,
    workflowId: coordinatorCooldownCreated.response.workflow.workflowId,
    taskId: coordinatorCooldownCreated.response.task.taskId,
    targetType: 'task',
    mode: 'resume',
    runNow: true,
    message: '恢复 coordinator transient cooldown 示例任务',
    payload: {
      source: 'protocol-examples',
      resumed: true,
      mode: 'cooldown'
    },
    assignmentLimit: 20,
    handoffLimit: 20,
    maxWorkflowSteps: 20,
    maxTaskRetries: 0
  }, { exampleName: 'resume-assigned-work.cooldown' }));

  examples.push(await captureExample('resume-assigned-work', {
    dbPath,
    workflowId: coordinatorBlockedCreated.response.workflow.workflowId,
    taskId: coordinatorBlockedCreated.response.task.taskId,
    targetType: 'task',
    mode: 'resume',
    runNow: true,
    message: '恢复 coordinator protocol example 任务',
    payload: {
      source: 'protocol-examples',
      resumed: true
    },
    assignmentLimit: 20,
    handoffLimit: 20,
    maxWorkflowSteps: 20
  }, { exampleName: 'resume-assigned-work.done' }));

  const document = normalizeExamples({
    protocolVersion: PROTOCOL_VERSION,
    generatedBy: 'scripts/generate-cli-protocol-examples.js',
    examples
  });

  await fs.writeFile(outputPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  await fs.rm(dbPath, { force: true });
  process.stdout.write(`${outputPath}\n`);
}

async function captureExample(command, input, options = {}) {
  const result = await runCli(command, input, options);
  return {
    name: options.exampleName || command,
    command,
    input,
    exitCode: result.code,
    response: result.response,
    stderr: result.stderr || null
  };
}

async function runCli(command, input = {}, options = {}) {
  const args = [cliPath, command, '--input', JSON.stringify(input)];
  const result = await new Promise((resolve, reject) => {
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
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });

  if (!options.allowFailure && result.code !== 0) {
    throw new Error(`CLI command failed: ${command}\n${result.stderr || result.stdout}`);
  }

  return {
    code: result.code,
    stderr: result.stderr.trim() || null,
    response: result.stdout.trim() ? JSON.parse(result.stdout) : null
  };
}

function normalizeExamples(document) {
  const valueMap = new Map();
  let idCounter = 0;
  let timestampCounter = 0;

  return transformValue(document);

  function transformValue(value) {
    if (Array.isArray(value)) {
      return value.map(transformValue);
    }

    if (!value || typeof value !== 'object') {
      return normalizeScalar(value);
    }

    const output = {};
    for (const [key, current] of Object.entries(value)) {
      if (key === 'dbPath') {
        output[key] = '<db-path>';
        continue;
      }
      output[key] = transformValue(current);
    }
    return output;
  }

  function normalizeScalar(value) {
    if (typeof value !== 'string') {
      return value;
    }

    let text = value.replace(rootDirRegex, '<project-root>');

    text = text.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, (match) => {
      if (!valueMap.has(match)) {
        idCounter += 1;
        valueMap.set(match, `<id-${idCounter}>`);
      }
      return valueMap.get(match);
    });

    text = text.replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\b/g, (match) => {
      if (!valueMap.has(match)) {
        timestampCounter += 1;
        valueMap.set(match, `<timestamp-${timestampCounter}>`);
      }
      return valueMap.get(match);
    });

    return text;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
