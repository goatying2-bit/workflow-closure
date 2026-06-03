export default async function cliRunnerSmokeAdapter({ task, prompt, ruleContext, contextItems, executionContext, activeMemoryContext }) {
  return {
    status: 'done',
    doneSummary: `CLI runner 完成：${task.title}`,
    payload: {
      taskId: task.taskId,
      promptHasRulesSection: prompt.includes('执行规则：'),
      promptIncludesPrimaryRule: prompt.includes('CLI runner rule｜先列出关键事实，再输出结论。'),
      promptIncludesPredecessorOutput: prompt.includes('runner-output') && prompt.includes('runner predecessor output content'),
      promptHasExecutionContext: prompt.includes('执行上下文：'),
      promptHasMemoryContext: prompt.includes('活跃记忆:'),
      promptHasToolsContext: prompt.includes('默认可见工具:'),
      contextHasPredecessorOutput: Array.isArray(contextItems) && contextItems.some((item) => item.kind === 'predecessor-output'),
      contextHasExecutionTools: Array.isArray(contextItems) && contextItems.some((item) => item.kind === 'execution-tools'),
      contextHasExecutionMemory: Array.isArray(contextItems) && contextItems.some((item) => item.kind === 'execution-memory'),
      executionToolCount: Array.isArray(executionContext?.tools) ? executionContext.tools.length : 0,
      activeMemoryEnabled: activeMemoryContext?.enabled === true,
      ruleCount: Array.isArray(ruleContext?.rules) ? ruleContext.rules.length : 0,
      providerKind: ruleContext?.metadata?.ruleProvider || null
    }
  };
}
