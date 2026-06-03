import { draftCodingPlan } from './coding-planner.js';
import { resolveTaskSource } from './task-source.js';
import { mergeWorkflowHygieneMetadata } from '../storage/data-hygiene.js';
import { getWorkflowStore, initializeWorkflowStore } from '../storage/workflows.js';

const RESEARCH_KEYWORDS = ['research', 'investigate', 'analysis', 'analyze', '调研', '研究', '分析', '排查'];
const FIX_KEYWORDS = ['fix', 'bug', 'error', 'issue', 'repair', '修复', '报错', '异常', '故障'];
const REFACTOR_KEYWORDS = ['refactor', 'cleanup', 'restructure', '重构', '整理', '收敛'];
const FEATURE_KEYWORDS = ['add', 'implement', 'build', 'create', 'support', '新增', '实现', '添加', '开发', '搭建'];
const CLOSURE_MODES = new Set(['small_loop', 'large_loop']);
const VERIFICATION_LEVELS = new Set(['targeted', 'broad']);
const DOC_POLICIES = new Set(['minimal', 'required']);
const CLEANUP_POLICIES = new Set(['defer', 'explicit_only']);

export async function createWorkflowEngine(options = {}) {
  await initializeWorkflowStore(options);
  const store = getWorkflowStore(options);

  return {
    draftInitialPlan(instruction) {
      return draftInitialPlan(instruction);
    },
    draftCodingPlan(input) {
      return draftCodingPlan(input);
    },
    createWorkflowFromInstruction(input) {
      return createWorkflowFromInstruction(input, { store });
    },
    createWorkflowFromTaskSource(input) {
      return createWorkflowFromTaskSource(input, { store });
    },
    createWorkflowDefinition(input) {
      return createWorkflowDefinition(input, { store });
    },
    getWorkflowDefinition(input) {
      return getWorkflowDefinition(input, { store });
    },
    listWorkflowDefinitions(input = {}) {
      return listWorkflowDefinitions(input, { store });
    },
    createWorkflowFromDefinition(input) {
      return createWorkflowFromDefinition(input, { store });
    },
    addTask(input) {
      return addTask(input, { store });
    },
    addTasksFromPlan(input) {
      return addTasksFromPlan(input, { store });
    },
    linkDependency(input) {
      return linkDependency(input, { store });
    },
    advanceTaskStatus(input) {
      return advanceTaskStatus(input, { store });
    },
    addRunLog(input) {
      return store.addRunLog(input);
    },
    listWorkflows(input = {}) {
      return listWorkflows(input, { store });
    },
    listWorkflowReruns(input) {
      return listWorkflowReruns(input, { store });
    },
    listTaskRevisions(input) {
      return listTaskRevisions(input, { store });
    },
    addTaskOutput(input) {
      return addTaskOutput(input, { store });
    },
    listTaskOutputs(input) {
      return listTaskOutputs(input, { store });
    },
    listPredecessorTaskOutputs(input) {
      return listPredecessorTaskOutputs(input, { store });
    },
    listDescendantTaskIds(input) {
      return listDescendantTaskIds(input, { store });
    },
    restartFromTask(input) {
      return restartFromTask(input, { store });
    },
    claimNextReadyTask(input) {
      return claimNextReadyTask(input, { store });
    },
    peekNextReadyTask(input) {
      return peekNextReadyTask(input, { store });
    },
    recoverSession(input) {
      return recoverSession(input, { store });
    },
    heartbeatTaskLease(input) {
      return heartbeatTaskLease(input, { store });
    },
    releaseExpiredTaskLeases(input) {
      return releaseExpiredTaskLeases(input, { store });
    },
    sweepTimedOutTasks(input) {
      return sweepTimedOutTasks(input, { store });
    },
    getNextTask(input) {
      return getNextTask(input, { store });
    },
    getWorkflowState(input) {
      return getWorkflowState(input, { store });
    }
  };
}

export function draftInitialPlan(input) {
  const normalized = normalizeInstructionInput(input);
  const category = detectInstructionCategory(normalized.instruction);
  const goal = normalized.goal || createGoalFromInstruction(normalized.instruction, category);
  const template = buildTemplate(category, goal);

  return {
    goal,
    category,
    instruction: normalized.instruction,
    steps: template.steps.map((step, index) => ({
      key: step.key || `step-${index + 1}`,
      title: step.title,
      description: step.description,
      sequence: index,
      type: step.type || category
    })),
    dependencies: template.dependencies,
    assumptions: template.assumptions,
    risks: template.risks,
    metadata: normalizePlanMetadata()
  };
}

