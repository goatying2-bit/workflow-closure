import fs from 'node:fs/promises';
import {
  createAgentContextSystem,
  createAgentMemorySystem,
  createMultiAgentCoordinator,
  createVerifier
} from '../index.js';
import { closeDb } from '../storage/db.js';
import { markTestPlan, prepareTestDb } from './helpers/test-db.js';

const dbPath = await prepareTestDb('multi-agent-smoke-test');

async function main() {

  const memorySystem = await createAgentMemorySystem({ dbPath });
  const contextSystem = await createAgentContextSystem({ dbPath });
  const memoryOptions = {
    system: memorySystem,
    scope: 'workspace',
    projectKey: 'workflow-closure',
    workspacePath: 'C:/workspace/workflow-closure',
    sessionId: 'multi-agent-smoke-test',
    limit: 5
  };
  const contextOptions = {
    system: contextSystem,
    scope: 'workspace',
    projectKey: 'workflow-closure',
    workspacePath: 'C:/workspace/workflow-closure',
    sessionId: 'multi-agent-smoke-test',
    limit: 8
  };

  const coordinator = await createMultiAgentCoordinator({
    dbPath,
    workflowHygieneMetadata: {
      dataClass: 'test',
      retention: 'ephemeral',
      generatedBy: 'multi-agent-smoke-test'
    },
    memory: memoryOptions,
    context: contextOptions,
    verifier: createVerifier(async ({ workflow, task, result, state }) => ({
      status: 'passed',
      payload: {
        workflowId: workflow.workflowId,
        taskId: task.taskId,
        adapterStatus: result.status,
        taskCount: state.tasks.length
      }
    }))
  });

  const researcherPrompts = [];
  const implementerPrompts = [];
  const verifierPrompts = [];
  let blockOnce = true;

  const researcher = coordinator.registerAgent({
    agentId: 'researcher-1',
    name: 'Researcher',
    role: 'researcher',
    capabilities: ['research', 'handoff'],
    visibility: {
      tools: [
        {
          name: 'knowledge-base',
          purpose: '读取项目资料与背景信息',
          whenToUse: '需要调研历史方案或需求背景时使用',
          constraints: '只读，不修改外部数据源'
        }
      ],
      memory: {
        scope: 'workspace',
        projectKey: 'workflow-closure',
        workspacePath: 'C:/workspace/workflow-closure',
        sessionId: 'multi-agent-smoke-test',
        limit: 5
      },
      workspace: {
        cwd: 'C:/workspace/workflow-closure',
        writablePaths: ['C:/workspace/workflow-closure']
      }
    },
    adapter: async ({ task, prompt, executionContext, activeMemoryContext, contextItems }) => {
      researcherPrompts.push(prompt);
      return {
        status: 'done',
        doneSummary: `调研完成：${task.title}`,
        payload: {
          phase: 'research',
          promptHasIdentity: prompt.includes('当前 agent 身份：'),
          promptHasAssignment: prompt.includes('当前分配：'),
          promptHasHandoffSection: prompt.includes('交接信息：'),
          promptHasExecutionContext: prompt.includes('执行上下文：'),
          promptHasToolsContext: prompt.includes('默认可见工具:'),
          promptHasMemoryContext: prompt.includes('活跃记忆:'),
          promptHasWorkspaceContext: prompt.includes('工作区提示:'),
          contextHasExecutionTools: Array.isArray(contextItems) && contextItems.some((item) => item.kind === 'execution-tools'),
          contextHasExecutionMemory: Array.isArray(contextItems) && contextItems.some((item) => item.kind === 'execution-memory'),
          executionToolCount: Array.isArray(executionContext?.tools) ? executionContext.tools.length : 0,
          executionToolNames: Array.isArray(executionContext?.tools) ? executionContext.tools.map((tool) => tool?.name || null) : [],
          executionMemoryScope: executionContext?.memory?.scope || null,
          executionWorkspaceCwd: executionContext?.workspace?.cwd || null,
          activeMemoryEnabled: activeMemoryContext?.enabled === true,
          activeMemoryWorkspacePath: activeMemoryContext?.workspacePath || null,
          outputs: [
            {
              kind: 'result',
              name: 'research-notes',
              content: '# research notes',
              path: 'artifacts/research-notes.md',
              metadata: {
                source: 'researcher-fixture'
              }
            }
          ]
        },
        handoff: {
          summary: '已完成调研，整理出可执行方案。',
          artifacts: ['research-notes.md'],
          decisions: ['采用顺序 researcher -> implementer 流程'],
          openQuestions: ['实现阶段需要确认验收边界'],
          risks: ['如果没有交接，下游实现会缺少背景'],
          recommendedNextRole: 'implementer'
        }
      };
    }
  });

  const implementer = coordinator.registerAgent({
    agentId: 'implementer-1',
    name: 'Implementer',
    role: 'implementer',
    capabilities: ['implement', 'handoff'],
    visibility: {
      tools: [
        {
          name: 'editor',
          purpose: '修改工作流实现代码',
          whenToUse: '需要实现任务要求时使用',
          constraints: '仅修改当前 workspace'
        }
      ],
      memory: {
        scope: 'workspace',
        projectKey: 'workflow-closure',
        workspacePath: 'C:/workspace/workflow-closure',
        sessionId: 'multi-agent-smoke-test',
        limit: 5
      },
      workspace: {
        cwd: 'C:/workspace/workflow-closure',
        writablePaths: ['C:/workspace/workflow-closure']
      }
    },
    adapter: async ({ workflow, task, prompt, executionContext, activeMemoryContext, contextItems }) => {
      implementerPrompts.push(prompt);

      if (workflow.instruction.includes('需要阻塞恢复') && blockOnce) {
        return {
          status: 'blocked',
          blockedReason: `等待恢复：${task.title}`,
          payload: {
            phase: 'implement-blocked',
            promptHasIdentity: prompt.includes('当前 agent 身份：'),
            promptHasAssignment: prompt.includes('当前分配：'),
            promptHasResearchHandoff: prompt.includes('上游任务交接：') || prompt.includes('当前任务已有交接：'),
            promptHasExecutionContext: prompt.includes('执行上下文：'),
            promptHasToolsContext: prompt.includes('默认可见工具:'),
            promptHasMemoryContext: prompt.includes('活跃记忆:'),
            promptHasWorkspaceContext: prompt.includes('工作区提示:'),
            contextHasExecutionTools: Array.isArray(contextItems) && contextItems.some((item) => item.kind === 'execution-tools'),
            contextHasExecutionMemory: Array.isArray(contextItems) && contextItems.some((item) => item.kind === 'execution-memory'),
            executionToolCount: Array.isArray(executionContext?.tools) ? executionContext.tools.length : 0,
            executionToolNames: Array.isArray(executionContext?.tools) ? executionContext.tools.map((tool) => tool?.name || null) : [],
            executionMemoryScope: executionContext?.memory?.scope || null,
            executionWorkspaceCwd: executionContext?.workspace?.cwd || null,
            activeMemoryEnabled: activeMemoryContext?.enabled === true,
            activeMemoryWorkspacePath: activeMemoryContext?.workspacePath || null
          }
        };
      }

      return {
        status: 'done',
        doneSummary: `实现完成：${task.title}`,
        payload: {
          phase: 'implement-done',
          promptHasIdentity: prompt.includes('当前 agent 身份：'),
          promptHasAssignment: prompt.includes('当前分配：'),
          promptHasResearchHandoff: prompt.includes('上游任务交接：') || prompt.includes('当前任务已有交接：'),
          promptHasLastError: prompt.includes('最近错误: 等待恢复'),
          promptHasResumeHint: prompt.includes('恢复信息：'),
          promptHasExecutionContext: prompt.includes('执行上下文：'),
          promptHasToolsContext: prompt.includes('默认可见工具:'),
          promptHasMemoryContext: prompt.includes('活跃记忆:'),
          promptHasWorkspaceContext: prompt.includes('工作区提示:'),
          contextHasExecutionTools: Array.isArray(contextItems) && contextItems.some((item) => item.kind === 'execution-tools'),
          contextHasExecutionMemory: Array.isArray(contextItems) && contextItems.some((item) => item.kind === 'execution-memory'),
          executionToolCount: Array.isArray(executionContext?.tools) ? executionContext.tools.length : 0,
          executionToolNames: Array.isArray(executionContext?.tools) ? executionContext.tools.map((tool) => tool?.name || null) : [],
          executionMemoryScope: executionContext?.memory?.scope || null,
          executionWorkspaceCwd: executionContext?.workspace?.cwd || null,
          activeMemoryEnabled: activeMemoryContext?.enabled === true,
          activeMemoryWorkspacePath: activeMemoryContext?.workspacePath || null,
          outputs: [
            {
              kind: 'result',
              name: 'implementation-patch',
              content: 'diff --git a/file b/file',
              path: 'artifacts/implementation.patch',
              metadata: {
                source: 'implementer-fixture'
              }
            }
          ]
        },
        handoff: {
          summary: '实现已完成，可进入校验。',
          artifacts: ['implementation.patch'],
          decisions: ['保留结构化 handoff'],
          openQuestions: [],
          risks: ['需要 verifier 做最终确认'],
          recommendedNextRole: 'verifier'
        }
      };
    }
  });

  const verifier = coordinator.registerAgent({
    agentId: 'verifier-1',
    name: 'Verifier',
    role: 'verifier',
    capabilities: ['verify'],
    visibility: {
      tools: [
        {
          name: 'test-runner',
          purpose: '运行验证与回归检查',
          whenToUse: '需要验证实现结果时使用',
          constraints: '优先运行 smoke 覆盖'
        }
      ],
      memory: {
        scope: 'workspace',
        projectKey: 'workflow-closure',
        workspacePath: 'C:/workspace/workflow-closure',
        sessionId: 'multi-agent-smoke-test',
        limit: 5
      },
      workspace: {
        cwd: 'C:/workspace/workflow-closure',
        writablePaths: ['C:/workspace/workflow-closure']
      }
    },
    adapter: async ({ task, prompt, executionContext, activeMemoryContext, contextItems }) => {
      verifierPrompts.push(prompt);
      return {
        status: 'done',
        doneSummary: `验证完成：${task.title}`,
        payload: {
          phase: 'verify',
          promptHasIdentity: prompt.includes('当前 agent 身份：'),
          promptHasAssignment: prompt.includes('当前分配：'),
          promptHasImplementationHandoff: prompt.includes('上游任务交接：') || prompt.includes('当前任务已有交接：'),
          promptHasExecutionContext: prompt.includes('执行上下文：'),
          promptHasToolsContext: prompt.includes('默认可见工具:'),
          promptHasMemoryContext: prompt.includes('活跃记忆:'),
          promptHasWorkspaceContext: prompt.includes('工作区提示:'),
          contextHasExecutionTools: Array.isArray(contextItems) && contextItems.some((item) => item.kind === 'execution-tools'),
          contextHasExecutionMemory: Array.isArray(contextItems) && contextItems.some((item) => item.kind === 'execution-memory'),
          executionToolCount: Array.isArray(executionContext?.tools) ? executionContext.tools.length : 0,
          executionToolNames: Array.isArray(executionContext?.tools) ? executionContext.tools.map((tool) => tool?.name || null) : [],
          executionMemoryScope: executionContext?.memory?.scope || null,
          executionWorkspaceCwd: executionContext?.workspace?.cwd || null,
          activeMemoryEnabled: activeMemoryContext?.enabled === true,
          activeMemoryWorkspacePath: activeMemoryContext?.workspacePath || null
        }
      };
    }
  });

  const happyChain = coordinator.getCoordinatorState({
    assignmentQuery: { limit: 20 },
    handoffQuery: { limit: 20 }
  });
  assert(happyChain.assignments.length === 0, 'coordinator should start with no assignments');

  const chainRuntime = await createHappyPathChain(coordinator);
  const firstRun = await coordinator.runNextAssignment({ chainId: chainRuntime.chainId, maxStages: 1, maxWorkflowSteps: 20 });
  const firstWorkflowStep = getExecutedWorkflowStep(firstRun);
  assert(firstRun.status === 'done', 'first assignment should complete researcher stage');
  assert(firstRun.agent.agentId === researcher.agentId, 'researcher should handle the research stage');
  assert(firstRun.assignment.status === 'completed', 'research assignment should complete');
  assert(firstRun.handoff?.summary.includes('调研'), 'research stage should produce a handoff');
  assert(firstWorkflowStep?.executionContext?.tools?.length === 1, 'research step should expose execution tools');
  assert(firstWorkflowStep?.executionContext?.tools?.[0]?.name === 'knowledge-base', 'research step should expose the researcher tool name');
  assert(firstWorkflowStep?.executionContext?.memory?.scope === 'workspace', 'research step should expose workspace memory defaults');
  assert(firstWorkflowStep?.executionContext?.workspace?.cwd === 'C:/workspace/workflow-closure', 'research step should expose workspace cwd');
  assert(firstWorkflowStep?.activeMemoryContext?.enabled === true, 'research step should expose active memory context');
  assert(firstWorkflowStep?.activeMemoryContext?.workspacePath?.replaceAll('\\', '/').toLowerCase() === 'c:/workspace/workflow-closure', 'research step should expose active memory workspace path');
  assert(firstWorkflowStep?.adapterPayload?.promptHasExecutionContext === true, 'research payload should confirm execution context in prompt');
  assert(firstWorkflowStep?.adapterPayload?.promptHasToolsContext === true, 'research payload should confirm visible tools in prompt');
  assert(firstWorkflowStep?.adapterPayload?.promptHasMemoryContext === true, 'research payload should confirm memory context in prompt');
  assert(firstWorkflowStep?.adapterPayload?.promptHasWorkspaceContext === true, 'research payload should confirm workspace context in prompt');
  assert(firstWorkflowStep?.adapterPayload?.contextHasExecutionTools === true, 'research payload should confirm execution tool context item');
  assert(firstWorkflowStep?.adapterPayload?.contextHasExecutionMemory === true, 'research payload should confirm execution memory context item');
  assert(firstWorkflowStep?.adapterPayload?.executionToolCount === 1, 'research payload should expose one execution tool');
  assert(firstWorkflowStep?.adapterPayload?.executionToolNames?.includes('knowledge-base'), 'research payload should expose the researcher tool name');
  assert(firstWorkflowStep?.adapterPayload?.executionMemoryScope === 'workspace', 'research payload should expose workspace memory scope');
  assert(firstWorkflowStep?.adapterPayload?.executionWorkspaceCwd === 'C:/workspace/workflow-closure', 'research payload should expose workspace cwd');
  assert(firstWorkflowStep?.adapterPayload?.activeMemoryEnabled === true, 'research payload should enable active memory context');
  assert(firstWorkflowStep?.adapterPayload?.activeMemoryWorkspacePath?.replaceAll('\\', '/').toLowerCase() === 'c:/workspace/workflow-closure', 'research payload should expose active memory workspace path');
  assert(researcherPrompts.some((prompt) => prompt.includes('当前 agent 身份：')), 'research prompt should include identity section');
  assert(researcherPrompts.some((prompt) => prompt.includes('当前分配：')), 'research prompt should include assignment section');
  assert(researcherPrompts.some((prompt) => prompt.includes('执行上下文：')), 'research prompt should include execution context');

  const secondRun = await coordinator.runNextAssignment({ chainId: chainRuntime.chainId, maxStages: 1, maxWorkflowSteps: 20 });
  const secondWorkflowStep = getExecutedWorkflowStep(secondRun);
  assert(secondRun.status === 'done', 'second assignment should complete implementer stage');
  assert(secondRun.agent.agentId === implementer.agentId, 'implementer should handle the implement stage');
  assert(secondRun.assignment.status === 'completed', 'implement assignment should complete');
  assert(secondWorkflowStep?.executionContext?.tools?.length === 1, 'implement step should expose execution tools');
  assert(secondWorkflowStep?.executionContext?.tools?.[0]?.name === 'editor', 'implement step should expose the implementer tool name');
  assert(secondWorkflowStep?.executionContext?.memory?.scope === 'workspace', 'implement step should expose workspace memory defaults');
  assert(secondWorkflowStep?.executionContext?.workspace?.cwd === 'C:/workspace/workflow-closure', 'implement step should expose workspace cwd');
  assert(secondWorkflowStep?.activeMemoryContext?.enabled === true, 'implement step should expose active memory context');
  assert(secondWorkflowStep?.activeMemoryContext?.workspacePath?.replaceAll('\\', '/').toLowerCase() === 'c:/workspace/workflow-closure', 'implement step should expose active memory workspace path');
  assert(secondWorkflowStep?.adapterPayload?.promptHasExecutionContext === true, 'implement payload should confirm execution context in prompt');
  assert(secondWorkflowStep?.adapterPayload?.promptHasToolsContext === true, 'implement payload should confirm visible tools in prompt');
  assert(secondWorkflowStep?.adapterPayload?.promptHasMemoryContext === true, 'implement payload should confirm memory context in prompt');
  assert(secondWorkflowStep?.adapterPayload?.promptHasWorkspaceContext === true, 'implement payload should confirm workspace context in prompt');
  assert(secondWorkflowStep?.adapterPayload?.contextHasExecutionTools === true, 'implement payload should confirm execution tool context item');
  assert(secondWorkflowStep?.adapterPayload?.contextHasExecutionMemory === true, 'implement payload should confirm execution memory context item');
  assert(secondWorkflowStep?.adapterPayload?.executionToolCount === 1, 'implement payload should expose one execution tool');
  assert(secondWorkflowStep?.adapterPayload?.executionToolNames?.includes('editor'), 'implement payload should expose the implementer tool name');
  assert(secondWorkflowStep?.adapterPayload?.executionMemoryScope === 'workspace', 'implement payload should expose workspace memory scope');
  assert(secondWorkflowStep?.adapterPayload?.executionWorkspaceCwd === 'C:/workspace/workflow-closure', 'implement payload should expose workspace cwd');
  assert(secondWorkflowStep?.adapterPayload?.activeMemoryEnabled === true, 'implement payload should enable active memory context');
  assert(secondWorkflowStep?.adapterPayload?.activeMemoryWorkspacePath?.replaceAll('\\', '/').toLowerCase() === 'c:/workspace/workflow-closure', 'implement payload should expose active memory workspace path');
  assert(implementerPrompts.some((prompt) => prompt.includes('交接信息：')), 'implement prompt should include handoff section');
  assert(implementerPrompts.some((prompt) => prompt.includes('research-notes.md')), 'implement prompt should include upstream handoff artifacts');
  assert(implementerPrompts.some((prompt) => prompt.includes('执行上下文：')), 'implement prompt should include execution context');

  const thirdRun = await coordinator.runNextAssignment({ chainId: chainRuntime.chainId, maxStages: 1, maxWorkflowSteps: 20 });
  const thirdWorkflowStep = getExecutedWorkflowStep(thirdRun);
  assert(thirdRun.status === 'done', 'third assignment should complete verifier stage');
  assert(thirdRun.agent.agentId === verifier.agentId, 'verifier should handle the verify stage');
  assert(thirdRun.assignment.status === 'completed', 'verify assignment should complete');
  assert(thirdWorkflowStep?.executionContext?.tools?.length === 1, 'verify step should expose execution tools');
  assert(thirdWorkflowStep?.executionContext?.tools?.[0]?.name === 'test-runner', 'verify step should expose the verifier tool name');
  assert(thirdWorkflowStep?.executionContext?.memory?.scope === 'workspace', 'verify step should expose workspace memory defaults');
  assert(thirdWorkflowStep?.executionContext?.workspace?.cwd === 'C:/workspace/workflow-closure', 'verify step should expose workspace cwd');
  assert(thirdWorkflowStep?.activeMemoryContext?.enabled === true, 'verify step should expose active memory context');
  assert(thirdWorkflowStep?.activeMemoryContext?.workspacePath?.replaceAll('\\', '/').toLowerCase() === 'c:/workspace/workflow-closure', 'verify step should expose active memory workspace path');
  assert(thirdWorkflowStep?.adapterPayload?.promptHasExecutionContext === true, 'verify payload should confirm execution context in prompt');
  assert(thirdWorkflowStep?.adapterPayload?.promptHasToolsContext === true, 'verify payload should confirm visible tools in prompt');
  assert(thirdWorkflowStep?.adapterPayload?.promptHasMemoryContext === true, 'verify payload should confirm memory context in prompt');
  assert(thirdWorkflowStep?.adapterPayload?.promptHasWorkspaceContext === true, 'verify payload should confirm workspace context in prompt');
  assert(thirdWorkflowStep?.adapterPayload?.contextHasExecutionTools === true, 'verify payload should confirm execution tool context item');
  assert(thirdWorkflowStep?.adapterPayload?.contextHasExecutionMemory === true, 'verify payload should confirm execution memory context item');
  assert(thirdWorkflowStep?.adapterPayload?.executionToolCount === 1, 'verify payload should expose one execution tool');
  assert(thirdWorkflowStep?.adapterPayload?.executionToolNames?.includes('test-runner'), 'verify payload should expose the verifier tool name');
  assert(thirdWorkflowStep?.adapterPayload?.executionMemoryScope === 'workspace', 'verify payload should expose workspace memory scope');
  assert(thirdWorkflowStep?.adapterPayload?.executionWorkspaceCwd === 'C:/workspace/workflow-closure', 'verify payload should expose workspace cwd');
  assert(thirdWorkflowStep?.adapterPayload?.activeMemoryEnabled === true, 'verify payload should enable active memory context');
  assert(thirdWorkflowStep?.adapterPayload?.activeMemoryWorkspacePath?.replaceAll('\\', '/').toLowerCase() === 'c:/workspace/workflow-closure', 'verify payload should expose active memory workspace path');
  assert(verifierPrompts.some((prompt) => prompt.includes('implementation.patch')), 'verify prompt should include implementation handoff');
  assert(verifierPrompts.some((prompt) => prompt.includes('执行上下文：')), 'verify prompt should include execution context');

  const happyState = coordinator.getCoordinatorState({
    chainId: chainRuntime.chainId,
    includeTestData: true,
    includeHistory: true,
    assignmentQuery: { limit: 20 },
    handoffQuery: { limit: 20 }
  });
  const happyVerifyWorkflowStep = thirdRun.workflowResult?.steps?.find((step) => step.status === 'done');
  const happyVerifyWorkflowTask = thirdRun.workflowResult?.state?.tasks?.find((task) => task.status === 'done');
  const happyVerifyCompletionLog = thirdRun.workflowResult?.state
    ? findTaskRunLog(thirdRun.workflowResult.state.runLogs, happyVerifyWorkflowTask?.taskId, 'task_completed_by_runner')
    : null;
  assert(happyVerifyWorkflowStep?.verification?.status === 'passed', 'happy path verifier workflow step should expose verifier result');
  assert(happyVerifyCompletionLog?.payload?.verification?.status === 'passed', 'happy path verifier workflow run log should persist verifier result');
  assert(happyVerifyCompletionLog?.payload?.verification?.payload?.byName?.custom?.payload?.adapterStatus === 'done', 'happy path verifier workflow run log should persist custom verifier payload');
  assert(happyState.chainState.chain.status === 'done', 'happy path chain should be done');
  assert(happyState.chainState.stages.every((stage) => stage.status === 'done'), 'all happy path stages should be done');
  assert(happyState.assignments.filter((item) => item.chainId === chainRuntime.chainId).length === 3, 'happy path should create one assignment per stage');
  assert(happyState.handoffs.filter((item) => item.chainId === chainRuntime.chainId).length >= 2, 'happy path should persist stage handoffs');
  const happyTaskHandoffs = happyState.handoffs.filter((item) => item.sourceType === 'task');
  const researchTaskHandoff = happyTaskHandoffs.find((item) => item.sourceId === firstWorkflowStep?.task?.taskId);
  const implementTaskHandoff = happyTaskHandoffs.find((item) => item.sourceId === secondWorkflowStep?.task?.taskId);
  assert(Array.isArray(researchTaskHandoff?.artifactRefs) && researchTaskHandoff.artifactRefs.length > 0, 'research task handoff should persist artifact refs');
  assert(researchTaskHandoff.artifactRefs.some((item) => item?.artifactRef === 'file:artifacts/research-notes.md'), 'research task handoff should persist research artifactRef');
  assert(researchTaskHandoff.artifactRefs.some((item) => item?.relativePath === 'artifacts/research-notes.md'), 'research task handoff should persist research relativePath');
  assert(Array.isArray(implementTaskHandoff?.artifactRefs) && implementTaskHandoff.artifactRefs.length > 0, 'implement task handoff should persist artifact refs');
  assert(implementTaskHandoff.artifactRefs.some((item) => item?.artifactRef === 'file:artifacts/implementation.patch'), 'implement task handoff should persist implementation artifactRef');
  assert(implementTaskHandoff.artifactRefs.some((item) => item?.relativePath === 'artifacts/implementation.patch'), 'implement task handoff should persist implementation relativePath');

  const blockedRuntime = await createBlockedPathChain(coordinator);
  const blockedResearchRun = await coordinator.runNextAssignment({ chainId: blockedRuntime.chainId, maxStages: 1, maxWorkflowSteps: 20 });
  assert(blockedResearchRun.status === 'done', 'blocked flow should still complete research stage first');

  const blockedImplementRun = await coordinator.runNextAssignment({ chainId: blockedRuntime.chainId, maxStages: 1, maxWorkflowSteps: 20 });
  const blockedImplementStep = getExecutedWorkflowStep(blockedImplementRun);
  const blockedImplementTaskId = blockedImplementStep?.task?.taskId;
  assert(blockedImplementRun.status === 'blocked', 'implement stage should block on first attempt');
  assert(blockedImplementRun.assignment.status === 'blocked', 'blocked assignment should be marked blocked');
  assert(blockedImplementTaskId, 'blocked implement run should expose the blocked task id');
  assert(blockedImplementStep?.executionContext?.tools?.[0]?.name === 'editor', 'blocked implement step should keep the implementer tool name');
  assert(blockedImplementStep?.executionContext?.memory?.scope === 'workspace', 'blocked implement step should keep workspace memory defaults');
  assert(blockedImplementStep?.executionContext?.workspace?.cwd === 'C:/workspace/workflow-closure', 'blocked implement step should keep workspace cwd');
  assert(blockedImplementStep?.activeMemoryContext?.enabled === true, 'blocked implement step should keep active memory context enabled');
  assert(blockedImplementStep?.activeMemoryContext?.workspacePath?.replaceAll('\\', '/').toLowerCase() === 'c:/workspace/workflow-closure', 'blocked implement step should keep active memory workspace path');
  assert(blockedImplementStep?.adapterPayload?.promptHasExecutionContext === true, 'blocked implement payload should keep execution context visible');
  assert(blockedImplementStep?.adapterPayload?.promptHasToolsContext === true, 'blocked implement payload should keep tools context visible');
  assert(blockedImplementStep?.adapterPayload?.promptHasMemoryContext === true, 'blocked implement payload should keep memory context visible');
  assert(blockedImplementStep?.adapterPayload?.promptHasWorkspaceContext === true, 'blocked implement payload should keep workspace context visible');
  assert(blockedImplementStep?.adapterPayload?.contextHasExecutionTools === true, 'blocked implement payload should keep execution tool context visible');
  assert(blockedImplementStep?.adapterPayload?.contextHasExecutionMemory === true, 'blocked implement payload should keep execution memory context visible');
  assert(blockedImplementStep?.adapterPayload?.executionToolCount === 1, 'blocked implement payload should expose one execution tool');
  assert(blockedImplementStep?.adapterPayload?.executionToolNames?.includes('editor'), 'blocked implement payload should expose the implementer tool name');
  assert(blockedImplementStep?.adapterPayload?.executionMemoryScope === 'workspace', 'blocked implement payload should expose workspace memory scope');
  assert(blockedImplementStep?.adapterPayload?.executionWorkspaceCwd === 'C:/workspace/workflow-closure', 'blocked implement payload should expose workspace cwd');
  assert(blockedImplementStep?.adapterPayload?.activeMemoryEnabled === true, 'blocked implement payload should keep active memory enabled');
  assert(blockedImplementStep?.adapterPayload?.activeMemoryWorkspacePath?.replaceAll('\\', '/').toLowerCase() === 'c:/workspace/workflow-closure', 'blocked implement payload should expose active memory workspace path');

  const blockedStateBeforeResume = coordinator.getCoordinatorState({
    chainId: blockedRuntime.chainId,
    includeTestData: true,
    assignmentQuery: { limit: 20 },
    handoffQuery: { limit: 20 }
  });
  const blockedStage = blockedStateBeforeResume.chainState.stages.find((stage) => stage.status === 'blocked');
  assert(blockedStage, 'blocked flow should contain a blocked stage');

  blockOnce = false;
  const resumedRun = await coordinator.resumeAssignedWork({
    chainId: blockedRuntime.chainId,
    stageId: blockedStage.stageId,
    targetType: 'stage',
    mode: 'resume',
    runNow: true,
    message: '恢复实现阶段',
    payload: { operator: 'multi-agent-smoke-test' },
    maxStages: 1,
    maxWorkflowSteps: 20
  });
  const resumedWorkflowStep = getExecutedWorkflowStep(resumedRun);
  assert(resumedRun.status === 'done', 'resumeAssignedWork should finish resumed stage when runNow is true');
  assert(resumedRun.assignment.status === 'completed', 'resumed assignment should end completed');
  assert(resumedWorkflowStep?.task?.taskId === blockedImplementTaskId, 'resumed stage should execute the previously blocked workflow task');
  assert(resumedRun.target?.taskId === blockedImplementTaskId, 'resumed stage should report the previously blocked workflow task as the target');
  assert(resumedRun.assignment.payload?.taskId === blockedImplementTaskId, 'resumed assignment should persist the executed workflow task id');
  assert(resumedRun.assignment.payload?.resumedTaskId === blockedImplementTaskId, 'resumed assignment should persist the resumed workflow task id');
  assert(resumedWorkflowStep?.executionContext?.tools?.length === 1, 'resumed implement step should still expose execution tools');
  assert(resumedWorkflowStep?.executionContext?.tools?.[0]?.name === 'editor', 'resumed implement step should still expose the implementer tool name');
  assert(resumedWorkflowStep?.executionContext?.memory?.scope === 'workspace', 'resumed implement step should still expose workspace memory defaults');
  assert(resumedWorkflowStep?.executionContext?.workspace?.cwd === 'C:/workspace/workflow-closure', 'resumed implement step should still expose workspace cwd');
  assert(resumedWorkflowStep?.activeMemoryContext?.enabled === true, 'resumed implement step should still expose active memory context');
  assert(resumedWorkflowStep?.activeMemoryContext?.workspacePath?.replaceAll('\\', '/').toLowerCase() === 'c:/workspace/workflow-closure', 'resumed implement step should still expose active memory workspace path');
  assert(resumedWorkflowStep?.adapterPayload?.promptHasResumeHint === true, 'resumed implement payload should confirm resume hints');
  assert(resumedWorkflowStep?.adapterPayload?.promptHasExecutionContext === true, 'resumed implement payload should confirm execution context');
  assert(resumedWorkflowStep?.adapterPayload?.promptHasToolsContext === true, 'resumed implement payload should confirm tools context');
  assert(resumedWorkflowStep?.adapterPayload?.promptHasMemoryContext === true, 'resumed implement payload should confirm memory context');
  assert(resumedWorkflowStep?.adapterPayload?.promptHasWorkspaceContext === true, 'resumed implement payload should confirm workspace context');
  assert(resumedWorkflowStep?.adapterPayload?.contextHasExecutionTools === true, 'resumed implement payload should confirm execution tool context');
  assert(resumedWorkflowStep?.adapterPayload?.contextHasExecutionMemory === true, 'resumed implement payload should confirm execution memory context');
  assert(resumedWorkflowStep?.adapterPayload?.executionToolCount === 1, 'resumed implement payload should expose one execution tool');
  assert(resumedWorkflowStep?.adapterPayload?.executionToolNames?.includes('editor'), 'resumed implement payload should expose the implementer tool name');
  assert(resumedWorkflowStep?.adapterPayload?.executionMemoryScope === 'workspace', 'resumed implement payload should expose workspace memory scope');
  assert(resumedWorkflowStep?.adapterPayload?.executionWorkspaceCwd === 'C:/workspace/workflow-closure', 'resumed implement payload should expose workspace cwd');
  assert(resumedWorkflowStep?.adapterPayload?.activeMemoryEnabled === true, 'resumed implement payload should keep active memory enabled');
  assert(resumedWorkflowStep?.adapterPayload?.activeMemoryWorkspacePath?.replaceAll('\\', '/').toLowerCase() === 'c:/workspace/workflow-closure', 'resumed implement payload should expose active memory workspace path');
  assert(implementerPrompts.some((prompt) => prompt.includes('最近错误: 等待恢复')), 'retried implement prompt should preserve last error');
  assert(implementerPrompts.some((prompt) => prompt.includes('恢复信息：')), 'retried implement prompt should include resume hint');

  const finalVerifyRun = await coordinator.runNextAssignment({ chainId: blockedRuntime.chainId, maxStages: 1, maxWorkflowSteps: 20 });
  assert(finalVerifyRun.status === 'done', 'verify stage should finish after resumed implement stage');

  const blockedState = coordinator.getCoordinatorState({
    chainId: blockedRuntime.chainId,
    includeTestData: true,
    includeHistory: true,
    assignmentQuery: { limit: 50 },
    handoffQuery: { limit: 50 }
  });
  const blockedVerifyWorkflowStep = finalVerifyRun.workflowResult?.steps?.find((step) => step.status === 'done');
  const blockedVerifyWorkflowTask = finalVerifyRun.workflowResult?.state?.tasks?.find((task) => task.status === 'done');
  const blockedVerifyCompletionLog = finalVerifyRun.workflowResult?.state
    ? findTaskRunLog(finalVerifyRun.workflowResult.state.runLogs, blockedVerifyWorkflowTask?.taskId, 'task_completed_by_runner')
    : null;
  assert(blockedVerifyWorkflowStep?.verification?.status === 'passed', 'blocked/resume verifier workflow step should expose verifier result');
  assert(blockedVerifyCompletionLog?.payload?.verification?.status === 'passed', 'blocked/resume verifier workflow run log should persist verifier result');
  assert(blockedVerifyCompletionLog?.payload?.verification?.payload?.byName?.custom?.payload?.adapterStatus === 'done', 'blocked/resume verifier workflow run log should persist custom verifier payload');
  assert(blockedState.chainState.chain.status === 'done', 'blocked/resume chain should finish');
  const blockedAssignments = blockedState.assignments.filter((item) => item.chainId === blockedRuntime.chainId);
  assert(blockedAssignments.some((item) => item.status === 'blocked'), 'blocked/resume chain should keep blocked assignment history');
  assert(blockedAssignments.some((item) => item.status === 'completed' && item.agentId === implementer.agentId), 'blocked/resume chain should complete with implementer after resume');
  assert(blockedState.handoffs.filter((item) => item.chainId === blockedRuntime.chainId).length >= 2, 'blocked/resume chain should persist handoff history');

  const directTargetWorkflowState = await createDirectTargetWorkflow();
  const directTargetFirstTask = directTargetWorkflowState.tasks.find((task) => task.title === '先完成非目标任务');
  const directTargetAssignedTask = directTargetWorkflowState.tasks.find((task) => task.title === '只执行已分配目标任务');
  assert(directTargetFirstTask, 'direct-target fixture should include a non-target ready task');
  assert(directTargetAssignedTask, 'direct-target fixture should include the assigned target task');

  const directTargetAssignment = await coordinator.assignNextWork({
    workflowId: directTargetWorkflowState.workflow.workflowId,
    targetType: 'task',
    taskId: directTargetAssignedTask.taskId
  });
  assert(directTargetAssignment.status === 'assigned', 'direct task assignment should be created for the requested target task');
  assert(directTargetAssignment.target.taskId === directTargetAssignedTask.taskId, 'direct task assignment should target the requested task');
  assert(directTargetAssignment.agent.agentId === implementer.agentId, 'direct task assignment should choose the implementer');

  const directTargetRun = await coordinator.runNextAssignment({ assignmentId: directTargetAssignment.assignment.assignmentId });
  assert(directTargetRun.status === 'done', 'direct target assignment should run successfully');
  assert(directTargetRun.step?.task?.taskId === directTargetAssignedTask.taskId, 'direct target assignment should execute only the assigned task');
  assert(directTargetRun.target?.taskId === directTargetAssignedTask.taskId, 'direct target assignment should report the assigned target');

  const directTargetFinalState = coordinator.getCoordinatorState({
    workflowId: directTargetWorkflowState.workflow.workflowId,
    includeTestData: true,
    assignmentQuery: { limit: 20 },
    handoffQuery: { limit: 20 }
  });
  const directTargetFirstFinalTask = directTargetFinalState.workflowState.tasks.find((task) => task.taskId === directTargetFirstTask.taskId);
  const directTargetAssignedFinalTask = directTargetFinalState.workflowState.tasks.find((task) => task.taskId === directTargetAssignedTask.taskId);
  assert(directTargetFirstFinalTask?.status === 'ready', 'direct target assignment should leave the earlier ready non-target task untouched');
  assert(directTargetFirstFinalTask?.doneSummary == null, 'direct target assignment should not write completion data to the non-target task');
  assert(directTargetAssignedFinalTask?.status === 'done', 'direct target assignment should complete the assigned task');

  const staleBlockedWorkflowState = await createStaleBlockedWorkflow();
  const staleBlockedTask = staleBlockedWorkflowState.tasks.find((task) => task.title === '历史阻塞任务');
  const activeBlockedTask = staleBlockedWorkflowState.tasks.find((task) => task.title === '当前真实阻塞任务');
  assert(staleBlockedTask, 'stale-blocked fixture should include a stale blocked task');
  assert(activeBlockedTask, 'stale-blocked fixture should include the active blocked task');

  const staleResumeRun = await coordinator.resumeAssignedWork({
    workflowId: staleBlockedWorkflowState.workflow.workflowId,
    mode: 'resume',
    message: '恢复当前真实阻塞任务'
  });
  assert(staleResumeRun.status === 'resumed', 'workflow-scoped resume should resume the active blocked task');
  assert(staleResumeRun.target?.taskId === activeBlockedTask.taskId, 'workflow-scoped resume must not select stale blocked task pollution');
  assert(staleResumeRun.task?.taskId === activeBlockedTask.taskId, 'workflow-scoped resume should return the active blocked task');

  console.log('multi-agent coordinator smoke test passed');
  console.log(JSON.stringify({
    happyChainId: chainRuntime.chainId,
    happyAssignmentCount: happyState.assignments.filter((item) => item.chainId === chainRuntime.chainId).length,
    happyHandoffCount: happyState.handoffs.filter((item) => item.chainId === chainRuntime.chainId).length,
    blockedChainId: blockedRuntime.chainId,
    blockedAssignmentCount: blockedAssignments.length,
    blockedHandoffCount: blockedState.handoffs.filter((item) => item.chainId === blockedRuntime.chainId).length,
    researcherPromptCount: researcherPrompts.length,
    implementerPromptCount: implementerPrompts.length,
    verifierPromptCount: verifierPrompts.length
  }, null, 2));
}

