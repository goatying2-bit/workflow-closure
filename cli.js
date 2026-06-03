#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  buildCoordinatorAssignmentInput as buildSharedCoordinatorAssignmentInput,
  buildCoordinatorExecutionInput as buildSharedCoordinatorExecutionInput,
  buildCoordinatorResumeInput as buildSharedCoordinatorResumeInput,
  buildCoordinatorRuntimeOptions as buildSharedCoordinatorRuntimeOptions,
  buildCoordinatorStateInput as buildSharedCoordinatorStateInput,
  buildCoordinatorStateView,
  buildSharedRuntimeOptions as buildSharedOpsRuntimeOptions,
  getAllowedNextCommandsForCoordinatorResult as getSharedAllowedNextCommandsForCoordinatorResult,
  getAllowedNextCommandsForCoordinatorState as getSharedAllowedNextCommandsForCoordinatorState,
  inferNextActionFromCoordinatorResult as inferSharedNextActionFromCoordinatorResult,
  inferNextActionFromCoordinatorState as inferSharedNextActionFromCoordinatorState
} from './runner/coordinator-ops.js';
import {
  buildTaskPrompt,
  createAgentWorkflowChain,
  createFileTaskSource,
  createMultiAgentCoordinator,
  createWorkflowEngine,
  createWorkflowRunner,
  getAgentStore,
  initializeAgentStore,
  draftCodingPlan,
  draftInitialPlan,
  resolveWorkflowRuntime,
  selectValidationCommands
} from './index.js';
import {
  createWorkflowTaskSourceRef,
  resolveAgentMemorySystem,
  resolveMemoryIntegrationContext,
  upsertMemoryBySource
} from './runner/memory-system.js';
import {
  resolveAgentContextSystem,
  resolveContextIntegrationContext,
  upsertContextItemBySource
} from './runner/context-system.js';
import { shouldWriteLifecycleMemory } from './runner/context-hygiene.js';
import {
  buildTaskOutputSpecs,
  mergeTaskHandoff,
  normalizeStructuredHandoff,
  resolveResultHandoff
} from './runner/task-capture.js';
import { resolveDbTarget, withDbLock } from './storage/db.js';
import { getPersistentAdapterPayload } from './runner/pollution-gateway.js';
import {
  createRuntimeRecoverySelector,
  listDbProfiles,
  resolveDbProfilesRoot
} from './storage/db-scope-config.js';

const PROTOCOL_VERSION = 'workflow-closure-cli/v1';
const PROFILE_QUERY_COMMANDS = [
  'resolve-db-profile',
  'list-db-profiles'
];
const WORKFLOW_QUERY_COMMANDS = [
  'list-workflows',
  'list-active-workflows',
  'inspect-workflow',
  'inspect-workflows',
  'get-workflow-state',
  'list-workflow-reruns',
  'list-task-revisions',
  'list-task-outputs',
  'list-descendant-task-ids',
  'peek-next-ready-task'
];
const WORKFLOW_DEFINITION_QUERY_COMMANDS = [
  'list-workflow-definitions',
  'get-workflow-definition'
];
const CHAIN_COMMANDS = [
  'create-chain',
  'get-chain-state',
  'run-chain',
  'run-next-stage',
  'resume-chain-stage',
  'restart-chain-from-stage'
];
const COORDINATOR_COMMANDS = [
  'register-agent',
  'get-coordinator-state',
  'assign-next-work',
  'run-next-assignment',
  'resume-assigned-work'
];
const RUNNER_COMMANDS = [
  'run-next-task'
];
const COMMANDS = new Set([
  ...PROFILE_QUERY_COMMANDS,
  'draft-plan',
  'draft-coding-plan',
  'create-workflow',
  'create-coding-workflow',
  'create-workflow-definition',
  'get-workflow-definition',
  'list-workflow-definitions',
  'create-workflow-from-definition',
  'resolve-workflow-runtime',
  'select-validation',
  'list-workflows',
  'list-active-workflows',
  'inspect-workflow',
  'inspect-workflows',
  'get-workflow-state',
  'list-workflow-reruns',
  'list-task-revisions',
  'add-task-output',
  'list-task-outputs',
  'list-descendant-task-ids',
  'restart-from-task',
  'claim-next-ready-task',
  'peek-next-ready-task',
  'resume-session',
  'heartbeat-task-lease',
  'release-expired-leases',
  'sweep-task-timeouts',
  'complete-task',
  'block-task',
  'resume-task',
  ...CHAIN_COMMANDS,
  ...COORDINATOR_COMMANDS,
  ...RUNNER_COMMANDS
]);

main();

const MUTATING_COMMANDS = new Set([
  'create-workflow',
  'create-coding-workflow',
  'create-workflow-definition',
  'create-workflow-from-definition',
  'add-task-output',
  'restart-from-task',
  'claim-next-ready-task',
  'resume-session',
  'heartbeat-task-lease',
  'release-expired-leases',
  'sweep-task-timeouts',
  'complete-task',
  'block-task',
  'resume-task',
  'create-chain',
  'run-chain',
  'run-next-stage',
  'resume-chain-stage',
  'restart-chain-from-stage',
  'register-agent',
  'assign-next-work',
  'run-next-assignment',
  'resume-assigned-work',
  ...RUNNER_COMMANDS
]);