export function createWorkflowFromInstruction(input, context = {}) {
  const store = requireStore(context);
  const normalized = normalizeInstructionInput(input);
  const plan = normalizePlan(input?.plan || draftInitialPlan(normalized));
  assertNoCyclicPlanDependencies(plan);

  const workflow = store.createWorkflow({
    workflowId: input?.workflowId,
    goal: plan.goal,
    instruction: normalized.instruction,
    initialPlan: plan,
    status: 'draft',
    concurrencyLimit: input?.concurrencyLimit
  });

  store.addRunLog({
    workflowId: workflow.workflowId,
    action: 'workflow_created',
    message: 'Created workflow from instruction.',
    payload: {
      goal: plan.goal,
      category: plan.category
    }
  });

  store.addRunLog({
    workflowId: workflow.workflowId,
    action: 'initial_plan_drafted',
    message: 'Drafted initial plan from instruction.',
    payload: plan
  });

  const applied = addTasksFromPlan({
    workflowId: workflow.workflowId,
    plan
  }, { store });

  store.addRunLog({
    workflowId: workflow.workflowId,
    action: 'initial_plan_applied',
    message: `Applied initial plan as ${applied.tasks.length} tasks and ${applied.dependencies.length} dependencies.`,
    payload: {
      taskCount: applied.tasks.length,
      dependencyCount: applied.dependencies.length
    }
  });

  return store.getWorkflowState(workflow.workflowId);
}

export async function createWorkflowFromTaskSource(input, context = {}) {
  const store = requireStore(context);
  const taskSource = resolveTaskSource(input?.taskSource);

  const sourceResult = await taskSource.load(input);
  const plan = normalizePlan(mergeInputWorkflowHygieneMetadata(
    sourceResult.plan || draftInitialPlan({
      instruction: sourceResult.instruction,
      goal: sourceResult.goal
    }),
    input
  ));
  assertNoCyclicPlanDependencies(plan);

  const workflow = store.createWorkflow({
    workflowId: sourceResult.workflowId || input?.workflowId,
    goal: sourceResult.goal || plan.goal,
    instruction: sourceResult.instruction,
    initialPlan: plan,
    status: 'draft',
    concurrencyLimit: sourceResult.concurrencyLimit ?? input?.concurrencyLimit
  });

  store.addRunLog({
    workflowId: workflow.workflowId,
    action: 'workflow_created',
    message: 'Created workflow from task source.',
    payload: {
      goal: sourceResult.goal || plan.goal,
      taskSource: sourceResult.metadata?.taskSource || null
    }
  });

  store.addRunLog({
    workflowId: workflow.workflowId,
    action: 'task_source_loaded',
    message: 'Loaded workflow input from task source.',
    payload: sourceResult
  });

  const applied = addTasksFromPlan({
    workflowId: workflow.workflowId,
    plan
  }, { store });

  store.addRunLog({
    workflowId: workflow.workflowId,
    action: 'initial_plan_applied',
    message: `Applied task source plan as ${applied.tasks.length} tasks and ${applied.dependencies.length} dependencies.`,
    payload: {
      taskCount: applied.tasks.length,
      dependencyCount: applied.dependencies.length,
      taskSource: sourceResult.metadata?.taskSource || null
    }
  });

  return {
    ...store.getWorkflowState(workflow.workflowId),
    sourceResult
  };
}

export function createWorkflowDefinition(input, context = {}) {
  const store = requireStore(context);
  return store.createWorkflowDefinition(normalizeWorkflowDefinitionInput(input, store));
}

export function getWorkflowDefinition(input, context = {}) {
  const store = requireStore(context);
  const definitionId = normalizeWorkflowDefinitionId(input);
  const definition = store.getWorkflowDefinition(definitionId);

  if (!definition) {
    throw new Error(`Workflow definition not found: ${definitionId}`);
  }

  return definition;
}

export function listWorkflowDefinitions(input = {}, context = {}) {
  const store = requireStore(context);
  return store.listWorkflowDefinitions({
    search: normalizeOptionalText(input.search),
    sourceWorkflowId: normalizeOptionalText(input.sourceWorkflowId),
    limit: input.limit
  });
}

export function createWorkflowFromDefinition(input, context = {}) {
  const store = requireStore(context);
  const created = store.createWorkflowFromDefinition({
    definitionId: normalizeWorkflowDefinitionId(input),
    workflowId: normalizeOptionalText(input?.workflowId),
    goal: normalizeOptionalText(input?.goal),
    instruction: normalizeOptionalText(input?.instruction),
    concurrencyLimit: input?.concurrencyLimit,
    status: normalizeOptionalText(input?.status)
  });
  const plan = normalizePlan(created.definition.plan);
  assertNoCyclicPlanDependencies(plan);

  store.addRunLog({
    workflowId: created.workflow.workflowId,
    action: 'workflow_created',
    message: 'Created workflow from definition.',
    payload: {
      definitionId: created.definition.definitionId,
      definitionName: created.definition.name,
      goal: created.workflow.goal
    }
  });

  const applied = addTasksFromPlan({
    workflowId: created.workflow.workflowId,
    plan
  }, { store });

  store.addRunLog({
    workflowId: created.workflow.workflowId,
    action: 'workflow_definition_applied',
    message: `Applied workflow definition "${created.definition.name}" as ${applied.tasks.length} tasks and ${applied.dependencies.length} dependencies.`,
    payload: {
      definitionId: created.definition.definitionId,
      definitionName: created.definition.name,
      taskCount: applied.tasks.length,
      dependencyCount: applied.dependencies.length
    }
  });

  return {
    ...store.getWorkflowState(created.workflow.workflowId),
    definition: created.definition
  };
}
export function addTask(input, context = {}) {
  const store = requireStore(context);
  return store.addTask(normalizeTaskInput(input));
}

