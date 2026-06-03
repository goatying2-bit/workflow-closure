import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import {
  buildTaskPrompt,
  createValidationCommandsVerifier,
  createWorkflowEngine,
  createWorkflowRunner,
  draftCodingPlan,
  selectValidationCommands
} from '../index.js';
import { closeDb } from '../storage/db.js';
import { markTestPlan, prepareTestDb } from './helpers/test-db.js';

const PROTOCOL_VERSION = 'workflow-closure-cli/v1';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.dirname(__dirname);
const cliPath = path.join(rootDir, 'cli.js');
const dbPath = await prepareTestDb('coding-workflow-smoke-test');
const artifactRelativePath = 'scripts/.tmp/coding-workflow/default.txt';
const artifactPath = path.join(rootDir, 'scripts', '.tmp', 'coding-workflow', 'default.txt');

async function main() {
  await fs.rm(dbPath, { force: true });
  await fs.rm(artifactPath, { force: true });

  const packageScripts = {
    'smoke-test': 'node ./scripts/smoke-test.js',
    'runner-smoke-test': 'node ./scripts/runner-smoke-test.js',
    'verifier-smoke-test': 'node ./scripts/verifier-smoke-test.js',
    'cli-smoke-test': 'node ./scripts/cli-smoke-test.js',
    'agent-contract-smoke-test': 'node ./scripts/agent-contract-smoke-test.js',
    'full-smoke-test': 'npm run smoke-test'
  };

  const selection = selectValidationCommands({
    changedFiles: ['runner/verifier.js', 'cli.js', 'unknown/module.js'],
    packageScripts,
    profile: 'standard',
    cwd: rootDir
  });
  const scripts = selection.commands.map((command) => command.script);
  assert(selection.profile === 'standard', 'validation selector should preserve the requested profile');
  assert(scripts.includes('verifier-smoke-test'), 'verifier changes should select verifier smoke test');
  assert(scripts.includes('runner-smoke-test'), 'verifier changes should select runner smoke test');
  assert(scripts.includes('cli-smoke-test'), 'CLI changes should select CLI smoke test');
  assert(scripts.includes('agent-contract-smoke-test'), 'CLI changes should select agent contract smoke test');
  assert(scripts.includes('smoke-test'), 'unknown JavaScript files should select smoke test fallback');
  assert(selection.commands.every((command) => command.command === 'npm'), 'selector should default to npm commands');
  assert(selection.commands.every((command) => command.cwd === rootDir), 'selector should preserve cwd on commands');

  const missingScriptSelection = selectValidationCommands({
    changedFiles: ['runner/verifier.js'],
    packageScripts: { 'runner-smoke-test': 'node ./scripts/runner-smoke-test.js' }
  });
  assert(missingScriptSelection.commands.length === 1, 'selector should only keep available package scripts when scripts are supplied');
  assert(missingScriptSelection.commands[0].script === 'runner-smoke-test', 'selector should keep the available runner smoke test');
  assert(missingScriptSelection.warnings.some((warning) => warning.includes('verifier-smoke-test')), 'selector should warn for unavailable scripts');

  const comprehensiveSelection = selectValidationCommands({
    changedFiles: ['storage/workflows.js'],
    packageScripts,
    profile: 'comprehensive'
  });
  assert(comprehensiveSelection.commands.some((command) => command.script === 'full-smoke-test'), 'comprehensive profile should add full smoke test when available');

  const plan = markTestPlan(draftCodingPlan({
    instruction: '修复 verifier validation command 选择逻辑',
    changedFiles: ['runner/verifier.js'],
    packageScripts,
    cwd: rootDir,
    validationProfile: 'standard'
  }), 'coding-workflow-smoke-test');
  assert(plan.category === 'coding', 'coding planner should mark the plan category');
  assert(plan.metadata?.planner === 'coding-planner', 'coding planner should expose planner metadata');
  assert(plan.metadata?.plannerMode === 'fix', 'coding planner should infer fix mode from the instruction');
  assertDefaultWorkflowClosurePolicy(plan.metadata, 'coding planner metadata');
  assert(plan.steps.length === 4, 'coding planner should create the default four-step workflow');
  assert(plan.dependencies.length === 3, 'coding planner should link the default steps');
  assert(plan.steps[0].contract?.forbiddenActions?.includes('modify-files'), 'inspect step should forbid edits');
  const validationStep = plan.steps.find((step) => step.key === 'select-validation');
  const runValidationStep = plan.steps.find((step) => step.key === 'run-validation');
  assert(validationStep?.contract?.validationCommands?.length >= 1, 'validation selection step should carry selected validation commands');
  assert(runValidationStep?.contract?.validationCommands?.length >= 1, 'validation run step should carry selected validation commands');
  assert(runValidationStep.contract.validationCommands.some((command) => command.script === 'verifier-smoke-test'), 'validation run step should include verifier smoke test');

  const engine = await createWorkflowEngine({ dbPath });
  const state = await engine.createWorkflowFromInstruction({
    dbPath,
    workflowId: 'coding-workflow-smoke',
    instruction: '修复 verifier validation command 选择逻辑',
    plan
  });
  assert(state.workflow.workflowId === 'coding-workflow-smoke', 'createWorkflowFromInstruction should store the explicit workflow id');
  assert(state.workflow.status === 'ready', 'created coding workflow should become ready');
  assertDefaultWorkflowClosurePolicy(state.workflow.initialPlan?.metadata, 'persisted coding workflow metadata');
  assert(state.tasks.length === 4, 'coding workflow should persist all planner steps');
  const storedRunValidationTask = state.tasks.find((task) => task.planTaskKey === 'run-validation');
  assert(storedRunValidationTask, 'coding workflow should persist the run-validation task');
  assert(storedRunValidationTask.contract?.validationCommands?.some((command) => command.script === 'verifier-smoke-test'), 'task contracts should preserve validationCommands through storage');
  assert(state.dependencies.length === 3, 'coding workflow should persist planner dependencies');
  assert(state.nextTask?.planTaskKey === 'inspect-scope', 'coding workflow should expose the first ready task');

  const unverifiedOutput = engine.addTaskOutput({
    workflowId: 'coding-workflow-smoke',
    taskId: storedRunValidationTask.taskId,
    kind: 'artifact',
    name: 'unverified-artifact',
    content: 'default trust metadata',
    path: artifactRelativePath,
    workspacePath: rootDir
  });
  assert(unverifiedOutput.metadata?.trustState === 'unverified', 'task outputs should default trustState to unverified');
  assert(unverifiedOutput.metadata?.producedByTaskId === storedRunValidationTask.taskId, 'task outputs should record producer task id');
  assert(unverifiedOutput.metadata?.relativePath === artifactRelativePath, 'relative output paths should be preserved in metadata');
  assert(unverifiedOutput.metadata?.artifactRef === `file:${artifactRelativePath}`, 'artifact outputs should expose artifactRef metadata after materialization');
  assert(unverifiedOutput.metadata?.storageStatus === 'written', 'artifact outputs should expose written storage status after materialization');
  assert(unverifiedOutput.metadata?.workspacePath?.replaceAll('\\', '/').toLowerCase() === rootDir.replaceAll('\\', '/').toLowerCase(), 'artifact outputs should preserve normalized workspacePath metadata');
  const writtenArtifactContent = await fs.readFile(artifactPath, 'utf8');
  assert(writtenArtifactContent === 'default trust metadata', 'artifact outputs should materialize their content into the workspace');

  let escapedOutputError = null;
  try {
    engine.addTaskOutput({
      workflowId: 'coding-workflow-smoke',
      taskId: storedRunValidationTask.taskId,
      kind: 'artifact',
      name: 'escaped-artifact',
      content: 'escaped path',
      path: path.dirname(rootDir),
      workspacePath: rootDir
    });
  } catch (error) {
    escapedOutputError = error;
  }
  assert(escapedOutputError instanceof Error, 'workspace-escaping paths should throw instead of persisting tainted outputs');
  assert(escapedOutputError.message.includes('Task output path must stay within workspace'), 'workspace-escaping paths should expose a clear workspace-boundary error');

  const prompt = buildTaskPrompt(state, storedRunValidationTask, {
    workflowClosurePolicy: {
      closureMode: 'large_loop',
      verificationLevel: 'broad',
      docPolicy: 'required',
      cleanupPolicy: 'explicit_only'
    }
  });
  assert(prompt.includes('Workflow closure policy：'), 'task prompt should render workflow closure policy section');
  assert(prompt.includes('- closureMode: small_loop'), 'task prompt should prefer persisted workflow closureMode over runtime overrides');
  assert(prompt.includes('- verificationLevel: targeted'), 'task prompt should prefer persisted workflow verification level over runtime overrides');
  assert(prompt.includes('- docPolicy: minimal'), 'task prompt should prefer persisted workflow doc policy over runtime overrides');
  assert(prompt.includes('- cleanupPolicy: defer'), 'task prompt should prefer persisted workflow cleanup policy over runtime overrides');
  assert(prompt.includes('优先走最小闭环；除非当前任务明确要求，否则不要主动跨边界扩 scope。'), 'task prompt should explain the small-loop closure rule');
  assert(prompt.includes('验证优先只覆盖与当前变更直接相关的命令，不主动扩成全量回归。'), 'task prompt should explain the targeted verification rule');

  const finalDeliverablePrompt = buildTaskPrompt(state, {
    ...storedRunValidationTask,
    title: '输出最终文档',
    description: '汇总上游结果并交付最终文档',
    contract: {
      requiredArtifacts: ['artifact://final-doc']
    }
  }, {
    predecessorOutputs: [{
      predecessorTaskId: 'upstream-task',
      predecessorTitle: '上游整理',
      output: {
        kind: 'artifact',
        name: 'draft-section',
        content: '已经整理好的正文片段',
        path: 'artifacts/draft-section.md',
        metadata: {
          trustState: 'validated'
        }
      }
    }],
    handoffContext: {
      predecessors: [{
        title: '上游整理',
        doneSummary: '整理完成',
        handoff: {
          summary: '已有正文可复用',
          artifacts: ['artifact://draft-section']
        }
      }]
    }
  });
  assert(finalDeliverablePrompt.includes('最终交付提示：'), 'final deliverable prompt should render reuse guidance when upstream artifacts exist');
  assert(finalDeliverablePrompt.includes('优先复用 validated 上游输出与交接信息'), 'final deliverable prompt should prefer upstream reuse');
  assert(finalDeliverablePrompt.includes('不要从头重写整份最终文档'), 'final deliverable prompt should avoid rewriting the full document');

  const passVerifier = createValidationCommandsVerifier({
    commands: [
      {
        id: 'node-pass',
        command: process.execPath,
        args: ['-e', 'process.stdout.write("ok")'],
        required: true,
        timeoutMs: 30_000,
        reason: 'deterministic passing command'
      }
    ]
  });
  const passResult = await passVerifier.run({ task: storedRunValidationTask, result: { status: 'done' }, workflow: state.workflow });
  assert(passResult.status === 'passed', 'validation command verifier should pass when required commands exit zero');
  assertDefaultWorkflowClosurePolicy(passResult.payload?.workflowClosurePolicy, 'passing validation verifier payload');
  assert(passResult.payload?.verificationLevel === 'targeted', 'validation verifier should expose the targeted verification level from workflow policy');
  assert(passResult.payload?.results?.[0]?.stdout === 'ok', 'validation verifier should capture stdout excerpts');

  const manualValidationOutput = engine.addTaskOutput({
    workflowId: 'coding-workflow-smoke',
    taskId: storedRunValidationTask.taskId,
    kind: 'validation-result',
    name: 'validation-commands',
    content: 'manual validation pass',
    metadata: {
      status: passResult.status,
      validationResults: passResult.payload.results
    }
  });
  assert(manualValidationOutput.metadata?.trustState === 'validated', 'passing validation-result outputs should derive validated trustState');

  const failVerifier = createValidationCommandsVerifier({
    commands: [
      {
        id: 'node-fail',
        command: process.execPath,
        args: ['-e', 'process.exit(7)'],
        required: true,
        timeoutMs: 30_000,
        reason: 'deterministic failing command'
      }
    ]
  });
  const failResult = await failVerifier.run({ task: storedRunValidationTask, result: { status: 'done' }, workflow: state.workflow });
  assert(failResult.status === 'failed', 'validation command verifier should fail on required non-zero commands');
  assertDefaultWorkflowClosurePolicy(failResult.payload?.workflowClosurePolicy, 'failing validation verifier payload');
  assert(failResult.payload?.verificationLevel === 'targeted', 'failing validation verifier should expose the targeted verification level from workflow policy');
  assert(failResult.reasonCode === 'validation_command_failed', 'validation verifier should expose a stable failure reason code');
  assert(failResult.payload?.failedCommand?.exitCode === 7, 'validation verifier should expose the failed command exit code');

  const failedValidationOutput = engine.addTaskOutput({
    workflowId: 'coding-workflow-smoke',
    taskId: storedRunValidationTask.taskId,
    kind: 'validation-result',
    name: 'validation-commands',
    content: 'manual validation failure',
    metadata: {
      status: failResult.status,
      reasonCode: failResult.reasonCode,
      validationResults: failResult.payload.results
    }
  });
  assert(failedValidationOutput.metadata?.trustState === 'failed', 'failing validation-result outputs should derive failed trustState');

  const optionalFailVerifier = createValidationCommandsVerifier({
    commands: [
      {
        id: 'node-optional-fail',
        command: process.execPath,
        args: ['-e', 'process.exit(9)'],
        required: false,
        timeoutMs: 30_000,
        reason: 'deterministic optional failing command'
      }
    ]
  });
  const optionalFailResult = await optionalFailVerifier.run({ task: storedRunValidationTask, result: { status: 'done' } });
  assert(optionalFailResult.status === 'passed', 'validation command verifier should not fail optional non-zero commands');
  assert(optionalFailResult.payload?.results?.[0]?.exitCode === 9, 'optional failure evidence should remain in verifier payload');

  const passRunnerState = await engine.createWorkflowFromInstruction({
    workflowId: 'validation-pass-runner-smoke',
    instruction: '验证 runner 会持久化通过的验证结果',
    plan: markTestPlan({
      goal: '验证 runner 会持久化通过的验证结果',
      steps: [
        { key: 'validate', title: 'Run validation', description: 'Run passing validation.' }
      ],
      dependencies: []
    }, 'coding-workflow-smoke-test')
  });
  const passRunnerTask = passRunnerState.tasks[0];
  const passRunner = await createWorkflowRunner({
    dbPath,
    engine,
    workflowId: 'validation-pass-runner-smoke',
    taskId: passRunnerTask.taskId,
    runnerId: 'validation-pass-runner',
    verifier: passVerifier,
    adapter: async () => ({ status: 'done', doneSummary: 'validation passed' })
  });
  const passRunnerResult = await passRunner.runOnce();
  assert(passRunnerResult.status === 'done', 'runner should complete when validation verifier passes');
  const passRunnerOutputs = engine.listTaskOutputs({
    workflowId: 'validation-pass-runner-smoke',
    taskId: passRunnerTask.taskId,
    kind: 'validation-result'
  });
  const passRunnerValidationOutput = passRunnerOutputs.find((output) => output.name === 'validation-commands');
  assert(passRunnerValidationOutput?.metadata?.trustState === 'validated', 'runner should persist passing validation evidence as validated output');
  assertDefaultWorkflowClosurePolicy(passRunnerValidationOutput?.metadata?.workflowClosurePolicy, 'runner passing validation output metadata');
  const passRunnerResultOutputs = engine.listTaskOutputs({
    workflowId: 'validation-pass-runner-smoke',
    taskId: passRunnerTask.taskId,
    kind: 'result'
  });
  const passRunnerResultOutput = passRunnerResultOutputs.find((output) => output.name === 'runner-result');
  assertDefaultWorkflowClosurePolicy(passRunnerResultOutput?.metadata?.workflowClosurePolicy, 'runner result output metadata');
  assertDefaultWorkflowClosurePolicy(passRunnerResult.verification?.payload?.workflowClosurePolicy, 'runner done verification payload');

  const failRunnerState = await engine.createWorkflowFromInstruction({
    workflowId: 'validation-fail-runner-smoke',
    instruction: '验证 runner 会持久化失败的验证结果',
    plan: markTestPlan({
      goal: '验证 runner 会持久化失败的验证结果',
      steps: [
        { key: 'validate', title: 'Run failing validation', description: 'Run failing validation.' }
      ],
      dependencies: []
    }, 'coding-workflow-smoke-test')
  });
  const failRunnerTask = failRunnerState.tasks[0];
  const failRunner = await createWorkflowRunner({
    dbPath,
    engine,
    workflowId: 'validation-fail-runner-smoke',
    taskId: failRunnerTask.taskId,
    runnerId: 'validation-fail-runner',
    verifier: failVerifier,
    adapter: async () => ({ status: 'done', doneSummary: 'validation should fail' })
  });
  const failRunnerResult = await failRunner.runOnce();
  assert(failRunnerResult.status === 'blocked', 'runner should block when required validation verifier fails');
  const failRunnerOutputs = engine.listTaskOutputs({
    workflowId: 'validation-fail-runner-smoke',
    taskId: failRunnerTask.taskId,
    kind: 'validation-result'
  });
  const failRunnerValidationOutput = failRunnerOutputs.find((output) => output.name === 'validation-commands');
  assert(failRunnerValidationOutput?.metadata?.trustState === 'failed', 'runner should persist failing validation evidence as failed output');
  assertDefaultWorkflowClosurePolicy(failRunnerValidationOutput?.metadata?.workflowClosurePolicy, 'runner failing validation output metadata');

  const repairPlan = draftCodingPlan({
    instruction: '修复 verifier validation command 选择逻辑',
    changedFiles: ['runner/verifier.js'],
    packageScripts,
    cwd: rootDir,
    validationProfile: 'standard',
    repairLoop: true,
    maxRepairAttempts: 2
  });
  assert(repairPlan.steps.length === 6, 'repair-loop planner should add repair and rerun validation steps');
  assertDefaultWorkflowClosurePolicy(repairPlan.metadata, 'repair-loop planner metadata');
  assert(repairPlan.dependencies.length === 5, 'repair-loop planner should add failed-validation and rerun dependencies');
  const repairStep = repairPlan.steps.find((step) => step.key === 'repair-validation-failure');
  const rerunStep = repairPlan.steps.find((step) => step.key === 'rerun-validation-after-repair');
  assert(repairStep?.contract?.repairOf === 'validation-result', 'repair task should declare validation-result repair contract');
  assert(repairStep?.contract?.maxRepairAttempts === 2, 'repair task should preserve max repair attempts');
  assert(rerunStep?.contract?.validationCommands?.some((command) => command.script === 'verifier-smoke-test'), 'rerun validation step should preserve selected commands');

  const repairState = await engine.createWorkflowFromInstruction({
    workflowId: 'repair-loop-smoke',
    instruction: '修复 verifier validation command 选择逻辑',
    plan: markTestPlan(repairPlan, 'coding-workflow-smoke-test')
  });
  assert(repairState.tasks.length === 6, 'repair-loop workflow should persist all repair-loop tasks');
  assert(repairState.dependencies.length === 5, 'repair-loop workflow should persist conditional repair dependency');
  for (const key of ['inspect-scope', 'implement-change', 'select-validation']) {
    const task = engine.getWorkflowState({ workflowId: 'repair-loop-smoke' }).tasks.find((item) => item.planTaskKey === key);
    engine.advanceTaskStatus({ workflowId: 'repair-loop-smoke', taskId: task.taskId, status: 'doing' });
    engine.advanceTaskStatus({ workflowId: 'repair-loop-smoke', taskId: task.taskId, status: 'done', doneSummary: key });
  }
  const repairRunValidationTask = engine.getWorkflowState({ workflowId: 'repair-loop-smoke' }).tasks.find((task) => task.planTaskKey === 'run-validation');
  const repairRunner = await createWorkflowRunner({
    dbPath,
    engine,
    workflowId: 'repair-loop-smoke',
    taskId: repairRunValidationTask.taskId,
    runnerId: 'repair-loop-validation-runner',
    verifier: failVerifier,
    adapter: async () => ({ status: 'done', doneSummary: 'validation should fail and continue to repair' })
  });
  const repairRunnerResult = await repairRunner.runOnce();
  assert(repairRunnerResult.status === 'blocked', 'failed validation should still block the validation task itself');
  const repairReadyState = engine.getWorkflowState({ workflowId: 'repair-loop-smoke' });
  const repairTask = repairReadyState.tasks.find((task) => task.planTaskKey === 'repair-validation-failure');
  assert(repairReadyState.nextTask?.planTaskKey === 'repair-validation-failure', 'failed validation evidence should unlock the repair task');
  const repairInputs = engine.listPredecessorTaskOutputs({
    workflowId: 'repair-loop-smoke',
    taskId: repairTask.taskId,
    kind: 'validation-result',
    name: 'validation-commands',
    trustStates: ['failed'],
    includeUnverified: false
  });
  assert(repairInputs.some((item) => item.output.metadata?.trustState === 'failed'), 'repair task should receive failed validation evidence as predecessor context');

  const filterState = await engine.createWorkflowFromInstruction({
    workflowId: 'trusted-inheritance-smoke',
    instruction: '验证上游输出按信任状态过滤',
    plan: markTestPlan({
      goal: '验证上游输出按信任状态过滤',
      steps: [
        { key: 'producer', title: 'Produce outputs', description: 'Produce mixed trust outputs.' },
        { key: 'consumer', title: 'Consume outputs', description: 'Consume trusted outputs only.' }
      ],
      dependencies: [
        { predecessor: 'producer', successor: 'consumer' }
      ]
    }, 'coding-workflow-smoke-test')
  });
  const filterProducer = filterState.tasks.find((task) => task.planTaskKey === 'producer');
  const filterConsumer = filterState.tasks.find((task) => task.planTaskKey === 'consumer');
  const validatedArtifact = engine.addTaskOutput({
    workflowId: 'trusted-inheritance-smoke',
    taskId: filterProducer.taskId,
    kind: 'artifact',
    name: 'trusted-artifact',
    content: 'trusted content',
    metadata: { trustState: 'validated' }
  });
  engine.addTaskOutput({
    workflowId: 'trusted-inheritance-smoke',
    taskId: filterProducer.taskId,
    kind: 'artifact',
    name: 'failed-artifact',
    content: 'failed content',
    metadata: { trustState: 'failed' }
  });
  const trustedPredecessorOutputs = engine.listPredecessorTaskOutputs({
    workflowId: 'trusted-inheritance-smoke',
    taskId: filterConsumer.taskId,
    trustStates: ['validated'],
    includeUnverified: false,
    includeFilterSummary: true
  });
  assert(trustedPredecessorOutputs.length === 1, 'trusted predecessor output filtering should exclude failed outputs');
  assert(trustedPredecessorOutputs[0].output.outputId === validatedArtifact.outputId, 'trusted predecessor output filtering should keep validated outputs');
  assert(trustedPredecessorOutputs.filteredOutputCount === 1, 'trusted predecessor output filtering should report excluded outputs');

  const gatedState = await engine.createWorkflowFromInstruction({
    workflowId: 'validation-gate-smoke',
    instruction: '验证 validation-result 条件依赖',
    plan: markTestPlan({
      goal: '验证 validation-result 条件依赖',
      steps: [
        { key: 'validate', title: 'Validate', description: 'Write validation result.' },
        { key: 'downstream', title: 'Downstream', description: 'Only runs after validated output.' }
      ],
      dependencies: [
        {
          predecessor: 'validate',
          successor: 'downstream',
          condition: {
            outputKind: 'validation-result',
            outputName: 'validation-commands',
            path: 'metadata.trustState',
            operator: 'equals',
            value: 'validated'
          }
        }
      ]
    }, 'coding-workflow-smoke-test')
  });
  const gateProducer = gatedState.tasks.find((task) => task.planTaskKey === 'validate');
  const gateConsumer = gatedState.tasks.find((task) => task.planTaskKey === 'downstream');
  engine.addTaskOutput({
    workflowId: 'validation-gate-smoke',
    taskId: gateProducer.taskId,
    kind: 'validation-result',
    name: 'validation-commands',
    content: 'failed validation gate',
    metadata: { status: 'failed', validationResults: failResult.payload.results }
  });
  engine.advanceTaskStatus({
    workflowId: 'validation-gate-smoke',
    taskId: gateProducer.taskId,
    status: 'doing'
  });
  engine.advanceTaskStatus({
    workflowId: 'validation-gate-smoke',
    taskId: gateProducer.taskId,
    status: 'done',
    doneSummary: 'validation failed'
  });
  const blockedGateState = engine.getWorkflowState({ workflowId: 'validation-gate-smoke' });
  const blockedGateConsumer = blockedGateState.tasks.find((task) => task.taskId === gateConsumer.taskId);
  assert(blockedGateConsumer.status === 'skipped', 'failed validation-result dependency condition should skip the downstream task');
  assert(blockedGateConsumer.reasonCode === 'dependency_condition_not_met', 'failed validation-result dependency condition should record the skip reason');
  assert(blockedGateState.runLogs.some((log) => log.action === 'task_skipped_by_dependency_condition' && log.taskId === gateConsumer.taskId), 'failed validation-result dependency condition should write a skipped-branch run log');

  const draftResponse = await runCli('draft-coding-plan', {
    instruction: '修复 CLI coding workflow',
    changedFiles: ['cli.js'],
    packageScripts,
    cwd: rootDir
  });
  assertProtocol(draftResponse, 'draft-coding-plan', 'ok');
  assert(draftResponse.category === 'coding', 'draft-coding-plan should return a coding plan');
  assertDefaultWorkflowClosurePolicy(draftResponse.metadata, 'draft-coding-plan CLI metadata');
  assert(draftResponse.steps?.some((step) => step.key === 'run-validation'), 'draft-coding-plan should include validation run step');

  const validationResponse = await runCli('select-validation', {
    changedFiles: ['runner/verifier.js'],
    packageScripts,
    cwd: rootDir
  });
  assertProtocol(validationResponse, 'select-validation', 'ok');
  assert(validationResponse.nextAction === 'run_validation_commands', 'select-validation should recommend running selected validation commands');
  assert(validationResponse.commands?.some((command) => command.script === 'verifier-smoke-test'), 'select-validation should return matching validation commands');

  const cliCreated = await runCli('create-coding-workflow', {
    dbPath,
    workflowId: 'cli-coding-workflow-smoke',
    instruction: '修复 CLI coding workflow',
    changedFiles: ['cli.js'],
    packageScripts,
    cwd: rootDir
  });
  assertProtocol(cliCreated, 'create-coding-workflow', 'ok');
  assert(cliCreated.workflow?.workflowId === 'cli-coding-workflow-smoke', 'create-coding-workflow should create the requested workflow');
  assertDefaultWorkflowClosurePolicy(cliCreated.workflow?.initialPlan?.metadata, 'create-coding-workflow persisted metadata');
  assert(cliCreated.tasks?.some((task) => task.planTaskKey === 'run-validation' && task.contract?.validationCommands?.length > 0), 'create-coding-workflow should persist validation commands in task contracts');

  console.log('coding workflow smoke test passed');
  console.log(JSON.stringify({
    selectedScripts: scripts,
    workflowId: state.workflow.workflowId,
    cliWorkflowId: cliCreated.workflow.workflowId,
    validationCommandCount: runValidationStep.contract.validationCommands.length
  }, null, 2));
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

function assertProtocol(response, command, status) {
  assert(response && typeof response === 'object', `${command} should return a JSON object`);
  assert(response.protocolVersion === PROTOCOL_VERSION, `${command} should expose protocolVersion`);
  assert(response.command === command, `${command} should echo the command name`);
  assert(response.status === status, `${command} should report status ${status}`);
  assert(Array.isArray(response.allowedNextCommands), `${command} should expose allowedNextCommands`);
}

function assertDefaultWorkflowClosurePolicy(policy, label) {
  assert(policy?.closureMode === 'small_loop', `${label} should default closureMode to small_loop`);
  assert(policy?.verificationLevel === 'targeted', `${label} should default verificationLevel to targeted`);
  assert(policy?.docPolicy === 'minimal', `${label} should default docPolicy to minimal`);
  assert(policy?.cleanupPolicy === 'defer', `${label} should default cleanupPolicy to defer`);
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