async function main() {
  try {
    const { command, flags } = parseCliArgs(process.argv.slice(2));
    const input = await loadStructuredInput(flags);
    const args = { ...input, ...flags };
    delete args.input;
    delete args.inputFile;
    delete args.inputStdin;

    const runtimeOptions = buildSharedOpsRuntimeOptions(args);

    let result;
    if (MUTATING_COMMANDS.has(command)) {
      result = await withDbLock(runtimeOptions.dbPath, () => executeCommand(command, args, runtimeOptions));
    } else {
      result = await executeCommand(command, args, runtimeOptions);
    }
    writeJson(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}

async function executeCommand(command, args, runtimeOptions = buildSharedOpsRuntimeOptions(args)) {
  if (!COMMANDS.has(command)) {
    throw new Error(`Unsupported command: ${command || '(empty)'}`);
  }

  if (PROFILE_QUERY_COMMANDS.includes(command)) {
    return executeProfileQueryCommand(command, args, runtimeOptions);
  }

  if (command === 'draft-plan') {
    const plan = draftInitialPlan(buildInstructionInput(args));
    return createResponse({
      command,
      status: 'ok',
      nextAction: 'create_workflow',
      allowedNextCommands: ['create-workflow'],
      data: plan
    });
  }

  if (command === 'draft-coding-plan') {
    const plan = draftCodingPlan(buildCodingInstructionInput(args));
    return createResponse({
      command,
      status: 'ok',
      nextAction: 'create_coding_workflow',
      allowedNextCommands: ['create-coding-workflow'],
      data: plan
    });
  }

  if (command === 'resolve-workflow-runtime') {
    const runtime = resolveWorkflowRuntime(buildWorkflowRuntimeResolverInput(args));
    return createResponse({
      command,
      status: 'ok',
      nextAction: runtime.runtimePolicy.nextAction,
      allowedNextCommands: runtime.runtimePolicy.allowedNextCommands,
      data: {
        runtime
      }
    });
  }

  if (command === 'select-validation') {
    const selection = selectValidationCommands(buildValidationSelectionInput(args));
    return createResponse({
      command,
      status: 'ok',
      nextAction: selection.commands.length > 0 ? 'run_validation_commands' : 'inspect_validation_gap',
      allowedNextCommands: [],
      data: selection
    });
  }

  if (CHAIN_COMMANDS.includes(command)) {
    const chain = await createAgentWorkflowChain(await buildChainRuntimeOptions(args, runtimeOptions));
    return executeChainCommand(chain, command, args);
  }

  if (COORDINATOR_COMMANDS.includes(command)) {
    const coordinator = await createMultiAgentCoordinator(await buildSharedCoordinatorRuntimeOptions(args, runtimeOptions));
    return executeCoordinatorCommand(coordinator, command, args);
  }

  if (RUNNER_COMMANDS.includes(command)) {
    return executeRunnerCommand(command, args, runtimeOptions);
  }

  const engine = await createWorkflowEngine({ dbPath: runtimeOptions.dbPath });

  switch (command) {
    case 'list-workflows':
      return listWorkflows(engine, args, command, runtimeOptions, { activeOnly: getOptionalBoolean(args.activeOnly, 'activeOnly') === true });
    case 'list-active-workflows':
      return listWorkflows(engine, args, command, runtimeOptions, { activeOnly: true });
    case 'inspect-workflow':
      return inspectWorkflow(engine, args, command, runtimeOptions);
    case 'inspect-workflows':
      return inspectWorkflows(engine, args, command, runtimeOptions);
    case 'create-workflow': {
      const created = await createWorkflowFromCliInput(engine, args);
      return createWorkflowStateResponse({
        command,
        status: 'ok',
        state: created,
        nextAction: 'claim_next_ready_task',
        data: {
          sourceResult: created.sourceResult || null,
          ...createRuntimeDbData(runtimeOptions),
          recoverySelector: createRuntimeRecoverySelector(runtimeOptions)
        }
      });
    }
    case 'create-coding-workflow': {
      const created = await engine.createWorkflowFromInstruction(buildCodingWorkflowInput(args));
      return createWorkflowStateResponse({
        command,
        status: 'ok',
        state: created,
        nextAction: 'claim_next_ready_task',
        data: {
          sourceResult: null,
          ...createRuntimeDbData(runtimeOptions),
          recoverySelector: createRuntimeRecoverySelector(runtimeOptions)
        }
      });
    }
    case 'create-workflow-definition': {
      const definition = await engine.createWorkflowDefinition(buildWorkflowDefinitionInput(args));
      return createWorkflowDefinitionResponse({
        command,
        status: 'ok',
        definition,
        nextAction: 'create_workflow_from_definition',
        allowedNextCommands: ['get-workflow-definition', 'list-workflow-definitions', 'create-workflow-from-definition']
      });
    }
    case 'get-workflow-definition': {
      const definition = await engine.getWorkflowDefinition({
        definitionId: requireText(args.definitionId, 'definitionId')
      });
      return createWorkflowDefinitionResponse({
        command,
        status: 'ok',
        definition,
        nextAction: 'create_workflow_from_definition',
        allowedNextCommands: ['create-workflow-from-definition', 'list-workflow-definitions', 'create-workflow-definition']
      });
    }
    case 'list-workflow-definitions': {
      const definitions = await engine.listWorkflowDefinitions(buildWorkflowDefinitionListInput(args));
      return createWorkflowDefinitionListResponse({
        command,
        status: 'ok',
        definitions,
        filters: {
          search: getOptionalText(args.search),
          sourceWorkflowId: getOptionalText(args.sourceWorkflowId),
          limit: getOptionalNumber(args.limit, 'limit') ?? null
        }
      });
    }
    case 'create-workflow-from-definition': {
      const created = await engine.createWorkflowFromDefinition(buildWorkflowFromDefinitionInput(args));
      return createWorkflowStateResponse({
        command,
        status: 'ok',
        state: created,
        nextAction: 'claim_next_ready_task',
        data: {
          definition: created.definition || null,
          sourceResult: null
        }
      });
    }
    case 'get-workflow-state': {
      const state = engine.getWorkflowState({ workflowId: requireText(args.workflowId, 'workflowId') });
      return createWorkflowStateResponse({
        command,
        status: 'ok',
        state,
        nextAction: inferNextActionFromState(state),
        allowedNextCommands: getAllowedNextCommandsForState(state)
      });
    }
    case 'list-workflow-reruns':
      return listWorkflowReruns(engine, args, command);
    case 'list-task-revisions':
      return listTaskRevisions(engine, args, command);
    case 'add-task-output':
      return addTaskOutput(engine, args, command, runtimeOptions);
    case 'list-task-outputs':
      return listTaskOutputs(engine, args, command);
    case 'list-descendant-task-ids':
      return listDescendantTaskIds(engine, args, command);
    case 'restart-from-task':
      return restartFromTask(engine, args, command);
    case 'claim-next-ready-task':
      return await claimNextReadyTask(engine, args, command);
    case 'peek-next-ready-task':
      return await peekNextReadyTask(engine, args, command, runtimeOptions);
    case 'resume-session':
      return await resumeSession(engine, args, command);
    case 'heartbeat-task-lease': {
      const task = engine.heartbeatTaskLease({
        workflowId: requireText(args.workflowId, 'workflowId'),
        taskId: requireText(args.taskId, 'taskId'),
        leaseOwner: requireText(args.leaseOwner, 'leaseOwner'),
        leaseMs: getOptionalNumber(args.leaseMs, 'leaseMs')
      });

      if (wantsCompactResponse(args)) {
        return createCompactWorkflowMutationResponse({
          command,
          status: 'renewed',
          task,
          nextAction: 'continue_claimed_task',
          allowedNextCommands: mergeUniqueCommands(['heartbeat-task-lease', 'complete-task', 'block-task'], WORKFLOW_QUERY_COMMANDS),
          data: {
            leaseOwner: task.leaseOwner,
            leaseExpiresAt: task.leaseExpiresAt
          }
        });
      }

      const state = engine.getWorkflowState({ workflowId: task.workflowId });
      return createWorkflowStateResponse({
        command,
        status: 'renewed',
        state,
        task,
        nextAction: 'continue_claimed_task',
        allowedNextCommands: mergeUniqueCommands(['heartbeat-task-lease', 'complete-task', 'block-task'], WORKFLOW_QUERY_COMMANDS),
        data: {
          leaseOwner: task.leaseOwner,
          leaseExpiresAt: task.leaseExpiresAt
        }
      });
    }
    case 'release-expired-leases': {
      const released = engine.releaseExpiredTaskLeases({
        workflowId: getOptionalText(args.workflowId),
        now: getOptionalText(args.now),
        reason: getOptionalText(args.reason)
      });
      return createResponse({
        command,
        status: 'released',
        nextAction: released.releasedTaskCount > 0 ? 'claim_next_ready_task' : 'inspect_workflow_state',
        allowedNextCommands: ['claim-next-ready-task', 'get-workflow-state'],
        data: {
          releasedTaskCount: released.releasedTaskCount,
          tasks: released.tasks
        }
      });
    }
    case 'sweep-task-timeouts': {
      const swept = engine.sweepTimedOutTasks({
        workflowId: getOptionalText(args.workflowId),
        now: getOptionalText(args.now),
        maxExecutionMs: getOptionalNumber(args.maxExecutionMs, 'maxExecutionMs'),
        stalledMs: getOptionalNumber(args.stalledMs, 'stalledMs'),
        maxAttempts: getOptionalNumber(args.maxAttempts, 'maxAttempts'),
        reason: getOptionalText(args.reason)
      });
      return createResponse({
        command,
        status: 'ok',
        nextAction: swept.releasedTaskCount > 0 ? 'claim_next_ready_task' : 'inspect_workflow_state',
        allowedNextCommands: ['claim-next-ready-task', 'get-workflow-state'],
        data: {
          releasedTaskCount: swept.releasedTaskCount,
          blockedTaskCount: swept.blockedTaskCount,
          released: swept.released,
          blocked: swept.blocked,
          tasks: swept.tasks
        }
      });
    }
    case 'complete-task':
      return updateTaskStatus(engine, command, args, runtimeOptions, {
        status: 'done',
        statusLabel: 'updated',
        doneSummary: getOptionalText(args.doneSummary),
        action: getOptionalText(args.action) || 'task_completed_via_cli',
        message: getOptionalText(args.message) || `CLI completed task "${requireText(args.taskId, 'taskId')}".`,
        payload: getOptionalObject(args.payload, 'payload'),
        nextAction: 'claim_next_ready_task'
      });
    case 'block-task':
      return updateTaskStatus(engine, command, args, runtimeOptions, {
        status: 'blocked',
        statusLabel: 'updated',
        blockedReason: requireText(args.blockedReason, 'blockedReason'),
        lastError: requireText(args.blockedReason, 'blockedReason'),
        action: getOptionalText(args.action) || 'task_blocked_via_cli',
        message: getOptionalText(args.message) || `CLI blocked task "${requireText(args.taskId, 'taskId')}".`,
        payload: getOptionalObject(args.payload, 'payload'),
        nextAction: 'resume_task'
      });
    case 'resume-task':
      return resumeTask(engine, args, command);
    default:
      throw new Error(`Unsupported command: ${command}`);
  }
}

async function executeChainCommand(chain, command, args) {
  switch (command) {
    case 'create-chain': {
      const result = chain.createChain(buildChainCreateInput(args));
      return createChainStateResponse({
        command,
        status: 'ok',
        state: result.state,
        stage: result.stage,
        nextAction: inferNextActionFromChainState(result.state)
      });
    }
    case 'get-chain-state': {
      const state = chain.getChainState({
        chainId: requireText(args.chainId, 'chainId'),
        includeWorkflowStates: getOptionalBoolean(args.includeWorkflowStates, 'includeWorkflowStates'),
        query: buildChainStateQuery(args)
      });
      return createChainStateResponse({
        command,
        status: 'ok',
        state,
        nextAction: inferNextActionFromChainState(state),
        allowedNextCommands: getAllowedNextCommandsForChainState(state),
        data: {
          workflowStates: state.workflowStates
        }
      });
    }
    case 'run-chain': {
      const result = await chain.runChain({
        chainId: requireText(args.chainId, 'chainId'),
        maxStages: getOptionalNumber(args.maxStages, 'maxStages'),
        maxWorkflowSteps: getOptionalNumber(args.maxWorkflowSteps, 'maxWorkflowSteps')
      });
      return createChainStateResponse({
        command,
        status: result.status,
        state: result.state,
        stage: result.stage,
        nextAction: inferNextActionFromChainState(result.state),
        allowedNextCommands: getAllowedNextCommandsForChainState(result.state),
        data: {
          steps: result.steps,
          workflowResult: result.workflowResult,
          lastStep: result.lastStep
        }
      });
    }
    case 'run-next-stage': {
      const result = await chain.runNextStage({
        chainId: requireText(args.chainId, 'chainId'),
        maxWorkflowSteps: getOptionalNumber(args.maxWorkflowSteps, 'maxWorkflowSteps')
      });
      return createChainStateResponse({
        command,
        status: result.status,
        state: result.state,
        stage: result.stage,
        nextAction: inferNextActionFromChainState(result.state),
        allowedNextCommands: getAllowedNextCommandsForChainState(result.state),
        data: {
          steps: result.steps,
          workflowResult: result.workflowResult,
          lastStep: result.lastStep
        }
      });
    }
    case 'resume-chain-stage': {
      const result = await chain.resumeChainStage({
        chainId: requireText(args.chainId, 'chainId'),
        stageId: requireText(args.stageId, 'stageId'),
        taskId: requireText(args.taskId, 'taskId'),
        payload: getOptionalObject(args.payload, 'payload'),
        message: getOptionalText(args.message)
      });
      return createChainStateResponse({
        command,
        status: 'updated',
        state: result.state,
        stage: result.stage,
        nextAction: inferNextActionFromChainState(result.state),
        allowedNextCommands: getAllowedNextCommandsForChainState(result.state),
        data: {
          task: result.task,
          workflow: result.workflow
        }
      });
    }
    case 'restart-chain-from-stage': {
      const result = await chain.restartChainFromStage({
        chainId: requireText(args.chainId, 'chainId'),
        stageId: requireText(args.stageId, 'stageId'),
        taskId: getOptionalText(args.taskId),
        originTaskId: getOptionalText(args.originTaskId),
        reason: requireText(args.reason, 'reason'),
        fingerprint: getOptionalText(args.fingerprint),
        payload: getOptionalObject(args.payload, 'payload'),
        operator: getOptionalText(args.operator),
        maxSameFingerprintReruns: getOptionalNumber(args.maxSameFingerprintReruns, 'maxSameFingerprintReruns')
      });
      return createChainStateResponse({
        command,
        status: 'restarted',
        state: result.state,
        stage: result.stage,
        nextAction: inferNextActionFromChainState(result.state),
        allowedNextCommands: getAllowedNextCommandsForChainState(result.state),
        data: {
          task: result.task,
          workflow: result.workflow,
          rerun: result.rerun,
          descendants: result.descendants,
          workflowRestart: result.workflowRestart
        }
      });
    }
    default:
      throw new Error(`Unsupported command: ${command}`);
  }
}

async function executeCoordinatorCommand(coordinator, command, args) {
  switch (command) {
    case 'register-agent': {
      const agent = coordinator.registerAgent({
        agentId: getOptionalText(args.agentId),
        name: requireText(args.name, 'name'),
        role: getOptionalText(args.role),
        capabilities: getOptionalArray(args.capabilities, 'capabilities'),
        visibility: getOptionalObject(args.visibility, 'visibility'),
        adapterModule: getOptionalText(args.adapterModule),
        adapter: await loadCliAdapterModule(getOptionalText(args.adapterModule), 'adapterModule'),
        maxConcurrency: getOptionalNumber(args.maxConcurrency, 'maxConcurrency'),
        status: getOptionalText(args.status)
      });
      const state = coordinator.getCoordinatorState(buildSharedCoordinatorStateInput(args));
      return createCoordinatorStateResponse({
        command,
        status: 'ok',
        state,
        nextAction: inferSharedNextActionFromCoordinatorState(state),
        allowedNextCommands: getSharedAllowedNextCommandsForCoordinatorState(state),
        data: {
          agent
        }
      });
    }
    case 'get-coordinator-state': {
      const state = coordinator.getCoordinatorState(buildSharedCoordinatorStateInput(args));
      return createCoordinatorStateResponse({
        command,
        status: 'ok',
        state,
        nextAction: inferSharedNextActionFromCoordinatorState(state),
        allowedNextCommands: getSharedAllowedNextCommandsForCoordinatorState(state)
      });
    }
    case 'assign-next-work': {
      const result = await coordinator.assignNextWork(buildSharedCoordinatorAssignmentInput(args));
      const state = coordinator.getCoordinatorState(buildSharedCoordinatorStateInput(args));
      return createCoordinatorStateResponse({
        command,
        status: result.status,
        state,
        nextAction: inferSharedNextActionFromCoordinatorResult(result, state),
        allowedNextCommands: getSharedAllowedNextCommandsForCoordinatorResult(result, state),
        data: buildCoordinatorExecutionData(result)
      });
    }
    case 'run-next-assignment': {
      const result = await coordinator.runNextAssignment(buildSharedCoordinatorExecutionInput(args));
      const state = coordinator.getCoordinatorState(buildSharedCoordinatorStateInput(args));
      return createCoordinatorStateResponse({
        command,
        status: result.status,
        state,
        nextAction: inferSharedNextActionFromCoordinatorResult(result, state),
        allowedNextCommands: getSharedAllowedNextCommandsForCoordinatorResult(result, state),
        data: buildCoordinatorExecutionData(result)
      });
    }
    case 'resume-assigned-work': {
      const result = await coordinator.resumeAssignedWork(buildSharedCoordinatorResumeInput(args));
      const state = coordinator.getCoordinatorState(buildSharedCoordinatorStateInput(args));
      return createCoordinatorStateResponse({
        command,
        status: result.status,
        state,
        nextAction: inferSharedNextActionFromCoordinatorResult(result, state),
        allowedNextCommands: getSharedAllowedNextCommandsForCoordinatorResult(result, state),
        data: {
          mode: result.mode || null,
          ...buildCoordinatorExecutionData(result)
        }
      });
    }
    default:
      throw new Error(`Unsupported command: ${command}`);
  }
}


async function executeRunnerCommand(command, args, runtimeOptions = buildSharedRuntimeOptions(args)) {
  const runnerOptions = await buildRunnerRuntimeOptions(args, runtimeOptions);
  const runner = await createWorkflowRunner(runnerOptions);
  const result = await runner.runOnce();
  const workflowId = result.workflow?.workflowId || getOptionalText(args.workflowId);
  const engine = await createWorkflowEngine({ dbPath: runnerOptions.dbPath });

  if (!workflowId) {
    return createResponse({
      command,
      status: 'idle',
      nextAction: 'inspect_workflow_state',
      allowedNextCommands: ['create-workflow', 'get-workflow-state', 'release-expired-leases'],
      data: {
        workflow: null,
        task: result.task || null,
        nextTask: null,
        summary: null,
        ...buildRunnerExecutionData(result)
      }
    });
  }

  const state = engine.getWorkflowState({ workflowId });

  return createWorkflowStateResponse({
    command,
    status: result.status,
    state,
    task: result.task || null,
    nextAction: result.status === 'idle'
      ? inferNextActionFromState(state)
      : inferNextActionFromState(state),
    allowedNextCommands: getAllowedNextCommandsForState(state),
    data: buildRunnerExecutionData(result)
  });
}

async function claimNextReadyTask(engine, args, command) {
  const leaseOwner = requireText(args.leaseOwner, 'leaseOwner');
  const preferredRole = getOptionalText(args.requiredRole) || getOptionalText(args.preferredRole);
  const claimed = engine.claimNextReadyTask({
    workflowId: getOptionalText(args.workflowId),
    taskId: getOptionalText(args.taskId),
    leaseOwner,
    leaseMs: getOptionalNumber(args.leaseMs, 'leaseMs'),
    now: getOptionalText(args.now),
    reason: getOptionalText(args.reason),
    ownerAgentId: getOptionalText(args.ownerAgentId),
    preferredRole,
    assignmentStatus: getOptionalText(args.assignmentStatus)
  });

  if (!claimed) {
    const runtimeOptions = buildSharedRuntimeOptions(args);
    return createResponse({
      command,
      status: 'idle',
      nextAction: 'inspect_workflow_state',
      allowedNextCommands: ['get-workflow-state', 'release-expired-leases', 'create-workflow'],
      data: {
        workflow: null,
        task: null,
        nextTask: null,
        prompt: null,
        leaseOwner,
        leaseExpiresAt: null,
        summary: null,
        ...createRuntimeDbData(runtimeOptions),
        recoverySelector: createRuntimeRecoverySelector(runtimeOptions)
      }
    });
  }

  const runtimeOptions = buildSharedRuntimeOptions(args);
  return buildClaimedTaskResponse(engine, args, command, {
    status: 'claimed',
    task: claimed.task,
    workflow: claimed.workflow,
    nextTask: claimed.nextTask,
    leaseOwner: claimed.leaseOwner,
    leaseExpiresAt: claimed.leaseExpiresAt,
    nextAction: 'execute_claimed_task',
    extraData: {
      ...createRuntimeDbData(runtimeOptions),
      recoverySelector: createRuntimeRecoverySelector(runtimeOptions)
    }
  });
}

async function peekNextReadyTask(engine, args, command, runtimeOptions = buildSharedRuntimeOptions(args)) {
  const preferredRole = getOptionalText(args.requiredRole) || getOptionalText(args.preferredRole);
  const peeked = engine.peekNextReadyTask({
    workflowId: getOptionalText(args.workflowId),
    taskId: getOptionalText(args.taskId),
    ownerAgentId: getOptionalText(args.ownerAgentId),
    preferredRole,
    assignmentStatus: getOptionalText(args.assignmentStatus)
  });
  const allowedNextCommands = mergeUniqueCommands(['claim-next-ready-task', 'get-workflow-state', 'release-expired-leases'], WORKFLOW_QUERY_COMMANDS);
  const baseData = {
    prompt: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    pollutionSafe: true,
    mutation: 'none',
    ...createRuntimeDbData(runtimeOptions),
    recoverySelector: createRuntimeRecoverySelector(runtimeOptions)
  };

  if (!peeked) {
    return createCompactWorkflowMutationResponse({
      command,
      status: 'idle',
      workflow: null,
      task: null,
      nextTask: null,
      nextAction: 'inspect_workflow_state',
      allowedNextCommands,
      data: baseData
    });
  }

  return createCompactWorkflowMutationResponse({
    command,
    status: 'peeked',
    workflow: peeked.workflow,
    task: peeked.task,
    nextTask: peeked.nextTask,
    nextAction: 'claim_next_ready_task',
    allowedNextCommands,
    data: baseData
  });
}

async function resumeSession(engine, args, command) {
  const leaseOwner = requireText(args.leaseOwner || args.workerId, 'leaseOwner');
  const preferredRole = getOptionalText(args.requiredRole) || getOptionalText(args.preferredRole);
  const recovered = engine.recoverSession({
    workflowId: getOptionalText(args.workflowId),
    leaseOwner,
    leaseMs: getOptionalNumber(args.leaseMs, 'leaseMs'),
    now: getOptionalText(args.now),
    reason: getOptionalText(args.reason),
    ownerAgentId: getOptionalText(args.ownerAgentId),
    preferredRole,
    assignmentStatus: getOptionalText(args.assignmentStatus)
  });
  const runtimeOptions = buildSharedRuntimeOptions(args);
  const releasedTasks = Array.isArray(recovered.releasedTasks) ? recovered.releasedTasks : [];
  const recoveryData = {
    recoveryMode: recovered.mode,
    resumedExistingTask: recovered.mode === 'continued',
    releasedTaskCount: releasedTasks.length,
    releasedTasks
  };

  if (recovered.mode === 'idle') {
    return createCompactWorkflowMutationResponse({
      command,
      status: 'idle',
      workflow: recovered.workflow,
      task: null,
      nextTask: recovered.nextTask,
      nextAction: 'inspect_workflow_state',
      allowedNextCommands: mergeUniqueCommands(['claim-next-ready-task', 'release-expired-leases', 'create-workflow'], WORKFLOW_QUERY_COMMANDS),
      data: {
        prompt: null,
        leaseOwner: recovered.leaseOwner,
        leaseExpiresAt: recovered.leaseExpiresAt,
        ...recoveryData,
        ...createRuntimeDbData(runtimeOptions),
        recoverySelector: createRuntimeRecoverySelector(runtimeOptions)
      }
    });
  }

  return buildClaimedTaskResponse(engine, args, command, {
    status: recovered.mode,
    task: recovered.task,
    workflow: recovered.workflow,
    nextTask: recovered.nextTask,
    leaseOwner: recovered.leaseOwner,
    leaseExpiresAt: recovered.leaseExpiresAt,
    nextAction: recovered.mode === 'continued' ? 'continue_claimed_task' : 'execute_claimed_task',
    extraData: {
      ...recoveryData,
      ...createRuntimeDbData(runtimeOptions),
      recoverySelector: createRuntimeRecoverySelector(runtimeOptions)
    }
  });
}

async function buildClaimedTaskResponse(engine, args, command, result) {
  const allowedNextCommands = mergeUniqueCommands(['heartbeat-task-lease', 'complete-task', 'block-task'], WORKFLOW_QUERY_COMMANDS);

  if (wantsCompactResponse(args)) {
    return createCompactWorkflowMutationResponse({
      command,
      status: result.status,
      workflow: result.workflow,
      task: result.task,
      nextTask: result.nextTask,
      nextAction: result.nextAction,
      allowedNextCommands,
      data: {
        prompt: null,
        leaseOwner: result.leaseOwner,
        leaseExpiresAt: result.leaseExpiresAt,
        ...(result.extraData || {})
      }
    });
  }

  const runtimeOptions = buildSharedRuntimeOptions(args);
  const state = engine.getWorkflowState({ workflowId: result.task.workflowId });
  const predecessorOutputs = engine.listPredecessorTaskOutputs({
    workflowId: result.task.workflowId,
    taskId: result.task.taskId,
    kind: getOptionalText(args.outputKind),
    trustStates: getOptionalArray(args.trustStates, 'trustStates'),
    includeUnverified: getOptionalBoolean(args.includeUnverified, 'includeUnverified'),
    includeFilterSummary: true,
    limitPerTask: getOptionalNumber(args.outputLimitPerTask, 'outputLimitPerTask')
  });
  const agentIdentity = await resolveCliAgentIdentity({
    dbPath: runtimeOptions.dbPath,
    task: result.task,
    agentId: getOptionalText(args.agentId),
    ownerAgentId: getOptionalText(args.ownerAgentId),
    leaseOwner: result.leaseOwner
  });
  const activeMemoryContext = buildCliActiveMemoryContext(runtimeOptions.memory, agentIdentity);
  const executionContext = buildCliExecutionContext({
    agentIdentity,
    activeMemoryContext,
    contextContext: runtimeOptions.context
  });

  return createWorkflowStateResponse({
    command,
    status: result.status,
    state,
    task: result.task,
    nextAction: result.nextAction,
    allowedNextCommands,
    data: {
      prompt: buildTaskPrompt(state, result.task, {
        predecessorOutputs,
        agentIdentity,
        executionContext
      }),
      activeMemoryContext,
      executionContext,
      agentIdentity,
      predecessorOutputs,
      filteredPredecessorOutputCount: predecessorOutputs.filteredOutputCount || 0,
      leaseOwner: result.leaseOwner,
      leaseExpiresAt: result.leaseExpiresAt,
      ...(result.extraData || {})
    }
  });
}

async function resolveCliAgentIdentity({ dbPath, task, agentId, ownerAgentId, leaseOwner }) {
  const candidateIds = [
    agentId,
    ownerAgentId,
    task?.ownerAgentId,
    leaseOwner
  ].map(getOptionalText).filter(Boolean);
  const agentStore = await createOptionalAgentStore(dbPath);

  if (agentStore) {
    for (const candidateId of candidateIds) {
      const agent = agentStore.getAgent(candidateId);
      if (agent) {
        return buildAgentIdentityFromAgent(agent);
      }
    }
  }

  return buildFallbackAgentIdentity(task, candidateIds[0]);
}

function buildAgentIdentityFromAgent(agent) {
  return {
    agentId: agent.agentId,
    name: agent.name,
    role: agent.role,
    capabilities: Array.isArray(agent.capabilities) ? agent.capabilities : [],
    visibility: getOptionalObject(agent.visibility, 'agent visibility') || null
  };
}

function buildFallbackAgentIdentity(task, agentId) {
  const role = getOptionalText(task?.preferredRole);
  const capabilities = Array.isArray(task?.requiredCapabilities) ? task.requiredCapabilities : [];
  const normalizedAgentId = getOptionalText(agentId);
  const visibility = getOptionalObject(task?.agentVisibility, 'task agent visibility')
    || getOptionalObject(task?.visibility, 'task visibility')
    || null;

  if (!normalizedAgentId && !role && capabilities.length === 0 && !visibility) {
    return null;
  }

  return {
    agentId: normalizedAgentId,
    name: normalizedAgentId,
    role,
    capabilities,
    visibility
  };
}

function buildCliActiveMemoryContext(memoryContext, agentIdentity) {
  const effectiveMemory = normalizeCliMemoryBoundary(agentIdentity?.visibility?.memory, memoryContext);
  if (!effectiveMemory) {
    return {
      enabled: false,
      scope: null,
      projectKey: null,
      workspacePath: null,
      sessionId: null,
      limit: null,
      query: null,
      recalledCount: 0
    };
  }

  return {
    enabled: effectiveMemory.enabled !== false,
    scope: effectiveMemory.scope,
    projectKey: effectiveMemory.projectKey,
    workspacePath: effectiveMemory.workspacePath,
    sessionId: effectiveMemory.sessionId,
    limit: effectiveMemory.limit,
    query: effectiveMemory.query || null,
    recalledCount: effectiveMemory.recalledCount ?? 0
  };
}

function buildCliExecutionContext({ agentIdentity, activeMemoryContext, contextContext } = {}) {
  const visibility = normalizeCliVisibility(agentIdentity?.visibility);
  const tools = Array.isArray(visibility?.tools) ? visibility.tools : [];
  const memory = normalizeCliMemoryBoundary(visibility?.memory, activeMemoryContext);
  const workspace = normalizeCliWorkspaceContext(visibility?.workspace, contextContext);

  if (!agentIdentity && tools.length === 0 && !memory && !workspace) {
    return null;
  }

  return {
    agent: agentIdentity || null,
    tools,
    memory,
    workspace
  };
}

function normalizeCliVisibility(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const tools = Array.isArray(value.tools)
    ? value.tools
      .map((item) => normalizeCliToolVisibility(item))
      .filter(Boolean)
    : [];
  const memory = normalizeCliMemoryBoundary(value.memory);
  const workspace = normalizeCliWorkspaceContext(value.workspace);

  return tools.length > 0 || memory || workspace
    ? { tools, memory, workspace }
    : null;
}

function normalizeCliToolVisibility(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const tool = {
    name: getOptionalText(value.name) || getOptionalText(value.tool),
    purpose: getOptionalText(value.purpose) || getOptionalText(value.description),
    when: getOptionalText(value.when) || getOptionalText(value.usage),
    limits: getOptionalText(value.limits) || getOptionalText(value.boundary)
  };

  return tool.name || tool.purpose || tool.when || tool.limits
    ? tool
    : null;
}

function normalizeCliMemoryBoundary(value, fallback = null) {
  if (value == null) {
    return normalizeCliMemoryBoundaryFromObject(fallback);
  }

  if (value === false) {
    return {
      enabled: false,
      scope: null,
      projectKey: null,
      workspacePath: null,
      sessionId: null,
      limit: null,
      notes: null,
      query: fallback?.query || null,
      recalledCount: fallback?.recalledCount ?? 0
    };
  }

  const normalized = normalizeCliMemoryBoundaryFromObject(value);
  if (!normalized) {
    return normalizeCliMemoryBoundaryFromObject(fallback);
  }

  if (fallback && typeof fallback === 'object') {
    return {
      enabled: normalized.enabled !== false,
      scope: normalized.scope || fallback.scope || null,
      projectKey: normalized.projectKey || fallback.projectKey || null,
      workspacePath: normalized.workspacePath || fallback.workspacePath || null,
      sessionId: normalized.sessionId || fallback.sessionId || null,
      limit: normalized.limit ?? fallback.limit ?? null,
      notes: normalized.notes || fallback.notes || null,
      query: normalized.query || fallback.query || null,
      recalledCount: normalized.recalledCount ?? fallback.recalledCount ?? 0
    };
  }

  return normalized;
}

function normalizeCliMemoryBoundaryFromObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const normalized = {
    enabled: value.enabled !== false,
    scope: getOptionalText(value.scope),
    projectKey: getOptionalText(value.projectKey),
    workspacePath: getOptionalText(value.workspacePath),
    sessionId: getOptionalText(value.sessionId),
    limit: normalizeCliOptionalInteger(value.limit),
    notes: getOptionalText(value.notes),
    query: value.query && typeof value.query === 'object' && !Array.isArray(value.query) ? value.query : null,
    recalledCount: normalizeCliOptionalInteger(value.recalledCount, true)
  };

  return normalized.enabled === false
    || normalized.scope
    || normalized.projectKey
    || normalized.workspacePath
    || normalized.sessionId
    || normalized.limit != null
    || normalized.notes
    || normalized.query
    || normalized.recalledCount != null
    ? normalized
    : null;
}

function normalizeCliWorkspaceContext(value, fallback = null) {
  if (value == null) {
    return normalizeCliWorkspaceContextObject(fallback);
  }

  const normalizedValue = normalizeCliWorkspaceContextObject(value);
  const normalizedFallback = normalizeCliWorkspaceContextObject(fallback);

  if (!normalizedValue) {
    return normalizedFallback;
  }

  if (!normalizedFallback) {
    return normalizedValue;
  }

  return {
    cwd: normalizedValue.cwd || normalizedFallback.cwd || null,
    path: normalizedValue.path || normalizedFallback.path || null,
    artifacts: normalizedValue.artifacts || normalizedFallback.artifacts || null,
    notes: normalizedValue.notes || normalizedFallback.notes || null
  };
}

function normalizeCliWorkspaceContextObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const workspacePath = getOptionalText(value.workspacePath);
  const normalized = {
    cwd: getOptionalText(value.cwd) || workspacePath,
    path: getOptionalText(value.path),
    artifacts: getOptionalText(value.artifacts),
    notes: getOptionalText(value.notes)
  };

  return normalized.cwd || normalized.path || normalized.artifacts || normalized.notes
    ? normalized
    : null;
}