export function addTasksFromPlan(input, context = {}) {
  const store = requireStore(context);
  const workflowId = normalizeWorkflowId(input);
  const plan = normalizePlan(input?.plan);
  const tasks = [];
  const createdDependencies = [];
  const taskIdByRef = new Map();

  for (let index = 0; index < plan.steps.length; index += 1) {
    const step = plan.steps[index];
    const created = store.addTask({
      workflowId,
      title: step.title,
      description: step.description || null,
      sequence: Number.isInteger(step.sequence) ? step.sequence : index,
      planTaskKey: step.key || `step-${index + 1}`,
      status: step.status || 'pending',
      preferredRole: step.preferredRole || inferPreferredRoleFromStepType(step.type),
      requiredCapabilities: step.requiredCapabilities,
      ownerAgentId: step.ownerAgentId,
      assignmentStatus: step.assignmentStatus,
      assignmentReason: step.assignmentReason,
      handoff: step.handoff,
      contract: step.contract
    });

    const refs = new Set([
      step.key || `step-${index + 1}`,
      String(index),
      String(index + 1)
    ]);

    for (const ref of refs) {
      taskIdByRef.set(ref, created.taskId);
    }

    tasks.push(created);
  }

  const normalizedDependencies = normalizePlanDependencies(plan.dependencies, taskIdByRef);
  assertNoCyclicTaskDependencies(normalizedDependencies);

  for (const dependency of normalizedDependencies) {
    createdDependencies.push(store.addDependency({
      workflowId,
      predecessorTaskId: dependency.predecessorTaskId,
      successorTaskId: dependency.successorTaskId,
      condition: dependency.condition
    }));
  }

  return {
    workflow: store.getWorkflow(workflowId),
    tasks,
    dependencies: createdDependencies,
    nextTask: store.getNextTask(workflowId)
  };
}


export function linkDependency(input, context = {}) {
  const store = requireStore(context);
  const workflowId = normalizeWorkflowId(input);

  return store.addDependency({
    workflowId,
    predecessorTaskId: String(input.predecessorTaskId || input.fromTaskId || '').trim(),
    successorTaskId: String(input.successorTaskId || input.toTaskId || '').trim(),
    condition: input.condition
  });
}

export function advanceTaskStatus(input, context = {}) {
  const store = requireStore(context);
  const workflowId = normalizeWorkflowId(input);

  return store.advanceTaskStatus({
    workflowId,
    taskId: String(input.taskId || '').trim(),
    status: String(input.status || '').trim(),
    blockedReason: input.blockedReason,
    doneSummary: input.doneSummary,
    action: input.action,
    message: input.message,
    payload: input.payload,
    leaseOwner: input.leaseOwner,
    leaseExpiresAt: input.leaseExpiresAt,
    attemptCount: input.attemptCount,
    lastError: input.lastError,
    reasonCode: input.reasonCode,
    recovery: input.recovery,
    ownerAgentId: input.ownerAgentId,
    preferredRole: input.preferredRole,
    requiredCapabilities: input.requiredCapabilities,
    assignmentStatus: input.assignmentStatus,
    assignmentReason: input.assignmentReason,
    handoff: input.handoff,
    contract: input.contract,
    expectedLeaseOwner: input.expectedLeaseOwner,
    taskOutputs: input.taskOutputs
  });
}

export function listWorkflows(input = {}, context = {}) {
  const store = requireStore(context);
  return store.listWorkflows({
    status: input.status,
    activeOnly: input.activeOnly,
    limit: input.limit,
    includeTestData: input.includeTestData,
    includeArchived: input.includeArchived,
    dataClass: input.dataClass
  });
}

export function listWorkflowReruns(input, context = {}) {
  const store = requireStore(context);
  const workflowId = normalizeWorkflowId(input);
  return store.listWorkflowReruns(workflowId, input?.query || {});
}

export function listTaskRevisions(input, context = {}) {
  const store = requireStore(context);
  return store.listTaskRevisions({
    workflowId: normalizeWorkflowId(input),
    taskId: input.taskId,
    rerunId: input.rerunId,
    limit: input.limit
  });
}

export function addTaskOutput(input, context = {}) {
  const store = requireStore(context);
  return store.addTaskOutput({
    workflowId: normalizeWorkflowId(input),
    taskId: input.taskId,
    kind: input.kind,
    name: input.name,
    content: input.content,
    path: input.path,
    workspacePath: input.workspacePath,
    metadata: input.metadata,
    createdAt: input.createdAt
  });
}

