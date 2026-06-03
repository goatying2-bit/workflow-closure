import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { closeDb, resolveDbTarget } from '../storage/db.js';
import { initializeAgentStore, getAgentStore } from '../storage/agents.js';
import { initializeChainStore, getChainStore } from '../storage/chains.js';
import { initializeWorkflowStore, getWorkflowStore } from '../storage/workflows.js';
import { markTestPlan, prepareTestDb } from './helpers/test-db.js';

const PROTOCOL_VERSION = 'workflow-closure-cli/v1';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.dirname(__dirname);
const cliPath = path.join(rootDir, 'cli.js');
const dbPath = await prepareTestDb('cli-smoke-test');
const chainAdapterModule = path.join(__dirname, 'cli-chain-smoke-adapter.js');
const taskSourceModule = path.join(__dirname, 'cli-task-source-smoke-module.js');
const taskSourcePlaceholderFile = path.join(__dirname, 'fixtures', 'task-source-placeholder.pdf');
const runnerAdapterModule = path.join(__dirname, 'cli-runner-smoke-adapter.js');
const runnerRuleProviderModule = path.join(__dirname, 'cli-runner-smoke-rule-provider.js');
// Use the real project root so assertions that compare against runtime
// defaults (which fall back to process.cwd()) stay consistent and portable.
const workflowWorkspacePath = process.cwd().replaceAll('\\', '/');
const artifactOutputWorkspacePath = path.join(rootDir, 'scripts', '.tmp', 'cli-artifacts');
const artifactOutputRelativePath = 'task-output.txt';
const artifactOutputPath = path.join(artifactOutputWorkspacePath, artifactOutputRelativePath);
const runnerAgentId = 'cli-runner-agent';
const coordinatorAgentId = 'cli-coordinator-agent';
const capabilityFirstAgentId = 'cli-capability-first-agent';

function createVisibilityFixture({ toolName, purpose, whenToUse, constraints, sessionId }) {
  return {
    tools: [
      {
        name: toolName,
        purpose,
        whenToUse,
        constraints
      }
    ],
    memory: {
      scope: 'workspace',
      projectKey: 'workflow-closure',
      workspacePath: workflowWorkspacePath,
      sessionId,
      limit: 5
    },
    workspace: {
      cwd: workflowWorkspacePath,
      writablePaths: [workflowWorkspacePath]
    }
  };
}

const runnerVisibility = createVisibilityFixture({
  toolName: 'runner-editor',
  purpose: '执行 CLI runner smoke 任务时读取和修改当前 workspace',
  whenToUse: 'run-next-task 推进 ready task 时使用',
  constraints: '仅限当前 workflow workspace',
  sessionId: 'cli-runner-smoke-test'
});
const coordinatorImplementerVisibility = createVisibilityFixture({
  toolName: 'editor',
  purpose: '实现 coordinator 分配到的任务',
  whenToUse: '执行 implementer 任务时使用',
  constraints: '仅修改当前 workflow workspace',
  sessionId: 'cli-coordinator-smoke-test'
});
const coordinatorValidatorVisibility = createVisibilityFixture({
  toolName: 'test-runner',
  purpose: '执行 validator 回归检查',
  whenToUse: '执行 validate/tests 任务时使用',
  constraints: '优先运行 smoke 范围验证',
  sessionId: 'cli-coordinator-smoke-test'
});
const capabilityFirstVisibility = createVisibilityFixture({
  toolName: 'capability-first-tool',
  purpose: '执行 capability-first 分配任务',
  whenToUse: '按 capabilities 选中 agent 后使用',
  constraints: '仅服务当前 workspace',
  sessionId: 'cli-capability-first-smoke-test'
});
const partialClaimVisibility = {
  tools: [
    {
      name: 'partial-claim-tool',
      purpose: '执行 direct claim partial visibility 任务',
      whenToUse: 'claim-next-ready-task 命中实现任务时使用',
      constraints: '只暴露工具提示，不显式携带 memory/workspace'
    }
  ]
};

function collectInnerWorkflowSteps(chainRun) {
  return Array.isArray(chainRun?.steps)
    ? chainRun.steps.flatMap((step) => step?.workflowResult?.steps || [])
    : [];
}