function normalizeCliOptionalInteger(value, allowZero = false) {
  if (value == null || value === '') {
    return null;
  }

  const number = Number(value);
  if (!Number.isFinite(number)) {
    return null;
  }

  if (allowZero) {
    return number < 0 ? null : Math.floor(number);
  }

  return number <= 0 ? null : Math.floor(number);
}

async function updateTaskStatus(engine, command, args, runtimeOptions, options) {
  return advanceTaskStatusHelper(engine, args, command, runtimeOptions, options);
}

async function advanceTaskStatusHelper(engine, args, command, runtimeOptions = buildSharedOpsRuntimeOptions(args), options) {
  const workflowId = requireText(args.workflowId, 'workflowId');
  const taskId = requireText(args.taskId, 'taskId');
  const leaseOwner = getOptionalText(args.leaseOwner);
  const expectedLeaseOwner = getOptionalText(args.expectedLeaseOwner) || leaseOwner;
  const stateBefore = engine.getWorkflowState({ workflowId });
  const taskBefore = stateBefore.tasks.find((item) => item.taskId === taskId);

  if (!taskBefore) {
    throw new Error('Task not found.');
  }

  const captureResult = buildCliTaskCaptureResult(args, options);
  const nextHandoff = mergeTaskHandoff(taskBefore.handoff, resolveResultHandoff(captureResult), taskBefore, captureResult);
  const taskOutputs = buildTaskOutputSpecs(captureResult, {
    workerId: leaseOwner || expectedLeaseOwner || null,
    nextHandoff,
    workspacePath: runtimeOptions.workspacePath,
    captureSource: command,
    defaultOutputName: 'cli-result'
  });

  const result = engine.advanceTaskStatus({
    workflowId,
    taskId,
    status: options.status,
    blockedReason: options.blockedReason,
    doneSummary: options.doneSummary,
    lastError: options.lastError,
    action: options.action,
    message: options.message,
    payload: {
      ...(options.payload || {}),
      ...(nextHandoff ? { handoff: nextHandoff } : {}),
      taskOutputs
    },
    handoff: nextHandoff,
    taskOutputs,
    expectedLeaseOwner
  });

  syncLatestTaskAssignmentForCliStatusChange({
    dbPath: runtimeOptions.dbPath,
    task: result.task,
    status: options.status
  });

  const lifecycleCapture = await writeCliTaskLifecycleCapture(runtimeOptions, result.workflow, result.task, {
    command,
    kind: options.status === 'done' ? 'done' : 'blocked',
    result: captureResult,
    workerId: leaseOwner || expectedLeaseOwner || null,
    handoff: nextHandoff
  });

  const capture = buildCliCaptureSummary(nextHandoff, taskOutputs, lifecycleCapture);

  if (wantsCompactResponse(args)) {
    return createCompactWorkflowMutationResponse({
      command,
      status: options.statusLabel,
      workflow: result.workflow,
      task: result.task,
      nextTask: result.nextTask,
      nextAction: options.nextAction,
      allowedNextCommands: WORKFLOW_QUERY_COMMANDS,
      data: { capture }
    });
  }

  const state = engine.getWorkflowState({ workflowId: result.workflow.workflowId });
  return createWorkflowStateResponse({
    command,
    status: options.statusLabel,
    state,
    task: result.task,
    nextAction: options.nextAction,
    allowedNextCommands: getAllowedNextCommandsForState(state),
    data: { capture }
  });
}

function buildCliTaskCaptureResult(args, options) {
  const payload = {
    ...(options.payload || {}),
    ...buildCliHandoffPayload(args),
    ...buildCliOutputPayload(args),
    ...buildCliMemoryPayload(args)
  };

  return {
    status: options.status,
    doneSummary: options.doneSummary,
    blockedReason: options.blockedReason,
    message: options.message,
    payload,
    handoff: getOptionalObject(args.handoff, 'handoff')
  };
}

function buildCliHandoffPayload(args) {
  const handoff = getOptionalObject(args.handoff, 'handoff') || getOptionalObject(args.payload?.handoff, 'payload.handoff');
  const convenienceHandoff = normalizeStructuredHandoff({
    artifacts: getOptionalArray(args.artifacts, 'artifacts'),
    decisions: getOptionalArray(args.decisions, 'decisions'),
    openQuestions: getOptionalArray(args.openQuestions, 'openQuestions'),
    risks: getOptionalArray(args.risks, 'risks'),
    recommendedNextRole: getOptionalText(args.recommendedNextRole)
  });
  const normalizedHandoff = normalizeStructuredHandoff(handoff);
  const mergedHandoff = normalizeStructuredHandoff({
    summary: convenienceHandoff?.summary || normalizedHandoff?.summary,
    artifacts: [...(normalizedHandoff?.artifacts || []), ...(convenienceHandoff?.artifacts || [])],
    decisions: [...(normalizedHandoff?.decisions || []), ...(convenienceHandoff?.decisions || [])],
    openQuestions: [...(normalizedHandoff?.openQuestions || []), ...(convenienceHandoff?.openQuestions || [])],
    risks: [...(normalizedHandoff?.risks || []), ...(convenienceHandoff?.risks || [])],
    recommendedNextRole: convenienceHandoff?.recommendedNextRole || normalizedHandoff?.recommendedNextRole,
    sourceRef: normalizedHandoff?.sourceRef
  });

  return mergedHandoff ? { handoff: mergedHandoff } : {};
}