async function createHappyPathChain(coordinator) {
  const runtime = await import('../runner/workflow-chain.js');
  const chain = await runtime.createAgentWorkflowChain({
    dbPath,
    workflowHygieneMetadata: {
      dataClass: 'test',
      retention: 'ephemeral',
      generatedBy: 'multi-agent-smoke-test'
    }
  });
  const created = chain.createChain({
    instruction: '多 agent happy path',
    stages: [
      {
        title: '调研方案',
        instruction: '先完成调研并输出结构化交接',
        preferredRole: 'researcher',
        requiredCapabilities: ['research']
      },
      {
        title: '实现方案',
        instruction: '根据调研交接完成实现',
        preferredRole: 'implementer',
        requiredCapabilities: ['implement']
      },
      {
        title: '验证结果',
        instruction: '根据实现交接完成最终验证',
        preferredRole: 'verifier',
        requiredCapabilities: ['verify']
      }
    ]
  });

  return { chainId: created.chain.chainId, chain };
}

async function createBlockedPathChain(coordinator) {
  const runtime = await import('../runner/workflow-chain.js');
  const chain = await runtime.createAgentWorkflowChain({
    dbPath,
    workflowHygieneMetadata: {
      dataClass: 'test',
      retention: 'ephemeral',
      generatedBy: 'multi-agent-smoke-test'
    }
  });
  const created = chain.createChain({
    instruction: '多 agent 需要阻塞恢复',
    stages: [
      {
        title: '调研阻塞恢复场景',
        instruction: '先完成调研并输出结构化交接',
        preferredRole: 'researcher',
        requiredCapabilities: ['research']
      },
      {
        title: '实现阻塞恢复场景',
        instruction: '实现阶段需要先阻塞再恢复',
        preferredRole: 'implementer',
        requiredCapabilities: ['implement']
      },
      {
        title: '验证阻塞恢复结果',
        instruction: '验证恢复后的实现结果',
        preferredRole: 'verifier',
        requiredCapabilities: ['verify']
      }
    ]
  });

  return { chainId: created.chain.chainId, chain };
}