async function main() {
  await fs.rm(dbPath, { force: true });
  await fs.rm(artifactOutputWorkspacePath, { recursive: true, force: true });

  const profileName = 'cli-profile-smoke';
  const profileTarget = resolveDbTarget({ dbProfile: profileName });
  await fs.rm(path.dirname(profileTarget.dbPath), { recursive: true, force: true });

  const resolvedProfile = await runCli('resolve-db-profile', {
    dbProfile: profileName
  });
  assertProtocol(resolvedProfile, 'resolve-db-profile', 'ok');
  assert(resolvedProfile.runtime?.dbProfile === profileName, 'resolve-db-profile should expose the normalized profile name');
  assert(resolvedProfile.runtime?.dbPathSource === 'profile', 'resolve-db-profile should report profile as the DB source');
  assert(resolvedProfile.runtime?.dbPath === profileTarget.dbPath, 'resolve-db-profile should expose the deterministic profile DB path');
  assert(resolvedProfile.runtime?.dbPath !== dbPath, 'profile DB path should be distinct from the smoke test explicit DB');
  assert(resolvedProfile.recoverySelector?.dbProfile === profileName, 'resolve-db-profile should prefer dbProfile in recovery selector');

  const profileCreated = await runCli('create-workflow', {
    dbProfile: profileName,
    workflowId: 'cli-profile-workflow',
    instruction: '验证 profile 数据库隔离',
    plan: {
      goal: '验证 profile 数据库隔离',
      steps: [
        { key: 'profile-step', title: 'Profile step', type: 'implement' }
      ]
    }
  });
  assertProtocol(profileCreated, 'create-workflow', 'ok');
  assert(profileCreated.runtime?.dbProfile === profileName, 'create-workflow should expose runtime dbProfile');
  assert(profileCreated.runtime?.dbPath === profileTarget.dbPath, 'create-workflow should use the profile DB path');
  assert(profileCreated.recoverySelector?.dbProfile === profileName, 'create-workflow recovery selector should prefer dbProfile');

  await assertDirectProfileStoreIsolation(profileName, profileTarget.dbPath, dbPath);

  const profileState = await runCli('get-workflow-state', {
    dbProfile: profileName,
    workflowId: 'cli-profile-workflow'
  });
  assertProtocol(profileState, 'get-workflow-state', 'ok');
  assert(profileState.workflow?.workflowId === 'cli-profile-workflow', 'profile workflow should be queryable with the same dbProfile');

  const defaultStateMiss = await runCli('get-workflow-state', {
    dbPath,
    workflowId: 'cli-profile-workflow'
  }, { allowFailure: true });
  assert(defaultStateMiss.code !== 0, 'profile workflow should not be visible in the explicit smoke test DB');

  const profileResume = await runCli('resume-session', {
    dbProfile: profileName,
    workflowId: 'cli-profile-workflow',
    workerId: 'claude-main',
    leaseMs: 600000
  });
  assertProtocol(profileResume, 'resume-session', 'claimed');
  assert(profileResume.runtime?.dbProfile === profileName, 'resume-session should expose runtime dbProfile');
  assert(profileResume.recoverySelector?.dbProfile === profileName, 'resume-session recovery selector should preserve dbProfile');
  assert(profileResume.task?.workflowId === 'cli-profile-workflow', 'resume-session should claim work from the profile database');

  const profileList = await runCli('list-db-profiles', {});
  assertProtocol(profileList, 'list-db-profiles', 'ok');
  assert(profileList.profiles?.some((profile) => profile.dbProfile === profileName && profile.exists === true), 'list-db-profiles should include the created profile database');

  const cyclicCreate = await runCli('create-workflow', {
    dbPath,
    instruction: 'CLI 循环依赖失败场景',
    plan: {
      goal: '验证循环依赖创建失败',
      steps: [
        { key: 'a', title: 'A', type: 'implement' },
        { key: 'b', title: 'B', type: 'implement' }
      ],
      dependencies: [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'a' }
      ]
    }
  }, { allowFailure: true });
  assert(cyclicCreate.code !== 0, 'create-workflow should reject cyclic dependencies');
  assert((cyclicCreate.stderr || '').includes('Cyclic dependency detected'), 'create-workflow should print a clear cyclic dependency error');

  const created = await runCli('create-workflow', {
    dbPath,
    instruction: '实现一个可给通用 agent 使用的工作流 CLI'
  });
  assertProtocol(created, 'create-workflow', 'ok');
  assert(created.workflow?.workflowId, 'create-workflow should return a workflow id');
  assert(created.workflow.status === 'ready', 'created workflow should become ready');
  assert(created.nextAction === 'claim_next_ready_task', 'create-workflow should recommend claiming the next task');
  assert(created.allowedNextCommands.includes('claim-next-ready-task'), 'create-workflow should expose allowed next commands');

  const peekedCreated = await runCli('peek-next-ready-task', {
    dbPath,
    workflowId: created.workflow.workflowId,
    compact: true
  });
  assertProtocol(peekedCreated, 'peek-next-ready-task', 'peeked');
  assert(peekedCreated.pollutionSafe === true, 'peek-next-ready-task should mark the response pollution-safe');
  assert(peekedCreated.mutation === 'none', 'peek-next-ready-task should declare no mutation');
  assert(peekedCreated.prompt === null, 'compact peek-next-ready-task should not build a prompt');
  assert(peekedCreated.task?.status === 'ready', 'peek-next-ready-task should return a ready task');
  const peekedCreatedState = await runCli('get-workflow-state', {
    dbPath,
    workflowId: created.workflow.workflowId
  });
  const peekedCreatedTask = peekedCreatedState.tasks.find((task) => task.taskId === peekedCreated.task.taskId);
  assert(peekedCreatedTask?.status === 'ready', 'peek-next-ready-task should not claim the task');
  assert(peekedCreatedTask?.attemptCount === 0, 'peek-next-ready-task should not increment attempts');
  assert(peekedCreatedTask?.leaseOwner == null, 'peek-next-ready-task should not write a lease owner');
  assert(!peekedCreatedState.runLogs.some((log) => log.taskId === peekedCreatedTask.taskId && log.action === 'task_claimed'), 'peek-next-ready-task should not write claim logs');
  assert(peekedCreated.allowedNextCommands.includes('claim-next-ready-task'), 'peek-next-ready-task should allow explicit claim as next command');
  assert(created.summary?.workflowStatus === 'ready', 'create-workflow should include a workflow summary');

  const stdinCreated = await runCli('create-workflow', {
    dbPath,
    workflowId: 'cli-stdin-workflow',
    instruction: '通过 stdin 创建 workflow'
  }, { structuredInputMode: 'stdin' });
  assertProtocol(stdinCreated, 'create-workflow', 'ok');
  assert(stdinCreated.workflow?.workflowId === 'cli-stdin-workflow', 'create-workflow should accept --input-stdin structured input');

  const stdinFileCreated = await runCli('create-workflow', {
    dbPath,
    workflowId: 'cli-stdin-file-workflow',
    instruction: '通过 --input-file - 创建 workflow'
  }, { structuredInputMode: 'stdin-file' });
  assertProtocol(stdinFileCreated, 'create-workflow', 'ok');
  assert(stdinFileCreated.workflow?.workflowId === 'cli-stdin-file-workflow', 'create-workflow should accept --input-file - structured input');

  const definitionCreated = await runCli('create-workflow-definition', {
    dbPath,
    definitionId: 'cli-definition-smoke',
    name: 'CLI Definition Smoke',
    description: '验证 CLI definition create/list/get/use 流程',
    sourceWorkflowId: created.workflow.workflowId,
    instruction: '为 CLI smoke test 构建可复用 workflow definition',
    goal: '验证 workflow definition CLI 闭环',
    metadata: { suite: 'cli-smoke-test', kind: 'definition' },
    plan: {
      goal: '验证 workflow definition CLI 闭环',
      steps: [
        { key: 'collect', title: '收集需求', type: 'implement' },
        { key: 'deliver', title: '交付结果', type: 'implement' }
      ],
      dependencies: [
        { from: 'collect', to: 'deliver' }
      ]
    }
  });
  assertProtocol(definitionCreated, 'create-workflow-definition', 'ok');
  assert(definitionCreated.definition?.definitionId === 'cli-definition-smoke', 'create-workflow-definition should preserve explicit definitionId');
  assert(definitionCreated.summary?.taskCount === 2, 'create-workflow-definition should expose plan task count');
  assert(definitionCreated.allowedNextCommands.includes('create-workflow-from-definition'), 'create-workflow-definition should recommend instantiation');

  const definitionFetched = await runCli('get-workflow-definition', {
    dbPath,
    definitionId: definitionCreated.definition.definitionId
  });
  assertProtocol(definitionFetched, 'get-workflow-definition', 'ok');
  assert(definitionFetched.definition?.name === 'CLI Definition Smoke', 'get-workflow-definition should return the saved definition');
  assert(definitionFetched.summary?.sourceWorkflowId === created.workflow.workflowId, 'get-workflow-definition should expose sourceWorkflowId in the summary');

  const definitionList = await runCli('list-workflow-definitions', {
    dbPath,
    search: 'CLI Definition Smoke',
    sourceWorkflowId: created.workflow.workflowId,
    limit: 10
  });
  assertProtocol(definitionList, 'list-workflow-definitions', 'ok');
  assert(definitionList.count >= 1, 'list-workflow-definitions should return the saved definition');
  assert(definitionList.filters?.search === 'CLI Definition Smoke', 'list-workflow-definitions should echo search filter');
  assert(definitionList.summaries.some((item) => item.definitionId === definitionCreated.definition.definitionId), 'list-workflow-definitions should expose summary rows');

  const workflowFromDefinition = await runCli('create-workflow-from-definition', {
    dbPath,
    definitionId: definitionCreated.definition.definitionId,
    workflowId: 'cli-definition-instance',
    instruction: '基于 definition 派生 workflow 实例',
    goal: '复用 workflow definition'
  });
  assertProtocol(workflowFromDefinition, 'create-workflow-from-definition', 'ok');
  assert(workflowFromDefinition.workflow?.workflowId === 'cli-definition-instance', 'create-workflow-from-definition should honor explicit workflowId');
  assert(workflowFromDefinition.definition?.definitionId === definitionCreated.definition.definitionId, 'create-workflow-from-definition should expose the source definition');
  assert(workflowFromDefinition.summary?.taskCount === 2, 'create-workflow-from-definition should materialize definition tasks');
  assert(workflowFromDefinition.nextTask?.title === '收集需求', 'create-workflow-from-definition should expose the first ready task');
  const taskSourceCreated = await runCli('create-workflow', {
    dbPath,
    taskSourceModule
  });
  assertProtocol(taskSourceCreated, 'create-workflow', 'ok');
  assert(taskSourceCreated.workflow?.workflowId === 'cli-task-source-workflow', 'task-source create-workflow should honor workflowId from the task source');
  assert(taskSourceCreated.workflow?.status === 'ready', 'task-source create-workflow should initialize the workflow as ready');
  assert(taskSourceCreated.summary?.taskCount === 2, 'task-source create-workflow should expose two tasks from the module plan');
  assert(taskSourceCreated.dependencies.length === 1, 'task-source create-workflow should expose module dependencies');
  assert(taskSourceCreated.sourceResult?.metadata?.taskSource === 'cli-task-source-module', 'task-source create-workflow should expose sourceResult metadata');
  assert(taskSourceCreated.sourceResult?.instruction === '通过 CLI task source module 创建 workflow', 'task-source create-workflow should preserve sourceResult instruction');
  assert(taskSourceCreated.nextTask?.title === '收集 task source 输入', 'task-source create-workflow should expose the first ready task');

  const placeholderTaskSourceCreated = await runCli('create-workflow', {
    dbPath,
    taskSourceFile: taskSourcePlaceholderFile,
    instruction: '通过 CLI 文档占位导入 workflow',
    goal: '人工审阅 PDF 并整理任务'
  });
  assertProtocol(placeholderTaskSourceCreated, 'create-workflow', 'ok');
  assert(placeholderTaskSourceCreated.workflow?.status === 'ready', 'document task-source create-workflow should initialize the workflow as ready');
  assert(placeholderTaskSourceCreated.workflow?.goal === '人工审阅 PDF 并整理任务', 'document task-source create-workflow should honor explicit goal');
  assert(placeholderTaskSourceCreated.summary?.taskCount === 1, 'document task-source create-workflow should create one placeholder task');
  assert(placeholderTaskSourceCreated.dependencies.length === 0, 'document task-source placeholder workflow should not create dependencies');
  assert(placeholderTaskSourceCreated.sourceResult?.instruction === '通过 CLI 文档占位导入 workflow', 'document task-source create-workflow should honor explicit instruction');
  assert(placeholderTaskSourceCreated.sourceResult?.metadata?.taskSource === 'document-placeholder', 'document task-source create-workflow should expose placeholder metadata');
  assert(placeholderTaskSourceCreated.sourceResult?.metadata?.parseMode === 'placeholder', 'document task-source create-workflow should mark placeholder parse mode');
  assert(placeholderTaskSourceCreated.sourceResult?.metadata?.fileExtension === '.pdf', 'document task-source create-workflow should expose file extension');
  assert(placeholderTaskSourceCreated.sourceResult?.metadata?.filePath === taskSourcePlaceholderFile, 'document task-source create-workflow should expose file path');
  assert(placeholderTaskSourceCreated.nextTask?.title === '检查源文档', 'document task-source create-workflow should expose the placeholder task');

  const runnerCreated = await runCli('create-workflow', {
    dbPath,
    workflowId: 'cli-runner-workflow',
    instruction: '通过 CLI run-next-task 自动推进 workflow',
    plan: {
      goal: '验证 CLI runner 命令和插件注入',
      steps: [
        {
          key: 'runner-collect',
          title: '收集 runner 输入',
          description: '验证 run-next-task 能自动 claim 并执行 ready task。'
        },
        {
          key: 'runner-apply',
          title: '输出 runner 结果',
          description: '验证 adapter payload、规则注入和最终状态汇总。'
        }
      ],
      dependencies: [
        { from: 'runner-collect', to: 'runner-apply' }
      ]
    }
  });
  assertProtocol(runnerCreated, 'create-workflow', 'ok');
  assert(runnerCreated.workflow?.workflowId === 'cli-runner-workflow', 'runner fixture should use the explicit workflowId');

  const registeredRunnerAgent = await runCli('register-agent', {
    dbPath,
    workflowId: runnerCreated.workflow.workflowId,
    agentId: runnerAgentId,
    name: 'CLI Runner Agent',
    role: 'implementer',
    capabilities: ['implement'],
    visibility: runnerVisibility,
    adapterModule: runnerAdapterModule,
    status: 'active',
    assignmentLimit: 20,
    handoffLimit: 20
  });
  assertProtocol(registeredRunnerAgent, 'register-agent', 'ok');
  assert(registeredRunnerAgent.agent?.agentId === runnerAgentId, 'runner fixture should register an agent identity for direct runner execution');

  const firstRunnerStep = await runCli('run-next-task', {
    dbPath,
    workflowId: runnerCreated.workflow.workflowId,
    runnerId: 'cli-runner-smoke',
    agentId: runnerAgentId,
    leaseMs: 60_000,
    maxTaskRetries: 2,
    adapterModule: runnerAdapterModule,
    ruleProviderModule: runnerRuleProviderModule
  });
  assertProtocol(firstRunnerStep, 'run-next-task', 'done');
  assert(firstRunnerStep.workflow?.workflowId === runnerCreated.workflow.workflowId, 'run-next-task should return the current workflow state');
  assert(firstRunnerStep.task?.status === 'done', 'run-next-task should complete the claimed task');
  assert(firstRunnerStep.summary?.workflowStatus === 'ready', 'workflow should remain ready while downstream tasks are still pending');
  assert(firstRunnerStep.summary?.countsByStatus?.done === 1, 'first run-next-task call should complete one task');
  assert(firstRunnerStep.summary?.countsByStatus?.ready === 1, 'first run-next-task call should release the dependent task');
  assert(firstRunnerStep.runnerId === 'cli-runner-smoke', 'run-next-task should echo the configured runnerId');
  assert(firstRunnerStep.adapterPayload?.taskId === firstRunnerStep.task.taskId, 'run-next-task should expose adapter payload from the runner');
  assert(firstRunnerStep.executionContext?.tools?.length === 1, 'run-next-task should expose execution context in the CLI response');
  assert(firstRunnerStep.executionContext?.memory?.scope === 'workspace', 'run-next-task should expose execution memory defaults in the CLI response');
  assert(firstRunnerStep.activeMemoryContext?.enabled === true, 'run-next-task should expose active memory context in the CLI response');
  assert(firstRunnerStep.activeMemoryContext?.workspacePath?.replaceAll('\\', '/').toLowerCase() === workflowWorkspacePath.toLowerCase(), 'run-next-task should expose active memory workspace path in the CLI response');
  assert(firstRunnerStep.adapterPayload?.promptHasExecutionContext === true, 'run-next-task should inject execution context into the prompt');
  assert(firstRunnerStep.adapterPayload?.promptHasMemoryContext === true, 'run-next-task should expose active memory context in the prompt');
  assert(firstRunnerStep.adapterPayload?.promptHasToolsContext === true, 'run-next-task should expose visible tools in the prompt');
  assert(firstRunnerStep.adapterPayload?.contextHasExecutionTools === true, 'run-next-task should expose execution tool context items');
  assert(firstRunnerStep.adapterPayload?.contextHasExecutionMemory === true, 'run-next-task should expose execution memory context items');
  assert(firstRunnerStep.adapterPayload?.executionToolCount === 1, 'run-next-task should expose one visible execution tool');
  assert(firstRunnerStep.adapterPayload?.activeMemoryEnabled === true, 'run-next-task should enable active memory context for registered agent visibility');
  assert(firstRunnerStep.adapterPayload?.promptHasRulesSection === true, 'run-next-task should inject the rules section into the prompt');
  assert(firstRunnerStep.adapterPayload?.promptIncludesPrimaryRule === true, 'run-next-task should pass rule-provider content into the prompt');
  assert(firstRunnerStep.adapterPayload?.ruleCount === 1, 'run-next-task should expose the injected rule count');
  assert(firstRunnerStep.adapterPayload?.providerKind === 'cli-runner-smoke', 'run-next-task should expose rule-provider metadata');
  assert(firstRunnerStep.ruleContext?.metadata?.ruleProvider === 'cli-runner-smoke', 'run-next-task should expose rule context metadata');
  assert(firstRunnerStep.runLogs.some((log) => log.action === 'task_completed_by_runner'), 'run-next-task should write a runner completion log');

  const runnerPredecessorOutput = await runCli('add-task-output', {
    dbPath,
    workflowId: runnerCreated.workflow.workflowId,
    taskId: firstRunnerStep.task.taskId,
    kind: 'result',
    name: 'runner-output',
    content: 'runner predecessor output content',
    metadata: { trustState: 'validated' }
  });
  assertProtocol(runnerPredecessorOutput, 'add-task-output', 'ok');

  const artifactTaskOutput = await runCli('add-task-output', {
    dbPath,
    workflowId: runnerCreated.workflow.workflowId,
    taskId: firstRunnerStep.task.taskId,
    kind: 'artifact',
    name: 'cli-artifact-output',
    content: 'cli artifact output content',
    path: artifactOutputRelativePath,
    workspacePath: artifactOutputWorkspacePath,
    metadata: { source: 'cli-smoke-test', branch: 'runner' }
  });
  assertProtocol(artifactTaskOutput, 'add-task-output', 'ok');
  assert(artifactTaskOutput.output?.path === artifactOutputRelativePath, 'CLI add-task-output should preserve artifact path');
  assert(artifactTaskOutput.output?.metadata?.artifactRef === `file:${artifactOutputRelativePath}`, 'CLI add-task-output should expose artifactRef metadata');
  assert(artifactTaskOutput.output?.metadata?.storageStatus === 'written', 'CLI add-task-output should expose written storage status');
  assert(artifactTaskOutput.output?.metadata?.relativePath === artifactOutputRelativePath, 'CLI add-task-output should expose normalized relative path');
  assert(artifactTaskOutput.output?.metadata?.workspacePath?.replaceAll('\\', '/').toLowerCase() === artifactOutputWorkspacePath.replaceAll('\\', '/').toLowerCase(), 'CLI add-task-output should preserve workspacePath metadata');
  const artifactOutputContent = await fs.readFile(artifactOutputPath, 'utf8');
  assert(artifactOutputContent === 'cli artifact output content', 'CLI add-task-output should materialize artifact content into the workspace');

  const secondRunnerStep = await runCli('run-next-task', {
    dbPath,
    workflowId: runnerCreated.workflow.workflowId,
    runnerId: 'cli-runner-smoke',
    leaseMs: 60_000,
    adapterModule: runnerAdapterModule,
    ruleProviderModule: runnerRuleProviderModule
  });
  assertProtocol(secondRunnerStep, 'run-next-task', 'done');
  assert(secondRunnerStep.summary?.workflowStatus === 'done', 'second run-next-task call should finish the workflow');
  assert(secondRunnerStep.summary?.countsByStatus?.done === 2, 'second run-next-task call should leave both tasks done');
  assert(secondRunnerStep.workflow?.status === 'done', 'workflow should be done after the final runner step');
  assert(secondRunnerStep.task?.status === 'done', 'second runner result should expose the completed task');
  assert(secondRunnerStep.adapterPayload?.promptIncludesPredecessorOutput === true, 'second runner prompt should include predecessor output content');
  assert(secondRunnerStep.adapterPayload?.contextHasPredecessorOutput === true, 'second runner context should include predecessor output item');
  assert(secondRunnerStep.contextSnapshot?.metadata?.predecessorOutputCount >= 1, 'second runner context snapshot should count predecessor outputs');

  const runnerIdle = await runCli('run-next-task', {
    dbPath,
    workflowId: runnerCreated.workflow.workflowId,
    runnerId: 'cli-runner-smoke',
    leaseMs: 60_000,
    adapterModule: runnerAdapterModule,
    ruleProviderModule: runnerRuleProviderModule
  });
  assertProtocol(runnerIdle, 'run-next-task', 'idle');
  assert(runnerIdle.summary?.workflowStatus === 'done', 'idle run-next-task should still expose the final workflow summary');
  assert(runnerIdle.task === null, 'idle run-next-task should not expose an active task');
  assert(runnerIdle.nextTask === null, 'idle run-next-task should not expose a next task after completion');

  await initializeAgentStore({ dbPath });
  const runnerIsolationStore = getAgentStore({ dbPath });
  const deactivatedRunnerAgent = runnerIsolationStore.updateAgent({
    agentId: runnerAgentId,
    status: 'inactive'
  });
  assert(deactivatedRunnerAgent?.status === 'inactive', 'runner fixture agent should be deactivated before coordinator coverage');

  let claim = await runCli('claim-next-ready-task', {
    dbPath,
    leaseOwner: 'cli-runner',
    leaseMs: 60_000
  });
  assertProtocol(claim, 'claim-next-ready-task', 'claimed');
  assert(claim.task?.status === 'doing', 'claimed task should be doing');
  assert(typeof claim.prompt === 'string' && claim.prompt.includes('当前任务：'), 'claim should return a task prompt');
  assert(claim.nextAction === 'execute_claimed_task', 'claim should recommend executing the claimed task');
  assert(claim.allowedNextCommands.includes('complete-task'), 'claim should expose completion as an allowed next command');
  assert(claim.summary?.workflowStatus === 'doing', 'claim should show the workflow as doing');
  assert(claim.summary?.countsByStatus?.doing === 1, 'claim summary should count the active task');

  const activeOverviewWhileDoing = await runCli('list-active-workflows', {
    dbPath,
    limit: 20
  });
  assertProtocol(activeOverviewWhileDoing, 'list-active-workflows', 'ok');
  assert(activeOverviewWhileDoing.overview?.doingCount >= 1, 'list-active-workflows should count doing workflows');
  const doingSummary = activeOverviewWhileDoing.summaries.find((summary) => summary.workflowId === claim.task.workflowId);
  assert(doingSummary?.doingTasks?.some((task) => task.taskId === claim.task.taskId && task.leaseOwner === 'cli-runner'), 'list-active-workflows should expose doing task lease owner');

  let blocked = await runCli('block-task', {
    dbPath,
    workflowId: claim.task.workflowId,
    taskId: claim.task.taskId,
    blockedReason: '等待人工确认 CLI 流程。',
    leaseOwner: 'cli-runner'
  });
  assertProtocol(blocked, 'block-task', 'updated');
  assert(blocked.task?.status === 'blocked', 'block-task should persist blocked task');
  assert(blocked.workflow?.status === 'blocked', 'workflow should become blocked after block-task');
  assert(blocked.nextAction === 'resume_task', 'block-task should recommend resuming the task');
  assert(blocked.allowedNextCommands.includes('resume-task'), 'block-task should expose resume-task as an allowed next command');

  let state = await runCli('get-workflow-state', {
    dbPath,
    workflowId: claim.task.workflowId
  });
  assertProtocol(state, 'get-workflow-state', 'ok');
  const blockedTask = state.tasks.find((task) => task.taskId === claim.task.taskId);
  assert(blockedTask?.lastError === '等待人工确认 CLI 流程。', 'blocked task should persist lastError');
  assert(state.summary?.hasBlockedTasks === true, 'workflow summary should report blocked tasks');
  assert(state.summary?.nextRecommendedCommand === 'resume_task', 'workflow summary should recommend resume');
  assert(state.runLogs.some((log) => log.action === 'task_blocked_via_cli'), 'block-task should write a CLI run log');

  const skippedRoutingCreated = await runCli('create-workflow', {
    dbPath,
    workflowId: 'cli-skipped-routing-workflow',
    instruction: '验证 CLI summary/inspection 对 skipped branch 的暴露',
    plan: {
      goal: '验证 skipped branch 在 CLI 观察面可见',
      steps: [
        { key: 'producer', title: '生成路由结果', description: '输出 routing signal。' },
        { key: 'unconditional', title: '无条件后继', description: '普通依赖完成后应变为 ready。' },
        { key: 'reviewer', title: 'Reviewer 分支', description: 'routing signal 指向 reviewer 时执行。' },
        { key: 'publisher', title: 'Publisher 分支', description: 'routing signal 指向 publisher 时执行。' }
      ],
      dependencies: [
        { predecessor: 'producer', successor: 'unconditional' },
        {
          predecessor: 'producer',
          successor: 'reviewer',
          condition: {
            outputKind: 'result',
            outputName: 'runner-result',
            path: 'metadata.routingSignal.next',
            operator: 'equals',
            value: 'reviewer'
          }
        },
        {
          predecessor: 'producer',
          successor: 'publisher',
          condition: {
            outputKind: 'result',
            outputName: 'runner-result',
            path: 'metadata.routingSignal.next',
            operator: 'equals',
            value: 'publisher'
          }
        }
      ]
    }
  });
  assertProtocol(skippedRoutingCreated, 'create-workflow', 'ok');

  const skippedProducerTask = skippedRoutingCreated.tasks.find((task) => task.planTaskKey === 'producer');
  assert(skippedProducerTask, 'skipped routing fixture should expose the producer task');

  const skippedRoutingClaim = await runCli('claim-next-ready-task', {
    dbPath,
    workflowId: skippedRoutingCreated.workflow.workflowId,
    leaseOwner: 'cli-skipped-runner',
    leaseMs: 60_000
  });
  assertProtocol(skippedRoutingClaim, 'claim-next-ready-task', 'claimed');
  assert(skippedRoutingClaim.task?.taskId === skippedProducerTask.taskId, 'skipped routing fixture should claim the producer first');

  const skippedRoutingOutput = await runCli('add-task-output', {
    dbPath,
    workflowId: skippedRoutingCreated.workflow.workflowId,
    taskId: skippedProducerTask.taskId,
    kind: 'result',
    name: 'runner-result',
    content: 'route to reviewer',
    metadata: { routingSignal: { next: 'reviewer' } }
  });
  assertProtocol(skippedRoutingOutput, 'add-task-output', 'ok');

  const skippedRoutingCompleted = await runCli('complete-task', {
    dbPath,
    workflowId: skippedRoutingCreated.workflow.workflowId,
    taskId: skippedProducerTask.taskId,
    doneSummary: 'producer selected reviewer',
    leaseOwner: 'cli-skipped-runner'
  });
  assertProtocol(skippedRoutingCompleted, 'complete-task', 'updated');

  const skippedRoutingState = await runCli('get-workflow-state', {
    dbPath,
    workflowId: skippedRoutingCreated.workflow.workflowId
  });
  assertProtocol(skippedRoutingState, 'get-workflow-state', 'ok');
  const skippedPublisherTask = skippedRoutingState.tasks.find((task) => task.planTaskKey === 'publisher');
  assert(skippedRoutingState.summary?.countsByStatus?.skipped === 1, 'get-workflow-state should count skipped tasks in workflow summary');
  assert(skippedRoutingState.summary?.progress?.skipped === 1, 'get-workflow-state should expose skipped progress counts');
  assert(skippedPublisherTask?.status === 'skipped', 'false conditional branch should appear as skipped in CLI state');
  assert(skippedPublisherTask?.reasonCode === 'dependency_condition_not_met', 'skipped CLI branch should expose the dependency skip reason');
  assert(skippedRoutingState.runLogs.some((log) => log.action === 'task_skipped_by_dependency_condition' && log.taskId === skippedPublisherTask.taskId), 'CLI state should expose skipped-branch run logs');

  const skippedRoutingInspection = await runCli('inspect-workflow', {
    dbPath,
    workflowId: skippedRoutingCreated.workflow.workflowId
  });
  assertProtocol(skippedRoutingInspection, 'inspect-workflow', 'ok');
  assert(skippedRoutingInspection.inspection?.skippedTasks?.some((task) => task.taskId === skippedPublisherTask.taskId && task.reasonCode === 'dependency_condition_not_met'), 'inspect-workflow should expose skipped task details');

  const sessionCreated = await runCli('create-workflow', {
    dbPath,
    workflowId: 'cli-session-recovery-workflow',
    instruction: '验证新窗口恢复 workflow session',
    plan: {
      goal: '验证新窗口恢复 workflow session',
      steps: [
        { key: 'first', title: '生成恢复上下文', description: '记录上游输出。' },
        { key: 'second', title: '消费恢复上下文', description: '验证恢复后的 prompt/context。' },
        { key: 'third', title: '补充执行分支', description: '供其他 owner 领取。' }
      ],
      dependencies: [
        { predecessor: 'first', successor: 'second' }
      ]
    }
  });
  assertProtocol(sessionCreated, 'create-workflow', 'ok');
  const sessionFirstTask = sessionCreated.tasks.find((task) => task.planTaskKey === 'first');
  const sessionSecondTask = sessionCreated.tasks.find((task) => task.planTaskKey === 'second');
  const sessionThirdTask = sessionCreated.tasks.find((task) => task.planTaskKey === 'third');

  const sessionFirstClaim = await runCli('claim-next-ready-task', {
    dbPath,
    workflowId: sessionCreated.workflow.workflowId,
    leaseOwner: 'cli-session-runner',
    leaseMs: 60_000
  });
  assertProtocol(sessionFirstClaim, 'claim-next-ready-task', 'claimed');
  assert(sessionFirstClaim.task?.taskId === sessionFirstTask.taskId, 'session recovery fixture should claim the first task initially');

  const continuedSession = await runCli('resume-session', {
    dbPath,
    workflowId: sessionCreated.workflow.workflowId,
    workerId: 'cli-session-runner',
    leaseMs: 120_000
  });
  assertProtocol(continuedSession, 'resume-session', 'continued');
  assert(continuedSession.task?.taskId === sessionFirstClaim.task.taskId, 'resume-session should continue the owned active task');
  assert(continuedSession.task?.attemptCount === sessionFirstClaim.task.attemptCount, 'resume-session should not increment attempt count when continuing owned work');
  assert(continuedSession.recoveryMode === 'continued', 'resume-session should expose continued recovery mode');
  assert(continuedSession.resumedExistingTask === true, 'resume-session should flag resumed existing tasks');
  assert(continuedSession.nextAction === 'continue_claimed_task', 'continued recovery should recommend continuing the active task');
  assert(continuedSession.allowedNextCommands.includes('heartbeat-task-lease'), 'continued recovery should allow lease heartbeat');
  assert(typeof continuedSession.prompt === 'string' && continuedSession.prompt.includes('当前任务：'), 'continued recovery should include an execution prompt');
  assert(continuedSession.leaseExpiresAt && continuedSession.leaseExpiresAt !== sessionFirstClaim.leaseExpiresAt, 'continued recovery should renew the lease expiry');

  const differentOwnerRecovery = await runCli('resume-session', {
    dbPath,
    workflowId: sessionCreated.workflow.workflowId,
    workerId: 'cli-other-session-runner',
    leaseMs: 60_000
  });
  assertProtocol(differentOwnerRecovery, 'resume-session', differentOwnerRecovery.status);
  assert(['claimed', 'idle'].includes(differentOwnerRecovery.status), 'different owner recovery should either claim other ready work or stay idle');
  if (differentOwnerRecovery.status === 'claimed') {
    assert(differentOwnerRecovery.task?.taskId === sessionThirdTask.taskId, 'different owner should not steal an active task owned by another worker');
  } else {
    assert(differentOwnerRecovery.task === null, 'different owner should not receive the active task owned by another worker');
  }
  assert(differentOwnerRecovery.resumedExistingTask === false, 'different owner recovery should not mark an existing resumed task');

  await runCli('complete-task', {
    dbPath,
    workflowId: sessionCreated.workflow.workflowId,
    taskId: sessionFirstClaim.task.taskId,
    doneSummary: 'session first task done',
    leaseOwner: 'cli-session-runner'
  });
  const sessionOutput = await runCli('add-task-output', {
    dbPath,
    workflowId: sessionCreated.workflow.workflowId,
    taskId: sessionFirstClaim.task.taskId,
    kind: 'result',
    name: 'session-result',
    content: 'session recovery predecessor output',
    metadata: { source: 'session-recovery-smoke', trustState: 'validated' }
  });
  assertProtocol(sessionOutput, 'add-task-output', 'ok');

  const sessionSecondClaim = await runCli('claim-next-ready-task', {
    dbPath,
    workflowId: sessionCreated.workflow.workflowId,
    leaseOwner: 'cli-session-runner',
    leaseMs: 60_000
  });
  assertProtocol(sessionSecondClaim, 'claim-next-ready-task', 'claimed');
  assert(sessionSecondClaim.task?.taskId === sessionSecondTask.taskId, 'session fixture should claim the dependent second task');

  const continuedDependentSession = await runCli('resume-session', {
    dbPath,
    workflowId: sessionCreated.workflow.workflowId,
    workerId: 'cli-session-runner',
    leaseMs: 120_000,
    outputKind: 'result',
    outputLimitPerTask: 5
  });
  assertProtocol(continuedDependentSession, 'resume-session', 'continued');
  assert(continuedDependentSession.task?.taskId === sessionSecondClaim.task.taskId, 'resume-session should continue the dependent owned task');
  assert(continuedDependentSession.predecessorOutputs.some((item) => item.output?.outputId === sessionOutput.output.outputId), 'continued recovery should include predecessor outputs');
  assert(continuedDependentSession.prompt.includes('session recovery predecessor output'), 'continued recovery prompt should include predecessor output content');

  const expiredSessionRecovery = await runCli('resume-session', {
    dbPath,
    workflowId: sessionCreated.workflow.workflowId,
    workerId: 'cli-session-runner',
    leaseMs: 60_000,
    now: new Date(Date.now() + 10_000_000).toISOString(),
    reason: 'Session recovery smoke expired lease.'
  });
  assertProtocol(expiredSessionRecovery, 'resume-session', 'claimed');
  assert(expiredSessionRecovery.releasedTaskCount >= 1, 'resume-session should report released expired owned leases');
  assert(expiredSessionRecovery.task?.taskId === sessionSecondClaim.task.taskId, 'resume-session should reclaim the released ready task');
  assert(expiredSessionRecovery.task?.attemptCount === sessionSecondClaim.task.attemptCount + 1, 'reclaiming after expired recovery should increment attempt count');

  await runCli('complete-task', {
    dbPath,
    workflowId: sessionCreated.workflow.workflowId,
    taskId: expiredSessionRecovery.task.taskId,
    doneSummary: 'session second task done after recovery',
    leaseOwner: 'cli-session-runner'
  });
  if (differentOwnerRecovery.status === 'claimed') {
    await runCli('complete-task', {
      dbPath,
      workflowId: sessionCreated.workflow.workflowId,
      taskId: differentOwnerRecovery.task.taskId,
      doneSummary: 'session third task done by other owner',
      leaseOwner: 'cli-other-session-runner'
    });
  }

  const idleSessionRecovery = await runCli('resume-session', {
    dbPath,
    workflowId: sessionCreated.workflow.workflowId,
    workerId: 'cli-session-runner',
    leaseMs: 60_000
  });
  assertProtocol(idleSessionRecovery, 'resume-session', idleSessionRecovery.status);
  if (idleSessionRecovery.status === 'claimed') {
    await runCli('complete-task', {
      dbPath,
      workflowId: sessionCreated.workflow.workflowId,
      taskId: idleSessionRecovery.task.taskId,
      doneSummary: 'session remaining task done before idle recovery',
      leaseOwner: 'cli-session-runner'
    });
  }

  const finalIdleSessionRecovery = await runCli('resume-session', {
    dbPath,
    workflowId: sessionCreated.workflow.workflowId,
    workerId: 'cli-session-runner',
    leaseMs: 60_000
  });
  assertProtocol(finalIdleSessionRecovery, 'resume-session', 'idle');
  assert(finalIdleSessionRecovery.recoveryMode === 'idle', 'idle resume-session should expose idle recovery mode');
  assert(finalIdleSessionRecovery.task === null, 'idle resume-session should not expose a task');
  assert(finalIdleSessionRecovery.nextAction === 'inspect_workflow_state', 'idle recovery should recommend inspection');

  const workflowOverview = await runCli('list-workflows', {
    dbPath,
    limit: 20
  });
  assertProtocol(workflowOverview, 'list-workflows', 'ok');
  assert(workflowOverview.overview?.workflowCount >= 2, 'list-workflows should expose recent workflows');
  assert(workflowOverview.overview?.blockedCount >= 1, 'list-workflows should count blocked workflows');
  assert(workflowOverview.allowedNextCommands.includes('inspect-workflow'), 'list-workflows should recommend inspect-workflow');
  const blockedSummary = workflowOverview.summaries.find((summary) => summary.workflowId === claim.task.workflowId);
  assert(blockedSummary?.status === 'blocked', 'list-workflows summary should expose blocked workflow status');
  assert(blockedSummary?.blockedTasks?.some((task) => task.taskId === claim.task.taskId && task.lastError === '等待人工确认 CLI 流程。'), 'list-workflows summary should expose blocked task reason');
  const skippedSummary = workflowOverview.summaries.find((summary) => summary.workflowId === skippedRoutingCreated.workflow.workflowId);
  assert(skippedSummary?.countsByStatus?.skipped === 1, 'list-workflows summary should expose skipped task counts');
  assert(skippedSummary?.progress?.skipped === 1, 'list-workflows summary should expose skipped progress');

  const blockedInspection = await runCli('inspect-workflow', {
    dbPath,
    workflowId: claim.task.workflowId
  });
  assertProtocol(blockedInspection, 'inspect-workflow', 'ok');
  assert(blockedInspection.summary?.status === 'blocked', 'inspect-workflow summary should expose blocked status');
  assert(blockedInspection.inspection?.blockedTasks?.some((task) => task.taskId === claim.task.taskId && task.lastError === '等待人工确认 CLI 流程。'), 'inspect-workflow should expose blocked task details');
  assert(blockedInspection.allowedNextCommands.includes('list-workflows'), 'inspect-workflow should allow returning to global overview');
  assert(skippedRoutingInspection.summary?.countsByStatus?.skipped === 1, 'inspect-workflow summary should expose skipped task counts');
  assert(skippedRoutingInspection.summary?.progress?.skipped === 1, 'inspect-workflow summary should expose skipped progress');

  const workflowInspections = await runCli('inspect-workflows', {
    dbPath,
    limit: 20,
    activeOnly: true
  });
  assertProtocol(workflowInspections, 'inspect-workflows', 'ok');
  assert(workflowInspections.overview?.blockedCount >= 1, 'inspect-workflows should count blocked workflows');
  assert(workflowInspections.inspections.some((inspection) => inspection.workflow?.workflowId === claim.task.workflowId && inspection.blockedTasks.some((task) => task.taskId === claim.task.taskId)), 'inspect-workflows should include blocked workflow inspection');
  assert(workflowInspections.inspections.some((inspection) => inspection.workflow?.workflowId === skippedRoutingCreated.workflow.workflowId && inspection.skippedTasks.some((task) => task.taskId === skippedPublisherTask.taskId && task.reasonCode === 'dependency_condition_not_met')), 'inspect-workflows should include skipped workflow inspection details');

  const resumed = await runCli('resume-task', {
    dbPath,
    workflowId: claim.task.workflowId,
    taskId: claim.task.taskId,
    payload: { source: 'cli-smoke-test', resumed: true }
  });
  assertProtocol(resumed, 'resume-task', 'updated');
  assert(resumed.task?.status === 'ready', 'resume-task should move the blocked task back to ready');
  assert(resumed.workflow?.status === 'ready', 'resume-task should restore the workflow to ready');
  assert(resumed.task?.attemptCount === blockedTask?.attemptCount, 'resume-task should preserve historical attemptCount before retrying');
  assert(resumed.task?.lastError === '等待人工确认 CLI 流程。', 'resume-task should preserve lastError for the next attempt');
  assert(resumed.nextAction === 'claim_next_ready_task', 'resume-task should recommend claiming the task again');
  assert(resumed.allowedNextCommands.includes('claim-next-ready-task'), 'resume-task should expose claim-next-ready-task as an allowed next command');

  claim = await runCli('claim-next-ready-task', {
    dbPath,
    leaseOwner: 'cli-runner',
    leaseMs: 60_000
  });
  assertProtocol(claim, 'claim-next-ready-task', 'claimed');
  assert(claim.task?.taskId === resumed.task.taskId, 'reclaimed task should be the resumed task');
  assert(claim.task?.status === 'doing', 'reclaimed task should return to doing');
  assert(claim.prompt.includes('最近错误: 等待人工确认 CLI 流程。'), 'reclaimed prompt should preserve the previous blocked reason');

  const taskOutput = await runCli('add-task-output', {
    dbPath,
    workflowId: claim.task.workflowId,
    taskId: claim.task.taskId,
    kind: 'result',
    name: 'manual-confirmation',
    content: '人工确认结果已记录。',
    metadata: { source: 'cli-smoke-test', resumed: true, trustState: 'validated' }
  });
  assertProtocol(taskOutput, 'add-task-output', 'ok');
  assert(taskOutput.output?.outputId, 'add-task-output should return an output id');
  assert(taskOutput.output?.workflowId === claim.task.workflowId, 'task output should preserve workflowId');
  assert(taskOutput.output?.taskId === claim.task.taskId, 'task output should preserve taskId');
  assert(taskOutput.output?.kind === 'result', 'task output should preserve kind');
  assert(taskOutput.output?.content === '人工确认结果已记录。', 'task output should preserve content');
  assert(taskOutput.output?.metadata?.source === 'cli-smoke-test', 'task output should preserve metadata');

  const taskOutputs = await runCli('list-task-outputs', {
    dbPath,
    workflowId: claim.task.workflowId,
    taskId: claim.task.taskId,
    kind: 'result'
  });
  assertProtocol(taskOutputs, 'list-task-outputs', 'ok');
  assert(taskOutputs.outputs.some((output) => output.outputId === taskOutput.output.outputId), 'list-task-outputs should return the stored output');

  const wrongLeaseOwnerComplete = await runCli('complete-task', {
    dbPath,
    workflowId: claim.task.workflowId,
    taskId: claim.task.taskId,
    doneSummary: '错误 owner 不应完成。',
    leaseOwner: 'another-runner'
  }, { allowFailure: true });
  assert(wrongLeaseOwnerComplete.code !== 0, 'complete-task should reject a mismatched lease owner');

  const completedResumedTask = await runCli('complete-task', {
    dbPath,
    workflowId: claim.task.workflowId,
    taskId: claim.task.taskId,
    doneSummary: '人工确认已经完成。',
    payload: {
      source: 'cli-smoke-test',
      resume: true,
      outputs: [
        {
          kind: 'artifact',
          name: 'payload-capture-artifact',
          content: 'payload 输出已自动捕获。',
          metadata: { source: 'payload.outputs' }
        }
      ]
    },
    handoff: {
      summary: '人工确认完成，后续任务可以消费结构化交接。',
      artifacts: ['artifacts/manual-confirmation.md'],
      decisions: ['继续使用 CLI 自动捕获任务记忆。'],
      openQuestions: ['是否需要人工复核最终发布内容？'],
      risks: ['未验证输出只能作为低信任参考。'],
      recommendedNextRole: 'reviewer'
    },
    taskOutputs: [
      {
        kind: 'result',
        name: 'structured-capture-result',
        content: '结构化 completion 输出已记录。',
        metadata: { source: 'complete-task', trustState: 'validated' }
      }
    ],
    memory: {
      name: 'manual-memory-note',
      content: 'CLI complete-task 传入的 memory 字段已记录为任务输出。'
    },
    leaseOwner: 'cli-runner'
  });
  assertProtocol(completedResumedTask, 'complete-task', 'updated');
  assert(completedResumedTask.capture?.handoffRecorded === true, 'complete-task should report captured handoff');
  assert(completedResumedTask.capture?.outputCount >= 6, 'complete-task should report generated and explicit outputs');
  assert(completedResumedTask.capture?.outputKinds?.includes('summary'), 'complete-task should capture a summary output');
  assert(completedResumedTask.capture?.outputKinds?.includes('handoff'), 'complete-task should capture a handoff output');
  assert(completedResumedTask.capture?.outputKinds?.includes('decision'), 'complete-task should capture decision outputs');
  assert(completedResumedTask.capture?.outputKinds?.includes('result'), 'complete-task should capture explicit result outputs');
  assert(completedResumedTask.task?.handoff?.recommendedNextRole === 'reviewer', 'complete-task should persist structured handoff on the task');

  const capturedOutputs = await runCli('list-task-outputs', {
    dbPath,
    workflowId: claim.task.workflowId,
    taskId: claim.task.taskId
  });
  assertProtocol(capturedOutputs, 'list-task-outputs', 'ok');
  assert(capturedOutputs.outputs.some((output) => output.kind === 'summary' && output.content === '人工确认已经完成。'), 'captured outputs should include generated summary');
  assert(capturedOutputs.outputs.some((output) => output.kind === 'handoff' && output.content.includes('人工确认完成')), 'captured outputs should include generated handoff');
  assert(capturedOutputs.outputs.some((output) => output.kind === 'decision' && output.content === '继续使用 CLI 自动捕获任务记忆。'), 'captured outputs should include generated decision');
  assert(capturedOutputs.outputs.some((output) => output.kind === 'result' && output.name === 'structured-capture-result'), 'captured outputs should include explicit taskOutputs result');
  assert(capturedOutputs.outputs.some((output) => output.kind === 'artifact' && output.name === 'payload-capture-artifact'), 'captured outputs should include payload.outputs artifact');
  assert(capturedOutputs.outputs.some((output) => output.name === 'manual-memory-note'), 'captured outputs should include memory payload output');

  const inheritedOutputClaim = await runCli('claim-next-ready-task', {
    dbPath,
    workflowId: claim.task.workflowId,
    leaseOwner: 'cli-runner',
    leaseMs: 60_000,
    outputKind: 'result',
    outputLimitPerTask: 5
  });
  assertProtocol(inheritedOutputClaim, 'claim-next-ready-task', 'claimed');
  assert(inheritedOutputClaim.prompt.includes('上游输出：'), 'dependent claim prompt should include inherited predecessor outputs');
  assert(inheritedOutputClaim.prompt.includes('manual-confirmation'), 'dependent claim prompt should include predecessor output name');
  assert(inheritedOutputClaim.prompt.includes('人工确认结果已记录。'), 'dependent claim prompt should include predecessor output content');
  assert(inheritedOutputClaim.predecessorOutputs.some((item) => item.output?.outputId === taskOutput.output.outputId), 'dependent claim response should include inherited predecessor output');
  await runCli('complete-task', {
    dbPath,
    workflowId: inheritedOutputClaim.task.workflowId,
    taskId: inheritedOutputClaim.task.taskId,
    doneSummary: `CLI 完成任务：${inheritedOutputClaim.task.title}`,
    leaseOwner: 'cli-runner'
  });

  state = await runCli('get-workflow-state', {
    dbPath,
    workflowId: claim.task.workflowId
  });
  assertProtocol(state, 'get-workflow-state', 'ok');
  assert(state.workflow.status !== 'blocked', 'workflow should leave blocked after completing the resumed task');

  while (true) {
    claim = await runCli('claim-next-ready-task', {
      dbPath,
      leaseOwner: 'cli-runner',
      leaseMs: 60_000
    });
    assertProtocol(claim, 'claim-next-ready-task', claim.status);

    if (claim.status === 'idle') {
      break;
    }

    await runCli('complete-task', {
      dbPath,
      workflowId: claim.task.workflowId,
      taskId: claim.task.taskId,
      doneSummary: `CLI 完成任务：${claim.task.title}`,
      leaseOwner: 'cli-runner'
    });
  }

  state = await runCli('get-workflow-state', {
    dbPath,
    workflowId: created.workflow.workflowId
  });
  assertProtocol(state, 'get-workflow-state', 'ok');
  assert(state.workflow.status === 'done', 'workflow should be done after CLI completes all tasks');
  assert(state.tasks.every((task) => task.status === 'done'), 'all tasks should be done after CLI loop');
  assert(state.summary?.workflowStatus === 'done', 'final workflow summary should show done');
  assert(state.summary?.nextRecommendedCommand === 'workflow_done', 'final workflow summary should recommend workflow_done');
  assert(state.allowedNextCommands.includes('list-workflow-reruns'), 'done workflow should allow rerun audit queries');
  assert(state.allowedNextCommands.includes('restart-from-task'), 'done workflow should allow restarting from a finished task');

  const rerunCreated = await runCli('create-workflow', {
    dbPath,
    instruction: '修正一条已经发布的错误结论',
    plan: {
      goal: '支持从中间任务重新启动工作流',
      steps: [
        {
          key: 'collect-facts',
          title: '收集事实',
          description: '先整理需要引用的事实。',
          type: 'analysis'
        },
        {
          key: 'rewrite-conclusion',
          title: '改写错误结论',
          description: '基于修正后的事实重写结论。',
          type: 'implement'
        },
        {
          key: 'publish-result',
          title: '发布最终结果',
          description: '基于修正后的结论重新产出最终结果。',
          type: 'handoff'
        }
      ],
      dependencies: [
        { from: 'collect-facts', to: 'rewrite-conclusion' },
        { from: 'rewrite-conclusion', to: 'publish-result' }
      ]
    }
  });
  assertProtocol(rerunCreated, 'create-workflow', 'ok');

  while (true) {
    const rerunClaim = await runCli('claim-next-ready-task', {
      dbPath,
      leaseOwner: 'rerun-cli-runner',
      leaseMs: 60_000
    });
    assertProtocol(rerunClaim, 'claim-next-ready-task', rerunClaim.status);

    if (rerunClaim.status === 'idle') {
      break;
    }

    assert(rerunClaim.allowedNextCommands.includes('list-task-revisions'), 'claimed task should allow audit queries during execution');
    await runCli('complete-task', {
      dbPath,
      workflowId: rerunClaim.task.workflowId,
      taskId: rerunClaim.task.taskId,
      doneSummary: `CLI 完成重跑夹具任务：${rerunClaim.task.title}`,
      leaseOwner: 'rerun-cli-runner'
    });
  }

  const rerunDoneState = await runCli('get-workflow-state', {
    dbPath,
    workflowId: rerunCreated.workflow.workflowId
  });
  assertProtocol(rerunDoneState, 'get-workflow-state', 'ok');
  assert(rerunDoneState.workflow.status === 'done', 'rerun fixture workflow should finish before restart-from-task');

  const rerunOriginTask = rerunDoneState.tasks.find((task) => task.title === '改写错误结论');
  const rerunDescendantTask = rerunDoneState.tasks.find((task) => task.title === '发布最终结果');
  assert(rerunOriginTask, 'rerun fixture should include the origin task');
  assert(rerunDescendantTask, 'rerun fixture should include the descendant task');

  const descendantQuery = await runCli('list-descendant-task-ids', {
    dbPath,
    workflowId: rerunCreated.workflow.workflowId,
    taskId: rerunOriginTask.taskId
  });
  assertProtocol(descendantQuery, 'list-descendant-task-ids', 'ok');
  assert(descendantQuery.workflowId === rerunCreated.workflow.workflowId, 'descendant query should echo workflowId');
  assert(descendantQuery.taskId === rerunOriginTask.taskId, 'descendant query should echo taskId');
  assert(Array.isArray(descendantQuery.descendantTaskIds) && descendantQuery.descendantTaskIds.length === 1, 'descendant query should return one descendant task');
  assert(descendantQuery.descendantTaskIds[0] === rerunDescendantTask.taskId, 'descendant query should return the expected descendant task');

  const rerunReason = '中间结论引用了错误上游事实，必须从起点重跑';
  const rerunFingerprint = 'cli-rerun-smoke';
  const restarted = await runCli('restart-from-task', {
    dbPath,
    workflowId: rerunCreated.workflow.workflowId,
    taskId: rerunOriginTask.taskId,
    reason: rerunReason,
    fingerprint: rerunFingerprint,
    operator: 'cli-smoke-test',
    payload: { operator: 'cli-smoke-test', mode: 'rerun' },
    maxSameFingerprintReruns: 2
  });
  assertProtocol(restarted, 'restart-from-task', 'restarted');
  assert(restarted.workflow?.status === 'ready', 'restart-from-task should move the workflow back to ready');
  assert(restarted.task?.taskId === rerunOriginTask.taskId, 'restart-from-task should return the origin task');
  assert(restarted.task?.status === 'ready', 'restart-from-task should move the origin task back to ready');
  assert(restarted.task?.attemptCount === 0, 'restart-from-task should reset the rerun origin attemptCount as a fresh execution window');
  assert(restarted.task?.lastError === rerunReason, 'restart-from-task should persist the rerun reason on the origin task');
  assert(Array.isArray(restarted.descendants) && restarted.descendants.length === 1, 'restart-from-task should return the invalidated descendants');
  assert(restarted.descendants[0].taskId === rerunDescendantTask.taskId, 'restart-from-task should invalidate the expected descendant task');
  assert(restarted.descendants[0].status === 'pending', 'restart-from-task should move descendants back to pending');
  assert(restarted.descendants[0].attemptCount === 0, 'restart-from-task should reset descendant attemptCount as part of rerun invalidation');
  assert(restarted.rerun?.fingerprint === rerunFingerprint, 'restart-from-task should return rerun metadata');
  assert(restarted.runLogs.some((log) => log.action === 'workflow_rerun_created'), 'restart-from-task should write a workflow rerun log');
  assert(restarted.runLogs.some((log) => log.action === 'task_invalidated_by_rerun' && log.taskId === rerunDescendantTask.taskId), 'restart-from-task should write a descendant invalidation log');
  assert(restarted.allowedNextCommands.includes('list-workflow-reruns'), 'restart-from-task should keep rerun audit commands available');

  const rerunAudit = await runCli('list-workflow-reruns', {
    dbPath,
    workflowId: rerunCreated.workflow.workflowId,
    limit: 5
  });
  assertProtocol(rerunAudit, 'list-workflow-reruns', 'ok');
  assert(rerunAudit.limit === 5, 'rerun audit query should echo the limit');
  assert(Array.isArray(rerunAudit.reruns) && rerunAudit.reruns.length === 1, 'rerun audit query should return one rerun row');
  assert(rerunAudit.reruns[0].rerunId === restarted.rerun.rerunId, 'rerun audit query should return the created rerun');
  assert(rerunAudit.reruns[0].originTaskId === rerunOriginTask.taskId, 'rerun audit query should store the origin task id');
  assert(rerunAudit.reruns[0].affectedTaskIds.includes(rerunDescendantTask.taskId), 'rerun audit query should include descendant task ids');

  const revisionAudit = await runCli('list-task-revisions', {
    dbPath,
    workflowId: rerunCreated.workflow.workflowId,
    rerunId: restarted.rerun.rerunId,
    limit: 10
  });
  assertProtocol(revisionAudit, 'list-task-revisions', 'ok');
  assert(revisionAudit.rerunId === restarted.rerun.rerunId, 'revision query should echo the rerun id');
  assert(Array.isArray(revisionAudit.revisions) && revisionAudit.revisions.length === 2, 'revision query should return origin and descendant snapshots');
  assert(revisionAudit.revisions.every((revision) => revision.previousStatus === 'done'), 'revision query should capture prior done states');
  assert(revisionAudit.revisions.some((revision) => revision.taskId === rerunOriginTask.taskId), 'revision query should include the origin task snapshot');
  assert(revisionAudit.revisions.some((revision) => revision.taskId === rerunDescendantTask.taskId), 'revision query should include the descendant task snapshot');

  const rerunBudgetExceeded = await runCli('restart-from-task', {
    dbPath,
    workflowId: rerunCreated.workflow.workflowId,
    taskId: rerunOriginTask.taskId,
    reason: rerunReason,
    fingerprint: rerunFingerprint,
    operator: 'cli-smoke-test',
    payload: { operator: 'cli-smoke-test', mode: 'budget-check' },
    maxSameFingerprintReruns: 1
  }, { allowFailure: true });
  assert(rerunBudgetExceeded.code !== 0, 'restart-from-task should fail when the rerun budget is exceeded');
  assert(rerunBudgetExceeded.stderr.includes('Rerun budget exceeded'), 'rerun budget error should surface through the CLI');

  const rerunAfterRestartClaim = await runCli('claim-next-ready-task', {
    dbPath,
    leaseOwner: 'rerun-cli-runner',
    leaseMs: 60_000
  });
  assertProtocol(rerunAfterRestartClaim, 'claim-next-ready-task', 'claimed');
  assert(rerunAfterRestartClaim.task?.taskId === rerunOriginTask.taskId, 'rerun claim should pick the restarted origin task first');
  assert(rerunAfterRestartClaim.prompt.includes(rerunReason), 'rerun claim prompt should include the rerun reason');
  await runCli('complete-task', {
    dbPath,
    workflowId: rerunAfterRestartClaim.task.workflowId,
    taskId: rerunAfterRestartClaim.task.taskId,
    doneSummary: 'CLI 完成重跑起点任务。',
    leaseOwner: 'rerun-cli-runner'
  });

  const rerunDescendantClaim = await runCli('claim-next-ready-task', {
    dbPath,
    leaseOwner: 'rerun-cli-runner',
    leaseMs: 60_000
  });
  assertProtocol(rerunDescendantClaim, 'claim-next-ready-task', 'claimed');
  assert(rerunDescendantClaim.task?.taskId === rerunDescendantTask.taskId, 'descendant task should become ready after rerun origin completes');
  await runCli('complete-task', {
    dbPath,
    workflowId: rerunDescendantClaim.task.workflowId,
    taskId: rerunDescendantClaim.task.taskId,
    doneSummary: 'CLI 完成重跑后的最终发布。',
    leaseOwner: 'rerun-cli-runner'
  });

  const rerunFinalState = await runCli('get-workflow-state', {
    dbPath,
    workflowId: rerunCreated.workflow.workflowId
  });
  assertProtocol(rerunFinalState, 'get-workflow-state', 'ok');
  assert(rerunFinalState.workflow.status === 'done', 'workflow should be done again after the CLI rerun flow');

  const happyChainCreated = await runCli('create-chain', {
    dbPath,
    adapterModule: chainAdapterModule,
    instruction: '完成顺序串联 happy path',
    stages: [
      {
        title: '准备分析',
        instruction: '先完成第一阶段准备工作'
      },
      {
        title: '输出结论',
        instruction: '基于上一阶段输出最终结论'
      }
    ]
  });
  assertProtocol(happyChainCreated, 'create-chain', 'ok');
  assert(happyChainCreated.chain?.chainId, 'create-chain should return a chain id');
  assert(happyChainCreated.chain.status === 'ready', 'create-chain should initialize the chain as ready');
  assert(happyChainCreated.stage?.status === 'ready', 'create-chain should expose the first ready stage');
  assert(happyChainCreated.summary?.chainStatus === 'ready', 'create-chain should include a chain summary');
  assert(happyChainCreated.allowedNextCommands.includes('run-chain'), 'ready chain should allow run-chain');

  let chainState = await runCli('get-chain-state', {
    dbPath,
    chainId: happyChainCreated.chain.chainId,
    includeWorkflowStates: true
  });
  assertProtocol(chainState, 'get-chain-state', 'ok');
  assert(chainState.chain.status === 'ready', 'get-chain-state should expose the latest chain status');
  assert(chainState.stages.length === 2, 'get-chain-state should return all stages');
  assert(Object.keys(chainState.workflowStates || {}).length === 0, 'fresh chain should not have workflow states before execution');
  assert(chainState.summary?.nextRecommendedCommand === 'run_chain', 'fresh chain summary should recommend running the chain');

  const happyChainRun = await runCli('run-chain', {
    dbPath,
    adapterModule: chainAdapterModule,
    chainId: happyChainCreated.chain.chainId,
    runnerId: 'cli-chain-runner',
    agentId: runnerAgentId,
    maxStages: 10,
    maxWorkflowSteps: 20
  });
  assertProtocol(happyChainRun, 'run-chain', 'done');
  assert(happyChainRun.chain.status === 'done', 'run-chain should finish the happy path chain');
  assert(happyChainRun.stages.every((stage) => stage.status === 'done'), 'run-chain happy path should complete every stage');
  assert(Array.isArray(happyChainRun.steps) && happyChainRun.steps.length === 2, 'run-chain should return one step per completed stage');
  assert(happyChainRun.lastStep?.stage?.title === '输出结论', 'run-chain should expose the last completed stage');
  const happyChainWorkflowSteps = collectInnerWorkflowSteps(happyChainRun);
  const happyChainWorkflowStep = happyChainWorkflowSteps.find((step) => step.status === 'done');
  assert(happyChainWorkflowStep, 'run-chain happy path should expose the inner workflow step for a stage');
  assert(happyChainWorkflowStep.executionContext?.tools?.length === 1, 'run-chain happy path should expose execution tools on the inner workflow step');
  assert(happyChainWorkflowStep.executionContext?.memory?.scope === 'workspace', 'run-chain happy path should expose execution memory defaults on the inner workflow step');
  assert(happyChainWorkflowStep.activeMemoryContext?.enabled === true, 'run-chain happy path should expose active memory context on the inner workflow step');
  assert(happyChainWorkflowStep.activeMemoryContext?.workspacePath?.replaceAll('\\', '/').toLowerCase() === workflowWorkspacePath.toLowerCase(), 'run-chain happy path should expose active memory workspace path on the inner workflow step');
  assert(happyChainWorkflowStep.adapterPayload?.promptHasExecutionContext === true, 'run-chain happy path should inject execution context into the stage prompt');
  assert(happyChainWorkflowStep.adapterPayload?.promptHasToolsContext === true, 'run-chain happy path should inject visible tools into the stage prompt');
  assert(happyChainWorkflowStep.adapterPayload?.promptHasMemoryContext === true, 'run-chain happy path should inject active memory context into the stage prompt');
  assert(happyChainWorkflowStep.adapterPayload?.promptHasWorkspaceContext === true, 'run-chain happy path should inject workspace hints into the stage prompt');
  assert(happyChainWorkflowStep.adapterPayload?.contextHasExecutionTools === true, 'run-chain happy path should include execution-tools context items');
  assert(happyChainWorkflowStep.adapterPayload?.contextHasExecutionMemory === true, 'run-chain happy path should include execution-memory context items');
  assert(happyChainWorkflowStep.adapterPayload?.contextHasExecutionWorkspace === true, 'run-chain happy path should include execution-workspace context items');
  assert(happyChainWorkflowStep.adapterPayload?.executionToolCount === 1, 'run-chain happy path should expose one execution tool on the inner workflow step');
  assert(happyChainWorkflowStep.adapterPayload?.activeMemoryEnabled === true, 'run-chain happy path should enable active memory context on the inner workflow step');
  assert(happyChainRun.allowedNextCommands.includes('restart-chain-from-stage'), 'done chain should allow restarting from a stage');

  chainState = await runCli('get-chain-state', {
    dbPath,
    chainId: happyChainCreated.chain.chainId,
    includeWorkflowStates: true
  });
  assertProtocol(chainState, 'get-chain-state', 'ok');
  assert(chainState.chain.status === 'done', 'happy chain state should become done after run-chain');
  assert(Object.keys(chainState.workflowStates || {}).length === 2, 'completed happy chain should expose workflow state per stage');

  const blockedChainCreated = await runCli('create-chain', {
    dbPath,
    adapterModule: chainAdapterModule,
    instruction: '完成带阻塞恢复的顺序串联',
    stages: [
      {
        title: '第一阶段',
        instruction: '先完成第一阶段'
      },
      {
        title: '第二阶段',
        instruction: '第二阶段需要先阻塞再恢复'
      }
    ]
  });
  assertProtocol(blockedChainCreated, 'create-chain', 'ok');

  const blockedChainRun = await runCli('run-chain', {
    dbPath,
    adapterModule: chainAdapterModule,
    chainId: blockedChainCreated.chain.chainId,
    runnerId: 'cli-chain-runner',
    agentId: runnerAgentId,
    maxStages: 10,
    maxWorkflowSteps: 20
  });
  assertProtocol(blockedChainRun, 'run-chain', 'blocked');
  assert(blockedChainRun.chain.status === 'blocked', 'run-chain should block when a stage blocks');
  assert(blockedChainRun.stage?.status === 'blocked', 'run-chain should expose the blocked stage');
  const blockedChainWorkflowStep = collectInnerWorkflowSteps(blockedChainRun)
    .find((step) => step.status === 'blocked');
  assert(blockedChainWorkflowStep, 'blocked chain run should expose the blocked inner workflow step for a stage');
  assert(blockedChainWorkflowStep.executionContext?.tools?.length === 1, 'blocked chain run should expose execution tools on the blocked inner workflow step');
  assert(blockedChainWorkflowStep.activeMemoryContext?.enabled === true, 'blocked chain run should expose active memory context on the blocked inner workflow step');
  assert(blockedChainWorkflowStep.adapterPayload?.promptHasExecutionContext === true, 'blocked chain run should inject execution context into the blocked stage prompt');
  assert(blockedChainWorkflowStep.adapterPayload?.promptHasToolsContext === true, 'blocked chain run should inject visible tools into the blocked stage prompt');
  assert(blockedChainWorkflowStep.adapterPayload?.promptHasMemoryContext === true, 'blocked chain run should inject active memory context into the blocked stage prompt');
  assert(blockedChainWorkflowStep.adapterPayload?.promptHasWorkspaceContext === true, 'blocked chain run should inject workspace hints into the blocked stage prompt');
  assert(blockedChainWorkflowStep.adapterPayload?.contextHasExecutionTools === true, 'blocked chain run should include execution-tools context items');
  assert(blockedChainWorkflowStep.adapterPayload?.contextHasExecutionMemory === true, 'blocked chain run should include execution-memory context items');
  assert(blockedChainWorkflowStep.adapterPayload?.contextHasExecutionWorkspace === true, 'blocked chain run should include execution-workspace context items');
  assert(blockedChainRun.summary?.hasBlockedStages === true, 'blocked chain summary should report blocked stages');
  assert(blockedChainRun.nextAction === 'resume_chain_stage', 'blocked chain should recommend resuming the stage');
  assert(blockedChainRun.allowedNextCommands.includes('resume-chain-stage'), 'blocked chain should allow resume-chain-stage');

  const blockedChainState = await runCli('get-chain-state', {
    dbPath,
    chainId: blockedChainCreated.chain.chainId,
    includeWorkflowStates: true
  });
  assertProtocol(blockedChainState, 'get-chain-state', 'ok');
  const blockedStage = blockedChainState.stages.find((stage) => stage.status === 'blocked');
  assert(blockedStage, 'blocked chain should contain a blocked stage');
  const blockedStageWorkflowState = blockedChainState.workflowStates?.[blockedStage.stageId];
  assert(blockedStageWorkflowState, 'blocked chain state should include the blocked stage workflow state');
  const blockedStageTask = blockedStageWorkflowState.tasks.find((task) => task.status === 'blocked');
  assert(blockedStageTask, 'blocked chain workflow should contain a blocked task');
  assert(blockedStageTask.lastError === `等待恢复：${blockedStageTask.title}`, 'blocked task should persist the adapter blocked reason');

  const resumedChainStage = await runCli('resume-chain-stage', {
    dbPath,
    adapterModule: chainAdapterModule,
    chainId: blockedChainCreated.chain.chainId,
    stageId: blockedStage.stageId,
    taskId: blockedStageTask.taskId,
    runnerId: 'cli-chain-runner',
    agentId: runnerAgentId,
    payload: { source: 'cli-smoke-test', resumed: true },
    message: '恢复第二阶段'
  });
  assertProtocol(resumedChainStage, 'resume-chain-stage', 'updated');
  assert(resumedChainStage.stage?.status === 'ready', 'resume-chain-stage should move the stage back to ready');
  assert(resumedChainStage.task?.status === 'ready', 'resume-chain-stage should move the workflow task back to ready');
  assert(resumedChainStage.task?.lastError === `等待恢复：${blockedStageTask.title}`, 'resume-chain-stage should preserve the previous blocked reason');
  assert(resumedChainStage.chain.status === 'ready', 'resume-chain-stage should restore the chain to ready');

  const resumedChainRun = await runCli('run-chain', {
    dbPath,
    adapterModule: chainAdapterModule,
    chainId: blockedChainCreated.chain.chainId,
    runnerId: 'cli-chain-runner',
    agentId: runnerAgentId,
    maxStages: 10,
    maxWorkflowSteps: 20
  });
  assertProtocol(resumedChainRun, 'run-chain', 'done');
  assert(resumedChainRun.chain.status === 'done', 'resumed chain should complete after re-running');
  assert(resumedChainRun.stages.every((stage) => stage.status === 'done'), 'all blocked chain stages should be done after resume');
  assert(resumedChainRun.runLogs.some((log) => log.action === 'chain_stage_resumed'), 'resume-chain-stage should write a chain_stage_resumed log');
  const resumedWorkflowStep = collectInnerWorkflowSteps(resumedChainRun)
    .find((step) => typeof step.prompt === 'string' && step.prompt.includes(`最近错误: ${blockedStageTask.lastError}`));
  assert(resumedWorkflowStep, 'resumed chain run should preserve the previous blocked reason in the workflow prompt');
  assert(resumedWorkflowStep.executionContext?.tools?.length === 1, 'resumed chain run should expose execution tools on the resumed inner workflow step');
  assert(resumedWorkflowStep.executionContext?.memory?.scope === 'workspace', 'resumed chain run should expose execution memory defaults on the resumed inner workflow step');
  assert(resumedWorkflowStep.activeMemoryContext?.enabled === true, 'resumed chain run should expose active memory context on the resumed inner workflow step');
  assert(resumedWorkflowStep.activeMemoryContext?.workspacePath?.replaceAll('\\', '/').toLowerCase() === workflowWorkspacePath.toLowerCase(), 'resumed chain run should expose active memory workspace path on the resumed inner workflow step');
  assert(resumedWorkflowStep.adapterPayload?.promptHasExecutionContext === true, 'resumed chain run should inject execution context into the resumed stage prompt');
  assert(resumedWorkflowStep.adapterPayload?.promptHasToolsContext === true, 'resumed chain run should inject visible tools into the resumed stage prompt');
  assert(resumedWorkflowStep.adapterPayload?.promptHasMemoryContext === true, 'resumed chain run should inject active memory context into the resumed stage prompt');
  assert(resumedWorkflowStep.adapterPayload?.promptHasWorkspaceContext === true, 'resumed chain run should inject workspace hints into the resumed stage prompt');
  assert(resumedWorkflowStep.adapterPayload?.contextHasExecutionTools === true, 'resumed chain run should include execution-tools context items');
  assert(resumedWorkflowStep.adapterPayload?.contextHasExecutionMemory === true, 'resumed chain run should include execution-memory context items');
  assert(resumedWorkflowStep.adapterPayload?.contextHasExecutionWorkspace === true, 'resumed chain run should include execution-workspace context items');
  assert(resumedWorkflowStep.adapterPayload?.executionToolCount === 1, 'resumed chain run should expose one execution tool on the resumed inner workflow step');
  assert(resumedWorkflowStep.adapterPayload?.activeMemoryEnabled === true, 'resumed chain run should enable active memory context on the resumed inner workflow step');

  const rerunChainCreated = await runCli('create-chain', {
    dbPath,
    adapterModule: chainAdapterModule,
    instruction: '完成带重跑的顺序串联',
    stages: [
      {
        title: '第一阶段',
        instruction: '先完成第一阶段'
      },
      {
        title: '第二阶段',
        instruction: '第二阶段需要在纠正上游错误后重新产出结果',
        plan: {
          goal: '第二阶段需要在纠正上游错误后重新产出结果',
          steps: [
            {
              key: 'collect-facts',
              title: '收集可信事实',
              description: '先产出上游可信事实'
            },
            {
              key: 'rewrite-conclusion',
              title: '改写错误结论',
              description: '修正语义上错误的中间结论'
            },
            {
              key: 'publish-result',
              title: '重新输出结果',
              description: '基于修正后的结论重新产出最终结果'
            }
          ],
          dependencies: [
            { from: 'collect-facts', to: 'rewrite-conclusion' },
            { from: 'rewrite-conclusion', to: 'publish-result' }
          ]
        }
      }
    ]
  });
  assertProtocol(rerunChainCreated, 'create-chain', 'ok');

  const rerunChainInitialRun = await runCli('run-chain', {
    dbPath,
    adapterModule: chainAdapterModule,
    chainId: rerunChainCreated.chain.chainId,
    runnerId: 'cli-chain-runner',
    agentId: runnerAgentId,
    maxStages: 10,
    maxWorkflowSteps: 20
  });
  assertProtocol(rerunChainInitialRun, 'run-chain', 'done');
  assert(rerunChainInitialRun.chain.status === 'done', 'rerun fixture chain should finish before restart');

  const rerunChainStateBeforeRestart = await runCli('get-chain-state', {
    dbPath,
    chainId: rerunChainCreated.chain.chainId,
    includeWorkflowStates: true
  });
  assertProtocol(rerunChainStateBeforeRestart, 'get-chain-state', 'ok');
  const rerunStage = rerunChainStateBeforeRestart.stages.find((stage) => stage.title === '第二阶段');
  assert(rerunStage?.workflowId, 'rerun chain should produce a workflow for the rerun stage');
  const rerunStageWorkflowState = rerunChainStateBeforeRestart.workflowStates?.[rerunStage.stageId];
  assert(rerunStageWorkflowState, 'rerun chain state should expose the rerun stage workflow state');
  const rerunOriginStageTask = rerunStageWorkflowState.tasks.find((task) => task.title === '改写错误结论');
  assert(rerunOriginStageTask, 'rerun stage workflow should contain the origin task');

  const rerunChainReason = '第二阶段引用了错误上游事实，chain 需要从错误起点重跑';
  const restartedChain = await runCli('restart-chain-from-stage', {
    dbPath,
    adapterModule: chainAdapterModule,
    chainId: rerunChainCreated.chain.chainId,
    stageId: rerunStage.stageId,
    taskId: rerunOriginStageTask.taskId,
    runnerId: 'cli-chain-runner',
    agentId: runnerAgentId,
    reason: rerunChainReason,
    fingerprint: 'chain-rerun-smoke',
    operator: 'cli-smoke-test',
    payload: { operator: 'cli-smoke-test', mode: 'rerun' },
    maxSameFingerprintReruns: 2
  });
  assertProtocol(restartedChain, 'restart-chain-from-stage', 'restarted');
  assert(restartedChain.stage?.status === 'ready', 'restart-chain-from-stage should move the stage back to ready');
  assert(restartedChain.task?.status === 'ready', 'restart-chain-from-stage should move the workflow origin task back to ready');
  assert(restartedChain.task?.taskId === rerunOriginStageTask.taskId, 'restart-chain-from-stage should return the origin task');
  assert(restartedChain.rerun?.rerunId, 'restart-chain-from-stage should return rerun metadata');
  assert(Array.isArray(restartedChain.descendants), 'restart-chain-from-stage should return descendant stage metadata');
  assert(Array.isArray(restartedChain.workflowRestart?.descendants) && restartedChain.workflowRestart.descendants.length >= 1, 'restart-chain-from-stage should expose invalidated workflow descendants');
  assert(restartedChain.workflowRestart?.task?.taskId === rerunOriginStageTask.taskId, 'restart-chain-from-stage should expose the underlying workflow restart result');

  const rerunChainAfterRestart = await runCli('run-chain', {
    dbPath,
    adapterModule: chainAdapterModule,
    chainId: rerunChainCreated.chain.chainId,
    runnerId: 'cli-chain-runner',
    agentId: runnerAgentId,
    maxStages: 10,
    maxWorkflowSteps: 20
  });
  assertProtocol(rerunChainAfterRestart, 'run-chain', 'done');
  assert(rerunChainAfterRestart.chain.status === 'done', 'rerun chain should become done again after restart');
  const rerunWorkflowStep = collectInnerWorkflowSteps(rerunChainAfterRestart)
    .find((step) => typeof step.prompt === 'string' && step.prompt.includes(rerunChainReason));
  assert(rerunWorkflowStep, 'rerun chain workflow prompt should include the rerun reason after restart');
  assert(rerunWorkflowStep.executionContext?.tools?.length === 1, 'rerun chain should expose execution tools on the restarted inner workflow step');
  assert(rerunWorkflowStep.executionContext?.memory?.scope === 'workspace', 'rerun chain should expose execution memory defaults on the restarted inner workflow step');
  assert(rerunWorkflowStep.activeMemoryContext?.enabled === true, 'rerun chain should expose active memory context on the restarted inner workflow step');
  assert(rerunWorkflowStep.activeMemoryContext?.workspacePath?.replaceAll('\\', '/').toLowerCase() === workflowWorkspacePath.toLowerCase(), 'rerun chain should expose active memory workspace path on the restarted inner workflow step');
  assert(rerunWorkflowStep.adapterPayload?.promptHasExecutionContext === true, 'rerun chain should inject execution context into the restarted stage prompt');
  assert(rerunWorkflowStep.adapterPayload?.promptHasToolsContext === true, 'rerun chain should inject visible tools into the restarted stage prompt');
  assert(rerunWorkflowStep.adapterPayload?.promptHasMemoryContext === true, 'rerun chain should inject active memory context into the restarted stage prompt');
  assert(rerunWorkflowStep.adapterPayload?.promptHasWorkspaceContext === true, 'rerun chain should inject workspace hints into the restarted stage prompt');
  assert(rerunWorkflowStep.adapterPayload?.contextHasExecutionTools === true, 'rerun chain should include execution-tools context items');
  assert(rerunWorkflowStep.adapterPayload?.contextHasExecutionMemory === true, 'rerun chain should include execution-memory context items');
  assert(rerunWorkflowStep.adapterPayload?.contextHasExecutionWorkspace === true, 'rerun chain should include execution-workspace context items');
  assert(rerunWorkflowStep.adapterPayload?.executionToolCount === 1, 'rerun chain should expose one execution tool on the restarted inner workflow step');
  assert(rerunWorkflowStep.adapterPayload?.activeMemoryEnabled === true, 'rerun chain should enable active memory context on the restarted inner workflow step');


  const coordinatorAdapterModule = path.join(__dirname, 'cli-coordinator-smoke-adapter.js');
  const validatorAgentId = 'cli-validator-agent';
  const capabilityOnlyMismatchAgentId = 'cli-capability-role-mismatch-agent';

  const coordinatorCreated = await runCli('create-workflow', {
    dbPath,
    instruction: 'coordinator CLI 需要阻塞恢复',
    plan: {
      goal: '验证 coordinator CLI 管理面主链路',
      steps: [
        {
          key: 'implement-blocked',
          title: '实现阻塞恢复场景',
          description: '先阻塞再恢复任务，验证 coordinator CLI 的 assign/resume 协议。',
          type: 'implement',
          requiredCapabilities: ['coordinator-implement']
        }
      ],
      dependencies: []
    }
  });
  assertProtocol(coordinatorCreated, 'create-workflow', 'ok');
  assert(coordinatorCreated.task?.requiredCapabilities?.includes('coordinator-implement'), 'coordinator fixture should require a coordinator-specific capability before registration');

  const noAgentAssignment = await runCli('assign-next-work', {
    dbPath,
    workflowId: coordinatorCreated.workflow.workflowId,
    targetType: 'task',
    taskId: coordinatorCreated.task.taskId,
    assignmentStatus: 'assigned',
    assignmentLimit: 20
  });
  assertProtocol(noAgentAssignment, 'assign-next-work', 'idle');
  assert(noAgentAssignment.reason === 'no_available_agent', 'assign-next-work should report no_available_agent before registration');
  assert(noAgentAssignment.target?.taskId === coordinatorCreated.task.taskId, 'assign-next-work should expose the ready task when no agent is available');
  assert(noAgentAssignment.nextAction === 'register_agent', 'no_available_agent should recommend registering an agent');

  const registeredAgent = await runCli('register-agent', {
    dbPath,
    workflowId: coordinatorCreated.workflow.workflowId,
    agentId: coordinatorAgentId,
    name: 'CLI Implementer',
    role: 'implementer',
    capabilities: ['implement', 'coordinator-implement'],
    visibility: coordinatorImplementerVisibility,
    adapterModule: coordinatorAdapterModule,
    status: 'active',
    assignmentLimit: 20,
    handoffLimit: 20
  });
  assertProtocol(registeredAgent, 'register-agent', 'ok');
  assert(registeredAgent.agent?.agentId === coordinatorAgentId, 'register-agent should echo the registered agent');
  assert(registeredAgent.summary?.agentCount >= 1, 'register-agent should include coordinator summary counts');
  assert(registeredAgent.allowedNextCommands.includes('assign-next-work'), 'registered coordinator should allow assignment');

  const registeredValidatorAgent = await runCli('register-agent', {
    dbPath,
    workflowId: coordinatorCreated.workflow.workflowId,
    agentId: validatorAgentId,
    name: 'CLI Validator',
    role: 'validator',
    capabilities: ['validate', 'tests'],
    visibility: coordinatorValidatorVisibility,
    adapterModule: coordinatorAdapterModule,
    status: 'active',
    assignmentLimit: 20,
    handoffLimit: 20
  });
  assertProtocol(registeredValidatorAgent, 'register-agent', 'ok');
  assert(registeredValidatorAgent.agent?.agentId === validatorAgentId, 'register-agent should persist validator role agent');

  const registeredCapabilityOnlyMismatchAgent = await runCli('register-agent', {
    dbPath,
    workflowId: coordinatorCreated.workflow.workflowId,
    agentId: capabilityOnlyMismatchAgentId,
    name: 'CLI Capability Role Mismatch Agent',
    capabilities: ['validate', 'tests'],
    adapterModule: coordinatorAdapterModule,
    status: 'active',
    assignmentLimit: 20,
    handoffLimit: 20
  });
  assertProtocol(registeredCapabilityOnlyMismatchAgent, 'register-agent', 'ok');
  assert(registeredCapabilityOnlyMismatchAgent.agent?.agentId === capabilityOnlyMismatchAgentId, 'register-agent should persist capability-only mismatch fixture agent');

  const roleAwareCreated = await runCli('create-workflow', {
    dbPath,
    workflowId: 'cli-role-aware-routing-workflow',
    instruction: 'coordinator role-aware assignment should pick validator',
    plan: {
      goal: '验证 role/capability 路由',
      steps: [
        {
          key: 'validate-result',
          title: '验证产出质量',
          description: '需要 validator 角色和 tests 能力。',
          requiredRole: 'validator',
          requiredCapabilities: ['tests']
        }
      ],
      dependencies: []
    }
  });
  assertProtocol(roleAwareCreated, 'create-workflow', 'ok');
  assert(roleAwareCreated.task?.preferredRole === 'validator', 'create-workflow should normalize requiredRole into preferredRole');
  assert(roleAwareCreated.task?.requiredCapabilities?.includes('tests'), 'create-workflow should preserve requiredCapabilities');

  const mismatchedRoleAssignment = await runCli('assign-next-work', {
    dbPath,
    workflowId: roleAwareCreated.workflow.workflowId,
    targetType: 'task',
    taskId: roleAwareCreated.task.taskId,
    agentId: capabilityOnlyMismatchAgentId,
    assignmentLimit: 20,
    handoffLimit: 20
  }, { allowFailure: true });
  assert(mismatchedRoleAssignment.code !== 0, 'assign-next-work should reject an explicit agent with matching capabilities but mismatched role');
  assert(mismatchedRoleAssignment.stderr.includes(`Agent "${capabilityOnlyMismatchAgentId}" cannot accept task "${roleAwareCreated.task.title}".`), 'mismatched role error should identify the rejected agent and task');

  const roleAwareAssignment = await runCli('assign-next-work', {
    dbPath,
    workflowId: roleAwareCreated.workflow.workflowId,
    targetType: 'task',
    taskId: roleAwareCreated.task.taskId,
    assignmentLimit: 20,
    handoffLimit: 20
  });
  assertProtocol(roleAwareAssignment, 'assign-next-work', 'assigned');
  assert(roleAwareAssignment.agent?.agentId === validatorAgentId, 'assign-next-work should pick the matching validator role agent');
  assert(roleAwareAssignment.assignment?.agentId === validatorAgentId, 'assign-next-work should assign role-aware task to validator');

  const roleAwareRun = await runCli('run-next-assignment', {
    dbPath,
    assignmentId: roleAwareAssignment.assignment.assignmentId,
    assignmentLimit: 20,
    handoffLimit: 20,
    maxWorkflowSteps: 20
  });
  assertProtocol(roleAwareRun, 'run-next-assignment', 'done');
  assert(roleAwareRun.agent?.agentId === validatorAgentId, 'run-next-assignment should execute role-aware task with validator');
  assert(roleAwareRun.step?.executionContext?.tools?.length === 1, 'run-next-assignment should expose validator execution tools on the workflow step');
  assert(roleAwareRun.step?.executionContext?.memory?.scope === 'workspace', 'run-next-assignment should expose validator memory defaults on the workflow step');
  assert(roleAwareRun.step?.activeMemoryContext?.enabled === true, 'run-next-assignment should expose validator active memory context on the workflow step');
  assert(roleAwareRun.step?.adapterPayload?.promptHasExecutionContext === true, 'run-next-assignment should inject execution context into the validator prompt');
  assert(roleAwareRun.step?.adapterPayload?.promptHasToolsContext === true, 'run-next-assignment should inject visible tools into the validator prompt');
  assert(roleAwareRun.step?.adapterPayload?.promptHasMemoryContext === true, 'run-next-assignment should inject active memory context into the validator prompt');
  assert(roleAwareRun.step?.adapterPayload?.contextHasExecutionTools === true, 'run-next-assignment should expose execution tools in validator context items');
  assert(roleAwareRun.step?.adapterPayload?.contextHasExecutionMemory === true, 'run-next-assignment should expose execution memory in validator context items');
  assert(roleAwareRun.step?.adapterPayload?.executionToolCount === 1, 'run-next-assignment should expose one validator execution tool');
  assert(roleAwareRun.step?.adapterPayload?.activeMemoryEnabled === true, 'run-next-assignment should enable validator active memory context');

  const roleAwareCoordinatorState = await runCli('get-coordinator-state', {
    dbPath,
    workflowId: roleAwareCreated.workflow.workflowId,
    taskId: roleAwareCreated.task.taskId,
    targetType: 'task',
    assignmentLimit: 20,
    handoffLimit: 20
  });
  assertProtocol(roleAwareCoordinatorState, 'get-coordinator-state', 'ok');
  const roleAwareRunnerLog = roleAwareCoordinatorState.workflowState?.runLogs?.find((log) => (
    log.action === 'task_completed_by_runner'
    && log.taskId === roleAwareCreated.task.taskId
  ));
  assert(roleAwareRunnerLog?.payload?.adapterPayload?.promptHasValidatorIdentity === true, 'coordinator-run prompt should include registered validator identity');
  assert(roleAwareRunnerLog?.payload?.adapterPayload?.promptHasValidatorCapabilities === true, 'coordinator-run prompt should include validator capabilities');
  assert(roleAwareRunnerLog?.payload?.adapterPayload?.promptHasExecutionContext === true, 'coordinator-run prompt should include validator execution context');
  assert(roleAwareRunnerLog?.payload?.adapterPayload?.promptHasToolsContext === true, 'coordinator-run prompt should include validator visible tools');
  assert(roleAwareRunnerLog?.payload?.adapterPayload?.promptHasMemoryContext === true, 'coordinator-run prompt should include validator active memory context');
  assert(roleAwareRunnerLog?.payload?.adapterPayload?.contextHasExecutionTools === true, 'coordinator-run payload should include validator execution tool context items');
  assert(roleAwareRunnerLog?.payload?.adapterPayload?.contextHasExecutionMemory === true, 'coordinator-run payload should include validator execution memory context items');
  assert(roleAwareRunnerLog?.payload?.adapterPayload?.executionToolCount === 1, 'coordinator-run payload should expose one validator execution tool');
  assert(roleAwareRunnerLog?.payload?.adapterPayload?.activeMemoryEnabled === true, 'coordinator-run payload should enable validator active memory context');

  const directClaimRoleCreated = await runCli('create-workflow', {
    dbPath,
    workflowId: 'cli-role-aware-direct-claim-workflow',
    instruction: 'direct claim role filters should select implementer task',
    plan: {
      goal: '验证 direct claim role filters and prompt identity',
      steps: [
        {
          key: 'implement-direct-claim',
          title: '实现 direct claim 任务',
          description: '需要 implementer 角色和 implement 能力。',
          requiredRole: 'implementer',
          requiredCapabilities: ['implement']
        }
      ],
      dependencies: []
    }
  });
  assertProtocol(directClaimRoleCreated, 'create-workflow', 'ok');

  const wrongRoleDirectClaim = await runCli('claim-next-ready-task', {
    dbPath,
    workflowId: directClaimRoleCreated.workflow.workflowId,
    leaseOwner: coordinatorAgentId,
    leaseMs: 60_000,
    requiredRole: 'validator',
    assignmentStatus: 'unassigned'
  });
  assertProtocol(wrongRoleDirectClaim, 'claim-next-ready-task', 'idle');

  const roleAwareDirectClaim = await runCli('claim-next-ready-task', {
    dbPath,
    workflowId: directClaimRoleCreated.workflow.workflowId,
    leaseOwner: coordinatorAgentId,
    agentId: coordinatorAgentId,
    leaseMs: 60_000,
    requiredRole: 'implementer',
    assignmentStatus: 'unassigned'
  });
  assertProtocol(roleAwareDirectClaim, 'claim-next-ready-task', 'claimed');
  assert(roleAwareDirectClaim.task?.taskId === directClaimRoleCreated.task.taskId, 'claim-next-ready-task should claim task through requiredRole filter');
  assert(roleAwareDirectClaim.prompt.includes('执行上下文：'), 'direct claim prompt should include execution context section');
  assert(roleAwareDirectClaim.prompt.includes('默认可见工具:'), 'direct claim prompt should include visible tools');
  assert(roleAwareDirectClaim.prompt.includes('活跃记忆:'), 'direct claim prompt should include active memory context');
  assert(roleAwareDirectClaim.prompt.includes('当前 agent 身份：'), 'direct claim prompt should include agent identity section');
  assert(roleAwareDirectClaim.prompt.includes(`agentId: ${coordinatorAgentId}`), 'direct claim prompt should include registered agentId');
  assert(roleAwareDirectClaim.prompt.includes('角色: implementer'), 'direct claim prompt should include registered agent role');
  assert(roleAwareDirectClaim.prompt.includes('能力: implement'), 'direct claim prompt should include registered agent capabilities');
  assert(roleAwareDirectClaim.executionContext?.tools?.length === 1, 'direct claim should expose execution context in the CLI response');
  assert(roleAwareDirectClaim.executionContext?.memory?.scope === 'workspace', 'direct claim should expose execution memory defaults in the CLI response');
  assert(roleAwareDirectClaim.activeMemoryContext?.enabled === true, 'direct claim should expose active memory context in the CLI response');
  assert(roleAwareDirectClaim.activeMemoryContext?.workspacePath?.replaceAll('\\', '/').toLowerCase() === workflowWorkspacePath.toLowerCase(), 'direct claim should expose active memory workspace path in the CLI response');
  await runCli('complete-task', {
    dbPath,
    workflowId: roleAwareDirectClaim.task.workflowId,
    taskId: roleAwareDirectClaim.task.taskId,
    leaseOwner: coordinatorAgentId,
    doneSummary: 'CLI completed role-aware direct claim task.'
  });

  const partialClaimAgentId = 'cli-partial-claim-agent';
  const partialClaimRegisteredAgent = await runCli('register-agent', {
    dbPath,
    workflowId: coordinatorCreated.workflow.workflowId,
    agentId: partialClaimAgentId,
    name: 'CLI Partial Claim Agent',
    role: 'implementer',
    capabilities: ['implement'],
    visibility: partialClaimVisibility,
    adapterModule: coordinatorAdapterModule,
    status: 'active',
    assignmentLimit: 20,
    handoffLimit: 20
  });
  assertProtocol(partialClaimRegisteredAgent, 'register-agent', 'ok');

  const partialClaimCreated = await runCli('create-workflow', {
    dbPath,
    workflowId: 'cli-partial-direct-claim-workflow',
    instruction: 'direct claim should inherit memory and workspace defaults when visibility is partial',
    plan: {
      goal: '验证 direct claim partial visibility fallback',
      steps: [
        {
          key: 'partial-direct-claim',
          title: '执行 partial direct claim 任务',
          description: 'agent 只显式提供工具，memory/workspace 依赖 runtime 默认值。',
          requiredRole: 'implementer',
          requiredCapabilities: ['implement']
        }
      ],
      dependencies: []
    }
  });
  assertProtocol(partialClaimCreated, 'create-workflow', 'ok');

  const partialVisibilityDirectClaim = await runCli('claim-next-ready-task', {
    dbPath,
    workflowId: partialClaimCreated.workflow.workflowId,
    leaseOwner: partialClaimAgentId,
    agentId: partialClaimAgentId,
    leaseMs: 60_000,
    requiredRole: 'implementer',
    assignmentStatus: 'unassigned'
  });
  assertProtocol(partialVisibilityDirectClaim, 'claim-next-ready-task', 'claimed');
  assert(partialVisibilityDirectClaim.executionContext?.tools?.length === 1, 'partial direct claim should preserve visible tools in execution context');
  assert(partialVisibilityDirectClaim.executionContext?.memory?.scope === 'workspace', 'partial direct claim should inherit workspace memory scope from runtime defaults');
  assert(partialVisibilityDirectClaim.executionContext?.memory?.workspacePath?.replaceAll('\\', '/').toLowerCase() === workflowWorkspacePath.toLowerCase(), 'partial direct claim should inherit memory workspace path from runtime defaults');
  assert(partialVisibilityDirectClaim.executionContext?.workspace?.cwd?.replaceAll('\\', '/').toLowerCase() === workflowWorkspacePath.toLowerCase(), 'partial direct claim should inherit workspace cwd from runtime defaults');
  assert(partialVisibilityDirectClaim.activeMemoryContext?.enabled === true, 'partial direct claim should expose enabled active memory context');
  const normalizedPartialClaimPrompt = partialVisibilityDirectClaim.prompt.replaceAll('\\', '/').toLowerCase();
  assert(normalizedPartialClaimPrompt.includes('活跃记忆: scope=workspace'), 'partial direct claim prompt should render inherited memory context');
  assert(normalizedPartialClaimPrompt.includes(`workspace=${workflowWorkspacePath.toLowerCase()}`), 'partial direct claim prompt should render inherited workspace path');
  assert(normalizedPartialClaimPrompt.includes(`cwd=${workflowWorkspacePath.toLowerCase()}`), 'partial direct claim prompt should render inherited workspace cwd');
  await runCli('complete-task', {
    dbPath,
    workflowId: partialVisibilityDirectClaim.task.workflowId,
    taskId: partialVisibilityDirectClaim.task.taskId,
    leaseOwner: partialClaimAgentId,
    doneSummary: 'CLI completed partial direct claim task.'
  });

  const capabilityFirstCreated = await runCli('create-workflow', {
    dbPath,
    workflowId: 'cli-capability-first-workflow',
    instruction: 'coordinator capability-first assignment without fixed role',
    plan: {
      goal: '验证不定义 role 也能按 capability 分配任务',
      steps: [
        {
          key: 'capability-first-task',
          title: '执行 capability-first 任务',
          description: '注册无 role agent 后按 capabilities 执行 ready task。',
          requiredCapabilities: ['capability-first-only']
        }
      ],
      dependencies: []
    }
  });
  assertProtocol(capabilityFirstCreated, 'create-workflow', 'ok');

  const capabilityOnlyAgent = await runCli('register-agent', {
    dbPath,
    workflowId: capabilityFirstCreated.workflow.workflowId,
    agentId: capabilityFirstAgentId,
    name: 'CLI Capability First Agent',
    capabilities: ['capability-first-only'],
    visibility: capabilityFirstVisibility,
    adapterModule: coordinatorAdapterModule,
    status: 'active',
    assignmentLimit: 20,
    handoffLimit: 20
  });
  assertProtocol(capabilityOnlyAgent, 'register-agent', 'ok');
  assert(capabilityOnlyAgent.agent?.agentId === capabilityFirstAgentId, 'register-agent should allow agent registration without role');
  assert(capabilityOnlyAgent.agent?.role === null, 'register-agent without role should persist role as null');

  const capabilityFirstAssignment = await runCli('assign-next-work', {
    dbPath,
    workflowId: capabilityFirstCreated.workflow.workflowId,
    targetType: 'task',
    taskId: capabilityFirstCreated.task.taskId,
    assignmentLimit: 20,
    handoffLimit: 20
  });
  assertProtocol(capabilityFirstAssignment, 'assign-next-work', 'assigned');
  assert(capabilityFirstAssignment.agent?.agentId === capabilityFirstAgentId, 'assign-next-work should pick capability-only agent');
  assert(capabilityFirstAssignment.assignment?.agentId === capabilityFirstAgentId, 'assign-next-work should create assignment for capability-only agent');
  assert(typeof capabilityFirstAssignment.assignment?.reason === 'string' && capabilityFirstAssignment.assignment.reason.includes('by capabilities/runtime availability'), 'assignment reason should explain capability-first fallback');
  assert(capabilityFirstAssignment.assignment.reason.includes('capabilities=capability-first-only'), 'assignment reason should include required capabilities');

  const capabilityFirstRun = await runCli('run-next-assignment', {
    dbPath,
    workflowId: capabilityFirstCreated.workflow.workflowId,
    targetType: 'task',
    taskId: capabilityFirstCreated.task.taskId,
    assignmentLimit: 20,
    handoffLimit: 20,
    maxWorkflowSteps: 20
  });
  assertProtocol(capabilityFirstRun, 'run-next-assignment', 'done');
  assert(capabilityFirstRun.agent?.agentId === capabilityFirstAgentId, 'run-next-assignment should execute with capability-only agent');
  assert(capabilityFirstRun.assignment?.agentId === capabilityFirstAgentId, 'run-next-assignment should complete the capability-only assignment');
  assert(capabilityFirstRun.step?.executionContext?.tools?.length === 1, 'capability-first run should expose execution tools on the workflow step');
  assert(capabilityFirstRun.step?.activeMemoryContext?.enabled === true, 'capability-first run should expose active memory context on the workflow step');
  assert(capabilityFirstRun.step?.adapterPayload?.promptHasExecutionContext === true, 'capability-first run should inject execution context into the prompt');
  assert(capabilityFirstRun.step?.adapterPayload?.contextHasExecutionTools === true, 'capability-first run should expose execution tools in context items');
  assert(capabilityFirstRun.step?.adapterPayload?.contextHasExecutionMemory === true, 'capability-first run should expose execution memory in context items');
  assert(capabilityFirstRun.workflow?.status === 'done', 'capability-first workflow should complete');

  const coordinatorHappyCreated = await runCli('create-workflow', {
    dbPath,
    instruction: 'coordinator CLI 直接执行 happy path',
    plan: {
      goal: '验证 coordinator CLI 直接执行 ready task',
      steps: [
        {
          key: 'implement-direct-run',
          title: '直接执行任务',
          description: '注册 agent 后直接通过 coordinator 执行 ready task。',
          type: 'implement'
        }
      ],
      dependencies: []
    }
  });
  assertProtocol(coordinatorHappyCreated, 'create-workflow', 'ok');

  const happyRun = await runCli('run-next-assignment', {
    dbPath,
    workflowId: coordinatorHappyCreated.workflow.workflowId,
    targetType: 'task',
    taskId: coordinatorHappyCreated.task.taskId,
    assignmentLimit: 20,
    handoffLimit: 20,
    maxWorkflowSteps: 20
  });
  assertProtocol(happyRun, 'run-next-assignment', 'done');
  assert(happyRun.assignment?.agentId === coordinatorAgentId, 'run-next-assignment should pick the registered agent for direct execution');
  assert(happyRun.assignment?.status === 'completed', 'run-next-assignment should complete the assignment on the happy path');
  assert(happyRun.agent?.agentId === coordinatorAgentId, 'run-next-assignment should return the executing agent');
  assert(happyRun.target?.taskId === coordinatorHappyCreated.task.taskId, 'run-next-assignment should expose the executed target');
  assert(happyRun.task?.taskId === coordinatorHappyCreated.task.taskId, 'run-next-assignment should expose the executed task');
  assert(happyRun.step?.status === 'done', 'run-next-assignment should expose the workflow step result');
  assert(happyRun.step?.executionContext?.tools?.length === 1, 'run-next-assignment should expose implementer execution tools on the happy-path step');
  assert(happyRun.step?.activeMemoryContext?.enabled === true, 'run-next-assignment should expose implementer active memory context on the happy-path step');
  assert(happyRun.step?.adapterPayload?.promptHasExecutionContext === true, 'run-next-assignment should inject execution context into the happy-path prompt');
  assert(happyRun.step?.adapterPayload?.promptHasToolsContext === true, 'run-next-assignment should inject visible tools into the happy-path prompt');
  assert(happyRun.step?.adapterPayload?.promptHasMemoryContext === true, 'run-next-assignment should inject active memory context into the happy-path prompt');
  assert(happyRun.step?.adapterPayload?.contextHasExecutionTools === true, 'run-next-assignment should expose execution tools in happy-path context items');
  assert(happyRun.step?.adapterPayload?.contextHasExecutionMemory === true, 'run-next-assignment should expose execution memory in happy-path context items');
  assert(happyRun.workflow?.status === 'done', 'run-next-assignment should expose the completed workflow state');
  assert(happyRun.allowedNextCommands.includes('run-next-assignment'), 'run-next-assignment happy path should keep coordinator execution available');

  const happyCoordinatorState = await runCli('get-coordinator-state', {
    dbPath,
    workflowId: coordinatorHappyCreated.workflow.workflowId,
    taskId: coordinatorHappyCreated.task.taskId,
    targetType: 'task',
    assignmentLimit: 20,
    handoffLimit: 20
  });
  assertProtocol(happyCoordinatorState, 'get-coordinator-state', 'ok');
  const happyFinalTaskState = happyCoordinatorState.workflowState?.tasks?.find((task) => task.taskId === coordinatorHappyCreated.task.taskId);
  assert(happyFinalTaskState?.doneSummary === `CLI coordinator 完成：${happyFinalTaskState.title}`, 'direct coordinator run should complete the original task through the adapter');
  const happyRunnerLog = happyCoordinatorState.workflowState?.runLogs?.find((log) => log.action === 'task_completed_by_runner');
  assert(happyRunnerLog?.payload?.adapterPayload?.promptHasAssignment === true, 'direct coordinator run should include assignment context in the adapter prompt');
  assert(happyRunnerLog?.payload?.adapterPayload?.promptHasExecutionContext === true, 'direct coordinator run should include execution context in the adapter prompt');
  assert(happyRunnerLog?.payload?.adapterPayload?.promptHasToolsContext === true, 'direct coordinator run should include visible tools in the adapter prompt');
  assert(happyRunnerLog?.payload?.adapterPayload?.promptHasMemoryContext === true, 'direct coordinator run should include active memory context in the adapter prompt');
  assert(happyRunnerLog?.payload?.adapterPayload?.contextHasExecutionTools === true, 'direct coordinator run should include execution tool context items');
  assert(happyRunnerLog?.payload?.adapterPayload?.contextHasExecutionMemory === true, 'direct coordinator run should include execution memory context items');
  assert(happyRunnerLog?.payload?.adapterPayload?.executionToolCount === 1, 'direct coordinator run should expose one implementer execution tool');
  assert(happyRunnerLog?.payload?.adapterPayload?.activeMemoryEnabled === true, 'direct coordinator run should enable implementer active memory context');
  assert(happyRunnerLog?.payload?.adapterPayload?.promptHasResumeHint === false, 'direct coordinator run should not include resume hints on the first attempt');
  assert(happyRunnerLog?.payload?.adapterPayload?.promptHasLastError === false, 'direct coordinator run should not include a last error on the first attempt');

  const coordinatorStateBeforeRun = await runCli('get-coordinator-state', {
    dbPath,
    workflowId: coordinatorCreated.workflow.workflowId,
    taskId: coordinatorCreated.task.taskId,
    targetType: 'task',
    assignmentLimit: 20,
    handoffLimit: 20
  });
  assertProtocol(coordinatorStateBeforeRun, 'get-coordinator-state', 'ok');
  assert(coordinatorStateBeforeRun.nextTask?.taskId === coordinatorCreated.task.taskId, 'get-coordinator-state should expose the next ready task');
  assert(coordinatorStateBeforeRun.summary?.nextTargetType === 'task', 'coordinator summary should identify the next target type');
  assert(coordinatorStateBeforeRun.nextAction === 'assign_next_work', 'ready work should recommend assignment');

  const blockedRun = await runCli('run-next-assignment', {
    dbPath,
    workflowId: coordinatorCreated.workflow.workflowId,
    targetType: 'task',
    taskId: coordinatorCreated.task.taskId,
    assignmentLimit: 20,
    handoffLimit: 20,
    maxWorkflowSteps: 20
  });
  assertProtocol(blockedRun, 'run-next-assignment', 'blocked');
  assert(blockedRun.assignment?.agentId === coordinatorAgentId, 'blocked run-next-assignment should use the registered agent');
  assert(blockedRun.assignment?.status === 'blocked', 'blocked run-next-assignment should keep blocked assignment history');
  assert(blockedRun.target?.taskId === coordinatorCreated.task.taskId, 'blocked run-next-assignment should expose the blocked target');
  assert(blockedRun.task?.taskId === coordinatorCreated.task.taskId, 'blocked run-next-assignment should expose the blocked task');
  assert(blockedRun.task?.status === 'blocked', 'blocked run-next-assignment should expose the blocked task status');
  assert(blockedRun.step?.status === 'blocked', 'blocked run-next-assignment should expose the blocked workflow step result');
  assert(blockedRun.step?.executionContext?.tools?.length === 1, 'blocked run-next-assignment should expose implementer execution tools on the workflow step');
  assert(blockedRun.step?.activeMemoryContext?.enabled === true, 'blocked run-next-assignment should expose implementer active memory context on the workflow step');
  assert(blockedRun.step?.adapterPayload?.promptHasExecutionContext === true, 'blocked run-next-assignment should inject execution context into the blocked prompt');
  assert(blockedRun.step?.adapterPayload?.promptHasToolsContext === true, 'blocked run-next-assignment should inject visible tools into the blocked prompt');
  assert(blockedRun.step?.adapterPayload?.promptHasMemoryContext === true, 'blocked run-next-assignment should inject active memory context into the blocked prompt');
  assert(blockedRun.step?.adapterPayload?.contextHasExecutionTools === true, 'blocked run-next-assignment should expose execution tools in blocked context items');
  assert(blockedRun.step?.adapterPayload?.contextHasExecutionMemory === true, 'blocked run-next-assignment should expose execution memory in blocked context items');
  assert(blockedRun.workflow?.status === 'blocked', 'blocked run-next-assignment should expose the blocked workflow state');
  assert(blockedRun.nextAction === 'resume_assigned_work', 'blocked run-next-assignment should recommend resuming assigned work');
  assert(blockedRun.allowedNextCommands.includes('resume-assigned-work'), 'blocked run-next-assignment should expose resume-assigned-work as an allowed next command');

  const blockedResume = await runCli('resume-assigned-work', {
    dbPath,
    workflowId: coordinatorCreated.workflow.workflowId,
    taskId: coordinatorCreated.task.taskId,
    targetType: 'task',
    mode: 'resume',
    runNow: true,
    message: '恢复 CLI coordinator 任务',
    payload: { source: 'cli-smoke-test', resumed: true },
    assignmentLimit: 20,
    handoffLimit: 20,
    maxWorkflowSteps: 20
  });
  assertProtocol(blockedResume, 'resume-assigned-work', 'done');
  assert(blockedResume.assignment?.status === 'completed', 'resume-assigned-work should finish the resumed assignment when runNow is true');
  assert(blockedResume.agent?.agentId === coordinatorAgentId, 'resume-assigned-work should keep the original agent in resume mode');
  assert(blockedResume.target?.taskId === coordinatorCreated.task.taskId, 'resume-assigned-work should target the same task');
  assert(blockedResume.step?.executionContext?.tools?.length === 1, 'resume-assigned-work should expose implementer execution tools on the resumed workflow step');
  assert(blockedResume.step?.activeMemoryContext?.enabled === true, 'resume-assigned-work should expose implementer active memory context on the resumed workflow step');
  assert(blockedResume.step?.adapterPayload?.promptHasExecutionContext === true, 'resume-assigned-work should inject execution context into the resumed prompt');
  assert(blockedResume.step?.adapterPayload?.promptHasToolsContext === true, 'resume-assigned-work should inject visible tools into the resumed prompt');
  assert(blockedResume.step?.adapterPayload?.promptHasMemoryContext === true, 'resume-assigned-work should inject active memory context into the resumed prompt');
  assert(blockedResume.step?.adapterPayload?.contextHasExecutionTools === true, 'resume-assigned-work should expose execution tools in resumed context items');
  assert(blockedResume.step?.adapterPayload?.contextHasExecutionMemory === true, 'resume-assigned-work should expose execution memory in resumed context items');
  assert(blockedResume.workflow?.status === 'done', 'resume-assigned-work should finish the workflow in this fixture');
  assert(blockedResume.step?.payload == null, 'resume response should stay on coordinator protocol fields');

  const coordinatorFinalState = await runCli('get-coordinator-state', {
    dbPath,
    workflowId: coordinatorCreated.workflow.workflowId,
    taskId: coordinatorCreated.task.taskId,
    targetType: 'task',
    includeTestData: true,
    includeHistory: true,
    assignmentLimit: 50,
    handoffLimit: 20
  });
  assertProtocol(coordinatorFinalState, 'get-coordinator-state', 'ok');
  assert(coordinatorFinalState.workflowState?.workflow?.status === 'done', 'coordinator state should expose the completed workflow state');
  assert(coordinatorFinalState.summary?.assignmentCountsByStatus?.blocked >= 1, 'coordinator summary should retain blocked assignment history');
  assert(coordinatorFinalState.summary?.assignmentCountsByStatus?.completed >= 1, 'coordinator summary should count completed assignments');
  assert(coordinatorFinalState.assignments.some((assignment) => assignment.assignmentId === blockedRun.assignment.assignmentId && assignment.status === 'blocked'), 'coordinator state should retain the blocked assignment row');
  const resumedAssignment = coordinatorFinalState.assignments.find((assignment) => assignment.payload?.resumedFromAssignmentId === blockedRun.assignment.assignmentId);
  assert(resumedAssignment?.status === 'completed', 'coordinator state should include the resumed assignment row');
  const finalTaskState = coordinatorFinalState.workflowState?.tasks?.find((task) => task.taskId === coordinatorCreated.task.taskId);
  assert(finalTaskState?.doneSummary === `CLI coordinator 完成：${finalTaskState.title}`, 'resumed coordinator run should complete the original task through the adapter');
  const runnerLog = coordinatorFinalState.workflowState?.runLogs?.find((log) => log.action === 'task_completed_by_runner');
  assert(runnerLog?.payload?.adapterPayload?.promptHasResumeHint === true, 'resumed coordinator run should pass resume hints into the adapter prompt');
  assert(runnerLog?.payload?.adapterPayload?.promptHasLastError === true, 'resumed coordinator run should preserve the last error in the prompt');
  assert(runnerLog?.payload?.adapterPayload?.promptHasExecutionContext === true, 'resumed coordinator run should include execution context in the adapter prompt');
  assert(runnerLog?.payload?.adapterPayload?.promptHasToolsContext === true, 'resumed coordinator run should include visible tools in the adapter prompt');
  assert(runnerLog?.payload?.adapterPayload?.promptHasMemoryContext === true, 'resumed coordinator run should include active memory context in the adapter prompt');
  assert(runnerLog?.payload?.adapterPayload?.contextHasExecutionTools === true, 'resumed coordinator run should include execution tool context items');
  assert(runnerLog?.payload?.adapterPayload?.contextHasExecutionMemory === true, 'resumed coordinator run should include execution memory context items');
  assert(runnerLog?.payload?.adapterPayload?.executionToolCount === 1, 'resumed coordinator run should expose one implementer execution tool');
  assert(runnerLog?.payload?.adapterPayload?.activeMemoryEnabled === true, 'resumed coordinator run should enable implementer active memory context');

  const coordinatorCooldownCreated = await runCli('create-workflow', {
    dbPath,
    workflowId: 'cli-coordinator-transient-cooldown-workflow',
    instruction: 'coordinator CLI 瞬时上游恢复冷却',
    plan: {
      goal: '验证 coordinator CLI transient cooldown 保护层',
      steps: [
        {
          key: 'implement-transient-cooldown',
          title: '处理 transient upstream cooldown',
          description: '持续上游 502 直到 runner 用尽即时重试，然后验证 coordinator 的 cooldown 语义。',
          type: 'implement',
          requiredCapabilities: ['coordinator-implement']
        }
      ],
      dependencies: []
    }
  });
  assertProtocol(coordinatorCooldownCreated, 'create-workflow', 'ok');

  const cooldownStateBeforeRun = await runCli('get-coordinator-state', {
    dbPath,
    workflowId: coordinatorCooldownCreated.workflow.workflowId,
    taskId: coordinatorCooldownCreated.task.taskId,
    targetType: 'task',
    assignmentLimit: 20,
    handoffLimit: 20
  });
  assertProtocol(cooldownStateBeforeRun, 'get-coordinator-state', 'ok');
  assert(cooldownStateBeforeRun.nextTask?.taskId === coordinatorCooldownCreated.task.taskId, 'cooldown fixture should expose the next ready task before execution');
  assert(cooldownStateBeforeRun.nextAction === 'assign_next_work', 'cooldown fixture should initially recommend assignment');

  const cooldownBlockedRun = await runCli('run-next-assignment', {
    dbPath,
    workflowId: coordinatorCooldownCreated.workflow.workflowId,
    targetType: 'task',
    taskId: coordinatorCooldownCreated.task.taskId,
    assignmentLimit: 20,
    handoffLimit: 20,
    maxWorkflowSteps: 20,
    maxTaskRetries: 0
  });
  assertProtocol(cooldownBlockedRun, 'run-next-assignment', 'blocked');
  assert(cooldownBlockedRun.assignment?.agentId === coordinatorAgentId, 'transient cooldown blocked run should use the registered coordinator agent');
  assert(cooldownBlockedRun.assignment?.status === 'blocked', 'transient cooldown blocked run should retain blocked assignment history');
  assert(cooldownBlockedRun.target?.taskId === coordinatorCooldownCreated.task.taskId, 'transient cooldown blocked run should expose the blocked target');
  assert(cooldownBlockedRun.task?.taskId === coordinatorCooldownCreated.task.taskId, 'transient cooldown blocked run should expose the blocked task');
  assert(cooldownBlockedRun.task?.status === 'blocked', 'transient cooldown blocked run should expose blocked task status');
  assert(cooldownBlockedRun.step?.status === 'blocked', 'transient cooldown blocked run should expose blocked workflow step result');
  assert(cooldownBlockedRun.step?.adapterPayload?.promptHasExecutionContext === true, 'transient cooldown blocked run should inject execution context into the blocked prompt');
  assert(cooldownBlockedRun.step?.adapterPayload?.contextHasExecutionTools === true, 'transient cooldown blocked run should expose execution tools in blocked context items');
  assert(cooldownBlockedRun.workflow?.status === 'blocked', 'transient cooldown blocked run should expose blocked workflow state');
  assert(cooldownBlockedRun.nextAction === 'wait_for_recovery', 'transient cooldown blocked run should recommend waiting for recovery');
  assert(cooldownBlockedRun.allowedNextCommands.includes('resume-assigned-work'), 'transient cooldown blocked run should still allow resume-assigned-work');

  const cooldownCoordinatorState = await runCli('get-coordinator-state', {
    dbPath,
    workflowId: coordinatorCooldownCreated.workflow.workflowId,
    taskId: coordinatorCooldownCreated.task.taskId,
    targetType: 'task',
    includeTestData: true,
    includeHistory: true,
    assignmentLimit: 20,
    handoffLimit: 20
  });
  assertProtocol(cooldownCoordinatorState, 'get-coordinator-state', 'ok');
  assert(cooldownCoordinatorState.blockedTarget?.taskId === coordinatorCooldownCreated.task.taskId, 'cooldown coordinator state should expose blocked target');
  assert(cooldownCoordinatorState.recoveryTarget?.taskId === coordinatorCooldownCreated.task.taskId, 'cooldown coordinator state should expose recovery target');
  assert(cooldownCoordinatorState.nextAction === 'wait_for_recovery', 'cooldown coordinator state should recommend wait_for_recovery');
  assert(cooldownCoordinatorState.summary?.recoveryPhase === 'cooldown', 'cooldown coordinator summary should expose recovery phase');
  assert(typeof cooldownCoordinatorState.summary?.recoveryWaitMs === 'number' && cooldownCoordinatorState.summary.recoveryWaitMs > 0, 'cooldown coordinator summary should expose positive recoveryWaitMs');
  assert(typeof cooldownCoordinatorState.summary?.recoveryNextEligibleRetryAt === 'string' && cooldownCoordinatorState.summary.recoveryNextEligibleRetryAt.length > 0, 'cooldown coordinator summary should expose recoveryNextEligibleRetryAt');
  assert(cooldownCoordinatorState.summary?.assignmentCountsByStatus?.blocked >= 1, 'cooldown coordinator state should retain blocked assignment history');
  const cooldownStateTask = cooldownCoordinatorState.workflowState?.tasks?.find((task) => task.taskId === coordinatorCooldownCreated.task.taskId);
  assert(cooldownStateTask?.reasonCode === 'runner_execution_failed', 'cooldown coordinator state should expose exhausted retry reason');
  assert(cooldownStateTask?.lastError?.includes('Claude upstream 502/upstream_error'), 'cooldown coordinator state should preserve sanitized upstream summary');
  assert(!cooldownStateTask?.lastError?.includes('API Error: 502'), 'cooldown coordinator state should not persist raw upstream API text');
  assert(cooldownStateTask?.recovery?.recoveryClass === 'transient_upstream', 'cooldown coordinator state should persist transient recovery metadata');
  assert(cooldownStateTask?.recovery?.recoverySource === 'claude_runtime', 'cooldown coordinator state should persist recovery source');
  assert(Number.isInteger(cooldownStateTask?.recovery?.cooldownMs) && cooldownStateTask.recovery.cooldownMs > 0, 'cooldown coordinator state should persist cooldownMs');
  assert(cooldownStateTask?.recovery?.retryBudget?.remainingRetries === 0, 'cooldown coordinator state should persist exhausted retry budget');

  const cooldownResume = await runCli('resume-assigned-work', {
    dbPath,
    workflowId: coordinatorCooldownCreated.workflow.workflowId,
    taskId: coordinatorCooldownCreated.task.taskId,
    targetType: 'task',
    mode: 'resume',
    runNow: true,
    message: '恢复 transient cooldown 任务',
    payload: { source: 'cli-smoke-test', resumed: true, mode: 'cooldown' },
    assignmentLimit: 20,
    handoffLimit: 20,
    maxWorkflowSteps: 20,
    maxTaskRetries: 0
  });
  assertProtocol(cooldownResume, 'resume-assigned-work', 'cooldown');
  assert(cooldownResume.reason === 'transient_recovery_cooldown', 'resume-assigned-work should expose transient cooldown reason during recovery window');
  assert(cooldownResume.nextAction === 'wait_for_recovery', 'resume-assigned-work cooldown response should recommend waiting');
  assert(cooldownResume.assignment?.assignmentId === cooldownBlockedRun.assignment.assignmentId, 'resume-assigned-work cooldown response should preserve the blocked assignment');
  assert(cooldownResume.assignment?.status === 'blocked', 'resume-assigned-work cooldown response should keep blocked assignment status');
  assert(cooldownResume.target?.taskId === coordinatorCooldownCreated.task.taskId, 'resume-assigned-work cooldown response should target the same task');
  assert(cooldownResume.recovery?.recoveryClass === 'transient_upstream', 'resume-assigned-work cooldown response should expose transient recovery class');
  assert(cooldownResume.recoveryStatus?.phase === 'cooldown', 'resume-assigned-work cooldown response should expose cooldown phase');
  assert(typeof cooldownResume.waitMs === 'number' && cooldownResume.waitMs > 0, 'resume-assigned-work cooldown response should expose waitMs');
  assert(typeof cooldownResume.nextEligibleRetryAt === 'string' && cooldownResume.nextEligibleRetryAt.length > 0, 'resume-assigned-work cooldown response should expose nextEligibleRetryAt');
  assert(cooldownResume.recovery?.nextEligibleRetryAt === cooldownResume.nextEligibleRetryAt, 'resume-assigned-work cooldown response should align recovery nextEligibleRetryAt');
  assert(cooldownResume.recoveryStatus?.nextEligibleRetryAt === cooldownResume.nextEligibleRetryAt, 'resume-assigned-work cooldown response should align recoveryStatus nextEligibleRetryAt');
  assert(cooldownResume.allowedNextCommands.includes('resume-assigned-work'), 'resume-assigned-work cooldown response should keep resume-assigned-work available');


  const latestAssignmentCreated = await runCli('create-workflow', {
    dbPath,
    instruction: 'CLI latest assignment sync should update the true newest assignment'
  });
  assertProtocol(latestAssignmentCreated, 'create-workflow', 'ok');
  await initializeAgentStore({ dbPath });
  const latestAssignmentStore = getAgentStore({ dbPath });
  const oldestAssignmentAgentId = 'cli-oldest-assignment-agent';
  const newestAssignmentAgentId = 'cli-newest-assignment-agent';
  latestAssignmentStore.registerAgent({
    agentId: oldestAssignmentAgentId,
    name: 'CLI Oldest Assignment Agent',
    role: 'implementer',
    capabilities: ['implement'],
    status: 'active'
  });
  latestAssignmentStore.registerAgent({
    agentId: newestAssignmentAgentId,
    name: 'CLI Newest Assignment Agent',
    role: 'implementer',
    capabilities: ['implement'],
    status: 'active'
  });

  const oldAssignments = [];
  for (let index = 0; index < 101; index += 1) {
    oldAssignments.push(latestAssignmentStore.createAssignment({
      assignmentId: `cli-old-assignment-${String(index).padStart(3, '0')}`,
      targetType: 'task',
      targetId: latestAssignmentCreated.task.taskId,
      workflowId: latestAssignmentCreated.workflow.workflowId,
      agentId: oldestAssignmentAgentId,
      status: 'assigned',
      reason: `old assignment ${index}`,
      payload: { index, generation: 'old' }
    }));
  }
  const newestAssignment = latestAssignmentStore.createAssignment({
    assignmentId: 'zz-cli-newest-assignment',
    targetType: 'task',
    targetId: latestAssignmentCreated.task.taskId,
    workflowId: latestAssignmentCreated.workflow.workflowId,
    agentId: newestAssignmentAgentId,
    status: 'assigned',
    reason: 'newest assignment should sync',
    payload: { generation: 'newest' }
  });

  const latestAssignmentClaim = await runCli('claim-next-ready-task', {
    dbPath,
    workflowId: latestAssignmentCreated.workflow.workflowId,
    leaseOwner: 'cli-latest-assignment-runner',
    leaseMs: 60_000
  });
  assertProtocol(latestAssignmentClaim, 'claim-next-ready-task', 'claimed');

  const latestAssignmentCompletion = await runCli('complete-task', {
    dbPath,
    workflowId: latestAssignmentCreated.workflow.workflowId,
    taskId: latestAssignmentCreated.task.taskId,
    leaseOwner: 'cli-latest-assignment-runner',
    doneSummary: 'CLI completed task with more than 100 older assignments'
  });
  assertProtocol(latestAssignmentCompletion, 'complete-task', 'updated');

  const refreshedNewestAssignment = latestAssignmentStore.getAssignment(newestAssignment.assignmentId);
  const refreshedLastOldAssignment = latestAssignmentStore.getAssignment(oldAssignments[oldAssignments.length - 1].assignmentId);
  assert(refreshedNewestAssignment.status === 'completed', 'CLI task completion should update the true newest assignment beyond the first 100 rows');
  assert(refreshedNewestAssignment.payload?.updatedVia === 'cli', 'CLI task completion should mark the newest assignment payload as CLI-updated');
  assert(refreshedNewestAssignment.payload?.doneSummary === 'CLI completed task with more than 100 older assignments', 'CLI task completion should copy doneSummary to the newest assignment payload');
  assert(refreshedLastOldAssignment.status === 'assigned', 'CLI task completion should not update older assignment rows when a newer assignment exists beyond the list limit');

  const leaseCreated = await runCli('create-workflow', {
    dbPath,
    instruction: '调研 CLI lease 回收流程'
  });
  assertProtocol(leaseCreated, 'create-workflow', 'ok');

  const leaseClaim = await runCli('claim-next-ready-task', {
    dbPath,
    leaseOwner: 'lease-runner',
    leaseMs: 5
  });
  assertProtocol(leaseClaim, 'claim-next-ready-task', 'claimed');

  const release = await runCli('release-expired-leases', {
    dbPath,
    now: new Date(Date.now() + 10_000).toISOString(),
    reason: 'Lease expired in CLI smoke test.'
  });
  assertProtocol(release, 'release-expired-leases', 'released');
  assert(release.releasedTaskCount >= 1, 'release-expired-leases should release an expired task');
  assert(release.allowedNextCommands.includes('claim-next-ready-task'), 'lease release should recommend re-claiming or inspection');

  const leaseState = await runCli('get-workflow-state', {
    dbPath,
    workflowId: leaseCreated.workflow.workflowId
  });
  assertProtocol(leaseState, 'get-workflow-state', 'ok');
  const releasedTask = leaseState.tasks.find((task) => task.taskId === leaseClaim.task.taskId);
  const leaseReleaseLog = [...leaseState.runLogs].reverse().find((log) => log.taskId === leaseClaim.task.taskId && log.action === 'task_lease_released') || null;
  assert(releasedTask?.status === 'ready', 'released lease task should return to ready');
  assert(releasedTask?.assignmentStatus !== 'assigned' && releasedTask?.assignmentStatus !== 'accepted', 'released lease task should not keep active assignment state');
  assert(releasedTask?.ownerAgentId == null, 'released lease task should clear stale owner agent');
  assert(releasedTask?.attemptCount === 1, 'released lease task should preserve the interrupted claim attempt count');
  assert(releasedTask?.lastError === 'Lease expired in CLI smoke test.', 'released lease should persist release reason');
  assert(leaseReleaseLog?.payload?.previousAttemptCount === 1, 'lease release log should record the pre-release attempt count');
  assert(leaseReleaseLog?.payload?.attemptCount === 1, 'lease release log should record the preserved attempt count');

  const heartbeat = await runCli('heartbeat-task-lease', {
    dbPath,
    workflowId: leaseClaim.task.workflowId,
    taskId: leaseClaim.task.taskId,
    leaseOwner: 'lease-runner',
    leaseMs: 60_000
  }, { allowFailure: true });
  assert(heartbeat.code !== 0, 'heartbeat after lease release should fail');

  console.log('workflow-cli smoke test passed');
  console.log(JSON.stringify({
    workflowId: state.workflow.workflowId,
    taskCount: state.tasks.length,
    finalStatus: state.workflow.status,
    happyChainId: happyChainRun.chain.chainId,
    blockedChainId: blockedChainRun.chain.chainId,
    rerunChainId: rerunChainAfterRestart.chain.chainId,
    coordinatorWorkflowId: coordinatorCreated.workflow.workflowId,
    coordinatorAssignmentCount: coordinatorFinalState.assignments.length,
    releasedTaskCount: release.releasedTaskCount,
    leaseWorkflowId: leaseState.workflow.workflowId
  }, null, 2));
}