function buildCliOutputPayload(args) {
  const taskOutputs = getOptionalArray(args.taskOutputs, 'taskOutputs');
  const payloadOutputs = getOptionalArray(args.payload?.outputs, 'payload.outputs');
  const outputs = [
    ...(Array.isArray(payloadOutputs) ? payloadOutputs : []),
    ...(Array.isArray(taskOutputs) ? taskOutputs : [])
  ];

  return outputs.length > 0 ? { outputs } : {};
}

function buildCliMemoryPayload(args) {
  const memory = args.memory ?? args.payload?.memory;
  const memories = args.memories ?? args.payload?.memories;
  return {
    ...(memory == null ? {} : { memory }),
    ...(memories == null ? {} : { memories })
  };
}

function buildCliCaptureSummary(handoff, taskOutputs, lifecycleCapture = null) {
  return {
    handoffRecorded: Boolean(handoff),
    outputCount: taskOutputs.length,
    outputKinds: [...new Set(taskOutputs.map((output) => output.kind).filter(Boolean))],
    lifecycle: lifecycleCapture
  };
}

async function writeCliTaskLifecycleCapture(runtimeOptions, workflow, task, input = {}) {
  const result = {
    memoryWritten: false,
    contextWritten: false,
    errors: []
  };

  try {
    const memoryContext = resolveMemoryIntegrationContext(runtimeOptions);
    const memorySystem = await resolveAgentMemorySystem(runtimeOptions);
    const memory = writeCliTaskLifecycleMemory(memorySystem, memoryContext, workflow, task, input);
    result.memoryWritten = Boolean(memory);
  } catch (error) {
    result.errors.push({ target: 'memory', message: error instanceof Error ? error.message : String(error) });
  }

  try {
    const contextContext = resolveContextIntegrationContext(runtimeOptions);
    const contextSystem = await resolveAgentContextSystem(runtimeOptions);
    const contextItem = writeCliTaskLifecycleContext(contextSystem, contextContext, workflow, task, input);
    result.contextWritten = Boolean(contextItem);
  } catch (error) {
    result.errors.push({ target: 'context', message: error instanceof Error ? error.message : String(error) });
  }

  return result;
}

function writeCliTaskLifecycleMemory(memorySystem, memoryContext, workflow, task, input = {}) {
  if (!memorySystem || !memoryContext.enabled || !workflow?.workflowId || !task?.taskId) {
    return null;
  }

  const lifecyclePolicy = shouldWriteLifecycleMemory({ kind: input.kind, task });
  if (!lifecyclePolicy.shouldWrite) {
    return null;
  }

  const sourceRef = createWorkflowTaskSourceRef(workflow.workflowId, task.taskId);

  return upsertMemoryBySource(memorySystem, {
    memoryPolicy: 'workflowTaskLifecycle',
    type: lifecyclePolicy.type,
    scope: memoryContext.scope,
    title: `Workflow task ${task.title}`,
    summary: buildCliTaskLifecycleSummary(task, input),
    content: buildCliTaskLifecycleContent(workflow, task, input),
    projectKey: memoryContext.projectKey,
    workspacePath: memoryContext.workspacePath,
    sessionId: memoryContext.sessionId,
    tags: buildCliLifecycleTags(task, input.kind, lifecyclePolicy),
    sourceKind: 'workflow-task',
    sourceRef,
    subjectKind: 'workflow-task',
    subjectRef: sourceRef,
    workflowId: workflow.workflowId,
    taskId: task.taskId,
    eventKind: input.kind || 'blocked',
    structureJson: buildCliTaskLifecycleStructure(workflow, task, input),
    stability: lifecyclePolicy.stability,
    confidence: lifecyclePolicy.confidence,
    message: appendCliLifecycleHygieneMessage(buildCliTaskLifecycleMessage(task, input.kind), lifecyclePolicy)
  });
}

function writeCliTaskLifecycleContext(contextSystem, contextContext, workflow, task, input = {}) {
  if (!contextSystem || !contextContext.enabled || !workflow?.workflowId || !task?.taskId) {
    return null;
  }

  const sourceRef = createWorkflowTaskSourceRef(workflow.workflowId, task.taskId);
  const lifecyclePolicy = shouldWriteLifecycleMemory({ kind: input.kind, task });

  return upsertContextItemBySource(contextSystem, {
    kind: 'workflow-task-lifecycle',
    scope: contextContext.scope,
    projectKey: contextContext.projectKey,
    workspacePath: contextContext.workspacePath,
    sessionId: contextContext.sessionId,
    workflowId: workflow.workflowId,
    taskId: task.taskId,
    sourceKind: 'workflow-task',
    sourceRef,
    title: `Workflow task ${task.title}`,
    summary: buildCliTaskLifecycleSummary(task, input),
    content: buildCliTaskLifecycleContent(workflow, task, input),
    metadata: {
      workerId: input.workerId || null,
      command: input.command || null,
      kind: input.kind || null,
      adapterPayload: input.result?.payload ?? null,
      handoff: input.handoff || null,
      hygiene: {
        hygieneLabel: lifecyclePolicy.hygieneLabel,
        sourceClass: lifecyclePolicy.sourceClass,
        allowedUse: lifecyclePolicy.allowedUse,
        promptAllowed: true,
        workflowGenerated: lifecyclePolicy.workflowGenerated,
        requiresPromotion: lifecyclePolicy.requiresPromotion
      }
    },
    priority: resolveCliTaskContextPriority(input.kind)
  });
}

function buildCliTaskLifecycleSummary(task, input = {}) {
  if (input.kind === 'done') {
    return task.doneSummary || `Task "${task.title}" completed.`;
  }

  return task.blockedReason || task.lastError || `Task "${task.title}" is blocked.`;
}

function buildCliTaskLifecycleContent(workflow, task, input = {}) {
  const adapterPayload = getPersistentAdapterPayload(input);
  return [
    `workflowId: ${workflow.workflowId}`,
    `taskId: ${task.taskId}`,
    `workflowGoal: ${workflow.goal}`,
    `workflowInstruction: ${workflow.instruction}`,
    `taskTitle: ${task.title}`,
    `taskDescription: ${task.description || '无'}`,
    `taskStatus: ${task.status}`,
    `attemptCount: ${task.attemptCount || 0}`,
    `doneSummary: ${task.doneSummary || '无'}`,
    `blockedReason: ${task.blockedReason || '无'}`,
    `lastError: ${task.lastError || '无'}`,
    `workerId: ${input.workerId || '无'}`,
    `command: ${input.command || '无'}`,
    `handoff: ${safeJson(input.handoff ?? null)}`,
    `payload: ${safeJson(adapterPayload)}`
  ].join('\n');
}

function buildCliTaskLifecycleStructure(workflow, task, input = {}) {
  const adapterPayload = getPersistentAdapterPayload(input);
  return {
    workflowId: workflow.workflowId,
    taskId: task.taskId,
    taskTitle: task.title,
    taskStatus: task.status,
    eventKind: input.kind || 'blocked',
    command: input.command || null,
    workerId: input.workerId || null,
    doneSummary: task.doneSummary || null,
    blockedReason: task.blockedReason || null,
    lastError: task.lastError || null,
    adapterPayload,
    handoff: input.handoff || null
  };
}

function buildCliLifecycleTags(task, kind, lifecyclePolicy) {
  return [...new Set([
    'workflow',
    'task',
    task.status,
    kind,
    'workflow-generated',
    lifecyclePolicy.hygieneLabel,
    lifecyclePolicy.sourceClass,
    lifecyclePolicy.requiresPromotion ? 'requires-promotion' : 'validated-promoted'
  ].filter(Boolean))];
}

function buildCliTaskLifecycleMessage(task, kind) {
  return kind === 'done'
    ? `Updated workflow-task memory after completing "${task.title}" via CLI.`
    : `Updated workflow-task memory after blocking "${task.title}" via CLI.`;
}

function appendCliLifecycleHygieneMessage(message, lifecyclePolicy) {
  return `${message} hygiene=${lifecyclePolicy.hygieneLabel}; allowedUse=${lifecyclePolicy.allowedUse}; requiresPromotion=${lifecyclePolicy.requiresPromotion ? 'true' : 'false'}`;
}

function resolveCliTaskContextPriority(kind) {
  if (kind === 'blocked') {
    return 96;
  }

  if (kind === 'done') {
    return 90;
  }

  return 92;
}

function safeJson(value) {
  return value == null ? 'null' : JSON.stringify(value);
}

