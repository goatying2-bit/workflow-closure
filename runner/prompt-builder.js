import {
  buildContextHygieneSummary,
  classifyMemoryForContext,
  classifyTaskOutputForContext,
  isContextItemAllowedInPrompt
} from './context-hygiene.js';

const DEFAULT_WORKFLOW_CLOSURE_POLICY = Object.freeze({
  closureMode: 'small_loop',
  verificationLevel: 'targeted',
  docPolicy: 'minimal',
  cleanupPolicy: 'defer'
});

export function buildTaskPrompt(state, task, options = {}) {
  if (!state?.workflow) {
    throw new Error('Workflow state is required to build a task prompt.');
  }

  if (!task?.taskId) {
    throw new Error('Task is required to build a task prompt.');
  }

  const workflow = state.workflow;
  const workflowClosurePolicy = resolveWorkflowClosurePolicy(options.workflowClosurePolicy, workflow.initialPlan?.metadata);
  const dependencies = state.dependencies || [];
  const tasks = state.tasks || [];
  const rawMemoryItems = Array.isArray(options.memoryContext?.items) ? options.memoryContext.items : [];
  const rawContextItems = Array.isArray(options.contextItems) ? options.contextItems : [];
  const promptContext = { isRepairTask: isValidationRepairTask(task) };
  const contextItems = rawContextItems.filter((item) => isContextItemAllowedInPrompt(item, promptContext));
  const memoryItems = rawMemoryItems
    .map((item) => ({ item, classification: classifyMemoryForContext(item) }))
    .filter(({ classification }) => classification.promptAllowed !== false)
    .map(({ item, classification }) => ({
      ...item,
      hygieneLabel: item.hygieneLabel || classification.hygieneLabel,
      sourceClass: item.sourceClass || classification.sourceClass,
      allowedUse: item.allowedUse || classification.allowedUse
    }));
  const hygienePromptSummary = buildContextHygieneSummary(contextItems, rawContextItems.length);
  const hygieneFilteredCount = Math.max(0, rawContextItems.length - contextItems.length);
  const contextSnapshot = options.contextSnapshot || null;
  const agentIdentity = normalizeAgentIdentity(options.agentIdentity);
  const executionContext = normalizeExecutionContext(options.executionContext);
  const assignment = normalizeAssignment(options.assignment) || buildDefaultAssignment(task);
  const handoffContext = normalizeHandoffContext(options.handoffContext) || buildDefaultHandoffContext(task, tasks, dependencies);
  const runtimeRules = normalizePromptRules(options.ruleContext?.rules ?? options.rules);
  const groupedContext = groupContextItems(contextItems);
  const predecessorOutputs = normalizePredecessorOutputs(options.predecessorOutputs, contextItems, task);
  const repairValidationEvidence = buildRepairValidationEvidence(predecessorOutputs);
  const filteredPredecessorOutputCount = getFilteredPredecessorOutputCount(options.predecessorOutputs, contextItems);
  const contract = normalizeTaskContract(task.contract);
  const workflowClosureRules = buildWorkflowClosurePolicyPromptRules(workflowClosurePolicy);
  const finalDeliverableReuseRules = buildFinalDeliverableReusePromptRules({
    task,
    contract,
    predecessorOutputs,
    handoffContext
  });
  const primaryPredecessorHandoff = handoffContext?.predecessors?.[0] || null;
  const primaryPredecessorSummary = primaryPredecessorHandoff
    ? null
    : dependencies
      .filter((dependency) => dependency.successorTaskId === task.taskId)
      .map((dependency) => tasks.find((item) => item.taskId === dependency.predecessorTaskId))
      .filter(Boolean)
      .map((item) => ({
        title: item.title,
        doneSummary: item.doneSummary || '无完成摘要。'
      }))[0] || null;

  const sections = [
    '你是工作流执行 agent。请只处理当前任务，并返回结构化执行结果。',
    `工作流目标：${workflow.goal}`,
    `原始指令：${workflow.instruction}`,
    '',
    '执行规则：',
    '- 只对“当前任务”直接作答，不要自行扩展目标。',
    '- 若当前任务事实与参考信息冲突，以当前任务事实为准。',
    '- 恢复信息、重跑信息、最近错误仅用于解释上次失败，不自动构成新的任务要求。',
    ...workflowClosureRules.map((rule) => `- ${rule}`),
    ...runtimeRules.map((rule) => `- ${formatPromptRule(rule)}`),
    '',
    'Workflow closure policy：',
    `- closureMode: ${workflowClosurePolicy.closureMode}｜${formatWorkflowClosureMode(workflowClosurePolicy.closureMode)}`,
    `- verificationLevel: ${workflowClosurePolicy.verificationLevel}｜${formatWorkflowVerificationLevel(workflowClosurePolicy.verificationLevel)}`,
    `- docPolicy: ${workflowClosurePolicy.docPolicy}｜${formatWorkflowDocPolicy(workflowClosurePolicy.docPolicy)}`,
    `- cleanupPolicy: ${workflowClosurePolicy.cleanupPolicy}｜${formatWorkflowCleanupPolicy(workflowClosurePolicy.cleanupPolicy)}`,
    '',
    '当前任务：',
    `- taskId: ${task.taskId}`,
    `- 标题: ${task.title}`,
    `- 描述: ${task.description || '无'}`,
    `- 尝试次数: ${task.attemptCount || 0}`,
    `- 最近错误: ${formatTaskLastError(task)}`,
    ''
  ];

  if (contract) {
    sections.push('任务契约：');
    sections.push(`- done 判定: ${contract.successCriteria.length > 0 ? contract.successCriteria.join('；') : '满足当前任务目标，并给出明确 doneSummary。'}`);
    sections.push(`- 必需交付物: ${contract.requiredArtifacts.length > 0 ? `${contract.requiredArtifacts.join('；')}（完成时写入 payload.handoff.artifacts）` : '无'}`);
    sections.push(`- 禁止动作: ${contract.forbiddenActions.length > 0 ? contract.forbiddenActions.join('；') : '无'}`);
    sections.push(`- 信息不足策略: ${formatAssumptionsPolicy(contract.assumptionsPolicy)}`);

    if (contract.assumptionsPolicy === 'block_on_missing_information') {
      sections.push('- 若缺少关键信息，不要自行补全；返回 blocked，并说明缺失信息。');
    }

    sections.push('');
  }

  if (contract?.validationCommands?.length > 0) {
    sections.push('验证要求：');
    for (const [index, command] of contract.validationCommands.entries()) {
      sections.push(`${index + 1}. ${formatValidationCommand(command)}`);
    }
    sections.push('- 必需验证无法运行时返回 blocked，并说明原因。');
    sections.push('');
  }

  if (repairValidationEvidence.length > 0) {
    sections.push('修复依据：');
    for (const [index, item] of repairValidationEvidence.entries()) {
      sections.push(`${index + 1}. 上游验证失败：${formatRepairValidationEvidence(item)}`);
    }
    sections.push('');
  }

  if (agentIdentity) {
    sections.push('当前 agent 身份：');
    sections.push(`- agentId: ${agentIdentity.agentId || '无'}`);
    sections.push(`- 名称: ${agentIdentity.name || '无'}`);
    sections.push(`- 角色: ${agentIdentity.role || '无'}`);
    sections.push(`- 能力: ${agentIdentity.capabilities.length > 0 ? agentIdentity.capabilities.join(', ') : '无'}`);
    sections.push('');
  }

  if (executionContext) {
    sections.push('执行上下文：');

    if (executionContext.tools.length > 0) {
      sections.push(`- 默认可见工具: ${executionContext.tools.map((tool) => tool.name || '未命名工具').join(', ')}`);
      for (const [index, tool] of executionContext.tools.entries()) {
        sections.push(...formatExecutionTool(tool, index));
      }
    } else {
      sections.push('- 默认可见工具: 无');
    }

    if (executionContext.memory) {
      sections.push(`- 活跃记忆: ${formatExecutionMemoryLine(executionContext.memory)}`);
      sections.push(...formatExecutionMemoryDetails(executionContext.memory));
    } else {
      sections.push('- 活跃记忆: 无');
    }

    if (executionContext.workspace) {
      sections.push(`- 工作区提示: ${formatExecutionWorkspaceLine(executionContext.workspace)}`);
      sections.push(...formatExecutionWorkspaceDetails(executionContext.workspace));
    } else {
      sections.push('- 工作区提示: 无');
    }

    sections.push('');
  }

  if (assignment) {
    sections.push('当前分配：');
    sections.push(`- ownerAgentId: ${assignment.ownerAgentId || '无'}`);
    sections.push(`- preferredRole: ${assignment.preferredRole || '无'}`);
    sections.push(`- requiredCapabilities: ${assignment.requiredCapabilities.length > 0 ? assignment.requiredCapabilities.join(', ') : '无'}`);
    sections.push(`- assignmentStatus: ${assignment.assignmentStatus || '无'}`);
    sections.push(`- assignmentReason: ${assignment.assignmentReason || '无'}`);
    sections.push('');
  }

  if (handoffContext?.current || primaryPredecessorHandoff) {
    sections.push('交接信息：');

    if (handoffContext?.current) {
      sections.push('- 当前任务已有交接：');
      sections.push(...formatStructuredHandoff(handoffContext.current, '  '));
    }

    if (primaryPredecessorHandoff) {
      sections.push('- 上游任务交接：');
      sections.push(`  1. ${primaryPredecessorHandoff.title}`);
      sections.push(...formatStructuredHandoff(primaryPredecessorHandoff.handoff, '    ', primaryPredecessorHandoff.doneSummary));
    }

    if (predecessorOutputs.length > 0) {
      sections.push('- 上游输出：');
      for (const [index, item] of predecessorOutputs.entries()) {
        sections.push(...formatPredecessorOutput(item, index, '  ', task));
      }
    }

    if (filteredPredecessorOutputCount > 0) {
      sections.push(`- 已过滤 ${filteredPredecessorOutputCount} 个未受信上游输出（failed/tainted/superseded 不进入提示）。`);
    }

    if (hygieneFilteredCount > 0) {
      sections.push(`- hygiene 策略额外阻止 ${hygieneFilteredCount} 个上下文项进入提示。`);
    }

    if (hygienePromptSummary.includedCount > 0) {
      sections.push(`- hygiene 标签摘要: ${formatHygieneSummary(hygienePromptSummary)}。`);
    }

    sections.push('');
  }

  pushContextItemSection(sections, '当前任务补充事实：', groupedContext.authoritativeExtras);

  if (!primaryPredecessorHandoff && (primaryPredecessorSummary || predecessorOutputs.length > 0 || groupedContext.upstream.length > 0)) {
    sections.push('直接上游事实：');

    if (primaryPredecessorSummary) {
      sections.push(`- 上游摘要: ${primaryPredecessorSummary.title}｜${primaryPredecessorSummary.doneSummary}`);
    }

    if (predecessorOutputs.length > 0) {
      sections.push('- 上游输出：');
      for (const [index, item] of predecessorOutputs.entries()) {
        sections.push(...formatPredecessorOutput(item, index, '  ', task));
      }
    }

    if (groupedContext.upstream.length > 0) {
      sections.push('- 补充上下文：');
      for (const [index, item] of groupedContext.upstream.entries()) {
        sections.push(...formatPromptContextItem(item, index, '  '));
      }
    }

    sections.push('');
  }

  if (groupedContext.recovery.length > 0 || contextSnapshot?.metadata?.hasResumeHint === true || contextSnapshot?.metadata?.hasRerunHint === true || task.lastError) {
    sections.push('恢复信息：');

    if (contextSnapshot?.metadata?.hasResumeHint === true) {
      sections.push('- 这是恢复后的重试；优先把它当成上次失败的解释，而不是新的任务目标。');
    }

    if (contextSnapshot?.metadata?.hasRerunHint === true) {
      sections.push('- 这是从错误起点发起的重跑；先修正上游错误，再重新产出当前任务结果。');
    }

    if (groupedContext.recovery.length > 0) {
      for (const [index, item] of groupedContext.recovery.entries()) {
        sections.push(...formatPromptContextItem(item, index));
      }
    } else if (task.lastError) {
      sections.push(`- 最近错误: ${formatTaskLastError(task)}`);
    }

    sections.push('');
  }

  if (memoryItems.length > 0) {
    sections.push('相关记忆：');
    for (const [index, item] of memoryItems.entries()) {
      sections.push(...formatPromptMemoryItem(item, index));
    }
    sections.push('');
  }

  if (finalDeliverableReuseRules.length > 0) {
    sections.push('最终交付提示：');
    for (const rule of finalDeliverableReuseRules) {
      sections.push(`- ${rule}`);
    }
    sections.push('');
  }

  sections.push(
    '返回要求：',
    '- 成功时返回 { status: "done", doneSummary, payload?, taskOutputs? }',
    '- 无法继续时返回 { status: "blocked", blockedReason, payload? }',
    '- payload 可附带 handoff: { summary, artifacts?, decisions?, openQuestions?, risks?, recommendedNextRole? }',
    '- 如需交付最终文档/文件，不要直接输出正文；把内容放进 taskOutputs 或 payload.outputs，并填写 path。',
    '- 如任务契约要求交付物，完成时把对应路径写入 payload.handoff.artifacts。',
    '- 如执行了验证命令，把证据写入 payload.validationResults。',
    '- 不要返回额外格式包裹。'
  );

  return sections.join('\n');
}