export function listTaskOutputs(input, context = {}) {
  const store = requireStore(context);
  return store.listTaskOutputs({
    workflowId: normalizeWorkflowId(input),
    taskId: input.taskId,
    kind: input.kind,
    name: input.name,
    limit: input.limit
  });
}

export function listPredecessorTaskOutputs(input, context = {}) {
  const store = requireStore(context);
  const workflowId = normalizeWorkflowId(input);
  const taskId = String(input.taskId || '').trim();
  if (!taskId) {
    throw new Error('Task id is required.');
  }

  const limitPerTask = Number.isInteger(input.limitPerTask) && input.limitPerTask > 0 ? input.limitPerTask : undefined;
  const state = store.getWorkflowState(workflowId);
  const tasksById = new Map((state.tasks || []).map((task) => [task.taskId, task]));
  const rawItems = (state.dependencies || [])
    .filter((dependency) => dependency.successorTaskId === taskId)
    .flatMap((dependency) => {
      const predecessor = tasksById.get(dependency.predecessorTaskId);
      const outputs = store.listTaskOutputs({
        workflowId,
        taskId: dependency.predecessorTaskId,
        kind: input.kind,
        name: input.name,
        limit: limitPerTask
      });

      return outputs.map((output) => ({
        predecessorTaskId: dependency.predecessorTaskId,
        predecessorTitle: predecessor?.title || dependency.predecessorTaskId,
        output
      }));
    });

  const filtered = store.filterTaskOutputsByTrust({
    outputs: rawItems.map((item) => item.output),
    trustStates: input.trustStates,
    includeUnverified: input.includeUnverified
  });
  const allowedOutputIds = new Set(filtered.outputs.map((output) => output.outputId));
  const items = rawItems.filter((item) => allowedOutputIds.has(item.output.outputId));

  if (input.includeFilterSummary) {
    Object.defineProperty(items, 'filteredOutputCount', {
      value: filtered.filteredCount,
      enumerable: false
    });
  }

  return items;
}

export function listDescendantTaskIds(input, context = {}) {
  const store = requireStore(context);
  return store.listDescendantTaskIds({
    workflowId: normalizeWorkflowId(input),
    taskId: String(input.taskId || '').trim()
  });
}

export function restartFromTask(input, context = {}) {
  const store = requireStore(context);
  return store.restartFromTask({
    workflowId: normalizeWorkflowId(input),
    taskId: String(input.taskId || '').trim(),
    reason: input.reason,
    fingerprint: input.fingerprint,
    payload: input.payload,
    operator: input.operator,
    maxSameFingerprintReruns: input.maxSameFingerprintReruns
  });
}

export function claimNextReadyTask(input = {}, context = {}) {
  const store = requireStore(context);
  return store.claimNextReadyTask({
    workflowId: input.workflowId,
    taskId: input.taskId,
    leaseOwner: input.leaseOwner,
    leaseMs: input.leaseMs,
    now: input.now,
    reason: input.reason,
    ownerAgentId: input.ownerAgentId,
    preferredRole: normalizeTaskRole(input),
    assignmentStatus: input.assignmentStatus,
    skipExpiredLeaseSweep: input.skipExpiredLeaseSweep
  });
}

export function peekNextReadyTask(input = {}, context = {}) {
  const store = requireStore(context);
  return store.peekNextReadyTask({
    workflowId: input.workflowId,
    taskId: input.taskId,
    ownerAgentId: input.ownerAgentId,
    preferredRole: normalizeTaskRole(input),
    assignmentStatus: input.assignmentStatus
  });
}

export function recoverSession(input = {}, context = {}) {
  const store = requireStore(context);
  return store.recoverSession({
    workflowId: input.workflowId,
    leaseOwner: input.leaseOwner,
    leaseMs: input.leaseMs,
    now: input.now,
    reason: input.reason,
    ownerAgentId: input.ownerAgentId,
    preferredRole: normalizeTaskRole(input),
    assignmentStatus: input.assignmentStatus
  });
}

export function heartbeatTaskLease(input, context = {}) {
  const store = requireStore(context);
  return store.heartbeatTaskLease({
    workflowId: normalizeWorkflowId(input),
    taskId: String(input.taskId || '').trim(),
    leaseOwner: input.leaseOwner,
    leaseMs: input.leaseMs
  });
}

export function releaseExpiredTaskLeases(input = {}, context = {}) {
  const store = requireStore(context);
  return store.releaseExpiredTaskLeases({
    workflowId: input.workflowId,
    now: input.now,
    reason: input.reason
  });
}

export function sweepTimedOutTasks(input = {}, context = {}) {
  const store = requireStore(context);
  return store.sweepTimedOutTasks({
    workflowId: input.workflowId,
    now: input.now,
    maxExecutionMs: input.maxExecutionMs,
    stalledMs: input.stalledMs,
    maxAttempts: input.maxAttempts,
    reason: input.reason
  });
}