function syncLatestTaskAssignmentForCliStatusChange({ dbPath, task, status }) {
  if (!task || task.taskId == null || task.workflowId == null) {
    return;
  }

  const assignmentStatus = status === 'blocked'
    ? 'blocked'
    : status === 'done'
      ? 'completed'
      : null;

  if (!assignmentStatus) {
    return;
  }

  let latestAssignment;
  try {
    latestAssignment = getAgentStore({ dbPath }).getLatestAssignmentForTarget({
      workflowId: task.workflowId,
      targetType: 'task',
      targetId: task.taskId
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes('no such table')) {
      return;
    }
    throw error;
  }

  if (!latestAssignment) {
    return;
  }

  const eligibleCurrentStatuses = assignmentStatus === 'blocked'
    ? new Set(['assigned', 'accepted'])
    : new Set(['assigned', 'accepted', 'blocked']);

  if (!eligibleCurrentStatuses.has(latestAssignment.status)) {
    return;
  }

  getAgentStore({ dbPath }).updateAssignment({
    assignmentId: latestAssignment.assignmentId,
    status: assignmentStatus,
    reason: assignmentStatus === 'blocked'
      ? `Task "${task.title}" blocked while assigned to agent "${latestAssignment.agentId}".`
      : `Task "${task.title}" completed by agent "${latestAssignment.agentId}".`,
    payload: {
      ...latestAssignment.payload,
      targetStatus: task.status,
      blockedReason: task.blockedReason || null,
      doneSummary: task.doneSummary || null,
      lastError: task.lastError || null,
      updatedVia: 'cli'
    }
  });
}

function resumeTask(engine, args, command) {
  const workflowId = requireText(args.workflowId, 'workflowId');
  const taskId = requireText(args.taskId, 'taskId');
  const state = engine.getWorkflowState({ workflowId });
  const task = state.tasks.find((item) => item.taskId === taskId);

  if (!task) {
    throw new Error('Task not found.');
  }

  if (task.status !== 'blocked') {
    throw new Error('Only blocked tasks can be resumed.');
  }

  const result = engine.advanceTaskStatus({
    workflowId,
    taskId,
    status: 'ready',
    lastError: task.lastError || task.blockedReason || null,
    reasonCode: null,
    action: getOptionalText(args.action) || 'task_resumed_via_cli',
    message: getOptionalText(args.message) || `CLI resumed task "${task.taskId}".`,
    payload: getOptionalObject(args.payload, 'payload')
  });

  const nextState = engine.getWorkflowState({ workflowId });
  return createWorkflowStateResponse({
    command,
    status: 'updated',
    state: nextState,
    task: result.task,
    nextAction: 'claim_next_ready_task',
    allowedNextCommands: getAllowedNextCommandsForState(nextState)
  });
}

function listWorkflows(engine, args, command, runtimeOptions = {}, options = {}) {
  const limit = getOptionalNumber(args.limit, 'limit');
  const status = getOptionalText(args.status);
  const activeOnly = options.activeOnly === true;
  const workflows = engine.listWorkflows({
    ...(status ? { status } : {}),
    activeOnly,
    ...(limit == null ? {} : { limit })
  });
  const inspections = workflows.map((workflow) => buildWorkflowInspection(
    engine.getWorkflowState({ workflowId: workflow.workflowId, query: { includeRunLogs: false } }),
    null
  ));
  const summaries = inspections.map((inspection) => inspection.summary);

  return createResponse({
    command,
    status: 'ok',
    nextAction: inspections.length > 0 ? 'inspect_workflow' : 'create_workflow',
    allowedNextCommands: ['inspect-workflow', 'get-workflow-state', 'create-workflow'],
    data: {
      limit: limit ?? null,
      filters: {
        status: status || null,
        activeOnly
      },
      workflows,
      summaries,
      overview: buildWorkflowOverview(inspections)
    }
  });
}

async function inspectWorkflow(engine, args, command, runtimeOptions = {}) {
  const workflowId = requireText(args.workflowId, 'workflowId');
  const state = engine.getWorkflowState({ workflowId });
  const agentStore = await createOptionalAgentStore(runtimeOptions.dbPath);
  const inspection = buildWorkflowInspection(state, agentStore);

  return createResponse({
    command,
    status: 'ok',
    nextAction: inferNextActionFromState(state),
    allowedNextCommands: mergeUniqueCommands(getAllowedNextCommandsForState(state), ['list-workflows', 'list-active-workflows', 'inspect-workflows']),
    data: {
      workflow: state.workflow,
      tasks: state.tasks,
      dependencies: state.dependencies,
      runLogs: state.runLogs || [],
      nextTask: state.nextTask || null,
      summary: inspection.summary,
      inspection
    }
  });
}

async function inspectWorkflows(engine, args, command, runtimeOptions = {}) {
  const limit = getOptionalNumber(args.limit, 'limit');
  const status = getOptionalText(args.status);
  const activeOnly = getOptionalBoolean(args.activeOnly, 'activeOnly') === true;
  const workflows = engine.listWorkflows({
    ...(status ? { status } : {}),
    activeOnly,
    ...(limit == null ? {} : { limit })
  });
  const agentStore = await createOptionalAgentStore(runtimeOptions.dbPath);
  const inspections = workflows.map((workflow) => buildWorkflowInspection(
    engine.getWorkflowState({ workflowId: workflow.workflowId }),
    agentStore
  ));

  return createResponse({
    command,
    status: 'ok',
    nextAction: inspections.length > 0 ? 'inspect_workflow' : 'create_workflow',
    allowedNextCommands: ['inspect-workflow', 'get-workflow-state', 'list-workflows', 'list-active-workflows'],
    data: {
      limit: limit ?? null,
      filters: {
        status: status || null,
        activeOnly
      },
      workflows,
      inspections,
      summaries: inspections.map((inspection) => inspection.summary),
      overview: buildWorkflowOverview(inspections)
    }
  });
}

function listWorkflowReruns(engine, args, command) {
  const workflowId = requireText(args.workflowId, 'workflowId');
  const limit = getOptionalNumber(args.limit, 'limit');
  const state = engine.getWorkflowState({ workflowId });
  const reruns = engine.listWorkflowReruns({
    workflowId,
    query: {
      ...(limit == null ? {} : { limit })
    }
  });

  return createWorkflowQueryResponse({
    command,
    state,
    data: {
      workflowId,
      limit: limit ?? null,
      reruns
    }
  });
}

function listTaskRevisions(engine, args, command) {
  const workflowId = requireText(args.workflowId, 'workflowId');
  const taskId = getOptionalText(args.taskId);
  const rerunId = getOptionalText(args.rerunId);
  const limit = getOptionalNumber(args.limit, 'limit');
  const state = engine.getWorkflowState({ workflowId });
  const revisions = engine.listTaskRevisions({
    workflowId,
    ...(taskId ? { taskId } : {}),
    ...(rerunId ? { rerunId } : {}),
    ...(limit == null ? {} : { limit })
  });

  return createWorkflowQueryResponse({
    command,
    state,
    data: {
      workflowId,
      taskId,
      rerunId,
      limit: limit ?? null,
      revisions
    }
  });
}

function addTaskOutput(engine, args, command, runtimeOptions = {}) {
  const workflowId = requireText(args.workflowId, 'workflowId');
  const taskId = requireText(args.taskId, 'taskId');
  const output = engine.addTaskOutput({
    workflowId,
    taskId,
    kind: requireText(args.kind, 'kind'),
    name: getOptionalText(args.name),
    content: args.content,
    path: getOptionalText(args.path),
    workspacePath: getOptionalText(args.workspacePath) || runtimeOptions.workspacePath,
    metadata: getOptionalObject(args.metadata, 'metadata')
  });
  const state = engine.getWorkflowState({ workflowId });

  return createWorkflowQueryResponse({
    command,
    state,
    data: {
      workflowId,
      taskId,
      output
    }
  });
}

function listTaskOutputs(engine, args, command) {
  const workflowId = requireText(args.workflowId, 'workflowId');
  const taskId = getOptionalText(args.taskId);
  const kind = getOptionalText(args.kind);
  const limit = getOptionalNumber(args.limit, 'limit');
  const state = engine.getWorkflowState({ workflowId });
  const outputs = engine.listTaskOutputs({
    workflowId,
    ...(taskId ? { taskId } : {}),
    ...(kind ? { kind } : {}),
    ...(limit == null ? {} : { limit })
  });

  return createWorkflowQueryResponse({
    command,
    state,
    data: {
      workflowId,
      taskId,
      kind,
      limit: limit ?? null,
      outputs
    }
  });
}

function listDescendantTaskIds(engine, args, command) {
  const workflowId = requireText(args.workflowId, 'workflowId');
  const taskId = requireText(args.taskId, 'taskId');
  const state = engine.getWorkflowState({ workflowId });
  const descendantTaskIds = engine.listDescendantTaskIds({ workflowId, taskId });

  return createWorkflowQueryResponse({
    command,
    state,
    data: {
      workflowId,
      taskId,
      descendantTaskIds
    }
  });
}

function restartFromTask(engine, args, command) {
  const workflowId = requireText(args.workflowId, 'workflowId');
  const result = engine.restartFromTask({
    workflowId,
    taskId: requireText(args.taskId, 'taskId'),
    reason: requireText(args.reason, 'reason'),
    fingerprint: getOptionalText(args.fingerprint),
    payload: getOptionalObject(args.payload, 'payload'),
    operator: getOptionalText(args.operator),
    maxSameFingerprintReruns: getOptionalNumber(args.maxSameFingerprintReruns, 'maxSameFingerprintReruns')
  });

  return createWorkflowStateResponse({
    command,
    status: 'restarted',
    state: result.state,
    task: result.task,
    nextAction: inferNextActionFromState(result.state),
    allowedNextCommands: getAllowedNextCommandsForState(result.state),
    data: {
      rerun: result.rerun,
      descendants: result.descendants
    }
  });
}

function createWorkflowDefinitionResponse({ command, status, definition, nextAction, allowedNextCommands, data }) {
  return createResponse({
    command,
    status,
    nextAction,
    allowedNextCommands,
    data: {
      definition,
      summary: buildWorkflowDefinitionSummary(definition),
      ...data
    }
  });
}

function createWorkflowDefinitionListResponse({ command, status, definitions, filters, nextAction, allowedNextCommands, data }) {
  const items = Array.isArray(definitions) ? definitions : [];
  return createResponse({
    command,
    status,
    nextAction: nextAction || (items.length > 0 ? 'get_workflow_definition' : 'create_workflow_definition'),
    allowedNextCommands: allowedNextCommands || mergeUniqueCommands(
      WORKFLOW_DEFINITION_QUERY_COMMANDS,
      ['create-workflow-definition', 'create-workflow-from-definition']
    ),
    data: {
      definitions: items,
      summaries: items.map((definition) => buildWorkflowDefinitionSummary(definition)),
      filters: filters || null,
      count: items.length,
      ...data
    }
  });
}

function createWorkflowQueryResponse({ command, state, status = 'ok', nextAction, allowedNextCommands, data }) {
  return createResponse({
    command,
    status,
    nextAction: nextAction || inferNextActionFromState(state),
    allowedNextCommands: allowedNextCommands || mergeUniqueCommands(getAllowedNextCommandsForState(state), WORKFLOW_QUERY_COMMANDS),
    data: {
      workflow: state.workflow,
      tasks: state.tasks,
      dependencies: state.dependencies,
      runLogs: state.runLogs || [],
      nextTask: state.nextTask || null,
      summary: buildWorkflowSummary(state),
      ...data
    }
  });
}

function buildWorkflowDefinitionSummary(definition) {
  if (!definition) {
    return null;
  }

  const planTasks = Array.isArray(definition.plan?.tasks)
    ? definition.plan.tasks
    : Array.isArray(definition.plan?.steps)
      ? definition.plan.steps
      : [];

  return {
    definitionId: definition.definitionId,
    name: definition.name,
    goal: definition.goal,
    description: definition.description || null,
    sourceWorkflowId: definition.sourceWorkflowId || null,
    concurrencyLimit: definition.concurrencyLimit ?? null,
    taskCount: planTasks.length,
    updatedAt: definition.updatedAt || null,
    createdAt: definition.createdAt || null
  };
}

function createRuntimeDbData(runtimeOptions = {}) {
  return {
    runtime: {
      dbPath: runtimeOptions.dbPath || null,
      dbPathSource: runtimeOptions.dbPathSource || null,
      dbScopeLabel: runtimeOptions.dbScopeLabel || null,
      dbProfile: runtimeOptions.dbProfile || null,
      workspacePath: runtimeOptions.workspacePath || null,
      workspaceKey: runtimeOptions.workspaceKey || null
    }
  };
}

function executeProfileQueryCommand(command, args, runtimeOptions) {
  if (command === 'resolve-db-profile') {
    return createResponse({
      command,
      status: 'ok',
      nextAction: 'use_runtime_selector',
      allowedNextCommands: ['create-workflow', 'resume-session', 'get-coordinator-state'],
      data: {
        ...createRuntimeDbData(runtimeOptions),
        recoverySelector: createRuntimeRecoverySelector(runtimeOptions)
      }
    });
  }

  if (command === 'list-db-profiles') {
    const profilesRoot = resolveDbProfilesRoot({ resolveDbTarget });
    const profiles = listDbProfiles({ profilesRoot, resolveDbTarget });

    return createResponse({
      command,
      status: 'ok',
      nextAction: profiles.length > 0 ? 'select_db_profile' : 'create_profile_workflow',
      allowedNextCommands: ['resolve-db-profile', 'create-workflow'],
      data: {
        profilesRoot,
        profiles
      }
    });
  }

  throw new Error(`Unsupported profile query command: ${command}`);
}

function createWorkflowStateResponse({ command, status, state, task, nextAction, allowedNextCommands, data }) {
  return createResponse({
    command,
    status,
    nextAction,
    allowedNextCommands: allowedNextCommands || getAllowedNextCommandsForState(state),
    data: {
      workflow: state.workflow,
      task: task || state.nextTask || null,
      tasks: state.tasks,
      dependencies: state.dependencies,
      runLogs: state.runLogs || [],
      nextTask: state.nextTask || null,
      summary: buildWorkflowSummary(state),
      ...data
    }
  });
}

function createCompactWorkflowMutationResponse({ command, status, workflow, task, nextTask, nextAction, allowedNextCommands, data }) {
  const compactWorkflow = workflow || (task?.workflowId ? { workflowId: task.workflowId } : null);
  return createResponse({
    command,
    status,
    nextAction,
    allowedNextCommands,
    data: {
      workflow: compactWorkflow,
      task: task || null,
      nextTask: nextTask || null,
      summary: compactWorkflow
        ? {
            workflowId: compactWorkflow.workflowId,
            workflowStatus: compactWorkflow.status || null,
            currentTaskId: compactWorkflow.currentTaskId || null,
            nextTaskId: nextTask?.taskId || null,
            nextRecommendedCommand: nextAction || null
          }
        : null,
      ...data
    }
  });
}

function createChainStateResponse({ command, status, state, stage, nextAction, allowedNextCommands, data }) {
  return createResponse({
    command,
    status,
    nextAction,
    allowedNextCommands: allowedNextCommands || getAllowedNextCommandsForChainState(state),
    data: {
      chain: state.chain,
      stage: stage || state.nextStage || null,
      stages: state.stages || [],
      runLogs: state.runLogs || [],
      nextStage: state.nextStage || null,
      summary: buildChainSummary(state),
      ...data
    }
  });
}

function createCoordinatorStateResponse({ command, status, state, nextAction, allowedNextCommands, data }) {
  return createResponse({
    command,
    status,
    nextAction,
    allowedNextCommands: allowedNextCommands || getSharedAllowedNextCommandsForCoordinatorState(state),
    data: buildCoordinatorStateView({
      state,
      data,
      nextAction,
      allowedNextCommands
    })
  });
}

function createResponse({ command, status, nextAction, allowedNextCommands, data }) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    command,
    status,
    nextAction: nextAction || null,
    allowedNextCommands: Array.isArray(allowedNextCommands) ? [...new Set(allowedNextCommands)] : [],
    ...data
  };
}

function buildWorkflowSummary(state) {
  if (!state?.workflow) {
    return null;
  }

  const tasks = Array.isArray(state.tasks) ? state.tasks : [];
  const countsByStatus = countTasksByStatus(tasks);

  return {
    workflowId: state.workflow.workflowId,
    workflowStatus: state.workflow.status,
    status: state.workflow.status,
    goal: state.workflow.goal,
    currentTaskId: state.workflow.currentTaskId,
    taskCount: tasks.length,
    countsByStatus,
    progress: {
      done: countsByStatus.done,
      skipped: countsByStatus.skipped,
      total: tasks.length
    },
    hasBlockedTasks: countsByStatus.blocked > 0,
    nextTaskId: state.nextTask?.taskId || null,
    nextTaskTitle: state.nextTask?.title || null,
    nextRecommendedCommand: inferNextActionFromState(state),
    owners: getWorkflowOwners(tasks),
    blockedTasks: summarizeTasks(tasks.filter((task) => task.status === 'blocked')),
    doingTasks: summarizeTasks(tasks.filter((task) => task.status === 'doing')),
    updatedAt: state.workflow.updatedAt
  };
}

function countTasksByStatus(tasks) {
  const countsByStatus = {
    pending: 0,
    ready: 0,
    doing: 0,
    blocked: 0,
    done: 0,
    skipped: 0
  };

  for (const task of tasks) {
    if (countsByStatus[task.status] != null) {
      countsByStatus[task.status] += 1;
    }
  }

  return countsByStatus;
}

function summarizeTasks(tasks) {
  return tasks.map((task) => ({
    taskId: task.taskId,
    title: task.title,
    status: task.status,
    planTaskKey: task.planTaskKey || null,
    ownerAgentId: task.ownerAgentId || null,
    leaseOwner: task.leaseOwner || null,
    leaseExpiresAt: task.leaseExpiresAt || null,
    blockedReason: task.blockedReason || null,
    lastError: task.lastError || null,
    reasonCode: task.reasonCode || null,
    updatedAt: task.updatedAt
  }));
}

function getWorkflowOwners(tasks) {
  return [...new Set(tasks.flatMap((task) => [task.ownerAgentId, task.leaseOwner]).filter(Boolean))];
}

function buildWorkflowInspection(state, agentStore) {
  const tasks = Array.isArray(state.tasks) ? state.tasks : [];
  const workflowId = state.workflow?.workflowId || null;
  const agentContext = workflowId && agentStore ? buildWorkflowAgentContext(agentStore, workflowId) : null;

  return {
    workflow: state.workflow || null,
    summary: buildWorkflowSummary(state),
    nextTask: state.nextTask || null,
    readyTasks: summarizeTasks(tasks.filter((task) => task.status === 'ready')),
    doingTasks: summarizeTasks(tasks.filter((task) => task.status === 'doing')),
    blockedTasks: summarizeTasks(tasks.filter((task) => task.status === 'blocked')),
    doneTasks: summarizeTasks(tasks.filter((task) => task.status === 'done')),
    skippedTasks: summarizeTasks(tasks.filter((task) => task.status === 'skipped')),
    runLogCount: Array.isArray(state.runLogs) ? state.runLogs.length : 0,
    agents: agentContext?.agents || null,
    assignments: agentContext?.assignments || null,
    handoffs: agentContext?.handoffs || null
  };
}

function buildWorkflowAgentContext(agentStore, workflowId) {
  const agents = agentStore.listAgents({ limit: 1000 });
  const assignments = agentStore.listAssignments({ workflowId, limit: 100 });
  const handoffs = agentStore.listHandoffs({ workflowId, limit: 100 });
  const openAssignments = assignments.filter((assignment) => !['completed', 'done', 'released'].includes(assignment.status));
  const blockedAssignments = assignments.filter((assignment) => assignment.status === 'blocked');
  const completedAssignments = assignments.filter((assignment) => assignment.status === 'completed' || assignment.status === 'done');
  const openHandoffs = handoffs.filter((handoff) => handoff.status !== 'closed' && handoff.status !== 'done');

  return {
    agents: {
      registered: agents.length,
      active: agents.filter((agent) => agent.status !== 'inactive').length,
      items: agents
    },
    assignments: {
      open: openAssignments,
      blocked: blockedAssignments,
      completedCount: completedAssignments.length,
      totalCount: assignments.length
    },
    handoffs: {
      open: openHandoffs,
      totalCount: handoffs.length
    }
  };
}

async function createOptionalAgentStore(dbPath) {
  if (!dbPath) {
    return null;
  }

  try {
    await initializeAgentStore({ dbPath });
    return getAgentStore({ dbPath });
  } catch {
    return null;
  }
}

function buildWorkflowOverview(inspections) {
  const countsByStatus = {
    draft: 0,
    ready: 0,
    doing: 0,
    blocked: 0,
    done: 0
  };

  for (const inspection of inspections) {
    const status = inspection.workflow?.status;
    if (countsByStatus[status] != null) {
      countsByStatus[status] += 1;
    }
  }

  return {
    workflowCount: inspections.length,
    countsByStatus,
    activeCount: inspections.filter((inspection) => inspection.workflow?.status !== 'done').length,
    blockedCount: countsByStatus.blocked,
    doingCount: countsByStatus.doing,
    readyCount: countsByStatus.ready
  };
}

function buildChainSummary(state) {
  if (!state?.chain) {
    return null;
  }

  const stages = Array.isArray(state.stages) ? state.stages : [];
  const countsByStatus = {
    pending: 0,
    ready: 0,
    doing: 0,
    blocked: 0,
    done: 0
  };

  for (const stage of stages) {
    if (countsByStatus[stage.status] != null) {
      countsByStatus[stage.status] += 1;
    }
  }

  return {
    chainId: state.chain.chainId,
    chainStatus: state.chain.status,
    currentStageId: state.chain.currentStageId,
    stageCount: stages.length,
    countsByStatus,
    hasBlockedStages: countsByStatus.blocked > 0,
    nextStageId: state.nextStage?.stageId || null,
    nextStageTitle: state.nextStage?.title || null,
    nextRecommendedCommand: inferNextActionFromChainState(state)
  };
}