function normalizePredecessorOutputs(predecessorOutputs, contextItems, task) {
  if (Array.isArray(predecessorOutputs) && predecessorOutputs.length > 0) {
    return predecessorOutputs
      .map((item) => normalizePredecessorOutput(item, task))
      .filter((item) => item && isNormalizedPredecessorOutputAllowed(item, task));
  }

  return (Array.isArray(contextItems) ? contextItems : [])
    .filter((item) => item?.kind === 'predecessor-output')
    .map((item) => normalizePredecessorOutput({
      predecessorTaskId: item.sourceRef,
      predecessorTitle: item.metadata?.predecessorTitle || item.title || '上游任务',
      output: item.metadata?.output || {
        outputId: item.metadata?.outputId,
        kind: item.metadata?.outputKind,
        name: item.metadata?.outputName,
        content: item.content,
        path: item.metadata?.path,
        metadata: item.metadata?.outputMetadata
      }
    }, task))
    .filter((item) => item && isNormalizedPredecessorOutputAllowed(item, task));
}

function getFilteredPredecessorOutputCount(predecessorOutputs, contextItems) {
  if (Array.isArray(predecessorOutputs) && Number.isInteger(predecessorOutputs.filteredOutputCount)) {
    return predecessorOutputs.filteredOutputCount;
  }

  if (!Array.isArray(contextItems)) {
    return 0;
  }

  return contextItems.reduce((total, item) => {
    if (item?.kind !== 'predecessor-output-filter-summary') {
      return total;
    }
    const count = Number(item.metadata?.filteredOutputCount || 0);
    return total + (Number.isFinite(count) ? count : 0);
  }, 0);
}