async function createDirectTargetWorkflow() {
  const runtime = await import('../core/workflow-engine.js');
  const engine = await runtime.createWorkflowEngine({ dbPath });
  const created = engine.createWorkflowFromInstruction({
    instruction: '验证已分配任务只执行指定 taskId',
    plan: markTestPlan({
      goal: '验证 assigned task targeting',
      steps: [
        {
          key: 'first-ready-task',
          title: '先完成非目标任务',
          description: '这个任务序号更早，但不应该被目标 assignment 执行。',
          type: 'implement'
        },
        {
          key: 'assigned-target-task',
          title: '只执行已分配目标任务',
          description: '直接分配到这个任务时，runner 必须只 claim 它。',
          type: 'implement'
        }
      ],
      dependencies: []
    }, 'multi-agent-smoke-test')
  });

  return created;
}

async function createStaleBlockedWorkflow() {
  const runtime = await import('../core/workflow-engine.js');
  const engine = await runtime.createWorkflowEngine({ dbPath });
  const created = engine.createWorkflowFromInstruction({
    instruction: '验证 workflow-scoped resume 不被历史 blocked 污染劫持',
    plan: markTestPlan({
      goal: '验证 stale blocked resume 选择',
      steps: [
        {
          key: 'stale-blocked-task',
          title: '历史阻塞任务',
          description: '这条 blocked 状态代表已经被后续推进覆盖的历史污染。',
          type: 'implement'
        },
        {
          key: 'completed-downstream-task',
          title: '后续已完成任务',
          description: '后续任务已推进，证明前序 blocked 不再是当前活跃阻塞点。',
          type: 'implement'
        },
        {
          key: 'active-blocked-task',
          title: '当前真实阻塞任务',
          description: 'workflow-scoped resume 应恢复这条任务。',
          type: 'implement'
        }
      ],
      dependencies: []
    }, 'multi-agent-smoke-test')
  });

  const staleTask = created.tasks.find((task) => task.title === '历史阻塞任务');
  const completedTask = created.tasks.find((task) => task.title === '后续已完成任务');
  const activeTask = created.tasks.find((task) => task.title === '当前真实阻塞任务');

  engine.advanceTaskStatus({
    workflowId: created.workflow.workflowId,
    taskId: staleTask.taskId,
    status: 'doing'
  });
  engine.advanceTaskStatus({
    workflowId: created.workflow.workflowId,
    taskId: staleTask.taskId,
    status: 'blocked',
    blockedReason: '历史污染：旧阻塞未收敛',
    lastError: '历史污染：旧阻塞未收敛'
  });
  engine.advanceTaskStatus({
    workflowId: created.workflow.workflowId,
    taskId: completedTask.taskId,
    status: 'doing'
  });
  engine.advanceTaskStatus({
    workflowId: created.workflow.workflowId,
    taskId: completedTask.taskId,
    status: 'done',
    doneSummary: '后续任务已经完成'
  });
  engine.advanceTaskStatus({
    workflowId: created.workflow.workflowId,
    taskId: activeTask.taskId,
    status: 'doing'
  });
  const blocked = engine.advanceTaskStatus({
    workflowId: created.workflow.workflowId,
    taskId: activeTask.taskId,
    status: 'blocked',
    blockedReason: '当前真实阻塞',
    lastError: '当前真实阻塞'
  });

  return engine.getWorkflowState({ workflowId: created.workflow.workflowId });
}

function getExecutedWorkflowStep(runResult) {
  const directStep = runResult?.step;

  if (directStep?.executionContext || directStep?.adapterPayload || directStep?.activeMemoryContext) {
    return directStep;
  }

  const directWorkflowResult = directStep?.workflowResult || runResult?.workflowResult;
  if (directWorkflowResult?.lastStep?.executionContext || directWorkflowResult?.lastStep?.adapterPayload || directWorkflowResult?.lastStep?.activeMemoryContext) {
    return directWorkflowResult.lastStep;
  }

  if (Array.isArray(directWorkflowResult?.steps) && directWorkflowResult.steps.length > 0) {
    const candidate = [...directWorkflowResult.steps].reverse().find((step) => step?.executionContext || step?.adapterPayload || step?.activeMemoryContext) || null;
    if (candidate) {
      return candidate;
    }
  }

  return null;
}


function findTaskRunLog(runLogs, taskId, action) {
  return Array.isArray(runLogs)
    ? [...runLogs].reverse().find((log) => log.taskId === taskId && log.action === action) || null
    : null;
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