async function runCli(command, input = {}, options = {}) {
  if (input.plan && typeof input.plan === 'object' && !Array.isArray(input.plan)) {
    input = {
      ...input,
      plan: markTestPlan(input.plan, 'cli-smoke-test')
    };
  }

  if (input.workflowHygieneMetadata == null && command !== 'draft-plan' && command !== 'draft-coding-plan' && command !== 'select-validation') {
    input = {
      ...input,
      workflowHygieneMetadata: {
        dataClass: 'test',
        retention: 'ephemeral',
        generatedBy: 'cli-smoke-test'
      }
    };
  }

  const structuredInputMode = options.structuredInputMode || 'inline';
  const args = [cliPath, command];
  let stdinText = null;

  if (structuredInputMode === 'inline') {
    args.push('--input', JSON.stringify(input));
  } else if (structuredInputMode === 'stdin') {
    args.push('--input-stdin');
    stdinText = JSON.stringify(input);
  } else if (structuredInputMode === 'stdin-file') {
    args.push('--input-file', '-');
    stdinText = JSON.stringify(input);
  } else {
    throw new Error(`Unsupported structuredInputMode: ${structuredInputMode}`);
  }

  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: rootDir,
      stdio: ['pipe', 'pipe', 'pipe']
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

    child.stdin.end(stdinText == null ? '' : stdinText);
  });

  if (!options.allowFailure && result.code !== 0) {
    throw new Error(`CLI command failed: ${command}\n${result.stderr || result.stdout}`);
  }

  if (options.allowFailure) {
    if (result.stdout.trim()) {
      return {
        ...result,
        json: JSON.parse(result.stdout)
      };
    }
    return result;
  }

  return JSON.parse(result.stdout);
}