function normalizePredecessorOutput(item) {
  if (!item || typeof item !== 'object') {
    return null;
  }

  const output = item.output && typeof item.output === 'object' ? item.output : item;
  return {
    predecessorTaskId: normalizeOptionalText(item.predecessorTaskId || output.taskId),
    predecessorTitle: normalizeOptionalText(item.predecessorTitle) || '上游任务',
    output: {
      outputId: normalizeOptionalText(output.outputId),
      kind: normalizeOptionalText(output.kind) || 'output',
      name: normalizeOptionalText(output.name),
      content: normalizeOptionalText(output.content),
      path: normalizeOptionalText(output.path),
      metadata: output.metadata && typeof output.metadata === 'object' && !Array.isArray(output.metadata) ? output.metadata : null
    }
  };
}

function isNormalizedPredecessorOutputAllowed(item, task) {
  const classification = classifyTaskOutputForContext(item?.output || {}, { isRepairTask: isValidationRepairTask(task) });
  return classification.promptAllowed !== false;
}

function isValidationRepairTask(task) {
  return task?.planTaskKey === 'repair-validation-failure'
    || task?.contract?.repairOf === 'validation-result';
}
function buildRepairValidationEvidence(predecessorOutputs) {
  if (!Array.isArray(predecessorOutputs) || predecessorOutputs.length === 0) {
    return [];
  }

  return predecessorOutputs
    .filter((item) => {
      const output = item?.output || {};
      return output.kind === 'validation-result'
        && output.name === 'validation-commands'
        && output.metadata?.trustState === 'failed';
    })
    .map((item) => ({
      predecessorTaskId: item.predecessorTaskId,
      predecessorTitle: item.predecessorTitle,
      content: item.output?.content,
      metadata: item.output?.metadata || {}
    }));
}

