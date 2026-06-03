export default async function cliCoordinatorSmokeAdapter({ workflow, task, prompt, contextItems, executionContext, activeMemoryContext }) {
  const lastErrorLine = prompt.split('\n').find((line) => line.includes('最近错误:')) || '';
  const payload = {
    taskId: task.taskId,
    promptHasAssignment: prompt.includes('当前分配：'),
    promptHasResumeHint: prompt.includes('恢复信息：'),
    promptHasLastError: Boolean(lastErrorLine && !lastErrorLine.includes('最近错误: 无')),
    promptHasRoleHint: prompt.includes('agent 身份：'),
    promptHasValidatorIdentity: prompt.includes('agentId: cli-validator-agent') && prompt.includes('角色: validator'),
    promptHasValidatorCapabilities: prompt.includes('能力: validate, tests'),
    promptHasExecutionContext: prompt.includes('执行上下文：'),
    promptHasMemoryContext: prompt.includes('活跃记忆:'),
    promptHasToolsContext: prompt.includes('默认可见工具:'),
    contextHasExecutionTools: Array.isArray(contextItems) && contextItems.some((item) => item.kind === 'execution-tools'),
    contextHasExecutionMemory: Array.isArray(contextItems) && contextItems.some((item) => item.kind === 'execution-memory'),
    executionToolCount: Array.isArray(executionContext?.tools) ? executionContext.tools.length : 0,
    activeMemoryEnabled: activeMemoryContext?.enabled === true
  };

  if (workflow.instruction.includes('瞬时上游恢复冷却') && !task.lastError) {
    const error = new Error(`API Error: 502 {"error":{"message":"Transient upstream smoke failure for ${task.title}","type":"upstream_error"}}`);
    error.failureType = 'transient';
    error.payload = payload;
    throw error;
  }

  if (workflow.instruction.includes('需要阻塞恢复') && !task.lastError) {
    return {
      status: 'blocked',
      blockedReason: `等待恢复：${task.title}`,
      payload
    };
  }

  return {
    status: 'done',
    doneSummary: `CLI coordinator 完成：${task.title}`,
    payload
  };
}