function buildCoordinatorSummary(state) {
  const agents = Array.isArray(state?.agents) ? state.agents : [];
  const assignments = Array.isArray(state?.assignments) ? state.assignments : [];
  const handoffs = Array.isArray(state?.handoffs) ? state.handoffs : [];
  const agentCountsByStatus = countItemsByStatus(agents, ['active', 'inactive', 'archived']);
  const assignmentCountsByStatus = countItemsByStatus(assignments, ['assigned', 'accepted', 'released', 'completed', 'blocked']);
  const nextTarget = state?.nextStage || state?.nextTask || null;

  return {
    agentCount: agents.length,
    assignmentCount: assignments.length,
    handoffCount: handoffs.length,
    openHandoffCount: handoffs.filter((item) => item.status === 'open').length,
    agentCountsByStatus,
    assignmentCountsByStatus,
    nextTargetType: nextTarget?.targetType || null,
    nextTargetId: nextTarget?.targetId || null,
    nextTargetTitle: nextTarget?.title || null,
    nextRecommendedCommand: inferNextActionFromCoordinatorState(state)
  };
}

function countItemsByStatus(items, allowedStatuses) {
  const counts = Object.fromEntries(allowedStatuses.map((status) => [status, 0]));

  for (const item of items) {
    if (item?.status != null && counts[item.status] != null) {
      counts[item.status] += 1;
    }
  }

  return counts;
}

function getAllowedNextCommandsForState(state) {
  if (!state?.workflow) {
    return ['create-workflow', 'draft-plan'];
  }

  if (state.workflow.status === 'done') {
    return mergeUniqueCommands(WORKFLOW_QUERY_COMMANDS, ['restart-from-task', 'create-workflow']);
  }

  if (state.workflow.status === 'blocked') {
    return mergeUniqueCommands(['resume-task'], WORKFLOW_QUERY_COMMANDS, ['restart-from-task']);
  }

  const currentTask = state.tasks?.find((task) => task.taskId === state.workflow.currentTaskId) || null;
  if (currentTask?.status === 'doing') {
    return mergeUniqueCommands(['heartbeat-task-lease', 'complete-task', 'block-task'], WORKFLOW_QUERY_COMMANDS);
  }

  if (state.workflow.status === 'ready') {
    return mergeUniqueCommands(['peek-next-ready-task', 'claim-next-ready-task', 'run-next-task'], WORKFLOW_QUERY_COMMANDS, ['restart-from-task']);
  }

  return mergeUniqueCommands(WORKFLOW_QUERY_COMMANDS, ['restart-from-task']);
}

function getAllowedNextCommandsForChainState(state) {
  if (!state?.chain) {
    return ['create-chain'];
  }

  if (state.chain.status === 'done') {
    return ['get-chain-state', 'restart-chain-from-stage', 'create-chain'];
  }

  if (state.chain.status === 'blocked') {
    return ['get-chain-state', 'resume-chain-stage', 'restart-chain-from-stage'];
  }

  if (state.chain.status === 'ready') {
    return ['get-chain-state', 'run-chain', 'run-next-stage', 'restart-chain-from-stage'];
  }

  if (state.chain.status === 'doing') {
    return ['get-chain-state', 'run-chain', 'run-next-stage', 'restart-chain-from-stage'];
  }

  return ['get-chain-state', 'run-chain', 'run-next-stage', 'restart-chain-from-stage'];
}

function mergeUniqueCommands(...groups) {
  return [...new Set(groups.flat().filter(Boolean))];
}

function inferNextActionFromState(state) {
  if (!state?.workflow) {
    return 'create_workflow';
  }

  switch (state.workflow.status) {
    case 'ready':
      return 'claim_next_ready_task';
    case 'doing':
      return 'continue_claimed_task';
    case 'blocked':
      return 'resume_task';
    case 'done':
      return 'workflow_done';
    default:
      return 'inspect_workflow_state';
  }
}

function inferNextActionFromChainState(state) {
  if (!state?.chain) {
    return 'create_chain';
  }

  switch (state.chain.status) {
    case 'ready':
      return 'run_chain';
    case 'doing':
      return 'continue_chain';
    case 'blocked':
      return 'resume_chain_stage';
    case 'done':
      return 'chain_done';
    default:
      return 'inspect_chain_state';
  }
}

function getAllowedNextCommandsForCoordinatorState(state) {
  const nextTarget = state?.nextStage || state?.nextTask || null;
  const recoveryStatus = getCoordinatorRecoveryStatus(state?.recoveryTarget || state?.blockedTarget || null);

  if (recoveryStatus?.phase === 'cooldown') {
    return ['get-coordinator-state', 'resume-assigned-work', 'assign-next-work', 'run-next-assignment', 'register-agent'];
  }

  if (nextTarget?.status === 'blocked') {
    return ['get-coordinator-state', 'resume-assigned-work', 'assign-next-work', 'run-next-assignment', 'register-agent'];
  }

  if (nextTarget?.status === 'ready') {
    return ['get-coordinator-state', 'assign-next-work', 'run-next-assignment', 'register-agent'];
  }

  if ((state?.assignments || []).some((assignment) => assignment.status === 'blocked')) {
    return ['get-coordinator-state', 'resume-assigned-work', 'assign-next-work', 'run-next-assignment', 'register-agent'];
  }

  if ((state?.agents || []).length > 0) {
    return ['get-coordinator-state', 'assign-next-work', 'run-next-assignment', 'resume-assigned-work', 'register-agent'];
  }

  return ['register-agent', 'get-coordinator-state'];
}

function getAllowedNextCommandsForCoordinatorResult(result, state) {
  if (result?.status === 'assigned') {
    return ['get-coordinator-state', 'assign-next-work', 'run-next-assignment', 'resume-assigned-work'];
  }

  if (result?.status === 'reassigned' || result?.status === 'resumed') {
    return ['get-coordinator-state', 'assign-next-work', 'run-next-assignment', 'resume-assigned-work'];
  }

  if (result?.status === 'cooldown') {
    return ['get-coordinator-state', 'resume-assigned-work', 'assign-next-work', 'run-next-assignment', 'register-agent'];
  }

  if (result?.status === 'blocked') {
    return ['get-coordinator-state', 'resume-assigned-work', 'assign-next-work', 'run-next-assignment', 'register-agent'];
  }

  if (result?.status === 'done') {
    return getAllowedNextCommandsForCoordinatorState(state);
  }

  if (result?.status === 'idle' && result?.reason === 'no_available_agent') {
    return ['register-agent', 'get-coordinator-state', 'assign-next-work', 'run-next-assignment'];
  }

  if (result?.status === 'idle' && result?.reason === 'no_ready_work') {
    return ['get-coordinator-state', 'assign-next-work', 'run-next-assignment', 'register-agent'];
  }

  if (result?.status === 'idle' && result?.reason === 'no_blocked_work') {
    return getAllowedNextCommandsForCoordinatorState(state);
  }

  return getAllowedNextCommandsForCoordinatorState(state);
}

function inferNextActionFromCoordinatorState(state) {
  const nextTarget = state?.nextStage || state?.nextTask || null;
  const recoveryStatus = getCoordinatorRecoveryStatus(state?.recoveryTarget || state?.blockedTarget || null);

  if (recoveryStatus?.phase === 'cooldown') {
    return 'wait_for_recovery';
  }

  if (recoveryStatus?.phase === 'ready') {
    return 'resume_assigned_work';
  }

  if (nextTarget?.status === 'blocked' || (state?.assignments || []).some((assignment) => assignment.status === 'blocked')) {
    return 'resume_assigned_work';
  }

  if (nextTarget?.status === 'ready') {
    return 'assign_next_work';
  }

  if ((state?.agents || []).length === 0) {
    return 'register_agent';
  }

  return 'inspect_coordinator_state';
}

function inferNextActionFromCoordinatorResult(result, state) {
  if (result?.status === 'assigned') {
    return 'assignment_prepared';
  }

  if (result?.status === 'reassigned') {
    return 'assignment_reassigned';
  }

  if (result?.status === 'resumed') {
    return 'resume_prepared';
  }

  if (result?.status === 'cooldown') {
    return 'wait_for_recovery';
  }

  if (result?.status === 'done') {
    return inferNextActionFromCoordinatorState(state);
  }

  if (result?.status === 'blocked') {
    const recoveryStatus = getCoordinatorRecoveryStatus(result?.target || state?.recoveryTarget || state?.blockedTarget || null);
    return recoveryStatus?.phase === 'cooldown' ? 'wait_for_recovery' : 'resume_assigned_work';
  }

  if (result?.status === 'idle' && result?.reason === 'no_blocked_work') {
    return inferNextActionFromCoordinatorState(state);
  }

  if (result?.status === 'idle' && result?.reason === 'no_available_agent') {
    return 'register_agent';
  }

  if (result?.status === 'idle' && result?.reason === 'no_ready_work') {
    return 'inspect_coordinator_state';
  }

  return inferNextActionFromCoordinatorState(state);
}

function getCoordinatorRecoveryStatus(target) {
  const recovery = target?.recovery && typeof target.recovery === 'object' && !Array.isArray(target.recovery)
    ? target.recovery
    : null;
  if (!recovery || recovery.recoveryClass !== 'transient_upstream') {
    return null;
  }

  const nextEligibleRetryAt = getOptionalText(recovery.nextEligibleRetryAt);
  if (!nextEligibleRetryAt) {
    return {
      phase: 'ready',
      recovery,
      nextEligibleRetryAt: null,
      waitMs: 0
    };
  }

  const nextEligibleAtMs = Date.parse(nextEligibleRetryAt);
  if (!Number.isFinite(nextEligibleAtMs)) {
    return {
      phase: 'ready',
      recovery,
      nextEligibleRetryAt,
      waitMs: 0
    };
  }

  const waitMs = Math.max(nextEligibleAtMs - Date.now(), 0);
  return {
    phase: waitMs > 0 ? 'cooldown' : 'ready',
    recovery,
    nextEligibleRetryAt,
    waitMs
  };
}

function buildCoordinatorExecutionData(result) {
  const target = result?.target || null;
  const stepTask = result?.step?.task || null;
  const task = result?.task || stepTask || (target?.targetType === 'task' ? target : null);
  const stage = result?.stage || (target?.targetType === 'stage' ? target : null);

  return {
    reason: result?.reason || null,
    assignment: result?.assignment || null,
    agent: result?.agent || null,
    target,
    workflow: result?.workflow || null,
    stage,
    task,
    step: result?.step || null,
    handoff: result?.handoff || null,
    workflowResult: result?.workflowResult || null,
    chain: result?.chain || null,
    recovery: result?.recovery || null,
    recoveryStatus: result?.recoveryStatus || null,
    waitMs: result?.waitMs ?? null,
    nextEligibleRetryAt: result?.nextEligibleRetryAt || null
  };
}

function buildRunnerExecutionData(result) {
  return {
    runnerId: result?.runnerId || null,
    releasedTaskCount: result?.releasedTaskCount ?? 0,
    sweptReleasedTaskCount: result?.sweptReleasedTaskCount ?? 0,
    sweptBlockedTaskCount: result?.sweptBlockedTaskCount ?? 0,
    reasonCode: result?.reasonCode || null,
    prompt: result?.prompt || null,
    memoryContext: result?.memoryContext || null,
    activeMemoryContext: result?.activeMemoryContext || null,
    executionContext: result?.executionContext || null,
    recalledMemories: Array.isArray(result?.recalledMemories) ? result.recalledMemories : [],
    contextSnapshot: result?.contextSnapshot || null,
    contextItems: Array.isArray(result?.contextItems) ? result.contextItems : [],
    ruleContext: result?.ruleContext || null,
    agentIdentity: result?.agentIdentity || null,
    assignment: result?.assignment || null,
    handoff: result?.handoff || null,
    adapterPayload: result?.adapterPayload ?? null,
    verification: result?.verification || null,
    checkpoint: result?.checkpoint || null,
    error: result?.error || null,
    recovery: result?.recovery || null
  };
}

function buildInstructionInput(args) {
  const instruction = requireText(args.instruction, 'instruction');
  const input = { instruction };

  if (getOptionalText(args.goal)) {
    input.goal = getOptionalText(args.goal);
  }

  if (getOptionalText(args.workflowId)) {
    input.workflowId = getOptionalText(args.workflowId);
  }

  const concurrencyLimit = getOptionalNumber(args.concurrencyLimit, 'concurrencyLimit');
  if (concurrencyLimit != null) {
    input.concurrencyLimit = concurrencyLimit;
  }

  if (args.plan != null) {
    input.plan = getOptionalObject(args.plan, 'plan');
  }

  const workflowHygieneMetadata = getOptionalObject(args.workflowHygieneMetadata, 'workflowHygieneMetadata');
  if (workflowHygieneMetadata) {
    input.workflowHygieneMetadata = workflowHygieneMetadata;
  }

  return input;
}

function buildWorkflowDefinitionInput(args) {
  const input = buildInstructionInput(args);
  input.name = requireText(args.name, 'name');

  if (getOptionalText(args.definitionId)) {
    input.definitionId = getOptionalText(args.definitionId);
  }

  if (getOptionalText(args.description)) {
    input.description = getOptionalText(args.description);
  }

  if (getOptionalText(args.sourceWorkflowId)) {
    input.sourceWorkflowId = getOptionalText(args.sourceWorkflowId);
  }

  if (args.metadata != null) {
    input.metadata = getOptionalObject(args.metadata, 'metadata');
  }

  return input;
}

function buildWorkflowDefinitionListInput(args) {
  const search = getOptionalText(args.search);
  const sourceWorkflowId = getOptionalText(args.sourceWorkflowId);
  const limit = getOptionalNumber(args.limit, 'limit');

  return {
    ...(search ? { search } : {}),
    ...(sourceWorkflowId ? { sourceWorkflowId } : {}),
    ...(limit == null ? {} : { limit })
  };
}

function buildWorkflowFromDefinitionInput(args) {
  const definitionId = requireText(args.definitionId, 'definitionId');
  const workflowId = getOptionalText(args.workflowId);
  const goal = getOptionalText(args.goal);
  const instruction = getOptionalText(args.instruction);
  const concurrencyLimit = getOptionalNumber(args.concurrencyLimit, 'concurrencyLimit');
  const status = getOptionalText(args.status);

  return {
    definitionId,
    ...(workflowId ? { workflowId } : {}),
    ...(goal ? { goal } : {}),
    ...(instruction ? { instruction } : {}),
    ...(concurrencyLimit == null ? {} : { concurrencyLimit }),
    ...(status ? { status } : {})
  };
}