function formatRepairValidationEvidence(item) {
  const metadata = item.metadata || {};
  const failedCommand = metadata.failedCommand && typeof metadata.failedCommand === 'object'
    ? metadata.failedCommand
    : null;
  const commandSummary = failedCommand
    ? formatFailedValidationCommand(failedCommand)
    : normalizeOptionalText(item.content) || '无命令摘要';
  const parts = [
    item.predecessorTitle ? `task=${item.predecessorTitle}` : null,
    metadata.reasonCode ? `reasonCode=${metadata.reasonCode}` : null,
    commandSummary ? `command=${commandSummary}` : null
  ].filter(Boolean);

  return parts.join('；') || '验证失败证据可用，但缺少摘要。';
}

function formatFailedValidationCommand(command) {
  const args = Array.isArray(command.args) ? command.args.join(' ') : '';
  const commandText = [command.command, args].filter(Boolean).join(' ').trim()
    || command.script
    || command.id
    || 'unknown-command';
  const exit = command.timedOut ? 'timed out' : `exit ${command.exitCode ?? 'unknown'}`;
  return `${command.id ? `${command.id}: ` : ''}${commandText} (${exit})`;
}

function formatPredecessorOutput(item, index, indent = '', task = null) {
  const output = item.output || {};
  const classification = classifyTaskOutputForContext(output, { isRepairTask: isValidationRepairTask(task) });
  const name = output.name ? `/${output.name}` : '';
  const title = `${item.predecessorTitle}${item.predecessorTaskId ? ` (${item.predecessorTaskId})` : ''}`;
  const hygiene = formatHygieneDescriptor(classification);
  const suffix = hygiene ? `｜${hygiene}` : '';
  const lines = [`${indent}${index + 1}. ${title}｜${output.kind}${name}${output.outputId ? `｜${output.outputId}` : ''}${suffix}`];

  if (output.content) {
    lines.push(`${indent}   content: ${excerptText(output.content, 240)}`);
  }

  if (output.path) {
    lines.push(`${indent}   path: ${output.path}`);
  }

  const metadata = formatCompactJson(output.metadata);
  if (metadata) {
    lines.push(`${indent}   metadata: ${metadata}`);
  }

  return lines;
}

function formatCompactJson(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const text = JSON.stringify(value);
  return text && text !== '{}' ? excerptText(text, 200) : null;
}

function groupContextItems(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return {
      authoritativeExtras: [],
      upstream: [],
      recovery: [],
      related: [],
      reference: []
    };
  }

  const authoritativeExtras = items.filter((item) => item?.authority === 'authoritative' && !isBuiltInCurrentFact(item));
  const upstream = items.filter((item) => isUpstreamContextItem(item));
  const recovery = items.filter((item) => isRecoveryContextItem(item));
  const reference = items.filter((item) => item?.authority === 'reference');
  const related = items.filter((item) => {
    if (!item || item.authority !== 'adjacent') {
      return false;
    }

    return !isUpstreamContextItem(item) && !isRecoveryContextItem(item);
  });

  return {
    authoritativeExtras,
    upstream,
    recovery,
    related,
    reference
  };
}

function isBuiltInCurrentFact(item) {
  if (!item) {
    return false;
  }

  return item.kind === 'current-task'
    || item.kind === 'agent-identity'
    || item.kind === 'assignment'
    || hasSelectedBecause(item, 'current-handoff');
}

function isUpstreamContextItem(item) {
  if (!item) {
    return false;
  }

  return item.kind === 'predecessor-summary' || item.kind === 'predecessor-output' || hasSelectedBecause(item, 'predecessor-handoff');
}

function isRecoveryContextItem(item) {
  if (!item) {
    return false;
  }

  return item.kind === 'resume-hint' || item.kind === 'rerun-hint' || item.kind === 'last-error';
}

function hasSelectedBecause(item, reason) {
  return Array.isArray(item?.selectedBecause) && item.selectedBecause.includes(reason);
}

function pushContextItemSection(sections, title, items) {
  if (!Array.isArray(items) || items.length === 0) {
    return;
  }

  sections.push(title);
  for (const [index, item] of items.entries()) {
    sections.push(...formatPromptContextItem(item, index));
  }
  sections.push('');
}

function formatPromptContextItem(item, index, indent = '') {
  const hygiene = formatHygieneDescriptor(item);
  const suffix = hygiene ? `｜${hygiene}` : '';
  const summary = formatPromptText(item?.summary, 240, '无摘要。');
  const lines = [`${indent}${index + 1}. ${item?.title || '未命名上下文'}｜${summary}${suffix}`];
  const content = normalizeOptionalText(item?.content);

  if (content && content !== item?.summary) {
    lines.push(`${indent}   ${formatPromptText(content, 200)}`);
  }

  if (item?.kind === 'memory-summary' && item?.metadata?.matchedBy) {
    lines.push(`${indent}   matchedBy: ${formatMatchedBy(item.metadata.matchedBy)}`);
  }

  return lines;
}