export function getNextTask(input, context = {}) {
  const store = requireStore(context);
  return store.getNextTask(normalizeWorkflowId(input));
}

export function getWorkflowState(input, context = {}) {
  const store = requireStore(context);
  const workflowId = normalizeWorkflowId(input);
  return store.getWorkflowState(workflowId, input?.query || {});
}

function buildTemplate(category, goal) {
  switch (category) {
    case 'research':
      return {
        steps: [
          createStep('step-1', '确认调研范围', `明确“${goal}”的对象、边界和输出要求。`, 'scoping'),
          createStep('step-2', '收集现状信息', `查找与“${goal}”直接相关的代码、数据或上下文。`, 'research'),
          createStep('step-3', '整理发现与假设', `把关键发现、当前假设和未确认点整理成可执行结论。`, 'synthesis'),
          createStep('step-4', '输出下一步建议', `基于调研结果给出后续执行建议、优先级和风险。`, 'handoff')
        ],
        dependencies: chainDependencies(4),
        assumptions: [
          '已有足够上下文可以支撑首轮调研。',
          '调研结果需要转成后续可执行动作。'
        ],
        risks: [
          '上下文缺失会导致结论不完整。',
          '目标范围不清会让调研结果过宽或过浅。'
        ]
      };
    case 'fix':
      return {
        steps: [
          createStep('step-1', '复现并界定问题', `确认“${goal}”的触发条件、影响范围和期望行为。`, 'reproduce'),
          createStep('step-2', '定位根因', `检查代码路径、状态流或数据链路，找到导致问题的直接原因。`, 'diagnose'),
          createStep('step-3', '实施最小修复', `以最小改动修复“${goal}”相关问题。`, 'implement'),
          createStep('step-4', '验证修复结果', `确认问题已消失且没有引入明显回归。`, 'verify'),
          createStep('step-5', '记录修复结论', `总结根因、修复点和仍需关注的风险。`, 'handoff')
        ],
        dependencies: chainDependencies(5),
        assumptions: [
          '问题可以通过当前代码或数据定位。',
          '修复目标是聚焦当前缺陷，不扩散到额外重构。'
        ],
        risks: [
          '无法稳定复现会拖慢根因定位。',
          '问题可能跨多个模块，单点修复不足。'
        ]
      };
    case 'refactor':
      return {
        steps: [
          createStep('step-1', '梳理现有结构', `识别“${goal}”当前实现的边界、耦合点和重复逻辑。`, 'analysis'),
          createStep('step-2', '确定最小重构切片', `选定一组最小但完整的改动范围，避免重构扩散。`, 'planning'),
          createStep('step-3', '执行重构', `在保持行为不变的前提下调整结构与职责分配。`, 'implement'),
          createStep('step-4', '验证行为一致性', `检查重构后行为是否保持一致，确认没有功能回退。`, 'verify'),
          createStep('step-5', '沉淀结构结论', `记录新的结构约束、收益和后续可继续收敛的点。`, 'handoff')
        ],
        dependencies: chainDependencies(5),
        assumptions: [
          '重构优先保持现有行为，不引入新特性。',
          '可以从最小可验证切片开始，而不是一次性大改。'
        ],
        risks: [
          '边界判断失误会扩大改动面。',
          '缺少验证会让重构结果难以确认。'
        ]
      };
    case 'feature':
    default:
      return {
        steps: [
          createStep('step-1', '确认目标与约束', `明确“${goal}”的交付结果、输入输出和限制条件。`, 'scoping'),
          createStep('step-2', '检查接入点', `定位实现“${goal}”所需修改的主要模块和依赖关系。`, 'analysis'),
          createStep('step-3', '实现最小可用版本', `完成“${goal}”的首个可执行版本。`, 'implement'),
          createStep('step-4', '做针对性验证', `验证主要流程、边界情况和关键状态变化。`, 'verify'),
          createStep('step-5', '整理交付说明', `总结已完成内容、未覆盖风险和后续可扩展点。`, 'handoff')
        ],
        dependencies: chainDependencies(5),
        assumptions: [
          '目标可以先落成一个最小可用版本。',
          '后续增强建立在首版可运行闭环之上。'
        ],
        risks: [
          '需求边界不清会影响实现切分。',
          '实现路径可能受现有约束或依赖阻塞。'
        ]
      };
  }
}

function detectInstructionCategory(instruction) {
  const text = instruction.toLowerCase();

  if (matchesAny(text, RESEARCH_KEYWORDS)) {
    return 'research';
  }

  if (matchesAny(text, FIX_KEYWORDS)) {
    return 'fix';
  }

  if (matchesAny(text, REFACTOR_KEYWORDS)) {
    return 'refactor';
  }

  if (matchesAny(text, FEATURE_KEYWORDS)) {
    return 'feature';
  }

  return 'feature';
}