function buildCodingInstructionInput(args) {
  const input = buildInstructionInput(args);

  if (getOptionalText(args.plannerMode) || getOptionalText(args.mode)) {
    input.plannerMode = getOptionalText(args.plannerMode) || getOptionalText(args.mode);
  }

  if (getOptionalText(args.validationProfile) || getOptionalText(args.profile)) {
    input.validationProfile = getOptionalText(args.validationProfile) || getOptionalText(args.profile);
  }

  if (getOptionalText(args.cwd)) {
    input.cwd = getOptionalText(args.cwd);
  }

  if (getOptionalText(args.packageManager)) {
    input.packageManager = getOptionalText(args.packageManager);
  }

  const changedFiles = getOptionalArray(args.changedFiles, 'changedFiles');
  if (changedFiles) {
    input.changedFiles = changedFiles;
  }

  const targetFiles = getOptionalArray(args.targetFiles, 'targetFiles');
  if (targetFiles) {
    input.targetFiles = targetFiles;
  }

  if (args.packageScripts != null) {
    input.packageScripts = getOptionalObject(args.packageScripts, 'packageScripts');
  }

  if (args.packageJson != null) {
    input.packageJson = getOptionalObject(args.packageJson, 'packageJson');
  }

  const repairLoop = getOptionalBoolean(args.repairLoop, 'repairLoop');
  if (repairLoop != null) {
    input.repairLoop = repairLoop;
  }

  const maxRepairAttempts = getOptionalNumber(args.maxRepairAttempts, 'maxRepairAttempts');
  if (maxRepairAttempts != null) {
    input.maxRepairAttempts = maxRepairAttempts;
  }

  return input;
}

function buildCodingWorkflowInput(args) {
  const input = buildInstructionInput(args);
  if (args.plan == null) {
    input.plan = draftCodingPlan(buildCodingInstructionInput(args));
  }
  return input;
}

function buildWorkflowRuntimeResolverInput(args) {
  const input = {};

  for (const key of [
    'instruction',
    'goal',
    'workspacePath',
    'projectKey',
    'sessionId',
    'dbProfile',
    'profile',
    'dbPath',
    'scope',
    'dataClass',
    'retention',
    'generatedBy',
    'cwd',
    'packageManager',
    'validationProfile',
    'workflowMode',
    'taskScale',
    'riskLevel',
    'runnerId',
    'ownerAgentId',
    'agentId',
    'preferredRole',
    'requiredRole',
    'assignmentStatus',
    'timeoutSweepReason'
  ]) {
    const text = getOptionalText(args[key]);
    if (text) {
      input[key] = text;
    }
  }

  for (const key of [
    'changedFiles',
    'targetFiles',
    'agentPool'
  ]) {
    const array = getOptionalArray(args[key], key);
    if (array) {
      input[key] = array;
    }
  }

  for (const key of [
    'stageCount',
    'memoryLimit',
    'contextLimit',
    'leaseMs',
    'maxTaskRetries',
    'taskExecutionTimeoutMs',
    'timeoutSweepMaxExecutionMs',
    'timeoutSweepStalledMs',
    'timeoutSweepMaxAttempts',
    'timeoutSweepIntervalMs'
  ]) {
    const number = getOptionalNumber(args[key], key);
    if (number != null) {
      input[key] = number;
    }
  }

  for (const key of ['temporary', 'ephemeral', 'requiresCoordination']) {
    const bool = getOptionalBoolean(args[key], key);
    if (bool != null) {
      input[key] = bool;
    }
  }

  for (const key of ['memory', 'context', 'packageJson', 'task', 'workflow']) {
    if (args[key] != null) {
      input[key] = getOptionalObject(args[key], key);
    }
  }

  if (args.packageScripts != null) {
    input.packageScripts = Array.isArray(args.packageScripts)
      ? getOptionalArray(args.packageScripts, 'packageScripts')
      : getOptionalObject(args.packageScripts, 'packageScripts');
  }

  return input;
}

function buildValidationSelectionInput(args) {
  const input = {};

  const changedFiles = getOptionalArray(args.changedFiles, 'changedFiles');
  if (changedFiles) {
    input.changedFiles = changedFiles;
  }

  const targetFiles = getOptionalArray(args.targetFiles, 'targetFiles');
  if (targetFiles) {
    input.targetFiles = targetFiles;
  }

  if (args.task != null) {
    input.task = getOptionalObject(args.task, 'task');
  }

  if (args.workflow != null) {
    input.workflow = getOptionalObject(args.workflow, 'workflow');
  }

  if (getOptionalText(args.cwd)) {
    input.cwd = getOptionalText(args.cwd);
  }

  if (getOptionalText(args.packageManager)) {
    input.packageManager = getOptionalText(args.packageManager);
  }

  if (getOptionalText(args.validationProfile) || getOptionalText(args.profile)) {
    input.profile = getOptionalText(args.validationProfile) || getOptionalText(args.profile);
  }

  if (args.packageScripts != null) {
    input.packageScripts = getOptionalObject(args.packageScripts, 'packageScripts');
  }

  if (args.packageJson != null) {
    input.packageJson = getOptionalObject(args.packageJson, 'packageJson');
  }

  return input;
}

function hasTaskSourceCliInput(args) {
  return Boolean(
    getOptionalText(args.taskSourceFile)
    || getOptionalText(args.taskSourcePath)
    || getOptionalText(args.taskSourceModule)
  );
}

async function buildTaskSourceInput(args) {
  const taskSourceFile = getOptionalText(args.taskSourceFile) || getOptionalText(args.taskSourcePath);
  const taskSourceModule = getOptionalText(args.taskSourceModule);

  if (taskSourceFile && taskSourceModule) {
    throw new Error('Use either taskSourceFile/taskSourcePath or taskSourceModule, not both.');
  }

  let taskSource;
  if (taskSourceFile) {
    taskSource = createFileTaskSource({ filePath: taskSourceFile });
  } else if (taskSourceModule) {
    taskSource = await loadCliTaskSourceModule(taskSourceModule, 'taskSourceModule');
  } else {
    throw new Error('taskSourceFile, taskSourcePath, or taskSourceModule is required.');
  }

  const concurrencyLimit = getOptionalNumber(args.concurrencyLimit, 'concurrencyLimit');

  return {
    taskSource,
    ...(getOptionalText(args.workflowId) ? { workflowId: getOptionalText(args.workflowId) } : {}),
    ...(getOptionalText(args.instruction) ? { instruction: getOptionalText(args.instruction) } : {}),
    ...(getOptionalText(args.goal) ? { goal: getOptionalText(args.goal) } : {}),
    ...(concurrencyLimit != null ? { concurrencyLimit } : {}),
    ...(args.plan != null ? { plan: getOptionalObject(args.plan, 'plan') } : {})
  };
}

async function createWorkflowFromCliInput(engine, args) {
  if (hasTaskSourceCliInput(args)) {
    return engine.createWorkflowFromTaskSource(await buildTaskSourceInput(args));
  }

  return engine.createWorkflowFromInstruction(buildInstructionInput(args));
}

function buildChainCreateInput(args) {
  return {
    chainId: getOptionalText(args.chainId),
    instruction: requireText(args.instruction, 'instruction'),
    stages: getRequiredArray(args.stages, 'stages')
  };
}

function buildChainStateQuery(args) {
  const includeRunLogs = getOptionalBoolean(args.includeRunLogs, 'includeRunLogs');
  const limit = getOptionalNumber(args.limit, 'limit');
  const offset = getOptionalNumber(args.offset, 'offset');

  return {
    ...(includeRunLogs == null ? {} : { includeRunLogs }),
    ...(limit == null ? {} : { limit }),
    ...(offset == null ? {} : { offset })
  };
}

async function buildChainRuntimeOptions(args, runtimeOptions = buildSharedRuntimeOptions(args)) {
  const options = {
    ...runtimeOptions,
    context: runtimeOptions.context ? { ...runtimeOptions.context } : runtimeOptions.context,
    memory: runtimeOptions.memory ? { ...runtimeOptions.memory } : runtimeOptions.memory
  };

  applyRunnerTimeoutRuntimeOptions(args, options);

  const runnerId = getOptionalText(args.runnerId);
  if (runnerId) {
    options.runnerId = runnerId;
  }

  const ownerAgentId = getOptionalText(args.ownerAgentId);
  if (ownerAgentId) {
    options.ownerAgentId = ownerAgentId;
  }

  const agentIdentity = await resolveCliAgentIdentity({
    dbPath: runtimeOptions.dbPath,
    task: null,
    agentId: getOptionalText(args.agentId),
    ownerAgentId,
    leaseOwner: runnerId
  });
  if (agentIdentity) {
    options.agentIdentity = agentIdentity;
  }

  const adapter = await loadCliAdapterModule(getOptionalText(args.adapterModule), 'adapterModule');
  if (adapter) {
    options.adapter = adapter;
  }

  const workflowHygieneMetadata = getOptionalObject(args.workflowHygieneMetadata, 'workflowHygieneMetadata');
  if (workflowHygieneMetadata) {
    options.workflowHygieneMetadata = workflowHygieneMetadata;
  }

  return options;
}

async function buildCoordinatorRuntimeOptions(args, runtimeOptions = buildSharedRuntimeOptions(args)) {
  const options = {
    ...runtimeOptions,
    context: runtimeOptions.context ? { ...runtimeOptions.context } : runtimeOptions.context,
    memory: runtimeOptions.memory ? { ...runtimeOptions.memory } : runtimeOptions.memory
  };
  applyRunnerTimeoutRuntimeOptions(args, options);
  const { dbPath } = options;
  const commandAdapterModule = getOptionalText(args.adapterModule);
  const requestedAgentId = getOptionalText(args.agentId);
  const adapterCache = new Map();

  async function resolveModuleAdapter(modulePath) {
    const normalizedPath = getOptionalText(modulePath);
    if (!normalizedPath) {
      return null;
    }

    if (!adapterCache.has(normalizedPath)) {
      adapterCache.set(normalizedPath, await loadCliAdapterModule(normalizedPath, 'adapterModule'));
    }

    return adapterCache.get(normalizedPath);
  }

  const commandAdapter = await resolveModuleAdapter(commandAdapterModule);

  if (dbPath) {
    await initializeAgentStore({ dbPath });
    const agentStore = getAgentStore({ dbPath });
    const agents = agentStore.listAgents({ limit: 1000 });

    for (const agent of agents) {
      if (getOptionalText(agent.adapterModule)) {
        await resolveModuleAdapter(agent.adapterModule);
      }
    }
  }

  const workflowHygieneMetadata = getOptionalObject(args.workflowHygieneMetadata, 'workflowHygieneMetadata');

  return {
    ...options,
    ...(workflowHygieneMetadata ? { workflowHygieneMetadata } : {}),
    resolveAgentAdapter(agent) {
      if (!agent) {
        return null;
      }

      if (commandAdapter) {
        if (requestedAgentId && agent.agentId === requestedAgentId) {
          return commandAdapter;
        }

        if (commandAdapterModule && agent.adapterModule && path.resolve(agent.adapterModule).toLowerCase() === path.resolve(commandAdapterModule).toLowerCase()) {
          return commandAdapter;
        }
      }

      const agentAdapterModule = getOptionalText(agent.adapterModule);
      if (!agentAdapterModule) {
        return null;
      }

      return adapterCache.get(agentAdapterModule) || null;
    }
  };
}

async function buildRunnerRuntimeOptions(args, runtimeOptions = buildSharedRuntimeOptions(args)) {
  const options = {
    ...runtimeOptions,
    context: runtimeOptions.context ? { ...runtimeOptions.context } : runtimeOptions.context,
    memory: runtimeOptions.memory ? { ...runtimeOptions.memory } : runtimeOptions.memory
  };

  const adapter = await loadCliAdapterModule(getOptionalText(args.adapterModule), 'adapterModule');
  if (adapter) {
    options.adapter = adapter;
  }

  const ruleProvider = await loadCliRuleProviderModule(getOptionalText(args.ruleProviderModule), 'ruleProviderModule');
  if (ruleProvider) {
    options.ruleProvider = ruleProvider;
  }

  const checkpointSink = await loadCliCheckpointSinkModule(getOptionalText(args.checkpointSinkModule), 'checkpointSinkModule');
  if (checkpointSink) {
    options.checkpointSink = checkpointSink;
  }

  const verifier = await loadCliVerifierModule(getOptionalText(args.verifierModule), 'verifierModule');
  if (verifier) {
    options.verifier = verifier;
  }

  applyRunnerTimeoutRuntimeOptions(args, options);

  const workflowId = getOptionalText(args.workflowId);
  if (workflowId) {
    options.workflowId = workflowId;
  }

  const runnerId = getOptionalText(args.runnerId);
  if (runnerId) {
    options.runnerId = runnerId;
  }

  const taskId = getOptionalText(args.taskId);
  if (taskId) {
    options.taskId = taskId;
  }

  const ownerAgentId = getOptionalText(args.ownerAgentId);
  if (ownerAgentId) {
    options.ownerAgentId = ownerAgentId;
  }

  const preferredRole = getOptionalText(args.requiredRole) || getOptionalText(args.preferredRole);
  if (preferredRole) {
    options.preferredRole = preferredRole;
  }

  const assignmentStatus = getOptionalText(args.assignmentStatus);
  if (assignmentStatus) {
    options.assignmentStatus = assignmentStatus;
  }

  const agentIdentity = await resolveCliAgentIdentity({
    dbPath: runtimeOptions.dbPath,
    task: null,
    agentId: getOptionalText(args.agentId),
    ownerAgentId,
    leaseOwner: runnerId
  });
  if (agentIdentity) {
    options.agentIdentity = agentIdentity;
  }

  const leaseMs = getOptionalNumber(args.leaseMs, 'leaseMs');
  if (leaseMs != null) {
    options.leaseMs = leaseMs;
  }

  return options;
}

function applyRunnerTimeoutRuntimeOptions(args, options) {
  const maxTaskRetries = getOptionalNumber(args.maxTaskRetries, 'maxTaskRetries');
  if (maxTaskRetries != null) {
    options.maxTaskRetries = maxTaskRetries;
  }

  const taskExecutionTimeoutMs = getOptionalNumber(args.taskExecutionTimeoutMs, 'taskExecutionTimeoutMs');
  if (taskExecutionTimeoutMs != null) {
    options.taskExecutionTimeoutMs = taskExecutionTimeoutMs;
  }

  const timeoutSweepMaxExecutionMs = getOptionalNumber(args.timeoutSweepMaxExecutionMs, 'timeoutSweepMaxExecutionMs');
  if (timeoutSweepMaxExecutionMs != null) {
    options.timeoutSweepMaxExecutionMs = timeoutSweepMaxExecutionMs;
  }

  const timeoutSweepStalledMs = getOptionalNumber(args.timeoutSweepStalledMs, 'timeoutSweepStalledMs');
  if (timeoutSweepStalledMs != null) {
    options.timeoutSweepStalledMs = timeoutSweepStalledMs;
  }

  const timeoutSweepMaxAttempts = getOptionalNumber(args.timeoutSweepMaxAttempts, 'timeoutSweepMaxAttempts');
  if (timeoutSweepMaxAttempts != null) {
    options.timeoutSweepMaxAttempts = timeoutSweepMaxAttempts;
  }

  const timeoutSweepIntervalMs = getOptionalNumber(args.timeoutSweepIntervalMs, 'timeoutSweepIntervalMs');
  if (timeoutSweepIntervalMs != null) {
    options.timeoutSweepIntervalMs = timeoutSweepIntervalMs;
  }

  const timeoutSweepReason = getOptionalText(args.timeoutSweepReason);
  if (timeoutSweepReason) {
    options.timeoutSweepReason = timeoutSweepReason;
  }

  return options;
}