function normalizePromptRules(value) {
  if (!Array.isArray(value) || value.length === 0) {
    return [];
  }

  return value
    .map((item) => {
      if (!item || typeof item !== 'object') {
        return null;
      }

      const text = normalizeOptionalText(item.text ?? item.rule ?? item.content ?? item.summary);
      if (!text) {
        return null;
      }

      return {
        title: normalizeOptionalText(item.title),
        text
      };
    })
    .filter(Boolean);
}

function formatPromptRule(rule) {
  return rule.title
    ? `${rule.title}｜${rule.text}`
    : rule.text;
}

function buildWorkflowClosurePolicyPromptRules(policy) {
  return [
    `遵守 workflow closure policy：${policy.closureMode}/${policy.verificationLevel}/${policy.docPolicy}/${policy.cleanupPolicy}。`,
    policy.closureMode === 'large_loop'
      ? '当前 workflow 已被分类为大闭环；允许处理明确跨边界影响，但仍只围绕当前任务推进。'
      : '优先走最小闭环；除非当前任务明确要求，否则不要主动跨边界扩 scope。',
    policy.verificationLevel === 'broad'
      ? '验证优先覆盖跨边界影响与更完整链路，不要只停留在单点自测。'
      : '验证优先只覆盖与当前变更直接相关的命令，不主动扩成全量回归。',
    policy.docPolicy === 'required'
      ? '文档更新属于必做范围；补齐与本次变更直接相关的说明。'
      : '只更新实现直接要求的最小文档，不补无关说明。',
    policy.cleanupPolicy === 'explicit_only'
      ? '只有在任务或证据明确要求时才做清理/重构/额外收尾。'
      : '不要顺手清理、机会主义重构或额外收尾。'
  ];
}

function buildFinalDeliverableReusePromptRules({ task, contract, predecessorOutputs, handoffContext }) {
  if (!shouldPreferFinalDeliverableReuse({ task, contract, predecessorOutputs, handoffContext })) {
    return [];
  }

  return [
    '当前任务更适合基于现有上游结果做收口交付：优先复用 validated 上游输出与交接信息，先整理、汇总、落盘，再补最少必要连接文字。',
    '除非缺少完成当前任务所必需的关键事实，否则不要从头重写整份最终文档，不要重复生成上游已经稳定的长文本。',
    '若上游已给出可复用的正文、片段、结论或 artifact 路径，优先直接组装为最终 taskOutputs/payload.outputs，并把最终 artifact 路径写入 payload.handoff.artifacts。'
  ];
}

function shouldPreferFinalDeliverableReuse({ task, contract, predecessorOutputs, handoffContext }) {
  const hasReusableUpstreamOutputs = Array.isArray(predecessorOutputs) && predecessorOutputs.length > 0;
  const hasPredecessorHandoff = Array.isArray(handoffContext?.predecessors) && handoffContext.predecessors.length > 0;

  if (!hasReusableUpstreamOutputs && !hasPredecessorHandoff) {
    return false;
  }

  const requiredArtifacts = Array.isArray(contract?.requiredArtifacts) && contract.requiredArtifacts.length > 0;
  const text = [task?.planTaskKey, task?.title, task?.description]
    .map((item) => normalizeOptionalText(item))
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  const looksLikeFinalDeliverableTask = requiredArtifacts
    || /final|deliverable|document|handoff|report|artifact|文档|最终|交付|收口|成稿/.test(text);

  return looksLikeFinalDeliverableTask;
}

function formatWorkflowClosureMode(value) {
  return value === 'large_loop'
    ? '明确跨边界的大闭环，可处理系统级影响，但仍只围绕当前任务推进。'
    : '默认最小闭环，优先局部完成，不主动跨边界扩 scope。';
}

function formatWorkflowVerificationLevel(value) {
  return value === 'broad'
    ? '优先做更完整的跨边界/链路级验证。'
    : '优先只跑与当前变更直接相关的 targeted 验证。';
}

function formatWorkflowDocPolicy(value) {
  return value === 'required'
    ? '补齐本次变更直接需要的文档说明。'
    : '只做最小必要文档更新。';
}

function formatWorkflowCleanupPolicy(value) {
  return value === 'explicit_only'
    ? '只有明确要求时才做清理或额外收尾。'
    : '默认推迟顺手清理，不做额外重构。';
}

function buildDefaultAssignment(task) {
  const assignment = normalizeAssignment({
    ownerAgentId: task.ownerAgentId,
    preferredRole: task.preferredRole,
    requiredCapabilities: task.requiredCapabilities,
    assignmentStatus: task.assignmentStatus,
    assignmentReason: task.assignmentReason
  });

  return assignment && hasAssignmentContent(assignment) ? assignment : null;
}

function buildDefaultHandoffContext(task, tasks, dependencies) {
  const current = normalizeStructuredHandoff(task.handoff);
  const predecessors = dependencies
    .filter((dependency) => dependency.successorTaskId === task.taskId)
    .map((dependency) => tasks.find((item) => item.taskId === dependency.predecessorTaskId))
    .filter((item) => item?.status === 'done')
    .map((item) => ({
      title: item.title,
      doneSummary: item.doneSummary || '无完成摘要。',
      handoff: normalizeStructuredHandoff(item.handoff)
    }))
    .filter((item) => item.handoff);

  if (!current && predecessors.length === 0) {
    return null;
  }

  return { current, predecessors };
}