function matchesAny(text, keywords) {
  return keywords.some((keyword) => text.includes(keyword));
}

function createGoalFromInstruction(instruction, category) {
  const trimmed = instruction.trim();
  if (!trimmed) {
    throw new Error('Instruction is required.');
  }

  const prefixByCategory = {
    research: '完成调研任务',
    fix: '完成问题修复',
    refactor: '完成重构任务',
    feature: '完成目标实现'
  };

  const compact = trimmed.replace(/\s+/g, ' ');
  return compact.length <= 80 ? compact : `${prefixByCategory[category]}：${compact.slice(0, 72)}...`;
}

function normalizeInstructionInput(input) {
  if (typeof input === 'string') {
    const instruction = input.trim();
    if (!instruction) {
      throw new Error('Instruction is required.');
    }

    return {
      instruction,
      goal: null
    };
  }

  if (!input || typeof input !== 'object') {
    throw new Error('Instruction input is required.');
  }

  const instruction = String(input.instruction || input.task || input.prompt || input.goal || '').trim();
  if (!instruction) {
    throw new Error('Instruction is required.');
  }

  return {
    instruction,
    goal: normalizeOptionalText(input.goal)
  };
}

function normalizeTaskInput(input) {
  if (!input || typeof input !== 'object') {
    throw new Error('Task input is required.');
  }

  return {
    workflowId: normalizeWorkflowId(input),
    taskId: normalizeOptionalText(input.taskId),
    title: String(input.title || '').trim(),
    description: input.description == null ? null : String(input.description),
    status: input.status,
    sequence: input.sequence,
    blockedReason: input.blockedReason,
    doneSummary: input.doneSummary,
    reasonCode: normalizeOptionalText(input.reasonCode),
    recovery: input.recovery,
    planTaskKey: input.planTaskKey,
    ownerAgentId: input.ownerAgentId,
    preferredRole: normalizeTaskRole(input),
    requiredCapabilities: normalizeOptionalStringArray(input.requiredCapabilities),
    assignmentStatus: input.assignmentStatus,
    assignmentReason: input.assignmentReason,
    handoff: input.handoff,
    contract: normalizeTaskContract(input.contract)
  };
}

function normalizeTaskRole(input = {}) {
  return normalizeOptionalText(input.requiredRole) || normalizeOptionalText(input.preferredRole);
}

function normalizeWorkflowId(input) {
  const workflowId = typeof input === 'string'
    ? input
    : input?.workflowId;

  const normalized = String(workflowId || '').trim();
  if (!normalized) {
    throw new Error('Workflow id is required.');
  }

  return normalized;
}

function normalizePlanMetadata(value) {
  if (value == null) {
    return {
      closureMode: 'small_loop',
      verificationLevel: 'targeted',
      docPolicy: 'minimal',
      cleanupPolicy: 'defer'
    };
  }

  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Plan metadata must be an object when provided.');
  }

  return {
    ...value,
    closureMode: normalizeClosureMode(value.closureMode),
    verificationLevel: normalizeVerificationLevel(value.verificationLevel),
    docPolicy: normalizeDocPolicy(value.docPolicy),
    cleanupPolicy: normalizeCleanupPolicy(value.cleanupPolicy)
  };
}

function normalizeClosureMode(value) {
  const normalized = normalizeOptionalText(value)?.toLowerCase();
  if (!normalized) {
    return 'small_loop';
  }
  if (!CLOSURE_MODES.has(normalized)) {
    throw new Error(`Unsupported closureMode: ${normalized}`);
  }
  return normalized;
}

function normalizeVerificationLevel(value) {
  const normalized = normalizeOptionalText(value)?.toLowerCase();
  if (!normalized) {
    return 'targeted';
  }
  if (!VERIFICATION_LEVELS.has(normalized)) {
    throw new Error(`Unsupported verificationLevel: ${normalized}`);
  }
  return normalized;
}

function normalizeDocPolicy(value) {
  const normalized = normalizeOptionalText(value)?.toLowerCase();
  if (!normalized) {
    return 'minimal';
  }
  if (!DOC_POLICIES.has(normalized)) {
    throw new Error(`Unsupported docPolicy: ${normalized}`);
  }
  return normalized;
}

function normalizeCleanupPolicy(value) {
  const normalized = normalizeOptionalText(value)?.toLowerCase();
  if (!normalized) {
    return 'defer';
  }
  if (!CLEANUP_POLICIES.has(normalized)) {
    throw new Error(`Unsupported cleanupPolicy: ${normalized}`);
  }
  return normalized;
}

function mergeInputWorkflowHygieneMetadata(plan, input = {}) {
  return input?.workflowHygieneMetadata
    ? mergeWorkflowHygieneMetadata(plan, input.workflowHygieneMetadata)
    : plan;
}

