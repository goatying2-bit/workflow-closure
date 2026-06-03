export default async function cliChainSmokeAdapter({ workflow, task, prompt, recalledMemories, contextSnapshot, contextItems, executionContext, activeMemoryContext }) {
  const payload = {
    taskId: task.taskId,
    promptHasMemorySection: prompt.includes('相关记忆：'),
    promptHasContextSection: prompt.includes('相关上下文：') || prompt.includes('恢复信息：') || prompt.includes('直接上游事实：'),
    promptHasExecutionContext: prompt.includes('执行上下文：'),
    promptHasMemoryContext: prompt.includes('活跃记忆:'),
    promptHasToolsContext: prompt.includes('默认可见工具:'),
    promptHasWorkspaceContext: prompt.includes('工作区提示:'),
    recalledMemoryIds: recalledMemories.map((item) => item.memoryId),
    contextSnapshotId: contextSnapshot?.snapshotId || null,
    contextItemKinds: contextItems.map((item) => item.kind),
    contextHasExecutionTools: Array.isArray(contextItems) && contextItems.some((item) => item.kind === 'execution-tools'),
    contextHasExecutionMemory: Array.isArray(contextItems) && contextItems.some((item) => item.kind === 'execution-memory'),
    contextHasExecutionWorkspace: Array.isArray(contextItems) && contextItems.some((item) => item.kind === 'execution-workspace'),
    executionToolCount: Array.isArray(executionContext?.tools) ? executionContext.tools.length : 0,
    activeMemoryEnabled: activeMemoryContext?.enabled === true
  };

  if (workflow.instruction.includes('第二阶段需要先阻塞再恢复') && !task.lastError) {
    return {
      status: 'blocked',
      blockedReason: `等待恢复：${task.title}`,
      payload
    };
  }

  return {
    status: 'done',
    doneSummary: `CLI 阶段完成：${task.title}`,
    payload
  };
}