function normalizeAgentIdentity(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const visibility = normalizeVisibility(value.visibility);
  const identity = {
    agentId: normalizeOptionalText(value.agentId || value.id),
    name: normalizeOptionalText(value.name),
    role: normalizeOptionalText(value.role),
    capabilities: normalizeStringArray(value.capabilities),
    visibility
  };

  return identity.agentId || identity.name || identity.role || identity.capabilities.length > 0 || visibility
    ? identity
    : null;
}

function normalizeExecutionContext(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const tools = normalizeToolVisibilityList(value.tools);
  const memory = normalizeMemoryBoundary(value.memory);
  const workspace = normalizeWorkspaceContext(value.workspace);

  return tools.length > 0 || memory || workspace
    ? { tools, memory, workspace }
    : null;
}

function normalizeVisibility(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const tools = normalizeToolVisibilityList(value.tools);
  const memory = normalizeMemoryBoundary(value.memory);
  const workspace = normalizeWorkspaceContext(value.workspace);

  return tools.length > 0 || memory || workspace
    ? { tools, memory, workspace }
    : null;
}

function normalizeToolVisibilityList(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => normalizeToolVisibility(item))
    .filter(Boolean);
}

function normalizeToolVisibility(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const tool = {
    name: normalizeOptionalText(value.name) || normalizeOptionalText(value.tool),
    purpose: normalizeOptionalText(value.purpose) || normalizeOptionalText(value.description),
    when: normalizeOptionalText(value.when) || normalizeOptionalText(value.usage),
    limits: normalizeOptionalText(value.limits) || normalizeOptionalText(value.boundary)
  };

  return tool.name || tool.purpose || tool.when || tool.limits
    ? tool
    : null;
}