async function assertDirectProfileStoreIsolation(profileName, profileDbPath, explicitDbPath) {
  const workflowId = 'direct-profile-workflow';
  const chainId = 'direct-profile-chain';
  const stageId = 'direct-profile-stage';
  const agentId = 'direct-profile-agent';

  await initializeWorkflowStore({ dbProfile: profileName });
  await initializeChainStore({ dbProfile: profileName });
  await initializeAgentStore({ dbProfile: profileName });

  const profileWorkflowStore = getWorkflowStore({ dbProfile: profileName });
  const profileChainStore = getChainStore({ dbProfile: profileName });
  const profileAgentStore = getAgentStore({ dbProfile: profileName });

  profileWorkflowStore.createWorkflow({
    workflowId,
    goal: 'Direct profile workflow isolation',
    instruction: 'Store workflow data using dbProfile directly.',
    status: 'ready'
  });
  profileChainStore.createChain({
    chainId,
    instruction: 'Store chain data using dbProfile directly.',
    stages: [
      {
        stageId,
        title: 'Direct profile stage',
        instruction: 'Verify direct profile chain storage.'
      }
    ]
  });
  profileAgentStore.registerAgent({
    agentId,
    name: 'Direct Profile Agent',
    role: 'isolation-smoke'
  });
  profileAgentStore.createAssignment({
    targetType: 'task',
    targetId: 'direct-profile-target',
    workflowId,
    agentId,
    status: 'assigned'
  });

  assert(profileWorkflowStore.getWorkflow(workflowId)?.workflowId === workflowId, 'direct workflow store should honor dbProfile');
  assert(profileChainStore.getChain(chainId)?.chainId === chainId, 'direct chain store should honor dbProfile');
  assert(profileAgentStore.getAgent(agentId)?.agentId === agentId, 'direct agent store should honor dbProfile');

  await initializeWorkflowStore({ dbPath: explicitDbPath });
  await initializeChainStore({ dbPath: explicitDbPath });
  await initializeAgentStore({ dbPath: explicitDbPath });

  assert(getWorkflowStore({ dbPath: explicitDbPath }).getWorkflow(workflowId) == null, 'direct profile workflow should not leak into explicit DB');
  assert(getChainStore({ dbPath: explicitDbPath }).getChain(chainId) == null, 'direct profile chain should not leak into explicit DB');
  assert(getAgentStore({ dbPath: explicitDbPath }).getAgent(agentId) == null, 'direct profile agent should not leak into explicit DB');
  assert(profileDbPath !== explicitDbPath, 'direct profile smoke should compare distinct DB paths');
}

function assertProtocol(response, command, status) {
  assert(response && typeof response === 'object', `${command} should return a JSON object`);
  assert(response.protocolVersion === PROTOCOL_VERSION, `${command} should expose protocolVersion`);
  assert(response.command === command, `${command} should echo the command name`);
  assert(response.status === status, `${command} should report status ${status}`);
  assert(Array.isArray(response.allowedNextCommands), `${command} should expose allowedNextCommands`);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  closeDb();
});