function normalizePlan(plan) {
  if (!plan || typeof plan !== 'object') {
    throw new Error('Plan is required.');
  }

  if (!Array.isArray(plan.steps) || plan.steps.length === 0) {
    throw new Error('Plan must contain at least one step.');
  }

  return {
    ...plan,
    metadata: normalizePlanMetadata(plan.metadata),
    steps: plan.steps.map((step, index) => ({
      key: step.key || `step-${index + 1}`,
      title: String(step.title || '').trim() || `步骤 ${index + 1}`,
      description: step.description == null ? null : String(step.description),
      sequence: Number.isInteger(step.sequence) ? step.sequence : index,
      status: step.status,
      type: step.type || 'task',
      ownerAgentId: normalizeOptionalText(step.ownerAgentId),
      preferredRole: normalizeTaskRole(step),
      requiredCapabilities: normalizeOptionalStringArray(step.requiredCapabilities),
      assignmentStatus: normalizeOptionalText(step.assignmentStatus),
      assignmentReason: normalizeOptionalText(step.assignmentReason),
      handoff: step.handoff ?? null,
      contract: normalizeTaskContract(step.contract)
    })),
    dependencies: Array.isArray(plan.dependencies) ? plan.dependencies : []
  };
}

function normalizePlanDependencies(dependencies, taskIdByRef) {
  return dependencies.filter((dependency) => dependency != null).map((dependency) => ({
    predecessorTaskId: resolveTaskReference(taskIdByRef, dependency.from ?? dependency.predecessor ?? dependency.source),
    successorTaskId: resolveTaskReference(taskIdByRef, dependency.to ?? dependency.successor ?? dependency.target),
    condition: dependency.condition ?? null
  }));
}

function assertNoCyclicPlanDependencies(plan) {
  const taskIdByRef = new Map();

  for (let index = 0; index < plan.steps.length; index += 1) {
    const step = plan.steps[index];
    const syntheticTaskId = step.key || `step-${index + 1}`;
    const refs = new Set([
      syntheticTaskId,
      String(index),
      String(index + 1)
    ]);

    for (const ref of refs) {
      taskIdByRef.set(ref, syntheticTaskId);
    }
  }

  assertNoCyclicTaskDependencies(normalizePlanDependencies(plan.dependencies, taskIdByRef));
}

function assertNoCyclicTaskDependencies(dependencies) {
  const successorsByTaskId = new Map();
  const taskIds = new Set();

  for (const dependency of dependencies) {
    const successorIds = successorsByTaskId.get(dependency.predecessorTaskId) || new Set();
    successorIds.add(dependency.successorTaskId);
    successorsByTaskId.set(dependency.predecessorTaskId, successorIds);
    taskIds.add(dependency.predecessorTaskId);
    taskIds.add(dependency.successorTaskId);
  }

  const visiting = new Set();
  const visited = new Set();
  const path = [];

  for (const taskId of taskIds) {
    visitTask(taskId);
  }

  function visitTask(taskId) {
    if (visited.has(taskId)) {
      return;
    }

    if (visiting.has(taskId)) {
      const cycleStartIndex = path.indexOf(taskId);
      const cyclePath = [...path.slice(cycleStartIndex), taskId];
      throw new Error(`Cyclic dependency detected: ${cyclePath.join(' -> ')}`);
    }

    visiting.add(taskId);
    path.push(taskId);

    for (const successorTaskId of successorsByTaskId.get(taskId) || []) {
      visitTask(successorTaskId);
    }

    path.pop();
    visiting.delete(taskId);
    visited.add(taskId);
  }
}

function resolveTaskReference(taskIdByRef, reference) {
  const normalized = String(reference || '').trim();
  if (!normalized) {
    throw new Error('Dependency reference is required.');
  }

  const taskId = taskIdByRef.get(normalized);
  if (!taskId) {
    throw new Error(`Unknown dependency reference: ${normalized}`);
  }

  return taskId;
}

function requireStore(context) {
  const store = context?.store;
  if (!store) {
    throw new Error('Workflow store is not available. Use createWorkflowEngine() first or pass a store context.');
  }

  return store;
}

function createStep(key, title, description, type) {
  return { key, title, description, type };
}

function chainDependencies(stepCount) {
  const dependencies = [];
  for (let index = 1; index < stepCount; index += 1) {
    dependencies.push({
      from: `step-${index}`,
      to: `step-${index + 1}`
    });
  }

  return dependencies;
}

function inferPreferredRoleFromStepType(type) {
  const normalized = normalizeOptionalText(type)?.toLowerCase();
  if (!normalized) {
    return null;
  }

  if (['research', 'analysis', 'diagnose', 'synthesis', 'scoping', 'reproduce', 'planning'].includes(normalized)) {
    return 'researcher';
  }

  if (normalized === 'implement') {
    return 'implementer';
  }

  if (normalized === 'verify') {
    return 'reviewer';
  }

  if (normalized === 'handoff') {
    return 'coordinator';
  }

  return null;
}

