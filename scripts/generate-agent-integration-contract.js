import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.dirname(__dirname);
const examplesPath = path.join(rootDir, 'cli-protocol-examples.json');
const outputPath = path.join(rootDir, 'agent-integration-contract.json');

async function main() {
  const examples = JSON.parse(await fs.readFile(examplesPath, 'utf8'));
  const contract = buildContract(examples);
  await fs.writeFile(outputPath, `${JSON.stringify(contract, null, 2)}\n`, 'utf8');
  process.stdout.write(`${outputPath}\n`);
}

function buildContract(examplesDocument) {
  const examples = Array.isArray(examplesDocument?.examples) ? examplesDocument.examples : [];

  return {
    contractVersion: 'workflow-closure-agent-contract/v1',
    protocolVersion: examplesDocument?.protocolVersion || 'workflow-closure-cli/v1',
    generatedBy: 'scripts/generate-agent-integration-contract.js',
    primaryLoop: {
      description: 'A broad agent should claim a task, execute only that task, then complete it or block it. If the workflow becomes blocked, inspect state and resume the blocked task before reclaiming.',
      steps: [
        {
          action: 'create_or_load_workflow',
          when: 'You are starting new work or resuming a known workflow.',
          commands: ['create-workflow', 'get-workflow-state'],
          notes: [
            'Use create-workflow to start from a natural-language instruction.',
            'Use get-workflow-state when you already have a workflowId.'
          ]
        },
        {
          action: 'inspect_next_action',
          when: 'After every successful command response.',
          sourceFields: ['nextAction', 'allowedNextCommands', 'summary.nextRecommendedCommand'],
          notes: [
            'Prefer nextAction for immediate branching.',
            'Use allowedNextCommands as the executable command whitelist.',
            'Use summary for a compact state check without scanning all tasks.'
          ]
        },
        {
          action: 'claim_ready_task',
          when: 'The workflow is ready and claiming is allowed.',
          commands: ['claim-next-ready-task'],
          expectedStatuses: ['claimed', 'idle'],
          notes: [
            'claimed means a task lease was acquired and prompt is available.',
            'idle means there is no globally ready task to claim right now.'
          ]
        },
        {
          action: 'execute_claimed_task',
          when: 'claim-next-ready-task returns status claimed.',
          inputFields: ['prompt', 'task', 'workflow', 'summary'],
          outputShapes: [
            '{ status: "done", doneSummary, payload? }',
            '{ status: "blocked", blockedReason, payload? }'
          ],
          notes: [
            'The agent should execute only the claimed task.',
            'The prompt already includes task title, description, attempt count, last error, predecessor summaries, and recent logs.'
          ]
        },
        {
          action: 'write_task_result',
          when: 'After task execution finishes.',
          commands: ['complete-task', 'block-task'],
          notes: [
            'Use complete-task for successful execution.',
            'Use block-task when the task cannot proceed without external input or a new decision.'
          ]
        },
        {
          action: 'recover_blocked_workflow',
          when: 'A workflow reports nextAction=resume_task or summary.hasBlockedTasks=true.',
          commands: ['get-workflow-state', 'resume-task', 'claim-next-ready-task'],
          notes: [
            'Inspect the blocked task, then call resume-task on that task once the blocker is cleared.',
            'After resume-task, reclaim the task with claim-next-ready-task.',
            'The reclaimed prompt preserves the previous lastError context.'
          ]
        },
        {
          action: 'maintain_or_recover_lease',
          when: 'A task remains in doing for long enough to need renewal or after a stale lease is suspected.',
          commands: ['heartbeat-task-lease', 'release-expired-leases'],
          notes: [
            'heartbeat-task-lease extends a valid lease held by the same leaseOwner.',
            'release-expired-leases moves expired doing tasks back to ready and records the release reason in lastError.'
          ]
        }
      ]
    },
    coordinatorLoop: {
      description: 'A coordinator-aware agent can register itself, let the coordinator assign ready work, execute that assignment immediately, and resume blocked assignments when recovery input becomes available.',
      steps: [
        {
          action: 'register_agent',
          when: 'Before coordinator-managed execution when no suitable agent is already active.',
          commands: ['register-agent', 'get-coordinator-state'],
          notes: [
            'register-agent persists role, capabilities, and adapterModule so later execution can resolve the runtime adapter safely.',
            'get-coordinator-state can verify whether the coordinator already has a ready target and available agents.'
          ]
        },
        {
          action: 'inspect_coordinator_next_action',
          when: 'After every successful coordinator command response.',
          sourceFields: ['nextAction', 'allowedNextCommands', 'summary.nextTargetType', 'summary.assignmentCountsByStatus'],
          notes: [
            'Use nextAction for the immediate branch between registration, assignment, execution, and resume.',
            'Use allowedNextCommands as the coordinator command whitelist.',
            'Use summary to distinguish ready work from blocked assignment history.'
          ]
        },
        {
          action: 'assign_or_run_ready_work',
          when: 'The coordinator reports ready task/stage work and execution is allowed.',
          commands: ['assign-next-work', 'run-next-assignment'],
          expectedStatuses: ['assigned', 'done', 'blocked', 'idle'],
          notes: [
            'assign-next-work prepares an assignment without executing it.',
            'run-next-assignment can both select the next target and execute it immediately in one step.',
            'idle with reason no_available_agent means registration is required; idle with reason no_ready_work means there is nothing runnable yet.'
          ]
        },
        {
          action: 'inspect_assignment_execution',
          when: 'run-next-assignment or resume-assigned-work returns.',
          inputFields: ['assignment', 'agent', 'target', 'workflow', 'stage', 'task', 'step', 'handoff', 'reason'],
          outputShapes: [
            '{ status: "done", assignment, agent, target, task?, stage?, step?, handoff? }',
            '{ status: "blocked", assignment, agent, target, task?, stage?, step?, reason? }',
            '{ status: "idle", reason, assignment: null, target? }'
          ],
          notes: [
            'task-oriented runs expose the executed task via task, step.task, and target; stage-oriented runs expose the stage and workflowResult.',
            'Coordinator execution responses also include the latest aggregate coordinator state so callers can continue without an extra query.'
          ]
        },
        {
          action: 'resume_blocked_assignment',
          when: 'The coordinator reports nextAction=resume_assigned_work or an execution result returns status blocked.',
          commands: ['get-coordinator-state', 'resume-assigned-work', 'run-next-assignment'],
          notes: [
            'Use resume-assigned-work to clear the blocked target with a message/payload and optionally run it immediately with runNow=true.',
            'The resumed prompt preserves both the previous lastError and an explicit resume hint.',
            'If reassignment is needed, resume-assigned-work can prepare or trigger a new assignment after the blocked target is reopened.'
          ]
        }
      ]
    },
    commandRouting: {
      create_workflow: ['create-workflow'],
      claim_next_ready_task: ['claim-next-ready-task'],
      execute_claimed_task: ['complete-task', 'block-task'],
      continue_claimed_task: ['heartbeat-task-lease', 'complete-task', 'block-task', 'get-workflow-state'],
      resume_task: ['get-workflow-state', 'resume-task'],
      inspect_workflow_state: ['get-workflow-state'],
      workflow_done: ['get-workflow-state', 'create-workflow'],
      register_agent: ['register-agent', 'get-coordinator-state'],
      assign_next_work: ['assign-next-work', 'run-next-assignment'],
      assignment_prepared: ['run-next-assignment', 'resume-assigned-work', 'get-coordinator-state'],
      resume_assigned_work: ['get-coordinator-state', 'resume-assigned-work', 'run-next-assignment'],
      inspect_coordinator_state: ['get-coordinator-state', 'assign-next-work', 'run-next-assignment', 'register-agent']
    },
    statusSemantics: {
      draftPlan: {
        ok: 'Initial plan drafted successfully.'
      },
      createWorkflow: {
        ok: 'Workflow created and initial tasks persisted.'
      },
      claimNextReadyTask: {
        claimed: 'A task was claimed and moved to doing.',
        idle: 'No ready task is currently claimable.'
      },
      heartbeatTaskLease: {
        renewed: 'The task lease was extended.'
      },
      updateCommands: {
        updated: 'The target task state was updated successfully.'
      },
      releaseExpiredLeases: {
        released: 'Expired leases were released and affected tasks were returned to ready.'
      },
      registerAgent: {
        ok: 'The coordinator stored an available agent profile and adapter reference.'
      },
      assignNextWork: {
        assigned: 'A coordinator assignment was prepared for a ready target.',
        idle: 'No assignment could be prepared because work is not ready or no suitable agent is available.'
      },
      runNextAssignment: {
        done: 'The coordinator executed the selected assignment successfully.',
        blocked: 'The coordinator executed the assignment and the target reported a blocker.',
        idle: 'The coordinator had nothing runnable or no suitable agent at execution time.'
      },
      resumeAssignedWork: {
        resumed: 'The blocked target was reopened without immediate execution.',
        reassigned: 'The blocked target was reopened and a replacement assignment was prepared.',
        done: 'The blocked assignment was resumed and completed when runNow=true.'
      }
    },
    decisionRules: [
      {
        condition: 'response.nextAction === "claim_next_ready_task"',
        do: 'Call claim-next-ready-task if it is present in allowedNextCommands.'
      },
      {
        condition: 'response.status === "claimed"',
        do: 'Execute the current task from response.prompt, then call complete-task or block-task.'
      },
      {
        condition: 'response.nextAction === "resume_task"',
        do: 'Read workflow state, identify the blocked task, then call resume-task before reclaiming.'
      },
      {
        condition: 'response.summary?.hasBlockedTasks === true',
        do: 'Prefer recovery flow instead of continuing to claim blindly.'
      },
      {
        condition: 'response.status === "idle"',
        do: 'Inspect workflow state or release expired leases; do not assume the workflow is done.'
      },
      {
        condition: 'response.summary?.nextRecommendedCommand === "workflow_done"',
        do: 'Treat the workflow as complete unless a fresh instruction starts a new workflow.'
      },
      {
        condition: 'response.nextAction === "register_agent"',
        do: 'Register an agent before retrying coordinator assignment or execution.'
      },
      {
        condition: 'response.nextAction === "assign_next_work" || response.nextAction === "assignment_prepared"',
        do: 'Use run-next-assignment when immediate coordinator-managed execution is desired.'
      },
      {
        condition: 'response.nextAction === "resume_assigned_work"',
        do: 'Use get-coordinator-state to inspect the blocked target, then call resume-assigned-work once recovery input is available.'
      },
      {
        condition: 'response.command === "run-next-assignment" && response.status === "blocked"',
        do: 'Preserve the blocked assignment context and route to resume-assigned-work instead of creating a fresh workflow task loop.'
      },
      {
        condition: 'response.command === "run-next-assignment" && response.status === "idle" && response.reason === "no_available_agent"',
        do: 'Register a coordinator agent rather than retrying the same execution call unchanged.'
      }
    ],
    requiredFields: {
      allResponses: ['protocolVersion', 'command', 'status', 'allowedNextCommands'],
      workflowStateResponses: ['workflow', 'tasks', 'dependencies', 'runLogs', 'summary'],
      claimedTaskResponses: ['task', 'prompt', 'leaseOwner', 'leaseExpiresAt'],
      coordinatorStateResponses: ['agents', 'assignments', 'handoffs', 'summary'],
      coordinatorExecutionResponses: ['assignment', 'agent', 'target', 'reason']
    },
    exampleReferences: {
      protocolExamplesFile: 'cli-protocol-examples.json',
      exampleNames: examples.map((example) => example.name)
    },
    examplesByCommand: indexExamplesByCommand(examples)
  };
}

function indexExamplesByCommand(examples) {
  const grouped = {};

  for (const example of examples) {
    if (!grouped[example.command]) {
      grouped[example.command] = [];
    }

    grouped[example.command].push({
      name: example.name,
      input: example.input,
      response: example.response,
      exitCode: example.exitCode,
      stderr: example.stderr
    });
  }

  return grouped;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
