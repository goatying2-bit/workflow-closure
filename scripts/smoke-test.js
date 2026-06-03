import {
  createWorkflowEngine,
  draftInitialPlan
} from '../core/workflow-engine.js';
import { closeDb } from '../storage/db.js';
import { markTestPlan, prepareTestDb } from './helpers/test-db.js';

const dbPath = await prepareTestDb('smoke-test');

async function main() {
  const engine = await createWorkflowEngine({ dbPath });

  const researchPlan = draftInitialPlan('调研当前工作流闭环工具的可复用结构');
  const fixPlan = draftInitialPlan('修复工作流推进时的状态同步问题');
  const featurePlan = draftInitialPlan('实现一个可给 agent 使用的工作流闭环工具');
  const refactorPlan = draftInitialPlan('重构工作流存储层以收敛状态更新逻辑');

  assertPlanShape(researchPlan, 'research');
  assertPlanShape(fixPlan, 'fix');
  assertPlanShape(featurePlan, 'feature');
  assertPlanShape(refactorPlan, 'refactor');

  const created = engine.createWorkflowFromInstruction({
    instruction: '实现一个可给 agent 使用的工作流闭环工具',
    plan: markTestPlan(draftInitialPlan('实现一个可给 agent 使用的工作流闭环工具'), 'smoke-test')
  });

  assert(created.workflow.goal, 'workflow goal should exist');
  assert(created.tasks.length >= 4, 'workflow should create tasks from the initial plan');
  assert(created.dependencies.length >= 3, 'workflow should create dependencies from the initial plan');
  assert(created.runLogs.length >= 3, 'workflow should record key run logs');
  assert(created.workflow.status === 'ready', 'workflow should become ready after initial plan is applied');

  const firstTask = engine.getNextTask({ workflowId: created.workflow.workflowId });
  assert(firstTask, 'first ready task should exist');

  const firstDoing = engine.advanceTaskStatus({
    workflowId: created.workflow.workflowId,
    taskId: firstTask.taskId,
    status: 'doing'
  });
  assert(firstDoing.workflow.status === 'doing', 'workflow should become doing when a task starts');

  const firstDone = engine.advanceTaskStatus({
    workflowId: created.workflow.workflowId,
    taskId: firstTask.taskId,
    status: 'done',
    doneSummary: '已完成第一步。'
  });
  assert(firstDone.task.status === 'done', 'first task should be marked done');
  assert(firstDone.nextTask, 'next task should unlock after first task is done');

  const secondTask = firstDone.nextTask;
  const blocked = engine.advanceTaskStatus({
    workflowId: created.workflow.workflowId,
    taskId: secondTask.taskId,
    status: 'blocked',
    blockedReason: '等待外部条件确认。'
  });
  assert(blocked.workflow.status === 'blocked', 'workflow should become blocked when no executable tasks remain');

  engine.advanceTaskStatus({
    workflowId: created.workflow.workflowId,
    taskId: secondTask.taskId,
    status: 'ready'
  });
  engine.advanceTaskStatus({
    workflowId: created.workflow.workflowId,
    taskId: secondTask.taskId,
    status: 'doing'
  });
  engine.advanceTaskStatus({
    workflowId: created.workflow.workflowId,
    taskId: secondTask.taskId,
    status: 'done',
    doneSummary: '第二步完成。'
  });

  let nextTask = engine.getNextTask({ workflowId: created.workflow.workflowId });
  while (nextTask) {
    engine.advanceTaskStatus({
      workflowId: created.workflow.workflowId,
      taskId: nextTask.taskId,
      status: 'doing'
    });

    engine.advanceTaskStatus({
      workflowId: created.workflow.workflowId,
      taskId: nextTask.taskId,
      status: 'done',
      doneSummary: `完成任务：${nextTask.title}`
    });

    nextTask = engine.getNextTask({ workflowId: created.workflow.workflowId });
  }

  const finalState = engine.getWorkflowState({ workflowId: created.workflow.workflowId });
  assert(finalState.workflow.status === 'done', 'workflow should be done after all tasks finish');
  assert(finalState.tasks.every((task) => task.status === 'done'), 'all tasks should be done');
  assert(finalState.runLogs.length >= 6, 'run logs should capture the workflow lifecycle');

  console.log('workflow-closure smoke test passed');
  console.log(JSON.stringify({
    workflowId: finalState.workflow.workflowId,
    taskCount: finalState.tasks.length,
    dependencyCount: finalState.dependencies.length,
    runLogCount: finalState.runLogs.length,
    finalStatus: finalState.workflow.status
  }, null, 2));
}

function assertPlanShape(plan, expectedCategory) {
  assert(plan.goal, `plan goal should exist for ${expectedCategory}`);
  assert(plan.category === expectedCategory, `plan category should be ${expectedCategory}`);
  assert(Array.isArray(plan.steps) && plan.steps.length >= 4, `plan steps should exist for ${expectedCategory}`);
  assert(Array.isArray(plan.dependencies) && plan.dependencies.length >= 3, `plan dependencies should exist for ${expectedCategory}`);
  assert(Array.isArray(plan.assumptions) && plan.assumptions.length >= 1, `plan assumptions should exist for ${expectedCategory}`);
  assert(Array.isArray(plan.risks) && plan.risks.length >= 1, `plan risks should exist for ${expectedCategory}`);
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