function normalizeWorkflowDefinitionInput(input, store) {
  if (!input || typeof input !== 'object') {
    throw new Error('Workflow definition input is required.');
  }

  const normalized = normalizeInstructionInput(input);
  const plan = normalizePlan(input.plan || draftInitialPlan(normalized));
  assertNoCyclicPlanDependencies(plan);

  return {
    definitionId: normalizeOptionalText(input.definitionId),
    name: normalizeRequiredText(input.name, 'Workflow definition name is required.'),
    description: normalizeOptionalText(input.description),
    goal: normalizeRequiredText(input.goal || plan.goal, 'Workflow definition goal is required.'),
    instruction: normalized.instruction,
    plan,
    metadata: normalizeOptionalObject(input.metadata, 'Workflow definition metadata must be an object when provided.'),
    concurrencyLimit: input.concurrencyLimit,
    sourceWorkflowId: normalizeExistingWorkflowId(store, input.sourceWorkflowId)
  };
}

function normalizeWorkflowDefinitionId(input) {
  const definitionId = typeof input === 'string'
    ? input
    : input?.definitionId;
  const normalized = normalizeOptionalText(definitionId);
  if (!normalized) {
    throw new Error('Workflow definition id is required.');
  }

  return normalized;
}

function normalizeRequiredText(value, message) {
  const text = normalizeOptionalText(value);
  if (!text) {
    throw new Error(message);
  }
  return text;
}

function normalizeOptionalObject(value, message) {
  if (value == null) {
    return null;
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(message);
  }

  return value;
}

function normalizeExistingWorkflowId(store, value) {
  const workflowId = normalizeOptionalText(value);
  if (!workflowId) {
    return null;
  }

  const workflow = store.getWorkflow(workflowId);
  if (!workflow) {
    throw new Error(`Workflow not found: ${workflowId}`);
  }

  return workflowId;
}

function normalizeTaskContract(value) {
  if (value == null) {
    return null;
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Task contract must be an object when provided.');
  }

  const contract = {
    successCriteria: normalizeOptionalStringArray(value.successCriteria) || [],
    requiredArtifacts: normalizeOptionalStringArray(value.requiredArtifacts) || [],
    forbiddenActions: normalizeOptionalStringArray(value.forbiddenActions) || [],
    assumptionsPolicy: normalizeTaskAssumptionsPolicy(value.assumptionsPolicy),
    validationCommands: normalizeValidationCommands(value.validationCommands),
    executionTimeoutMs: normalizeOptionalNumber(value.executionTimeoutMs),
    stalledTimeoutMs: normalizeOptionalNumber(value.stalledTimeoutMs),
    maxTimeoutAttempts: normalizeOptionalNumber(value.maxTimeoutAttempts),
    timeoutReason: normalizeOptionalText(value.timeoutReason)
  };

  return contract.successCriteria.length > 0
    || contract.requiredArtifacts.length > 0
    || contract.forbiddenActions.length > 0
    || contract.assumptionsPolicy
    || contract.validationCommands.length > 0
    || contract.executionTimeoutMs != null
    || contract.stalledTimeoutMs != null
    || contract.maxTimeoutAttempts != null
    || contract.timeoutReason
    ? contract
    : null;
}

function normalizeValidationCommands(value) {
  if (value == null) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new Error('validationCommands must be an array when provided.');
  }

  return value.map((item) => normalizeValidationCommand(item)).filter(Boolean);
}

function normalizeValidationCommand(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Validation command must be an object when provided.');
  }

  const command = normalizeOptionalText(value.command);
  const args = normalizeOptionalStringArray(value.args) || [];
  if (!command) {
    throw new Error('Validation command requires command.');
  }

  return {
    id: normalizeOptionalText(value.id),
    command,
    args,
    script: normalizeOptionalText(value.script),
    cwd: normalizeOptionalText(value.cwd),
    required: value.required !== false,
    timeoutMs: normalizeOptionalNumber(value.timeoutMs),
    reason: normalizeOptionalText(value.reason)
  };
}

function normalizeOptionalNumber(value) {
  if (value == null) {
    return null;
  }

  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new Error('Expected a non-negative number.');
  }

  return Math.floor(number);
}

function normalizeTaskAssumptionsPolicy(value) {
  const normalized = normalizeOptionalText(value);
  if (!normalized) {
    return null;
  }

  if (normalized !== 'block_on_missing_information' && normalized !== 'allow_reasonable_assumptions') {
    throw new Error(`Unsupported task assumptions policy: ${normalized}`);
  }

  return normalized;
}

function normalizeOptionalStringArray(value) {
  if (value == null) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new Error('requiredCapabilities must be an array when provided.');
  }

  return value
    .map((item) => normalizeOptionalText(item))
    .filter(Boolean);
}

function normalizeOptionalText(value) {
  if (value == null) {
    return null;
  }

  const text = String(value).trim();
  return text || null;
}