function buildSharedRuntimeOptions(args) {
  const requestedWorkspacePath = getOptionalText(args.workspacePath) || process.cwd();
  const dbTarget = resolveDbTarget({
    dbPath: getOptionalText(args.dbPath) || undefined,
    dbProfile: getOptionalText(args.dbProfile) || getOptionalText(args.profile) || undefined,
    workspacePath: requestedWorkspacePath
  });
  const baseOptions = {
    dbPath: dbTarget.dbPath,
    dbPathSource: dbTarget.dbPathSource,
    dbScopeLabel: dbTarget.dbScopeLabel,
    dbProfile: dbTarget.dbProfile,
    workspacePath: dbTarget.workspacePath,
    workspaceKey: dbTarget.workspaceKey
  };

  return {
    ...baseOptions,
    context: resolveContextIntegrationContext({
      ...baseOptions,
      context: baseOptions
    }),
    memory: resolveMemoryIntegrationContext({
      ...baseOptions,
      memory: baseOptions
    })
  };
}

function buildCoordinatorStateInput(args) {
  const includeTestData = getOptionalBoolean(args.includeTestData, 'includeTestData');
  const includeHistory = getOptionalBoolean(args.includeHistory, 'includeHistory');

  return {
    ...(getOptionalText(args.workflowId) ? { workflowId: getOptionalText(args.workflowId) } : {}),
    ...(getOptionalText(args.chainId) ? { chainId: getOptionalText(args.chainId) } : {}),
    ...(getOptionalText(args.taskId) ? { taskId: getOptionalText(args.taskId) } : {}),
    ...(getOptionalText(args.stageId) ? { stageId: getOptionalText(args.stageId) } : {}),
    ...(includeTestData == null ? {} : { includeTestData }),
    ...(includeHistory == null ? {} : { includeHistory }),
    agentQuery: buildAgentQuery(args),
    assignmentQuery: buildAssignmentQuery(args),
    handoffQuery: buildHandoffQuery(args),
    chainQuery: buildChainStateQuery(args)
  };
}

function buildCoordinatorAssignmentInput(args) {
  const targetType = getOptionalText(args.targetType);

  return {
    ...(targetType ? { targetType } : {}),
    ...(getOptionalText(args.workflowId) ? { workflowId: getOptionalText(args.workflowId) } : {}),
    ...(getOptionalText(args.chainId) ? { chainId: getOptionalText(args.chainId) } : {}),
    ...(getOptionalText(args.taskId) ? { taskId: getOptionalText(args.taskId) } : {}),
    ...(getOptionalText(args.stageId) ? { stageId: getOptionalText(args.stageId) } : {}),
    ...(getOptionalText(args.agentId) ? { agentId: getOptionalText(args.agentId) } : {}),
    ...(getOptionalText(args.reason) ? { reason: getOptionalText(args.reason) } : {})
  };
}

function buildCoordinatorExecutionInput(args) {
  const assignmentInput = buildCoordinatorAssignmentInput(args);
  const assignmentId = getOptionalText(args.assignmentId);
  const maxStages = getOptionalNumber(args.maxStages, 'maxStages');
  const maxWorkflowSteps = getOptionalNumber(args.maxWorkflowSteps, 'maxWorkflowSteps');

  return {
    ...(assignmentId ? { assignmentId } : {}),
    ...assignmentInput,
    ...(maxStages == null ? {} : { maxStages }),
    ...(maxWorkflowSteps == null ? {} : { maxWorkflowSteps })
  };
}

function buildCoordinatorResumeInput(args) {
  const targetType = getOptionalText(args.targetType);
  const mode = getOptionalText(args.mode);
  const runNow = getOptionalBoolean(args.runNow, 'runNow');
  const maxStages = getOptionalNumber(args.maxStages, 'maxStages');
  const maxWorkflowSteps = getOptionalNumber(args.maxWorkflowSteps, 'maxWorkflowSteps');

  return {
    ...(getOptionalText(args.assignmentId) ? { assignmentId: getOptionalText(args.assignmentId) } : {}),
    ...(targetType ? { targetType } : {}),
    ...(getOptionalText(args.workflowId) ? { workflowId: getOptionalText(args.workflowId) } : {}),
    ...(getOptionalText(args.chainId) ? { chainId: getOptionalText(args.chainId) } : {}),
    ...(getOptionalText(args.taskId) ? { taskId: getOptionalText(args.taskId) } : {}),
    ...(getOptionalText(args.stageId) ? { stageId: getOptionalText(args.stageId) } : {}),
    ...(getOptionalText(args.agentId) ? { agentId: getOptionalText(args.agentId) } : {}),
    ...(mode ? { mode } : {}),
    ...(runNow == null ? {} : { runNow }),
    ...(getOptionalText(args.message) ? { message: getOptionalText(args.message) } : {}),
    ...(args.payload == null ? {} : { payload: getOptionalObject(args.payload, 'payload') }),
    ...(getOptionalText(args.reason) ? { reason: getOptionalText(args.reason) } : {}),
    ...(maxStages == null ? {} : { maxStages }),
    ...(maxWorkflowSteps == null ? {} : { maxWorkflowSteps })
  };
}

function buildAgentQuery(args) {
  const role = getOptionalText(args.role);
  const status = getOptionalText(args.status);
  const limit = getOptionalNumber(args.limit, 'limit');

  return {
    ...(role ? { role } : {}),
    ...(status ? { status } : {}),
    ...(limit == null ? {} : { limit })
  };
}

function buildAssignmentQuery(args) {
  const targetType = getOptionalText(args.assignmentTargetType) || getOptionalText(args.targetType) || inferTargetTypeFromArgs(args);
  const targetId = getOptionalText(args.assignmentTargetId) || getOptionalText(args.targetId) || inferTargetIdFromArgs(args, targetType);
  const status = getOptionalText(args.assignmentStatus);
  const agentId = getOptionalText(args.assignmentAgentId) || getOptionalText(args.agentId);
  const workflowId = getOptionalText(args.assignmentWorkflowId) || getOptionalText(args.workflowId);
  const chainId = getOptionalText(args.assignmentChainId) || getOptionalText(args.chainId);
  const stageId = getOptionalText(args.assignmentStageId) || getOptionalText(args.stageId);
  const limit = getOptionalNumber(args.assignmentLimit, 'assignmentLimit') ?? getOptionalNumber(args.limit, 'limit');

  return {
    ...(targetType ? { targetType } : {}),
    ...(targetId ? { targetId } : {}),
    ...(workflowId ? { workflowId } : {}),
    ...(chainId ? { chainId } : {}),
    ...(stageId ? { stageId } : {}),
    ...(agentId ? { agentId } : {}),
    ...(status ? { status } : {}),
    ...(limit == null ? {} : { limit })
  };
}

function buildHandoffQuery(args) {
  const sourceType = getOptionalText(args.sourceType) || inferTargetTypeFromArgs(args);
  const sourceId = getOptionalText(args.sourceId) || inferTargetIdFromArgs(args, sourceType);
  const workflowId = getOptionalText(args.handoffWorkflowId) || getOptionalText(args.workflowId);
  const chainId = getOptionalText(args.handoffChainId) || getOptionalText(args.chainId);
  const stageId = getOptionalText(args.handoffStageId) || getOptionalText(args.stageId);
  const toAgentId = getOptionalText(args.toAgentId);
  const fromAgentId = getOptionalText(args.fromAgentId);
  const status = getOptionalText(args.handoffStatus);
  const limit = getOptionalNumber(args.handoffLimit, 'handoffLimit') ?? getOptionalNumber(args.limit, 'limit');

  return {
    ...(sourceType ? { sourceType } : {}),
    ...(sourceId ? { sourceId } : {}),
    ...(workflowId ? { workflowId } : {}),
    ...(chainId ? { chainId } : {}),
    ...(stageId ? { stageId } : {}),
    ...(toAgentId ? { toAgentId } : {}),
    ...(fromAgentId ? { fromAgentId } : {}),
    ...(status ? { status } : {}),
    ...(limit == null ? {} : { limit })
  };
}

function inferTargetTypeFromArgs(args) {
  if (getOptionalText(args.stageId)) {
    return 'stage';
  }

  if (getOptionalText(args.taskId)) {
    return 'task';
  }

  return null;
}

function inferTargetIdFromArgs(args, targetType) {
  if (targetType === 'stage') {
    return getOptionalText(args.stageId);
  }

  if (targetType === 'task') {
    return getOptionalText(args.taskId);
  }

  return null;
}

async function loadCliModuleValue(modulePath, label) {
  const normalizedModulePath = getOptionalText(modulePath);
  if (!normalizedModulePath) {
    return undefined;
  }

  const resolvedPath = path.resolve(normalizedModulePath);
  const cwd = process.cwd();

  if (!resolvedPath.startsWith(cwd + path.sep) && resolvedPath !== cwd) {
    throw new Error(`${label} path must be within the current working directory.`);
  }

  try {
    await fs.access(resolvedPath);
  } catch {
    throw new Error(`${label} not found: ${resolvedPath}`);
  }

  const imported = await import(pathToFileURL(resolvedPath).href);
  return imported?.default ?? imported;
}

async function loadCliAdapterModule(modulePath, label) {
  const value = await loadCliModuleValue(modulePath, label);
  if (value === undefined) {
    return undefined;
  }

  if (value && typeof value === 'object' && typeof value.run === 'function') {
    return value;
  }

  if (typeof value === 'function') {
    return value;
  }

  throw new Error(`${label} must export a function or an object with a run() method.`);
}

async function loadCliTaskSourceModule(modulePath, label) {
  const value = await loadCliModuleValue(modulePath, label);
  if (value === undefined) {
    return undefined;
  }

  if (value && typeof value === 'object' && typeof value.load === 'function') {
    return value;
  }

  if (typeof value === 'function') {
    return value;
  }

  throw new Error(`${label} must export a function or an object with a load() method.`);
}

async function loadCliRuleProviderModule(modulePath, label) {
  const value = await loadCliModuleValue(modulePath, label);
  if (value === undefined) {
    return undefined;
  }

  if (value && typeof value === 'object' && typeof value.getRules === 'function') {
    return value;
  }

  if (typeof value === 'function') {
    return value;
  }

  throw new Error(`${label} must export a function or an object with a getRules() method.`);
}

async function loadCliCheckpointSinkModule(modulePath, label) {
  const value = await loadCliModuleValue(modulePath, label);
  if (value === undefined) {
    return undefined;
  }

  if (value && typeof value === 'object' && typeof value.write === 'function') {
    return value;
  }

  if (typeof value === 'function') {
    return value;
  }

  throw new Error(`${label} must export a function or an object with a write() method.`);
}

async function loadCliVerifierModule(modulePath, label) {
  const value = await loadCliModuleValue(modulePath, label);
  if (value === undefined) {
    return undefined;
  }

  if (value && typeof value === 'object' && typeof value.run === 'function') {
    return value;
  }

  if (typeof value === 'function') {
    return value;
  }

  throw new Error(`${label} must export a function or an object with a run() method.`);
}

async function loadStructuredInput(flags) {
  const inputFile = flags.inputFile != null ? String(flags.inputFile) : null;
  const inputStdin = getOptionalBoolean(flags.inputStdin, 'inputStdin') === true;

  if (flags.input != null && (inputFile != null || inputStdin)) {
    throw new Error('Use only one structured input source: --input, --input-file, or --input-stdin.');
  }

  if (inputFile != null && inputStdin) {
    throw new Error('Use either --input-file or --input-stdin, not both.');
  }

  if (flags.input != null) {
    return parseJsonObject(String(flags.input), 'input');
  }

  if (inputFile === '-') {
    const content = await readStdinText();
    return parseJsonObject(content, 'stdin input');
  }

  if (inputFile != null) {
    const content = await fs.readFile(inputFile, 'utf8');
    return parseJsonObject(content, 'input file');
  }

  if (inputStdin) {
    const content = await readStdinText();
    return parseJsonObject(content, 'stdin input');
  }

  return {};
}

async function readStdinText() {
  const chunks = [];

  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
  }

  return chunks.join('');
}

function parseCliArgs(argv) {
  const args = [...argv];
  const command = String(args.shift() || '').trim();
  const flags = {};

  while (args.length > 0) {
    const token = args.shift();
    if (!token.startsWith('--')) {
      throw new Error(`Unexpected positional argument: ${token}`);
    }

    const equalsIndex = token.indexOf('=');
    if (equalsIndex >= 0) {
      const rawKey = token.slice(2, equalsIndex);
      const rawValue = token.slice(equalsIndex + 1);
      flags[toCamelCase(rawKey)] = rawValue;
      continue;
    }

    const rawKey = token.slice(2);
    const next = args[0];
    if (!next || next.startsWith('--')) {
      flags[toCamelCase(rawKey)] = true;
      continue;
    }

    flags[toCamelCase(rawKey)] = args.shift();
  }

  return { command, flags };
}

function parseJsonObject(source, label) {
  let value;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new Error(`Failed to parse ${label} JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} JSON must be an object.`);
  }

  return value;
}

function writeJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function requireText(value, label) {
  const text = getOptionalText(value);
  if (!text) {
    throw new Error(`${label} is required.`);
  }
  return text;
}

function wantsCompactResponse(args) {
  return getOptionalBoolean(args.compact, 'compact') === true
    || getOptionalText(args.responseMode) === 'compact';
}

function getOptionalText(value) {
  if (value == null || value === false) {
    return null;
  }

  const text = String(value).trim();
  return text || null;
}

function getOptionalNumber(value, label) {
  if (value == null || value === false || value === '') {
    return undefined;
  }

  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new Error(`${label} must be a number.`);
  }

  return number;
}

function getOptionalBoolean(value, label) {
  if (value == null || value === '') {
    return undefined;
  }

  if (typeof value === 'boolean') {
    return value;
  }

  if (value === 1 || value === '1' || value === 'true') {
    return true;
  }

  if (value === 0 || value === '0' || value === 'false') {
    return false;
  }

  throw new Error(`${label} must be a boolean.`);
}

function getRequiredArray(value, label) {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array.`);
  }

  return value;
}

function getOptionalArray(value, label) {
  if (value == null) {
    return undefined;
  }

  if (Array.isArray(value)) {
    return value;
  }

  if (typeof value === 'string') {
    let parsed;
    try {
      parsed = JSON.parse(value);
    } catch (error) {
      throw new Error(`Failed to parse ${label} JSON: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (!Array.isArray(parsed)) {
      throw new Error(`${label} must be an array.`);
    }

    return parsed;
  }

  throw new Error(`${label} must be an array.`);
}

function getOptionalObject(value, label) {
  if (value == null) {
    return undefined;
  }

  if (typeof value === 'string') {
    return parseJsonObject(value, label);
  }

  if (typeof value === 'object' && !Array.isArray(value)) {
    return value;
  }

  throw new Error(`${label} must be an object.`);
}

function toCamelCase(value) {
  return String(value).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
}

