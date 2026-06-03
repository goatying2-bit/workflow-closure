import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.dirname(__dirname);
const contractPath = path.join(rootDir, 'agent-integration-contract.json');
const examplesPath = path.join(rootDir, 'cli-protocol-examples.json');

async function main() {
  const contract = JSON.parse(await fs.readFile(contractPath, 'utf8'));
  const examplesDocument = JSON.parse(await fs.readFile(examplesPath, 'utf8'));

  assert(contract.contractVersion === 'workflow-closure-agent-contract/v1', 'contractVersion should match v1');
  assert(contract.protocolVersion === 'workflow-closure-cli/v1', 'protocolVersion should match CLI v1');
  assert(contract.generatedBy === 'scripts/generate-agent-integration-contract.js', 'generatedBy should point to the contract generator');

  assert(contract.primaryLoop && typeof contract.primaryLoop === 'object', 'primaryLoop should exist');
  assert(Array.isArray(contract.primaryLoop.steps) && contract.primaryLoop.steps.length >= 6, 'primaryLoop should define the expected loop steps');

  const stepByAction = new Map(contract.primaryLoop.steps.map((step) => [step.action, step]));
  assertStepCommands(stepByAction.get('create_or_load_workflow'), ['create-workflow', 'get-workflow-state']);
  assertStepCommands(stepByAction.get('claim_ready_task'), ['claim-next-ready-task']);
  assertStepCommands(stepByAction.get('write_task_result'), ['complete-task', 'block-task']);
  assertStepCommands(stepByAction.get('recover_blocked_workflow'), ['get-workflow-state', 'resume-task', 'claim-next-ready-task']);
  assertStepCommands(stepByAction.get('maintain_or_recover_lease'), ['heartbeat-task-lease', 'release-expired-leases']);

  assert(contract.coordinatorLoop && typeof contract.coordinatorLoop === 'object', 'coordinatorLoop should exist');
  assert(Array.isArray(contract.coordinatorLoop.steps) && contract.coordinatorLoop.steps.length >= 4, 'coordinatorLoop should define the expected loop steps');

  const coordinatorStepByAction = new Map(contract.coordinatorLoop.steps.map((step) => [step.action, step]));
  assertStepCommands(coordinatorStepByAction.get('register_agent'), ['register-agent', 'get-coordinator-state']);
  assertStepCommands(coordinatorStepByAction.get('assign_or_run_ready_work'), ['assign-next-work', 'run-next-assignment']);
  assertStepCommands(coordinatorStepByAction.get('resume_blocked_assignment'), ['get-coordinator-state', 'resume-assigned-work', 'run-next-assignment']);

  assert(Array.isArray(contract.commandRouting?.claim_next_ready_task), 'commandRouting.claim_next_ready_task should exist');
  assert(contract.commandRouting.claim_next_ready_task.includes('claim-next-ready-task'), 'claim routing should include claim-next-ready-task');
  assert(Array.isArray(contract.commandRouting?.execute_claimed_task), 'commandRouting.execute_claimed_task should exist');
  assert(contract.commandRouting.execute_claimed_task.includes('complete-task'), 'execute routing should include complete-task');
  assert(contract.commandRouting.execute_claimed_task.includes('block-task'), 'execute routing should include block-task');
  assert(Array.isArray(contract.commandRouting?.resume_task), 'commandRouting.resume_task should exist');
  assert(contract.commandRouting.resume_task.includes('resume-task'), 'resume routing should include resume-task');
  assert(Array.isArray(contract.commandRouting?.register_agent), 'commandRouting.register_agent should exist');
  assert(contract.commandRouting.register_agent.includes('register-agent'), 'coordinator routing should include register-agent');
  assert(Array.isArray(contract.commandRouting?.assign_next_work), 'commandRouting.assign_next_work should exist');
  assert(contract.commandRouting.assign_next_work.includes('run-next-assignment'), 'coordinator routing should include run-next-assignment');
  assert(Array.isArray(contract.commandRouting?.resume_assigned_work), 'commandRouting.resume_assigned_work should exist');
  assert(contract.commandRouting.resume_assigned_work.includes('resume-assigned-work'), 'coordinator resume routing should include resume-assigned-work');

  assert(contract.statusSemantics?.claimNextReadyTask?.claimed, 'statusSemantics should describe claimed status');
  assert(contract.statusSemantics?.claimNextReadyTask?.idle, 'statusSemantics should describe idle status');
  assert(contract.statusSemantics?.releaseExpiredLeases?.released, 'statusSemantics should describe released status');
  assert(contract.statusSemantics?.runNextAssignment?.done, 'statusSemantics should describe coordinator done status');
  assert(contract.statusSemantics?.runNextAssignment?.blocked, 'statusSemantics should describe coordinator blocked status');
  assert(contract.statusSemantics?.resumeAssignedWork?.done, 'statusSemantics should describe coordinator resume completion');

  assert(Array.isArray(contract.decisionRules) && contract.decisionRules.length >= 10, 'decisionRules should exist');
  assert(contract.decisionRules.some((rule) => rule.condition === 'response.nextAction === "resume_task"'), 'decisionRules should cover resume_task branching');
  assert(contract.decisionRules.some((rule) => rule.condition === 'response.status === "idle"'), 'decisionRules should cover idle branching');
  assert(contract.decisionRules.some((rule) => rule.condition === 'response.nextAction === "resume_assigned_work"'), 'decisionRules should cover coordinator resume branching');
  assert(contract.decisionRules.some((rule) => rule.condition === 'response.command === "run-next-assignment" && response.status === "blocked"'), 'decisionRules should cover blocked coordinator execution');

  assert(Array.isArray(contract.requiredFields?.allResponses), 'requiredFields.allResponses should exist');
  assert(contract.requiredFields.allResponses.includes('protocolVersion'), 'allResponses should require protocolVersion');
  assert(contract.requiredFields.allResponses.includes('allowedNextCommands'), 'allResponses should require allowedNextCommands');
  assert(Array.isArray(contract.requiredFields?.claimedTaskResponses), 'requiredFields.claimedTaskResponses should exist');
  assert(contract.requiredFields.claimedTaskResponses.includes('prompt'), 'claimedTaskResponses should require prompt');
  assert(contract.requiredFields.claimedTaskResponses.includes('leaseExpiresAt'), 'claimedTaskResponses should require leaseExpiresAt');
  assert(Array.isArray(contract.requiredFields?.coordinatorStateResponses), 'requiredFields.coordinatorStateResponses should exist');
  assert(contract.requiredFields.coordinatorStateResponses.includes('assignments'), 'coordinatorStateResponses should require assignments');
  assert(Array.isArray(contract.requiredFields?.coordinatorExecutionResponses), 'requiredFields.coordinatorExecutionResponses should exist');
  assert(contract.requiredFields.coordinatorExecutionResponses.includes('assignment'), 'coordinatorExecutionResponses should require assignment');
  assert(contract.requiredFields.coordinatorExecutionResponses.includes('target'), 'coordinatorExecutionResponses should require target');

  const exampleNames = Array.isArray(contract.exampleReferences?.exampleNames) ? contract.exampleReferences.exampleNames : [];
  const sourceExamples = Array.isArray(examplesDocument.examples) ? examplesDocument.examples : [];
  assert(contract.exampleReferences?.protocolExamplesFile === 'cli-protocol-examples.json', 'exampleReferences should point to cli-protocol-examples.json');
  assert(exampleNames.length === sourceExamples.length, 'exampleNames should stay aligned with the protocol examples');
  assert(exampleNames.includes('heartbeat-task-lease.failure'), 'exampleNames should include the lease failure example');
  assert(exampleNames.includes('get-workflow-state.done'), 'exampleNames should include the completed workflow example');
  assert(exampleNames.includes('run-next-assignment.done'), 'exampleNames should include the coordinator happy-path example');
  assert(exampleNames.includes('run-next-assignment.blocked'), 'exampleNames should include the coordinator blocked example');
  assert(exampleNames.includes('run-next-assignment.idle-no-agent'), 'exampleNames should include the coordinator no-agent idle example');
  assert(exampleNames.includes('resume-assigned-work.done'), 'exampleNames should include the coordinator resume example');

  const examplesByCommand = contract.examplesByCommand || {};
  assert(Array.isArray(examplesByCommand['claim-next-ready-task']) && examplesByCommand['claim-next-ready-task'].length >= 2, 'examplesByCommand should group claim-next-ready-task examples');
  assert(Array.isArray(examplesByCommand['get-workflow-state']) && examplesByCommand['get-workflow-state'].length >= 3, 'examplesByCommand should group get-workflow-state examples');
  assert(Array.isArray(examplesByCommand['resume-task']) && examplesByCommand['resume-task'].length === 1, 'examplesByCommand should group the resume-task example');
  assert(Array.isArray(examplesByCommand['run-next-assignment']) && examplesByCommand['run-next-assignment'].length >= 3, 'examplesByCommand should group coordinator execution examples');
  assert(Array.isArray(examplesByCommand['resume-assigned-work']) && examplesByCommand['resume-assigned-work'].length >= 1, 'examplesByCommand should group coordinator resume examples');

  const claimedExample = examplesByCommand['claim-next-ready-task'].find((example) => example.response?.status === 'claimed');
  assert(claimedExample, 'claim-next-ready-task examples should include a claimed response');
  assert(claimedExample.response.nextAction === 'execute_claimed_task', 'claimed example should recommend execute_claimed_task');
  assert(claimedExample.response.allowedNextCommands.includes('complete-task'), 'claimed example should allow complete-task');

  const releasedLeaseExample = examplesByCommand['release-expired-leases']?.[0];
  assert(releasedLeaseExample?.response?.status === 'released', 'release-expired-leases example should report released');

  const heartbeatFailureExample = examplesByCommand['heartbeat-task-lease']?.find((example) => example.name === 'heartbeat-task-lease.failure');
  assert(heartbeatFailureExample, 'heartbeat-task-lease examples should include the failure case');
  assert(heartbeatFailureExample.exitCode !== 0, 'heartbeat failure example should keep a non-zero exit code');

  const coordinatorDoneExample = examplesByCommand['run-next-assignment']?.find((example) => example.name === 'run-next-assignment.done');
  assert(coordinatorDoneExample?.response?.status === 'done', 'run-next-assignment should include a done example');
  assert(coordinatorDoneExample.response.allowedNextCommands.includes('run-next-assignment'), 'done coordinator example should keep execution available');
  assert(coordinatorDoneExample.response.assignment?.status === 'completed', 'done coordinator example should include a completed assignment');

  const coordinatorBlockedExample = examplesByCommand['run-next-assignment']?.find((example) => example.name === 'run-next-assignment.blocked');
  assert(coordinatorBlockedExample?.response?.status === 'blocked', 'run-next-assignment should include a blocked example');
  assert(coordinatorBlockedExample.response.nextAction === 'resume_assigned_work', 'blocked coordinator example should recommend resume_assigned_work');
  assert(coordinatorBlockedExample.response.allowedNextCommands.includes('resume-assigned-work'), 'blocked coordinator example should allow resume-assigned-work');

  const coordinatorIdleExample = examplesByCommand['run-next-assignment']?.find((example) => example.name === 'run-next-assignment.idle-no-agent');
  assert(coordinatorIdleExample?.response?.status === 'idle', 'run-next-assignment should include an idle example');
  assert(coordinatorIdleExample.response.reason === 'no_available_agent', 'idle coordinator example should report no_available_agent');
  assert(coordinatorIdleExample.response.nextAction === 'register_agent', 'idle coordinator example should recommend registering an agent');

  const coordinatorResumeExample = examplesByCommand['resume-assigned-work']?.find((example) => example.name === 'resume-assigned-work.done');
  assert(coordinatorResumeExample?.response?.status === 'done', 'resume-assigned-work should include a done example');
  assert(coordinatorResumeExample.response.assignment?.status === 'completed', 'resume coordinator example should include a completed assignment');

  console.log('agent integration contract smoke test passed');
  console.log(JSON.stringify({
    contractVersion: contract.contractVersion,
    protocolVersion: contract.protocolVersion,
    loopStepCount: contract.primaryLoop.steps.length,
    coordinatorLoopStepCount: contract.coordinatorLoop.steps.length,
    decisionRuleCount: contract.decisionRules.length,
    exampleCount: sourceExamples.length,
    commandsCovered: Object.keys(examplesByCommand).length
  }, null, 2));
}

function assertStepCommands(step, expectedCommands) {
  assert(step && typeof step === 'object', `loop step should exist for ${expectedCommands.join(', ')}`);
  assert(Array.isArray(step.commands), `loop step commands should exist for ${expectedCommands.join(', ')}`);
  for (const command of expectedCommands) {
    assert(step.commands.includes(command), `loop step should include ${command}`);
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