function normalizeMemoryBoundary(value) {
  if (value == null) {
    return null;
  }

  if (value === false) {
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

  if (typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const memory = {
    enabled: value.enabled !== false,
    scope: normalizeOptionalText(value.scope),
    projectKey: normalizeOptionalText(value.projectKey),
    workspacePath: normalizeOptionalText(value.workspacePath),
    sessionId: normalizeOptionalText(value.sessionId),
    limit: normalizeOptionalInteger(value.limit),
    query: value.query && typeof value.query === 'object' && !Array.isArray(value.query) ? value.query : null,
    recalledCount: normalizeOptionalInteger(value.recalledCount, true)
  };

  return memory.enabled === false
    || memory.scope
    || memory.projectKey
    || memory.workspacePath
    || memory.sessionId
    || memory.limit != null
    || memory.query
    || memory.recalledCount != null
    ? memory
    : null;
}

function normalizeWorkspaceContext(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const workspace = {
    cwd: normalizeOptionalText(value.cwd),
    path: normalizeOptionalText(value.path),
    artifacts: normalizeOptionalText(value.artifacts),
    notes: normalizeOptionalText(value.notes)
  };

  return workspace.cwd || workspace.path || workspace.artifacts || workspace.notes
    ? workspace
    : null;
}

function normalizeAssignment(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }

  return {
    ownerAgentId: normalizeOptionalText(value.ownerAgentId),
    preferredRole: normalizeOptionalText(value.preferredRole),
    requiredCapabilities: normalizeStringArray(value.requiredCapabilities),
    assignmentStatus: normalizeOptionalText(value.assignmentStatus),
    assignmentReason: normalizeOptionalText(value.assignmentReason)
  };
}

function hasAssignmentContent(assignment) {
  return Boolean(
    assignment.ownerAgentId
    || assignment.preferredRole
    || assignment.assignmentStatus
    || assignment.assignmentReason
    || assignment.requiredCapabilities.length > 0
  );
}

function normalizeHandoffContext(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const current = normalizeStructuredHandoff(value.current);
  const predecessors = Array.isArray(value.predecessors)
    ? value.predecessors
      .map((item) => ({
        title: normalizeOptionalText(item?.title) || '上游任务',
        doneSummary: normalizeOptionalText(item?.doneSummary) || '无完成摘要。',
        handoff: normalizeStructuredHandoff(item?.handoff)
      }))
      .filter((item) => item.handoff)
    : [];

  if (!current && predecessors.length === 0) {
    return null;
  }

  return { current, predecessors };
}

function normalizeStructuredHandoff(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const handoff = {
    summary: normalizeOptionalText(value.summary),
    artifacts: normalizeStringArray(value.artifacts),
    decisions: normalizeStringArray(value.decisions),
    openQuestions: normalizeStringArray(value.openQuestions),
    risks: normalizeStringArray(value.risks),
    recommendedNextRole: normalizeOptionalText(value.recommendedNextRole)
  };

  return handoff.summary
    || handoff.artifacts.length > 0
    || handoff.decisions.length > 0
    || handoff.openQuestions.length > 0
    || handoff.risks.length > 0
    || handoff.recommendedNextRole
    ? handoff
    : null;
}

function formatStructuredHandoff(handoff, indent, fallbackSummary) {
  const lines = [];
  const summary = formatPromptText(handoff?.summary || fallbackSummary, 240, '无');
  lines.push(`${indent}summary: ${summary}`);

  if (handoff?.artifacts?.length > 0) {
    lines.push(`${indent}artifacts: ${handoff.artifacts.map((item) => formatPromptText(item, 160)).join('；')}`);
  }

  if (handoff?.decisions?.length > 0) {
    lines.push(`${indent}decisions: ${handoff.decisions.map((item) => formatPromptText(item, 160)).join('；')}`);
  }

  if (handoff?.openQuestions?.length > 0) {
    lines.push(`${indent}openQuestions: ${handoff.openQuestions.map((item) => formatPromptText(item, 160)).join('；')}`);
  }

  if (handoff?.risks?.length > 0) {
    lines.push(`${indent}risks: ${handoff.risks.map((item) => formatPromptText(item, 160)).join('；')}`);
  }

  if (handoff?.recommendedNextRole) {
    lines.push(`${indent}recommendedNextRole: ${formatPromptText(handoff.recommendedNextRole, 80)}`);
  }

  return lines;
}

function formatExecutionTool(tool, index) {
  const lines = [`  ${index + 1}. ${tool.name || '未命名工具'}`];

  if (tool.purpose) {
    lines.push(`     用途: ${tool.purpose}`);
  }
  if (tool.when) {
    lines.push(`     使用时机: ${tool.when}`);
  }
  if (tool.limits) {
    lines.push(`     边界: ${tool.limits}`);
  }

  return lines;
}

function formatExecutionMemoryLine(memory) {
  if (memory.enabled === false) {
    return '已禁用';
  }

  return [
    memory.scope ? `scope=${memory.scope}` : null,
    memory.projectKey ? `project=${memory.projectKey}` : null,
    memory.workspacePath ? `workspace=${memory.workspacePath}` : null,
    memory.limit != null ? `limit=${memory.limit}` : null,
    `recalled=${memory.recalledCount ?? 0}`
  ].filter(Boolean).join('｜') || '已启用';
}

function formatExecutionMemoryDetails(memory) {
  return [
    `  - sessionId: ${memory.sessionId || '无'}`,
    `  - query: ${formatExecutionMemoryQuery(memory.query)}`
  ];
}

function formatExecutionMemoryQuery(query) {
  if (!query || typeof query !== 'object') {
    return '无';
  }

  return [
    query.text ? `text=${query.text}` : null,
    query.scope ? `scope=${query.scope}` : null,
    query.projectKey ? `projectKey=${query.projectKey}` : null,
    query.workspacePath ? `workspacePath=${query.workspacePath}` : null,
    query.sessionId ? `sessionId=${query.sessionId}` : null,
    query.limit != null ? `limit=${query.limit}` : null
  ].filter(Boolean).join('｜') || '已生成 recall query';
}

function formatExecutionWorkspaceLine(workspace) {
  return [
    workspace.cwd ? `cwd=${workspace.cwd}` : null,
    workspace.path ? `path=${workspace.path}` : null,
    workspace.artifacts ? `artifacts=${workspace.artifacts}` : null
  ].filter(Boolean).join('｜') || '已声明';
}

function formatExecutionWorkspaceDetails(workspace) {
  return [
    `  - notes: ${workspace.notes || '无'}`
  ];
}

function formatPromptMemoryItem(item, index) {
  const lines = [`${index + 1}. ${formatMemoryItem(item)}`];

  if (item?.matchedBy) {
    lines.push(`   matchedBy: ${formatMatchedBy(item.matchedBy)}`);
  }

  return lines;
}

function formatMemoryItem(item) {
  const hygiene = formatHygieneDescriptor(item);
  const parts = [item.title || '未命名记忆'];
  if (item.summary) {
    parts.push(formatPromptText(item.summary, 160));
  }
  if (hygiene) {
    parts.push(hygiene);
  }
  if (item.content && item.content !== item.summary) {
    parts.push(formatPromptText(item.content, 160));
  }
  return parts.join('｜');
}

function formatHygieneSummary(summary) {
  if (!summary || typeof summary !== 'object') {
    return '无';
  }

  const labels = Object.entries(summary.byLabel || {})
    .filter(([, count]) => count > 0)
    .map(([label, count]) => `${label}=${count}`);
  const blocked = summary.promptBlockedCount > 0 ? `promptBlocked=${summary.promptBlockedCount}` : null;
  const quarantined = summary.quarantinedCount > 0 ? `quarantined=${summary.quarantinedCount}` : null;

  return [
    `included=${summary.includedCount || 0}/${summary.candidateCount || 0}`,
    ...labels,
    blocked,
    quarantined
  ].filter(Boolean).join(', ');
}

function formatHygieneDescriptor(item) {
  const hygiene = item?.metadata?.hygiene && typeof item.metadata.hygiene === 'object'
    ? item.metadata.hygiene
    : {};
  const label = normalizeOptionalText(item?.hygieneLabel || hygiene.hygieneLabel);
  const source = normalizeOptionalText(item?.sourceClass || hygiene.sourceClass);
  const use = normalizeOptionalText(item?.allowedUse || hygiene.allowedUse);

  if (!label && !source && !use) {
    return null;
  }

  return [
    label ? `hygiene=${label}` : null,
    source ? `source=${source}` : null,
    use ? `use=${use}` : null
  ].filter(Boolean).join('；');
}

function formatMatchedBy(value) {
  if (!value) {
    return 'unknown';
  }

  if (typeof value === 'string') {
    return value;
  }

  if (typeof value !== 'object' || Array.isArray(value)) {
    return String(value);
  }

  const parts = [];
  if (value.exactSourceRef) {
    parts.push('exact-source-ref');
  }
  if (value.semantic) {
    parts.push('semantic');
  }
  if (value.text) {
    parts.push('text');
  }
  if (Array.isArray(value.filters) && value.filters.length > 0) {
    parts.push(`filters=${value.filters.join(',')}`);
  }
  if (value.label) {
    parts.push(value.label);
  }

  return parts.length > 0 ? parts.join(', ') : 'unknown';
}

function formatTaskLastError(task) {
  return formatPromptText(task?.lastError, 240, '无');
}

function formatPromptText(value, maxLength = 120, emptyText = '无') {
  const text = normalizeOptionalText(value);
  if (!text) {
    return emptyText;
  }

  const transientSummary = formatTransientClaudeError(text);
  if (transientSummary) {
    return transientSummary;
  }

  return excerptText(text, maxLength);
}

function formatTransientClaudeError(lastError) {
  const text = normalizeOptionalText(lastError);
  if (!text) {
    return null;
  }

  if (/\b502\b/.test(text) && /upstream_error|Upstream request failed/i.test(text)) {
    return 'Claude upstream 502/upstream_error；按临时上游失败处理，不要复述完整错误正文。';
  }

  if (/timed?\s*out|timeout/i.test(text)) {
    return '执行超时；按上次运行耗时过长处理，不要复述完整错误正文。';
  }

  return null;
}

function excerptText(value, maxLength = 120) {
  const text = normalizeOptionalText(value);
  if (!text) {
    return '无';
  }

  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 3)}...`;
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => normalizeOptionalText(item))
    .filter(Boolean);
}

function normalizeOptionalInteger(value, allowZero = false) {
  if (value == null) {
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

function normalizeTaskContract(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const contract = {
    successCriteria: normalizeStringArray(value.successCriteria),
    requiredArtifacts: normalizeStringArray(value.requiredArtifacts),
    forbiddenActions: normalizeStringArray(value.forbiddenActions),
    assumptionsPolicy: normalizeAssumptionsPolicy(value.assumptionsPolicy),
    validationCommands: normalizeValidationCommands(value.validationCommands)
  };

  return contract.successCriteria.length > 0
    || contract.requiredArtifacts.length > 0
    || contract.forbiddenActions.length > 0
    || contract.assumptionsPolicy
    || contract.validationCommands.length > 0
    ? contract
    : null;
}

function normalizeValidationCommands(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        return null;
      }

      const command = normalizeOptionalText(item.command);
      if (!command) {
        return null;
      }

      return {
        id: normalizeOptionalText(item.id),
        command,
        args: normalizeStringArray(item.args),
        script: normalizeOptionalText(item.script),
        cwd: normalizeOptionalText(item.cwd),
        required: item.required !== false,
        timeoutMs: item.timeoutMs == null ? null : Number(item.timeoutMs),
        reason: normalizeOptionalText(item.reason)
      };
    })
    .filter(Boolean);
}

function normalizeAssumptionsPolicy(value) {
  if (value == null) {
    return null;
  }

  const normalized = String(value).trim();
  if (!normalized) {
    return null;
  }

  return normalized === 'block_on_missing_information' || normalized === 'allow_reasonable_assumptions'
    ? normalized
    : null;
}

function formatValidationCommand(command) {
  const args = command.args.length > 0 ? ` ${command.args.join(' ')}` : '';
  const required = command.required ? 'required' : 'optional';
  const reason = command.reason ? `｜${command.reason}` : '';
  const cwd = command.cwd ? `｜cwd=${command.cwd}` : '';
  return `${command.command}${args}｜${required}${reason}${cwd}`;
}

function formatAssumptionsPolicy(value) {
  if (value === 'block_on_missing_information') {
    return '信息不足时必须阻塞，不能自行假设';
  }

  if (value === 'allow_reasonable_assumptions') {
    return '信息不足时可做合理假设，但应在结果中明确说明';
  }

  return '未指定';
}

function resolveWorkflowClosurePolicy(explicit, metadata) {
  const source = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? metadata
    : explicit && typeof explicit === 'object' && !Array.isArray(explicit)
      ? explicit
      : null;

  return {
    closureMode: normalizeWorkflowClosureMode(source?.closureMode),
    verificationLevel: normalizeWorkflowVerificationLevel(source?.verificationLevel),
    docPolicy: normalizeWorkflowDocPolicy(source?.docPolicy),
    cleanupPolicy: normalizeWorkflowCleanupPolicy(source?.cleanupPolicy)
  };
}

function normalizeWorkflowClosureMode(value) {
  return value === 'large_loop' ? 'large_loop' : DEFAULT_WORKFLOW_CLOSURE_POLICY.closureMode;
}

function normalizeWorkflowVerificationLevel(value) {
  return value === 'broad' ? 'broad' : DEFAULT_WORKFLOW_CLOSURE_POLICY.verificationLevel;
}

function normalizeWorkflowDocPolicy(value) {
  return value === 'required' ? 'required' : DEFAULT_WORKFLOW_CLOSURE_POLICY.docPolicy;
}

function normalizeWorkflowCleanupPolicy(value) {
  return value === 'explicit_only' ? 'explicit_only' : DEFAULT_WORKFLOW_CLOSURE_POLICY.cleanupPolicy;
}

function normalizeOptionalText(value) {
  if (value == null) {
    return null;
  }

  const text = String(value).trim();
  return text || null;
}
