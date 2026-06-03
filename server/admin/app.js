import { AdminApiRoutes } from './api-routes.js';
import {
  createRuntimeRecoverySelector,
  formatRuntimeDbScope
} from './db-scope-config.js';

const DEFAULT_RECOVERY_WORKER_ID = 'claude-main';
const DEFAULT_RECOVERY_LEASE_MS = 600_000;

const state = {
  selectedAgentId: null,
  selectedAssignmentId: null,
  selectedHandoffId: null,
  selectedTimelineEventId: null,
  selectedMemoryId: null,
  latest: null,
  chainDetailsById: {},
  workflowDetailsById: {},
  workflowMemoryByKey: {},
  memoryDetailsById: {},
  refreshTimerId: null,
  refreshIntervalMs: 0,
  isRefreshing: false,
  liveConnection: {
    source: null,
    key: '',
    status: 'idle',
    lastEventType: null,
    lastEventAt: null,
    heartbeatAt: null,
    error: null
  },
  filters: {
    workflowId: '',
    chainId: '',
    blockedOnly: false,
    includeTestData: false,
    includeHistory: false
  }
};

const statusBar = document.querySelector('#status-bar');
const overviewGrid = document.querySelector('#overview-grid');
const agentsList = document.querySelector('#agents-list');
const assignmentsList = document.querySelector('#assignments-list');
const handoffsList = document.querySelector('#handoffs-list');
const detailsOutput = document.querySelector('#details-output');
const detailsSummary = document.querySelector('#details-summary');
const detailsMeta = document.querySelector('#details-meta');
const selectionLabel = document.querySelector('#selection-label');
const agentsCount = document.querySelector('#agents-count');
const assignmentsCount = document.querySelector('#assignments-count');
const handoffsCount = document.querySelector('#handoffs-count');
const reassignAgentSelect = document.querySelector('#reassign-agent-select');
const workflowIdFilterInput = document.querySelector('#workflow-id-filter');
const chainIdFilterInput = document.querySelector('#chain-id-filter');
const blockedOnlyFilterInput = document.querySelector('#blocked-only-filter');
const includeTestDataFilterInput = document.querySelector('#include-test-data-filter');
const includeHistoryFilterInput = document.querySelector('#include-history-filter');
const rawDetailsToggle = document.querySelector('#raw-details-toggle');
const autoRefreshSelect = document.querySelector('#auto-refresh-select');

const refreshButton = document.querySelector('#refresh-button');
const assignButton = document.querySelector('#assign-button');
const runButton = document.querySelector('#run-button');
const resumeButton = document.querySelector('#resume-button');
const reassignButton = document.querySelector('#reassign-button');
const applyFiltersButton = document.querySelector('#apply-filters-button');
const clearFiltersButton = document.querySelector('#clear-filters-button');

refreshButton.addEventListener('click', () => refresh());
assignButton.addEventListener('click', () => postAction(AdminApiRoutes.paths.assignNextWork, buildActionContext()));
runButton.addEventListener('click', () => postAction(AdminApiRoutes.paths.runNextAssignment, buildActionContext()));
resumeButton.addEventListener('click', () => runResume('resume'));
reassignButton.addEventListener('click', () => runResume('reassign'));
applyFiltersButton.addEventListener('click', () => applyFilters());
clearFiltersButton.addEventListener('click', () => clearFilters());
rawDetailsToggle.addEventListener('change', () => renderDetails());
autoRefreshSelect.addEventListener('change', () => setAutoRefreshInterval(Number(autoRefreshSelect.value) || 0));
window.addEventListener('beforeunload', () => {
  stopAutoRefresh();
  stopLiveUpdates();
});
workflowIdFilterInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    applyFilters();
  }
});
chainIdFilterInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    applyFilters();
  }
});

syncFilterInputs();
syncAutoRefreshInput();
await refresh();

async function refresh() {
  if (state.isRefreshing) {
    return;
  }

  state.isRefreshing = true;
  setStatus('Loading coordinator state...');

  try {
    const payload = await fetchJson(AdminApiRoutes.coordinatorState(buildStateQueryParams()));
    state.latest = payload;
    syncSelection(payload);
    render(payload);
    await ensureSelectedObservabilityDetails();
    ensureSelectedTimelineEvent();
    renderDetails();
    syncLiveUpdates();
    setStatus(buildRefreshStatus(payload));
  } catch (error) {
    setStatus(`Refresh failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    state.isRefreshing = false;
  }
}

async function postAction(url, body) {
  setStatus('Running action...');

  try {
    const payload = await fetchJson(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify(body)
    });
    state.latest = payload;
    syncSelection(payload);
    render(payload);
    await ensureSelectedObservabilityDetails(true);
    ensureSelectedTimelineEvent();
    renderDetails();
    syncLiveUpdates();
    setStatus(`Action status: ${payload.status}`);
  } catch (error) {
    setStatus(`Action failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function runResume(mode) {
  const assignment = getSelectedAssignment();
  if (!assignment) {
    setStatus('Select a blocked assignment first.');
    return;
  }

  if (assignment.status !== 'blocked') {
    setStatus('Selected assignment is not blocked.');
    return;
  }

  let agentId = assignment.agentId;
  if (mode === 'reassign') {
    agentId = reassignAgentSelect.value || '';
    if (!agentId) {
      setStatus('Select a target implementer before reassign.');
      return;
    }
  }

  await postAction(AdminApiRoutes.paths.resumeAssignedWork, {
    ...buildActionContext(),
    assignmentId: assignment.assignmentId,
    targetType: assignment.targetType,
    workflowId: assignment.workflowId,
    chainId: assignment.chainId,
    taskId: assignment.taskId,
    stageId: assignment.stageId,
    agentId,
    mode,
    runNow: false
  });
}

function render(payload) {
  renderOverview(payload.summary || {});
  renderAgents(payload.agents || []);
  renderAssignments(payload.assignments || []);
  renderHandoffs(payload.handoffs || []);
  renderReassignOptions(payload.agents || []);
  renderDetails();
}

function renderOverview(summary) {
  const cards = [
    ['Active agents', summary.agentCountsByStatus?.active ?? 0],
    ['Open assignments', (summary.assignmentCountsByStatus?.assigned ?? 0) + (summary.assignmentCountsByStatus?.accepted ?? 0)],
    ['Blocked assignments', summary.assignmentCountsByStatus?.blocked ?? 0],
    ['Open handoffs', summary.openHandoffCount ?? 0],
    ['Next target', summary.nextTargetTitle || '-']
  ];

  overviewGrid.innerHTML = cards.map(([label, value]) => `
    <article class="overview-card">
      <div class="overview-label">${escapeHtml(label)}</div>
      <div class="overview-value">${escapeHtml(String(value))}</div>
    </article>
  `).join('');
}

function renderAgents(agents) {
  agentsCount.textContent = `${agents.length} items`;
  agentsList.innerHTML = agents.map((agent) => `
    <button class="list-item ${agent.agentId === state.selectedAgentId ? 'selected' : ''}" type="button" data-kind="agent" data-id="${escapeHtml(agent.agentId)}">
      <div class="list-title-row">
        <strong>${escapeHtml(agent.name || agent.agentId)}</strong>
        <span class="badge">${escapeHtml(agent.status || 'unknown')}</span>
      </div>
      <div class="list-meta">${escapeHtml(agent.role || '-')} · active assignments ${escapeHtml(String(agent.activeAssignmentCount || 0))}</div>
    </button>
  `).join('');
  bindSelections(agentsList);
}

function renderAssignments(assignments) {
  const summary = state.latest?.summary || {};
  const current = assignments.filter((assignment) => assignment.historyKind !== 'history');
  const history = assignments.filter((assignment) => assignment.historyKind === 'history');
  const currentCount = summary.currentAssignmentCount ?? current.length;
  const historyCount = summary.historyAssignmentCount ?? history.length;
  const blocked = current.filter((assignment) => assignment.status === 'blocked');
  const active = current.filter((assignment) => assignment.status !== 'blocked');
  assignmentsCount.textContent = state.filters.includeHistory
    ? `${currentCount} current · ${historyCount} history`
    : `${currentCount} current${historyCount > 0 ? ` · ${historyCount} history hidden` : ''}`;

  assignmentsList.innerHTML = [
    renderAssignmentSection('Blocked current', blocked, true),
    renderAssignmentSection('Active', active, false),
    state.filters.includeHistory ? renderAssignmentSection('History / Audit', history, false, true) : ''
  ].filter(Boolean).join('');

  bindSelections(assignmentsList);
}

function renderAssignmentSection(label, assignments, highlight, history = false) {
  if (assignments.length === 0) {
    return '';
  }

  return `
    <section class="assignment-section">
      <div class="section-label ${highlight ? 'danger' : ''}">${escapeHtml(label)} · ${escapeHtml(String(assignments.length))}</div>
      <div class="assignment-section-list">
        ${assignments.map((assignment) => renderAssignmentItem(assignment, highlight, history)).join('')}
      </div>
    </section>
  `;
}

function renderAssignmentItem(assignment, highlight, history = false) {
  const badgeText = history || assignment.historyKind === 'history'
    ? `${assignment.status || 'unknown'} · history`
    : assignment.status || 'unknown';
  const meta = compactParts([
    assignment.targetType || '-',
    assignment.agentId || 'unassigned',
    assignment.targetStatus ? `target ${assignment.targetStatus}` : null,
    assignment.historyKind === 'history' ? assignment.historyReason : null
  ]);
  return `
    <button class="list-item ${assignment.assignmentId === state.selectedAssignmentId ? 'selected' : ''} ${highlight ? 'blocked-item' : ''}" type="button" data-kind="assignment" data-id="${escapeHtml(assignment.assignmentId)}">
      <div class="list-title-row">
        <strong>${escapeHtml(assignment.title || assignment.assignmentId)}</strong>
        <span class="badge ${assignment.status === 'blocked' && assignment.historyKind !== 'history' ? 'danger' : ''}">${escapeHtml(badgeText)}</span>
      </div>
      <div class="list-meta">${escapeHtml(meta)}</div>
    </button>
  `;
}

function renderHandoffs(handoffs) {
  const summary = state.latest?.summary || {};
  const current = handoffs.filter((handoff) => handoff.historyKind !== 'history');
  const history = handoffs.filter((handoff) => handoff.historyKind === 'history');
  const currentCount = summary.currentHandoffCount ?? current.length;
  const historyCount = summary.historyHandoffCount ?? history.length;
  const classifiedCurrent = current.map((handoff) => ({ handoff, display: classifyHandoffForDisplay(handoff) }));
  const actionable = classifiedCurrent.filter((item) => item.display.lane === 'actionable');
  const noisy = classifiedCurrent.filter((item) => item.display.lane !== 'actionable');
  handoffsCount.textContent = state.filters.includeHistory
    ? `${actionable.length} clean · ${noisy.length} noisy · ${historyCount} history`
    : `${actionable.length} clean · ${noisy.length} noisy${historyCount > 0 ? ` · ${historyCount} history hidden` : ''}`;
  handoffsList.innerHTML = [
    renderHandoffSection('Actionable open', actionable),
    renderHandoffSection('Needs cleanup / noisy', noisy, true),
    state.filters.includeHistory ? renderHandoffSection('History / Audit', history.map((handoff) => ({ handoff, display: classifyHandoffForDisplay(handoff) })), false, true) : '',
    currentCount === 0 && historyCount === 0 ? renderEmptyState('No handoffs match the current filters.') : ''
  ].filter(Boolean).join('');
  bindSelections(handoffsList);
}

function renderHandoffSection(label, items, warning = false, history = false) {
  if (items.length === 0) {
    return '';
  }

  return `
    <section class="assignment-section">
      <div class="section-label ${warning ? 'danger' : ''}">${escapeHtml(label)} · ${escapeHtml(String(items.length))}</div>
      <div class="assignment-section-list">
        ${items.map((item) => renderHandoffItem(item.handoff, item.display, history)).join('')}
      </div>
    </section>
  `;
}

function renderHandoffItem(handoff, display = classifyHandoffForDisplay(handoff), history = false) {
  const badgeText = history || handoff.historyKind === 'history'
    ? `${handoff.status || 'unknown'} · history`
    : handoff.status || 'unknown';
  const source = compactParts([
    handoff.sourceType || null,
    handoff.sourceId || null
  ]) || '-';
  const meta = compactParts([
    `${handoff.fromAgentId || '-'} → ${handoff.toAgentId || handoff.recommendedNextRole || '-'}`,
    `source ${source}`,
    handoff.targetStatus ? `target ${handoff.targetStatus}` : null,
    handoff.historyKind === 'history' ? handoff.historyReason : null
  ]);
  return `
    <button class="list-item ${handoff.handoffId === state.selectedHandoffId ? 'selected' : ''} ${display.lane === 'attention' ? 'blocked-item' : ''}" type="button" data-kind="handoff" data-id="${escapeHtml(handoff.handoffId)}">
      <div class="list-title-row">
        <strong>${escapeHtml(truncateText(handoff.summary || handoff.handoffId, 96))}</strong>
        <span class="badge ${display.tone === 'danger' ? 'danger' : ''}">${escapeHtml(badgeText)}</span>
      </div>
      <div class="list-meta">${escapeHtml(meta)}</div>
      <div class="handoff-signal-row">
        ${display.signals.map((signal) => `<span class="signal-chip ${signal.tone}">${escapeHtml(signal.label)}</span>`).join('')}
      </div>
    </button>
  `;
}

function classifyHandoffForDisplay(handoff) {
  const signals = [];
  const structuredCount = getHandoffStructuredSignalCount(handoff);
  const status = String(handoff?.status || '').toLowerCase();
  const targetStatus = String(handoff?.targetStatus || '').toLowerCase();
  const workflowStatus = String(handoff?.targetWorkflowStatus || '').toLowerCase();

  if (handoff?.historyKind === 'history') {
    signals.push({ label: handoff.historyReason || 'history', tone: 'muted' });
  }

  if (status && status !== 'open') {
    signals.push({ label: `status ${status}`, tone: 'muted' });
  }

  const isTerminalTarget = ['done', 'completed', 'cancelled', 'canceled', 'failed', 'skipped'].includes(targetStatus);
  const isTerminalWorkflow = ['done', 'completed', 'cancelled', 'canceled', 'failed', 'skipped'].includes(workflowStatus);

  if (isTerminalTarget) {
    signals.push({ label: `target ${targetStatus}`, tone: 'muted' });
  }

  if (isTerminalWorkflow) {
    signals.push({ label: `workflow ${workflowStatus}`, tone: 'muted' });
  }

  if (!handoff?.toAgentId && !handoff?.recommendedNextRole) {
    signals.push({ label: 'no route', tone: 'danger' });
  }

  if (structuredCount === 0) {
    signals.push({ label: 'summary only', tone: 'warning' });
  } else {
    signals.push({ label: `${structuredCount} structured fields`, tone: 'success' });
  }

  if (handoff?.artifactRefs?.length) {
    signals.push({ label: `${handoff.artifactRefs.length} refs`, tone: 'success' });
  }

  const hasDanger = signals.some((signal) => signal.tone === 'danger' || signal.tone === 'warning');
  const lane = handoff?.historyKind === 'history' || status !== 'open' || isTerminalTarget || isTerminalWorkflow || hasDanger
    ? 'attention'
    : 'actionable';

  return {
    lane,
    tone: hasDanger ? 'danger' : 'info',
    signals: signals.length > 0 ? signals : [{ label: 'clean', tone: 'success' }]
  };
}

function getHandoffStructuredSignalCount(handoff) {
  return [
    handoff?.artifacts,
    handoff?.artifactRefs,
    handoff?.decisions,
    handoff?.openQuestions,
    handoff?.risks,
    handoff?.recommendedNextRole
  ].filter((value) => Array.isArray(value) ? value.length > 0 : Boolean(value)).length;
}

function renderReassignOptions(agents) {
  const selectedAssignment = getSelectedAssignment();
  const currentAgentId = selectedAssignment?.agentId || '';
  const implementers = agents.filter((agent) => agent.role === 'implementer' && agent.status === 'active');
  const nextValue = reassignAgentSelect.value;

  reassignAgentSelect.innerHTML = [
    '<option value="">Select target agent</option>',
    ...implementers.map((agent) => {
      const isCurrent = agent.agentId === currentAgentId;
      return `<option value="${escapeHtml(agent.agentId)}">${escapeHtml(agent.name || agent.agentId)}${isCurrent ? ' (current)' : ''}</option>`;
    })
  ].join('');

  if (selectedAssignment?.status === 'blocked') {
    const preferredAgent = implementers.find((agent) => agent.agentId !== currentAgentId)?.agentId || currentAgentId;
    reassignAgentSelect.value = implementers.some((agent) => agent.agentId === nextValue)
      ? nextValue
      : (preferredAgent || '');
  } else {
    reassignAgentSelect.value = '';
  }

  reassignAgentSelect.disabled = implementers.length === 0;
}

function bindSelections(root) {
  root.querySelectorAll('[data-kind]').forEach((node) => {
    node.addEventListener('click', () => {
      if (node.dataset.kind === 'agent') {
        state.selectedAgentId = node.dataset.id;
        state.selectedAssignmentId = null;
        state.selectedHandoffId = null;
        state.selectedTimelineEventId = null;
        state.selectedMemoryId = null;
      } else if (node.dataset.kind === 'assignment') {
        state.selectedAssignmentId = node.dataset.id;
        state.selectedAgentId = null;
        state.selectedHandoffId = null;
        state.selectedTimelineEventId = null;
        state.selectedMemoryId = null;
      } else if (node.dataset.kind === 'handoff') {
        state.selectedHandoffId = node.dataset.id;
        state.selectedAgentId = null;
        state.selectedAssignmentId = null;
        state.selectedTimelineEventId = null;
        state.selectedMemoryId = null;
      }
      render(state.latest);
      void ensureSelectedObservabilityDetails().then(() => {
        ensureSelectedTimelineEvent();
        renderDetails();
        syncLiveUpdates();
      });
    });
  });
}

function renderSelectionDetails(entity, chainDetails, workflowDetails, workflowMemory, summaryLabel, metaText, blockTitle) {
  const workflowId = getSelectedWorkflowId();
  const taskId = entity?.taskId || null;
  const memoryDetails = getSelectedMemoryDetails();
  return {
    summaryHtml: [
      renderDetailsBlock(blockTitle, renderKeyValueSummary([
        ['Title', entity?.title || entity?.summary || summaryLabel],
        ['Status', entity?.status || 'unknown'],
        ['Target type', entity?.targetType || '-'],
        ['Agent', entity?.agentId || entity?.toAgentId || 'unassigned'],
        ['Workflow ID', workflowId || entity?.workflowId || '-'],
        ['Chain ID', entity?.chainId || '-'],
        ['Stage ID', entity?.stageId || '-'],
        ['Task ID', taskId || '-'],
        ['Chain status', chainDetails?.chain?.status || '-'],
        ['Workflow status', workflowDetails?.workflow?.status || '-']
      ])),
      renderWorkflowRecoveryCard({ workflowId, taskId, runtime: resolveRuntimeDbMetadata(workflowDetails) }),
      renderDetailsBlock('Live execution', renderLiveExecutionStrip(chainDetails, workflowDetails, {
        stageId: entity?.stageId || null,
        taskId
      })),
      renderDetailsBlock('Claude windows / workers', renderWorkflowMonitor(workflowDetails)),
      renderDetailsBlock('Execution timeline', renderExecutionTimeline(chainDetails, workflowDetails, {
        stageId: entity?.stageId || null,
        taskId
      })),
      renderDetailsBlock('Event inspector', renderTimelineEventInspector(chainDetails, workflowDetails)),
      renderDetailsBlock('Chain graph', renderChainGraph(chainDetails, entity?.stageId || null)),
      renderDetailsBlock('Workflow DAG', renderWorkflowDag(workflowDetails, {
        workflowId,
        selectedTaskId: taskId
      })),
      renderDetailsBlock('Memory lineage', renderMemoryLineage(workflowMemory, {
        selectedTaskId: taskId,
        selectedMemoryId: state.selectedMemoryId
      })),
      renderDetailsBlock('Memory inspector', renderMemoryInspector(workflowMemory, memoryDetails)),
      renderDetailsBlock('Chain stages', renderChainStages(chainDetails, entity?.stageId || null))
    ].join(''),
    rawPayload: {
      entity,
      chainState: chainDetails || null,
      workflowState: workflowDetails || null,
      workflowMemory: workflowMemory || null,
      selectedMemoryState: memoryDetails || null,
      liveConnection: state.liveConnection,
      selectedTimelineEvent: getSelectedTimelineEvent(chainDetails, workflowDetails)
    },
    metaText
  };
}

function renderDetails() {
  const agent = getSelectedAgent();
  const assignment = getSelectedAssignment();
  const handoff = getSelectedHandoff();
  const chainDetails = getSelectedChainDetails();
  const workflowDetails = getSelectedWorkflowDetails();
  const workflowMemory = getSelectedWorkflowMemory();

  ensureSelectedMemorySelection(workflowMemory);

  let selectionText = 'Nothing selected';
  let metaText = 'Select an agent, assignment, or handoff.';
  let summaryHtml = 'Select an agent, assignment, or handoff.';
  let rawPayload = null;

  if (assignment) {
    const details = renderSelectionDetails(
      assignment,
      chainDetails,
      workflowDetails,
      workflowMemory,
      assignment.title || assignment.assignmentId,
      buildAssignmentMeta(assignment, chainDetails, workflowDetails),
      'Assignment summary'
    );
    selectionText = assignment.title || assignment.assignmentId || 'Assignment';
    metaText = details.metaText;
    summaryHtml = details.summaryHtml;
    rawPayload = details.rawPayload;
  } else if (handoff) {
    const details = renderHandoffDetails(handoff, chainDetails, workflowDetails, workflowMemory);
    selectionText = handoff.summary || handoff.handoffId || 'Handoff';
    metaText = details.metaText;
    summaryHtml = details.summaryHtml;
    rawPayload = details.rawPayload;
  } else if (agent) {
    const relatedAssignments = (state.latest?.assignments || []).filter((item) => item.agentId === agent.agentId);
    const relatedHandoffs = (state.latest?.handoffs || []).filter((item) => item.toAgentId === agent.agentId || item.fromAgentId === agent.agentId);
    selectionText = agent.name || agent.agentId || 'Agent';
    metaText = compactParts([
      agent.status || 'unknown',
      agent.role || '-',
      `${relatedAssignments.length} assignments`,
      `${relatedHandoffs.length} handoffs`
    ]);
    summaryHtml = renderDetailsBlock('Agent summary', renderKeyValueSummary([
      ['Name', agent.name || agent.agentId || '-'],
      ['Agent ID', agent.agentId || '-'],
      ['Status', agent.status || '-'],
      ['Role', agent.role || '-'],
      ['Active assignments', agent.activeAssignmentCount ?? relatedAssignments.length],
      ['Inbound / outbound handoffs', `${relatedHandoffs.filter((item) => item.toAgentId === agent.agentId).length} / ${relatedHandoffs.filter((item) => item.fromAgentId === agent.agentId).length}`]
    ]));
    rawPayload = {
      agent,
      relatedAssignments,
      relatedHandoffs
    };
  } else {
    const chainId = getSelectedChainId();
    const workflowId = getSelectedWorkflowId();
    selectionText = workflowId || chainId ? 'Live workflow focus' : 'Live overview';
    metaText = compactParts([
      workflowId ? `workflow ${workflowId}` : null,
      chainId ? `chain ${chainId}` : null,
      `live ${state.liveConnection.status || 'idle'}`,
      state.liveConnection.lastEventType ? `last ${state.liveConnection.lastEventType}` : null
    ]) || 'Realtime coordinator stream.';
    summaryHtml = [
      renderWorkflowRecoveryCard({ workflowId, taskId: getSelectedTaskId() }),
      renderDetailsBlock('Live execution', renderLiveExecutionStrip(chainDetails, workflowDetails, {
        stageId: getSelectedStageId(),
        taskId: getSelectedTaskId()
      })),
      workflowId ? renderDetailsBlock('Claude windows / workers', renderWorkflowMonitor(workflowDetails)) : '',
      renderDetailsBlock('Execution timeline', renderExecutionTimeline(chainDetails, workflowDetails, {
        stageId: getSelectedStageId(),
        taskId: getSelectedTaskId()
      })),
      renderDetailsBlock('Event inspector', renderTimelineEventInspector(chainDetails, workflowDetails)),
      workflowId ? renderDetailsBlock('Workflow DAG', renderWorkflowDag(workflowDetails, {
        workflowId,
        selectedTaskId: getSelectedTaskId()
      })) : '',
      chainId ? renderDetailsBlock('Chain graph', renderChainGraph(chainDetails, getSelectedStageId())) : ''
    ].filter(Boolean).join('');
    rawPayload = {
      chainState: chainDetails || null,
      workflowState: workflowDetails || null,
      liveConnection: state.liveConnection,
      selectedTimelineEvent: getSelectedTimelineEvent(chainDetails, workflowDetails)
    };
  }

  selectionLabel.textContent = selectionText;
  detailsMeta.textContent = metaText;
  detailsSummary.innerHTML = summaryHtml;
  detailsOutput.textContent = rawPayload == null ? 'Select an agent, assignment, or handoff.' : JSON.stringify(rawPayload, null, 2);
  detailsSummary.classList.toggle('hidden', rawDetailsToggle.checked);
  detailsOutput.classList.toggle('hidden', !rawDetailsToggle.checked);

  bindTimelineSelection();
  bindMemorySelection();
}

function renderHandoffDetails(handoff, chainDetails, workflowDetails, workflowMemory) {
  const workflowId = getSelectedWorkflowId();
  const taskId = getSelectedTaskId();
  const memoryDetails = getSelectedMemoryDetails();
  const display = classifyHandoffForDisplay(handoff);
  const metaText = compactParts([
    handoff.status || 'unknown',
    handoff.fromAgentId ? `${handoff.fromAgentId} → ${handoff.toAgentId || handoff.recommendedNextRole || '-'}` : null,
    handoff.sourceType ? `${handoff.sourceType} ${handoff.sourceId || '-'}` : null,
    handoff.historyKind === 'history' ? handoff.historyReason : null,
    chainDetails?.chain?.status ? `chain ${chainDetails.chain.status}` : null,
    workflowDetails?.workflow?.status ? `workflow ${workflowDetails.workflow.status}` : null
  ]);

  return {
    summaryHtml: [
      renderDetailsBlock('Handoff summary', renderKeyValueSummary([
        ['Summary', handoff.summary || '-'],
        ['Status', handoff.status || 'unknown'],
        ['Display lane', display.lane],
        ['Signals', display.signals.map((signal) => signal.label).join(' · ')],
        ['From agent', handoff.fromAgentId || '-'],
        ['To agent', handoff.toAgentId || '-'],
        ['Recommended next role', handoff.recommendedNextRole || '-'],
        ['Source', compactParts([handoff.sourceType, handoff.sourceId]) || '-'],
        ['Target status', handoff.targetStatus || '-'],
        ['Workflow ID', workflowId || handoff.workflowId || '-'],
        ['Task ID', taskId || '-'],
        ['Workflow status', handoff.targetWorkflowStatus || workflowDetails?.workflow?.status || '-'],
        ['Created', handoff.createdAt ? formatTimestamp(handoff.createdAt) : '-'],
        ['Updated', handoff.updatedAt ? formatTimestamp(handoff.updatedAt) : '-']
      ])),
      renderWorkflowRecoveryCard({ workflowId, taskId, runtime: resolveRuntimeDbMetadata(workflowDetails) }),
      renderDetailsBlock('Handoff content', renderHandoffStructuredSections(handoff)),
      renderDetailsBlock('Live execution', renderLiveExecutionStrip(chainDetails, workflowDetails, {
        stageId: handoff.stageId || null,
        taskId
      })),
      renderDetailsBlock('Claude windows / workers', renderWorkflowMonitor(workflowDetails)),
      renderDetailsBlock('Execution timeline', renderExecutionTimeline(chainDetails, workflowDetails, {
        stageId: handoff.stageId || null,
        taskId
      })),
      renderDetailsBlock('Event inspector', renderTimelineEventInspector(chainDetails, workflowDetails)),
      renderDetailsBlock('Chain graph', renderChainGraph(chainDetails, handoff.stageId || null)),
      renderDetailsBlock('Workflow DAG', renderWorkflowDag(workflowDetails, {
        workflowId,
        selectedTaskId: taskId
      })),
      renderDetailsBlock('Memory lineage', renderMemoryLineage(workflowMemory, {
        selectedTaskId: taskId,
        selectedMemoryId: state.selectedMemoryId
      })),
      renderDetailsBlock('Memory inspector', renderMemoryInspector(workflowMemory, memoryDetails)),
      renderDetailsBlock('Chain stages', renderChainStages(chainDetails, handoff.stageId || null))
    ].join(''),
    rawPayload: {
      entity: handoff,
      display,
      chainState: chainDetails || null,
      workflowState: workflowDetails || null,
      workflowMemory: workflowMemory || null,
      selectedMemoryState: memoryDetails || null,
      liveConnection: state.liveConnection,
      selectedTimelineEvent: getSelectedTimelineEvent(chainDetails, workflowDetails)
    },
    metaText
  };
}

function renderHandoffStructuredSections(handoff) {
  const blocks = [
    renderHandoffTextSection('Summary', handoff.summary),
    renderHandoffArraySection('Artifacts', handoff.artifacts),
    renderHandoffArtifactRefs(handoff.artifactRefs),
    renderHandoffArraySection('Decisions', handoff.decisions),
    renderHandoffArraySection('Open questions', handoff.openQuestions),
    renderHandoffArraySection('Risks', handoff.risks)
  ].filter(Boolean);

  return blocks.length === 0
    ? renderEmptyState('No structured handoff content. This is likely polluted summary-only data.')
    : `<div class="handoff-detail-grid">${blocks.join('')}</div>`;
}

function renderHandoffTextSection(label, value) {
  if (value == null || value === '') {
    return '';
  }

  return `
    <article class="handoff-detail-card">
      <div class="inspector-label">${escapeHtml(label)}</div>
      <div class="handoff-detail-text">${escapeHtml(value)}</div>
    </article>
  `;
}

function renderHandoffArraySection(label, values) {
  if (!Array.isArray(values) || values.length === 0) {
    return '';
  }

  return `
    <article class="handoff-detail-card">
      <div class="inspector-label">${escapeHtml(label)}</div>
      <ul class="handoff-detail-list">
        ${values.map((value) => `<li>${escapeHtml(formatStructuredValue(value))}</li>`).join('')}
      </ul>
    </article>
  `;
}

function renderHandoffArtifactRefs(refs) {
  if (!Array.isArray(refs) || refs.length === 0) {
    return '';
  }

  return `
    <article class="handoff-detail-card">
      <div class="inspector-label">Artifact refs</div>
      <ul class="handoff-detail-list">
        ${refs.map((ref) => `<li>${escapeHtml(formatArtifactRef(ref))}</li>`).join('')}
      </ul>
    </article>
  `;
}

function formatArtifactRef(ref) {
  if (!ref || typeof ref !== 'object') {
    return formatStructuredValue(ref);
  }

  return compactParts([
    ref.kind || ref.type || null,
    ref.path || ref.uri || ref.url || ref.id || null,
    ref.label || ref.name || null
  ]) || formatStructuredValue(ref);
}

function renderWorkflowRecoveryCard({ workflowId, taskId, runtime }) {
  if (!workflowId) {
    return '';
  }

  const runtimeSelector = createRuntimeRecoverySelector(runtime);
  const input = {
    workflowId,
    workerId: DEFAULT_RECOVERY_WORKER_ID,
    leaseMs: DEFAULT_RECOVERY_LEASE_MS,
    ...runtimeSelector
  };
  const cliPath = runtime?.cliPath || './cli.js';
  const command = `node "${cliPath}" resume-session --input '${JSON.stringify(input)}'`;

  return renderDetailsBlock('New window recovery', `
    <div class="recovery-card">
      <div class="recovery-card-grid">
        <div>
          <div class="inspector-label">Workflow ID</div>
          <div class="recovery-card-value">${escapeHtml(workflowId)}</div>
        </div>
        <div>
          <div class="inspector-label">Task ID</div>
          <div class="recovery-card-value">${escapeHtml(taskId || '-')}</div>
        </div>
        <div>
          <div class="inspector-label">Worker ID</div>
          <div class="recovery-card-value">${escapeHtml(DEFAULT_RECOVERY_WORKER_ID)}</div>
        </div>
        <div>
          <div class="inspector-label">Data scope</div>
          <div class="recovery-card-value">${escapeHtml(formatRuntimeDbScope(runtime))}</div>
        </div>
        <div>
          <div class="inspector-label">DB profile</div>
          <div class="recovery-card-value">${escapeHtml(runtime?.dbProfile || '-')}</div>
        </div>
        <div>
          <div class="inspector-label">DB source</div>
          <div class="recovery-card-value">${escapeHtml(runtime?.dbPathSource || '-')}</div>
        </div>
        <div>
          <div class="inspector-label">DB path</div>
          <div class="recovery-card-value">${escapeHtml(runtime?.dbPath || '-')}</div>
        </div>
      </div>
      <div class="recovery-card-hint">新 Claude 窗口复制下面命令即可恢复当前 workflow session。同一 workerId 用于续接；不同 workerId 用于并行执行。默认数据按 workspace 归档；独立数据使用 dbProfile 或显式 dbPath，恢复命令会优先保留独立口径。</div>
      <pre class="command-snippet"><code>${escapeHtml(command)}</code></pre>
    </div>
  `);
}

function resolveRuntimeDbMetadata(workflowDetails = null) {
  return workflowDetails?.runtime || state.latest?.runtime || null;
}

function renderKeyValueSummary(entries) {
  return `
    <dl class="summary-grid">
      ${entries.map(([label, value]) => `
        <div class="summary-row">
          <dt>${escapeHtml(label)}</dt>
          <dd>${escapeHtml(value == null || value === '' ? '-' : String(value))}</dd>
        </div>
      `).join('')}
    </dl>
  `;
}

function buildAssignmentMeta(assignment, chainDetails, workflowDetails) {
  const parts = [
    assignment.status || 'unknown',
    assignment.targetType || '-',
    assignment.agentId || 'unassigned'
  ];

  if (chainDetails?.chain?.status) {
    parts.push(`chain ${chainDetails.chain.status}`);
  }

  if (workflowDetails?.workflow?.status) {
    parts.push(`workflow ${workflowDetails.workflow.status}`);
  }

  return parts.join(' · ');
}

function buildRefreshStatus(payload) {
  const intervalLabel = state.refreshIntervalMs > 0 ? ` · auto ${formatIntervalLabel(state.refreshIntervalMs)}` : '';
  const liveLabel = buildLiveStatusLabel();
  return `Next: ${payload.summary?.nextRecommendedCommand || 'inspect'} · assignments: ${payload.summary?.assignmentCount || 0}${intervalLabel}${liveLabel}`;
}

function buildLiveStatusLabel() {
  const status = state.liveConnection.status || 'idle';
  const event = state.liveConnection.lastEventType ? ` ${state.liveConnection.lastEventType}` : '';
  const heartbeat = state.liveConnection.heartbeatAt ? ` heartbeat ${formatTimestamp(state.liveConnection.heartbeatAt)}` : '';
  return ` · live ${status}${event}${heartbeat}`;
}

function syncAutoRefreshInput() {
  autoRefreshSelect.value = String(state.refreshIntervalMs || 0);
}

function setAutoRefreshInterval(intervalMs) {
  state.refreshIntervalMs = intervalMs > 0 ? intervalMs : 0;
  syncAutoRefreshInput();
  stopAutoRefresh();

  if (state.refreshIntervalMs > 0) {
    state.refreshTimerId = window.setInterval(() => {
      void refresh();
    }, state.refreshIntervalMs);
  }

  if (state.latest) {
    setStatus(buildRefreshStatus(state.latest));
  }
}

function stopAutoRefresh() {
  if (state.refreshTimerId != null) {
    window.clearInterval(state.refreshTimerId);
    state.refreshTimerId = null;
  }
}

function syncLiveUpdates() {
  const liveUrl = buildLiveUpdatesUrl();
  if (!liveUrl) {
    stopLiveUpdates();
    return;
  }

  if (state.liveConnection.source && state.liveConnection.key === liveUrl) {
    return;
  }

  stopLiveUpdates();

  if (typeof window.EventSource !== 'function') {
    state.liveConnection = {
      source: null,
      key: liveUrl,
      status: 'error',
      lastEventType: null,
      lastEventAt: null,
      heartbeatAt: null,
      error: 'This browser does not support live EventSource updates.'
    };
    renderDetails();
    return;
  }

  const source = new window.EventSource(liveUrl);
  state.liveConnection = {
    source,
    key: liveUrl,
    status: 'connecting',
    lastEventType: null,
    lastEventAt: null,
    heartbeatAt: null,
    error: null
  };

  source.addEventListener('summary', (event) => applyLiveEvent('summary', event));
  source.addEventListener('chain', (event) => applyLiveEvent('chain', event));
  source.addEventListener('workflow', (event) => applyLiveEvent('workflow', event));
  source.addEventListener('heartbeat', (event) => applyLiveEvent('heartbeat', event));
  source.onerror = () => {
    if (state.liveConnection.source !== source) {
      return;
    }
    state.liveConnection.status = 'error';
    state.liveConnection.error = 'Live stream disconnected. Waiting to reconnect…';
    renderDetails();
  };

  renderDetails();
}

function stopLiveUpdates() {
  if (state.liveConnection.source) {
    state.liveConnection.source.close();
  }

  state.liveConnection = {
    source: null,
    key: '',
    status: 'idle',
    lastEventType: null,
    lastEventAt: null,
    heartbeatAt: null,
    error: null
  };
}

function buildLiveUpdatesUrl() {
  const assignment = getSelectedAssignment();
  const handoff = getSelectedHandoff();
  const params = new URLSearchParams();
  const chainId = assignment?.chainId || handoff?.chainId || state.filters.chainId || '';
  const workflowId = getSelectedWorkflowId() || assignment?.workflowId || handoff?.workflowId || state.filters.workflowId || '';
  const stageId = assignment?.stageId || handoff?.stageId || '';
  const taskId = assignment?.taskId || handoff?.taskId || '';

  if (chainId) {
    params.set('chainId', chainId);
  }
  if (workflowId) {
    params.set('workflowId', workflowId);
  }
  if (stageId) {
    params.set('stageId', stageId);
  }
  if (taskId) {
    params.set('taskId', taskId);
  }
  if (state.filters.blockedOnly) {
    params.set('assignmentStatus', 'blocked');
  }
  params.set('includeTestData', state.filters.includeTestData ? 'true' : 'false');
  params.set('includeHistory', state.filters.includeHistory ? 'true' : 'false');
  params.set('limit', '50');

  return AdminApiRoutes.liveUpdates(params);
}

function applyLiveEvent(type, rawEvent) {
  const payload = parseLiveEventPayload(rawEvent);
  const eventTime = payload?.time || new Date().toISOString();

  state.liveConnection.status = 'streaming';
  state.liveConnection.lastEventType = humanizeAction(type) || type;
  state.liveConnection.lastEventAt = eventTime;
  state.liveConnection.error = null;

  if (type === 'heartbeat') {
    state.liveConnection.heartbeatAt = eventTime;
    renderDetails();
    if (state.latest) {
      setStatus(buildRefreshStatus(state.latest));
    }
    return;
  }

  if (type === 'summary' && payload && typeof payload === 'object') {
    state.latest = payload;
    syncSelection(payload);
    render(payload);
    setStatus(buildRefreshStatus(payload));
  }

  if (type === 'chain' && payload?.chainState?.chain?.chainId) {
    state.chainDetailsById[payload.chainState.chain.chainId] = payload.chainState;
  }

  if (type === 'workflow' && payload?.workflowState?.workflow?.workflowId) {
    state.workflowDetailsById[payload.workflowState.workflow.workflowId] = mergeWorkflowMonitorState(payload.workflowState, payload.monitorState);
  }

  ensureSelectedTimelineEvent();
  renderDetails();
}

function parseLiveEventPayload(rawEvent) {
  if (!rawEvent?.data) {
    return null;
  }

  try {
    return JSON.parse(rawEvent.data);
  } catch {
    return {
      message: rawEvent.data
    };
  }
}

function formatIntervalLabel(intervalMs) {
  if (intervalMs % 1000 === 0) {
    return `${intervalMs / 1000}s`;
  }
  return `${intervalMs}ms`;
}

function renderExecutionTimeline(chainDetails, workflowDetails, selection = {}) {
  const events = buildExecutionTimeline(chainDetails, workflowDetails);
  if (events.length === 0) {
    return renderEmptyState('No execution events yet.');
  }

  ensureSelectedTimelineEvent(events);

  return `
    <div class="timeline-list">
      ${events.map((event) => renderTimelineItem(event, selection)).join('')}
    </div>
  `;
}

function buildExecutionTimeline(chainDetails, workflowDetails) {
  const events = [];

  for (const log of chainDetails?.runLogs || []) {
    events.push({
      id: `chain-log-${log.logId}`,
      time: log.createdAt,
      source: 'chain log',
      stageId: log.stageId || null,
      taskId: null,
      tone: inferEventTone(log.action, log.message, log.payload),
      title: humanizeAction(log.action) || 'Chain event',
      message: log.message || 'Chain run log recorded.',
      meta: compactParts([
        log.stageId ? `stage ${log.stageId}` : null,
        log.payload?.workflowId ? `workflow ${log.payload.workflowId}` : null
      ]),
      payloadSummary: summarizeStructuredValue(log.payload),
      details: {
        action: log.action || null,
        message: log.message || null,
        payload: log.payload ?? null
      }
    });
  }

  for (const rerun of chainDetails?.reruns || []) {
    events.push({
      id: `chain-rerun-${rerun.rerunId}`,
      time: rerun.createdAt,
      source: 'chain rerun',
      stageId: rerun.originStageId || null,
      taskId: rerun.originTaskId || null,
      tone: inferEventTone('rerun', rerun.reason, rerun.payload),
      title: 'Chain rerun',
      message: rerun.reason || 'Chain rerun recorded.',
      meta: compactParts([
        rerun.originStageId ? `origin stage ${rerun.originStageId}` : null,
        rerun.originWorkflowId ? `workflow ${rerun.originWorkflowId}` : null,
        rerun.operator ? `operator ${rerun.operator}` : null
      ]),
      payloadSummary: summarizeStructuredValue({
        affectedStageCount: rerun.affectedStageCount,
        affectedStageIds: rerun.affectedStageIds,
        fingerprint: rerun.fingerprint,
        ...normalizeObject(rerun.payload)
      }),
      details: {
        reason: rerun.reason || null,
        payload: rerun.payload ?? null,
        fingerprint: rerun.fingerprint || null,
        affectedStageCount: rerun.affectedStageCount ?? null,
        affectedStageIds: rerun.affectedStageIds ?? null,
        operator: rerun.operator || null
      }
    });
  }

  for (const revision of chainDetails?.stageRevisions || []) {
    events.push({
      id: `stage-revision-${revision.revisionId}`,
      time: revision.createdAt,
      source: 'stage revision',
      stageId: revision.stageId || null,
      taskId: null,
      tone: inferEventTone('revision', revision.previousBlockedReason, revision.snapshot),
      title: 'Stage revision',
      message: revision.previousStatus
        ? `Previous status ${revision.previousStatus}.`
        : 'Stage revision recorded.',
      meta: compactParts([
        revision.stageId ? `stage ${revision.stageId}` : null,
        revision.rerunId ? `rerun ${revision.rerunId}` : null,
        revision.previousWorkflowId ? `workflow ${revision.previousWorkflowId}` : null
      ]),
      payloadSummary: summarizeStructuredValue({
        previousBlockedReason: revision.previousBlockedReason,
        previousDoneSummary: revision.previousDoneSummary,
        snapshot: revision.snapshot
      }),
      details: {
        previousStatus: revision.previousStatus || null,
        previousBlockedReason: revision.previousBlockedReason || null,
        previousDoneSummary: revision.previousDoneSummary || null,
        snapshot: revision.snapshot ?? null
      }
    });
  }

  for (const log of workflowDetails?.runLogs || []) {
    events.push({
      id: `workflow-log-${log.logId}`,
      time: log.createdAt,
      source: 'workflow log',
      stageId: null,
      taskId: log.taskId || null,
      tone: inferEventTone(log.action, log.message, log.payload),
      title: humanizeAction(log.action) || 'Workflow event',
      message: log.message || 'Workflow run log recorded.',
      meta: compactParts([
        workflowDetails?.workflow?.workflowId ? `workflow ${workflowDetails.workflow.workflowId}` : null,
        log.taskId ? `task ${log.taskId}` : null
      ]),
      payloadSummary: summarizeStructuredValue(log.payload),
      details: {
        action: log.action || null,
        message: log.message || null,
        payload: log.payload ?? null
      }
    });
  }

  for (const rerun of workflowDetails?.reruns || []) {
    events.push({
      id: `workflow-rerun-${rerun.rerunId}`,
      time: rerun.createdAt,
      source: 'workflow rerun',
      stageId: null,
      taskId: rerun.originTaskId || null,
      tone: inferEventTone('rerun', rerun.reason, rerun.payload),
      title: 'Workflow rerun',
      message: rerun.reason || 'Workflow rerun recorded.',
      meta: compactParts([
        rerun.originTaskId ? `origin task ${rerun.originTaskId}` : null,
        rerun.operator ? `operator ${rerun.operator}` : null
      ]),
      payloadSummary: summarizeStructuredValue({
        affectedTaskCount: rerun.affectedTaskCount,
        affectedTaskIds: rerun.affectedTaskIds,
        fingerprint: rerun.fingerprint,
        ...normalizeObject(rerun.payload)
      }),
      details: {
        reason: rerun.reason || null,
        payload: rerun.payload ?? null,
        fingerprint: rerun.fingerprint || null,
        affectedTaskCount: rerun.affectedTaskCount ?? null,
        affectedTaskIds: rerun.affectedTaskIds ?? null,
        operator: rerun.operator || null
      }
    });
  }

  for (const revision of workflowDetails?.taskRevisions || []) {
    events.push({
      id: `task-revision-${revision.revisionId}`,
      time: revision.createdAt,
      source: 'task revision',
      stageId: null,
      taskId: revision.taskId || null,
      tone: inferEventTone('revision', revision.previousBlockedReason || revision.previousLastError, revision.snapshot),
      title: 'Task revision',
      message: revision.previousStatus
        ? `Previous status ${revision.previousStatus}.`
        : 'Task revision recorded.',
      meta: compactParts([
        revision.taskId ? `task ${revision.taskId}` : null,
        revision.rerunId ? `rerun ${revision.rerunId}` : null
      ]),
      payloadSummary: summarizeStructuredValue({
        previousBlockedReason: revision.previousBlockedReason,
        previousLastError: revision.previousLastError,
        previousAttemptCount: revision.previousAttemptCount,
        previousDoneSummary: revision.previousDoneSummary,
        snapshot: revision.snapshot
      }),
      details: {
        previousStatus: revision.previousStatus || null,
        previousBlockedReason: revision.previousBlockedReason || null,
        previousLastError: revision.previousLastError || null,
        previousAttemptCount: revision.previousAttemptCount ?? null,
        previousDoneSummary: revision.previousDoneSummary || null,
        snapshot: revision.snapshot ?? null
      }
    });
  }

  for (const output of workflowDetails?.taskOutputs || []) {
    events.push({
      id: `task-output-${output.outputId}`,
      time: output.createdAt,
      source: 'task output',
      stageId: null,
      taskId: output.taskId || null,
      tone: 'info',
      title: output.kind ? `Task output · ${output.kind}` : 'Task output',
      message: output.name || output.path || 'Task output recorded.',
      meta: compactParts([
        output.taskId ? `task ${output.taskId}` : null,
        output.path ? `path ${output.path}` : null
      ]),
      payloadSummary: summarizeStructuredValue({
        metadata: output.metadata,
        content: output.content
      }),
      details: {
        kind: output.kind || null,
        name: output.name || null,
        path: output.path || null,
        metadata: output.metadata ?? null,
        content: output.content ?? null
      }
    });
  }

  return events.sort(compareTimelineEvents);
}

function compareTimelineEvents(left, right) {
  const leftTime = Date.parse(left.time || '') || 0;
  const rightTime = Date.parse(right.time || '') || 0;
  if (leftTime !== rightTime) {
    return rightTime - leftTime;
  }
  return String(right.id || '').localeCompare(String(left.id || ''));
}

function renderTimelineItem(event, selection) {
  const isFocusMatch = Boolean(
    (selection.stageId && event.stageId && selection.stageId === event.stageId)
    || (selection.taskId && event.taskId && selection.taskId === event.taskId)
  );
  const isInspectorSelected = state.selectedTimelineEventId === event.id;

  return `
    <article class="timeline-item ${escapeHtml(event.tone || 'info')} ${isFocusMatch ? 'selected' : ''} ${isInspectorSelected ? 'inspector-selected' : ''}" data-timeline-event-id="${escapeHtml(event.id)}" role="button" tabindex="0" aria-label="Inspect timeline event ${escapeHtml(event.title || 'Event')}">
      <div class="timeline-header">
        <div>
          <div class="timeline-title">${escapeHtml(event.title || 'Event')}</div>
          <div class="timeline-source">${escapeHtml(compactParts([
            event.source || '-',
            event.time || '-'
          ]))}</div>
        </div>
        <span class="badge ${event.tone === 'danger' ? 'danger' : ''}">${escapeHtml(event.time ? formatTimestamp(event.time) : '-')}</span>
      </div>
      <div class="timeline-message">${escapeHtml(event.message || '-')}</div>
      ${event.meta ? `<div class="timeline-meta-row">${escapeHtml(event.meta)}</div>` : ''}
      ${event.payloadSummary ? `<div class="timeline-payload">${escapeHtml(event.payloadSummary)}</div>` : ''}
    </article>
  `;
}

function bindTimelineSelection() {
  detailsSummary.querySelectorAll('[data-timeline-event-id]').forEach((node) => {
    const selectEvent = () => {
      state.selectedTimelineEventId = node.dataset.timelineEventId || null;
      renderDetails();
    };
    node.addEventListener('click', selectEvent);
    node.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        selectEvent();
      }
    });
  });
}

function bindMemorySelection() {
  detailsSummary.querySelectorAll('[data-memory-id]').forEach((node) => {
    const selectMemory = () => {
      state.selectedMemoryId = node.dataset.memoryId || null;
      void ensureSelectedMemoryDetails().then(() => {
        renderDetails();
      });
    };
    node.addEventListener('click', selectMemory);
    node.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        selectMemory();
      }
    });
  });
}

function ensureSelectedTimelineEvent(events = null) {
  const timelineEvents = Array.isArray(events)
    ? events
    : buildExecutionTimeline(getSelectedChainDetails(), getSelectedWorkflowDetails());

  if (timelineEvents.length === 0) {
    state.selectedTimelineEventId = null;
    return;
  }

  if (!state.selectedTimelineEventId || !timelineEvents.some((event) => event.id === state.selectedTimelineEventId)) {
    state.selectedTimelineEventId = timelineEvents[0].id;
  }
}

function getSelectedTimelineEvent(chainDetails, workflowDetails) {
  const events = buildExecutionTimeline(chainDetails, workflowDetails);
  if (events.length === 0) {
    return null;
  }
  ensureSelectedTimelineEvent(events);
  return events.find((event) => event.id === state.selectedTimelineEventId) || events[0] || null;
}

function renderTimelineEventInspector(chainDetails, workflowDetails) {
  const event = getSelectedTimelineEvent(chainDetails, workflowDetails);
  if (!event) {
    return renderEmptyState('Select a timeline event to inspect structured details.');
  }

  const detailEntries = Object.entries(event.details || {}).filter(([, value]) => value != null && value !== '');
  return `
    <div class="event-inspector">
      <div class="event-inspector-header">
        <div>
          <div class="timeline-title">${escapeHtml(event.title || 'Event')}</div>
          <div class="timeline-source">${escapeHtml(compactParts([
            event.source || '-',
            event.meta || null
          ]))}</div>
        </div>
        <span class="badge ${event.tone === 'danger' ? 'danger' : ''}">${escapeHtml(event.time ? formatTimestamp(event.time) : '-')}</span>
      </div>
      <div class="timeline-message">${escapeHtml(event.message || '-')}</div>
      ${detailEntries.length === 0 ? renderEmptyState('No structured detail fields on this event.') : detailEntries.map(([label, value]) => `
        <div class="inspector-section">
          <div class="inspector-label">${escapeHtml(humanizeAction(label) || label)}</div>
          <pre class="inspector-payload">${escapeHtml(formatStructuredValue(value))}</pre>
        </div>
      `).join('')}
    </div>
  `;
}

function renderLiveExecutionStrip(chainDetails, workflowDetails, selection = {}) {
  const event = getSelectedTimelineEvent(chainDetails, workflowDetails);
  const connectionStatus = state.liveConnection.status || 'idle';
  const isStreaming = connectionStatus === 'streaming';
  return `
    <div class="live-strip ${isStreaming ? 'active' : ''}">
      <div class="live-pill ${isStreaming ? 'active' : ''}">
        <span class="live-dot"></span>
        <span>${escapeHtml(isStreaming ? 'Live connected' : 'Live idle')}</span>
      </div>
      <div class="live-strip-grid">
        ${renderLiveMetric('Connection', connectionStatus)}
        ${renderLiveMetric('Last event', state.liveConnection.lastEventType || (event?.title || '-'))}
        ${renderLiveMetric('Heartbeat', state.liveConnection.heartbeatAt ? formatTimestamp(state.liveConnection.heartbeatAt) : '-')}
        ${renderLiveMetric('Focus stage', selection.stageId || '-')}
        ${renderLiveMetric('Focus task', selection.taskId || '-')}
        ${renderLiveMetric('Latest activity', event?.time ? formatTimestamp(event.time) : '-')}
      </div>
      ${state.liveConnection.error ? `<div class="timeline-meta-row">${escapeHtml(state.liveConnection.error)}</div>` : ''}
    </div>
  `;
}

function renderLiveMetric(label, value) {
  return `
    <div class="live-metric">
      <div class="inspector-label">${escapeHtml(label)}</div>
      <div class="live-metric-value">${escapeHtml(value == null || value === '' ? '-' : String(value))}</div>
    </div>
  `;
}

function renderWorkflowMonitor(workflowDetails) {
  if (!workflowDetails) {
    return renderEmptyState('Loading workflow monitor...');
  }

  if (workflowDetails.error) {
    return renderEmptyState(`Workflow monitor unavailable: ${workflowDetails.error}`);
  }

  const monitorState = getWorkflowMonitorState(workflowDetails);
  if (!monitorState) {
    return renderEmptyState('No workflow monitor state yet.');
  }

  return `
    <div class="monitor-shell">
      ${renderMonitorSummary(monitorState)}
      ${renderMonitorWorkers(monitorState)}
      ${renderMonitorTaskBoard(monitorState)}
      ${renderMonitorRecentEvents(monitorState)}
      ${renderMonitorRecentOutputs(monitorState)}
    </div>
  `;
}

function getWorkflowMonitorState(workflowDetails) {
  return workflowDetails?.monitorState || null;
}

function renderMonitorSummary(monitorState) {
  const summary = monitorState.summary || {};
  const counts = summary.taskCountsByStatus || {};
  const taskCountText = Object.entries(counts)
    .map(([status, count]) => `${status}: ${count}`)
    .join(' · ');

  return `
    <div class="live-strip monitor-summary">
      <div class="live-pill ${summary.activeWindowCount > 0 ? 'active' : ''}">
        <span class="live-dot"></span>
        <span>${escapeHtml(summary.activeWindowCount > 0 ? 'Active workflow windows' : 'No active windows')}</span>
      </div>
      <div class="live-strip-grid">
        ${renderLiveMetric('Workers', summary.workerCount ?? 0)}
        ${renderLiveMetric('Active leases', summary.activeWindowCount ?? 0)}
        ${renderLiveMetric('Expired leases', summary.expiredWindowCount ?? 0)}
        ${renderLiveMetric('Task status', taskCountText || '-')}
        ${renderLiveMetric('Workflow ID', monitorState.workflowId || '-')}
        ${renderLiveMetric('Generated', monitorState.generatedAt ? formatTimestamp(monitorState.generatedAt) : '-')}
      </div>
    </div>
  `;
}

function renderMonitorWorkers(monitorState) {
  const workers = Array.isArray(monitorState.workers) ? monitorState.workers : [];
  if (workers.length === 0) {
    return renderEmptyState('No active Claude windows with task leases.');
  }

  return `
    <div class="monitor-section">
      <div class="inspector-label">Active Claude windows</div>
      <div class="timeline-list">
        ${workers.map((worker) => `
          <article class="timeline-item ${buildMonitorToneClass(worker.leaseState)}">
            <div class="timeline-header">
              <div>
                <div class="timeline-title">${escapeHtml(worker.workerId || 'Unknown window')}</div>
                <div class="timeline-source">${escapeHtml(compactParts([
                  `${worker.activeTaskCount || 0} active task${worker.activeTaskCount === 1 ? '' : 's'}`,
                  worker.roles?.length ? `roles ${worker.roles.join(', ')}` : null,
                  worker.ownerAgentIds?.length ? `owners ${worker.ownerAgentIds.join(', ')}` : null
                ]))}</div>
              </div>
              <span class="badge ${worker.leaseState === 'expired' ? 'danger' : ''}">${escapeHtml(worker.leaseState || 'unknown')}</span>
            </div>
            <div class="timeline-message">${escapeHtml((worker.tasks || []).map((task) => `${task.taskId}: ${task.title || '-'}`).join(' · ') || '-')}</div>
            <div class="timeline-meta-row">${escapeHtml(compactParts([
              worker.nearestLeaseExpiresAt ? `lease until ${formatTimestamp(worker.nearestLeaseExpiresAt)}` : null,
              worker.latestUpdatedAt ? `updated ${formatTimestamp(worker.latestUpdatedAt)}` : null
            ]))}</div>
          </article>
        `).join('')}
      </div>
    </div>
  `;
}

function renderMonitorTaskBoard(monitorState) {
  const tasks = Array.isArray(monitorState.taskBoard) ? monitorState.taskBoard : [];
  if (tasks.length === 0) {
    return renderEmptyState('No workflow tasks to monitor.');
  }

  return `
    <div class="monitor-section">
      <div class="inspector-label">Task board</div>
      <div class="dag-sequence-list monitor-task-board">
        ${tasks.map((task, index) => `
          <article class="dag-node ${buildStatusClass(task.status)}">
            <div class="chain-node-header">
              <strong>${escapeHtml(task.title || task.taskId || `Task ${index + 1}`)}</strong>
              <span class="badge ${task.status === 'blocked' ? 'danger' : ''}">${escapeHtml(task.status || 'unknown')}</span>
            </div>
            <div class="chain-node-meta">${escapeHtml(compactParts([
              task.taskId ? `task ${task.taskId}` : null,
              task.leaseOwner ? `lease ${task.leaseOwner}` : null,
              task.leaseState ? `lease ${task.leaseState}` : null,
              task.preferredRole ? `role ${task.preferredRole}` : null,
              task.ownerAgentId ? `owner ${task.ownerAgentId}` : null
            ]))}</div>
            <div class="chain-node-summary">${escapeHtml(task.blockedReason || task.doneSummary || task.handoffSummary || '-')}</div>
          </article>
        `).join('')}
      </div>
    </div>
  `;
}

function renderMonitorRecentEvents(monitorState) {
  const events = Array.isArray(monitorState.recentEvents) ? monitorState.recentEvents.slice(0, 8) : [];
  if (events.length === 0) {
    return renderEmptyState('No recent workflow events.');
  }

  return `
    <div class="monitor-section">
      <div class="inspector-label">Recent events</div>
      <div class="timeline-list">
        ${events.map((event) => `
          <article class="timeline-item ${inferEventTone(event.action, event.message, event)}">
            <div class="timeline-header">
              <div>
                <div class="timeline-title">${escapeHtml(humanizeAction(event.action) || 'Workflow event')}</div>
                <div class="timeline-source">${escapeHtml(compactParts([
                  event.taskId ? `task ${event.taskId}` : null,
                  event.taskTitle || null,
                  event.leaseOwner ? `lease ${event.leaseOwner}` : null
                ]))}</div>
              </div>
              <span class="badge">${escapeHtml(event.createdAt ? formatTimestamp(event.createdAt) : '-')}</span>
            </div>
            <div class="timeline-message">${escapeHtml(event.message || event.nextStatus || '-')}</div>
          </article>
        `).join('')}
      </div>
    </div>
  `;
}

function renderMonitorRecentOutputs(monitorState) {
  const outputs = Array.isArray(monitorState.recentOutputs) ? monitorState.recentOutputs.slice(0, 8) : [];
  if (outputs.length === 0) {
    return renderEmptyState('No captured task outputs yet.');
  }

  return `
    <div class="monitor-section">
      <div class="inspector-label">Recent captured outputs</div>
      <div class="timeline-list">
        ${outputs.map((output) => `
          <article class="timeline-item ${output.kind === 'error' ? 'danger' : output.kind === 'handoff' || output.kind === 'decision' ? 'success' : ''}">
            <div class="timeline-header">
              <div>
                <div class="timeline-title">${escapeHtml(compactParts([output.kind || 'output', output.name || null]))}</div>
                <div class="timeline-source">${escapeHtml(compactParts([
                  output.taskId ? `task ${output.taskId}` : null,
                  output.taskTitle || null,
                  output.workerId ? `worker ${output.workerId}` : null,
                  output.captureSource || null
                ]))}</div>
              </div>
              <span class="badge">${escapeHtml(output.createdAt ? formatTimestamp(output.createdAt) : '-')}</span>
            </div>
            <div class="timeline-message">${escapeHtml(output.contentPreview || output.path || '-')}</div>
          </article>
        `).join('')}
      </div>
    </div>
  `;
}

function buildMonitorToneClass(leaseState) {
  if (leaseState === 'expired') {
    return 'danger';
  }
  if (leaseState === 'active') {
    return 'accent';
  }
  return 'muted';
}


function renderChainGraph(chainDetails, selectedStageId) {
  if (!chainDetails) {
    return renderEmptyState('Loading chain graph...');
  }

  if (chainDetails.error) {
    return renderEmptyState(`Chain graph unavailable: ${chainDetails.error}`);
  }

  const stages = chainDetails.stages || [];
  if (stages.length === 0) {
    return renderEmptyState('No chain stages.');
  }

  const rowHeight = 148;
  const topOffset = 74;
  const svgHeight = Math.max(0, (stages.length - 1) * rowHeight + 16);

  return `
    <div class="graph-shell chain-graph-shell" data-graph-kind="chain">
      <svg class="graph-overlay chain-graph-overlay" viewBox="0 0 160 ${escapeHtml(String(svgHeight || 1))}" preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <marker id="chain-arrow" markerWidth="10" markerHeight="10" refX="7" refY="5" orient="auto" markerUnits="strokeWidth">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor"></path>
          </marker>
        </defs>
        ${stages.slice(0, -1).map((stage, index) => {
          const nextStage = stages[index + 1];
          const y1 = topOffset + (index * rowHeight);
          const y2 = topOffset + ((index + 1) * rowHeight);
          const toneClass = buildConnectorToneClass(stage.status, nextStage?.status);
          return `
            <path class="graph-edge chain-graph-edge ${toneClass}" d="M 80 ${y1} C 80 ${(y1 + y2) / 2}, 80 ${(y1 + y2) / 2}, 80 ${y2}" marker-end="url(#chain-arrow)"></path>
          `;
        }).join('')}
      </svg>
      <div class="chain-graph">
        ${stages.map((stage, index) => `
          <div class="chain-graph-step">
            <article class="chain-node ${buildStatusClass(stage.status)} ${stage.stageId === selectedStageId ? 'selected' : ''}">
              <div class="chain-node-header">
                <strong>${escapeHtml(stage.title || stage.stageId || `Stage ${index + 1}`)}</strong>
                <span class="badge ${stage.status === 'blocked' ? 'danger' : ''}">${escapeHtml(stage.status || 'unknown')}</span>
              </div>
              <div class="chain-node-meta">${escapeHtml(compactParts([
                `#${index + 1}`,
                stage.stageId ? `stage ${stage.stageId}` : null,
                stage.workflowId ? `workflow ${stage.workflowId}` : null
              ]))}</div>
              <div class="chain-node-summary">${escapeHtml(stage.blockedReason || stage.doneSummary || stage.instruction || '-')}</div>
            </article>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

function renderWorkflowDag(workflowDetails, options = {}) {
  if (!options.workflowId) {
    return renderEmptyState('No workflow is attached to this selection yet.');
  }

  if (!workflowDetails) {
    return renderEmptyState('Loading workflow DAG...');
  }

  if (workflowDetails.error) {
    return renderEmptyState(`Workflow DAG unavailable: ${workflowDetails.error}`);
  }

  const tasks = workflowDetails.tasks || [];
  const dependencies = workflowDetails.dependencies || [];
  if (tasks.length === 0) {
    return renderEmptyState('No workflow tasks.');
  }

  if (dependencies.length === 0) {
    return `
      <div class="dag-note">No dependency edges recorded. Showing tasks in sequence.</div>
      <div class="dag-sequence-list">
        ${tasks.map((task, index) => renderWorkflowTaskNode(task, options.selectedTaskId, index)).join('')}
      </div>
    `;
  }

  const layout = buildWorkflowDagLayout(workflowDetails);
  const rowGap = 122;
  const columnGap = 270;
  const topPadding = 64;
  const leftPadding = 120;
  const edgeLabels = [];
  const taskPositions = new Map();

  layout.columns.forEach((column, columnIndex) => {
    column.forEach((task, rowIndex) => {
      taskPositions.set(task.taskId, {
        x: leftPadding + (columnIndex * columnGap),
        y: topPadding + (rowIndex * rowGap),
        columnIndex,
        rowIndex,
        task
      });
    });
  });

  const svgWidth = Math.max(420, leftPadding * 2 + Math.max(0, layout.columns.length - 1) * columnGap + 220);
  const maxRows = Math.max(...layout.columns.map((column) => column.length), 1);
  const svgHeight = Math.max(220, topPadding * 2 + Math.max(0, maxRows - 1) * rowGap + 60);

  const edgePaths = layout.dependencies.map((dependency, index) => {
    const from = taskPositions.get(dependency.predecessorTaskId);
    const to = taskPositions.get(dependency.successorTaskId);
    if (!from || !to) {
      return '';
    }

    const startX = from.x + 192;
    const startY = from.y + 42;
    const endX = to.x;
    const endY = to.y + 42;
    const midX = startX + ((endX - startX) / 2);
    const labelX = startX + ((endX - startX) / 2);
    const labelY = startY + ((endY - startY) / 2) - 10;
    const toneClass = buildConnectorToneClass(from.task?.status, to.task?.status);

    if (dependency.condition) {
      edgeLabels.push(`
        <text class="graph-edge-label" x="${labelX}" y="${labelY}">${escapeHtml(`if ${summarizeStructuredValue(dependency.condition)}`)}</text>
      `);
    }

    return `
      <path class="graph-edge dag-graph-edge ${toneClass}" d="M ${startX} ${startY} C ${midX} ${startY}, ${midX} ${endY}, ${endX} ${endY}" marker-end="url(#dag-arrow)"></path>
    `;
  }).join('');

  return `
    <div class="graph-shell dag-graph-shell" data-graph-kind="workflow">
      <svg class="graph-overlay dag-graph-overlay" viewBox="0 0 ${escapeHtml(String(svgWidth))} ${escapeHtml(String(svgHeight))}" preserveAspectRatio="xMidYMin meet" aria-hidden="true">
        <defs>
          <marker id="dag-arrow" markerWidth="10" markerHeight="10" refX="7" refY="5" orient="auto" markerUnits="strokeWidth">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor"></path>
          </marker>
        </defs>
        ${edgePaths}
        ${edgeLabels.join('')}
      </svg>
      <div class="dag-columns dag-columns-graph">
        ${layout.columns.map((column, index) => `
          <section class="dag-column">
            <div class="dag-column-label">Depth ${escapeHtml(String(index))}</div>
            <div class="dag-column-body">
              ${column.map((task, taskIndex) => renderWorkflowTaskNode(task, options.selectedTaskId, taskIndex)).join('')}
            </div>
          </section>
        `).join('')}
      </div>
    </div>
  `;
}

function renderMemoryLineage(workflowMemory, options = {}) {
  if (!options.selectedTaskId) {
    return renderEmptyState('No workflow task is attached to this selection yet.');
  }

  if (!workflowMemory) {
    return renderEmptyState('Loading memory lineage...');
  }

  if (workflowMemory.error) {
    return renderEmptyState(`Memory lineage unavailable: ${workflowMemory.error}`);
  }

  const graph = workflowMemory.graph || {};
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph.edges) ? graph.edges : [];
  if (nodes.length === 0) {
    return renderEmptyState('No recalled memories for this task.');
  }

  const lanes = ['task', 'exact', 'structural', 'graph', 'semantic', 'linked', 'selected'];
  const laneLabels = {
    task: 'Task',
    exact: 'Exact',
    structural: 'Structural',
    graph: 'Graph',
    semantic: 'Semantic',
    linked: 'Linked',
    selected: 'Selected'
  };
  const nodesByLane = new Map(lanes.map((lane) => [lane, []]));
  for (const node of nodes) {
    const lane = node.lane && nodesByLane.has(node.lane) ? node.lane : 'selected';
    nodesByLane.get(lane).push(node);
  }

  const orderedNodes = [];
  const positions = new Map();
  const rowGap = 104;
  const laneGap = 220;
  const topPadding = 70;
  const leftPadding = 110;
  lanes.forEach((lane, laneIndex) => {
    const laneNodes = nodesByLane.get(lane) || [];
    laneNodes.forEach((node, rowIndex) => {
      orderedNodes.push(node);
      positions.set(node.id, {
        x: leftPadding + (laneIndex * laneGap),
        y: topPadding + (rowIndex * rowGap),
        lane,
        rowIndex,
        node
      });
    });
  });

  const svgWidth = Math.max(420, leftPadding * 2 + Math.max(0, lanes.length - 1) * laneGap + 180);
  const maxRows = Math.max(...lanes.map((lane) => (nodesByLane.get(lane) || []).length), 1);
  const svgHeight = Math.max(200, topPadding * 2 + Math.max(0, maxRows - 1) * rowGap + 60);
  const edgeMarkup = edges.map((edge) => {
    const from = positions.get(edge.source);
    const to = positions.get(edge.target);
    if (!from || !to) {
      return '';
    }
    const startX = from.x + 176;
    const startY = from.y + 34;
    const endX = to.x;
    const endY = to.y + 34;
    const midX = startX + ((endX - startX) / 2);
    const labelX = startX + ((endX - startX) / 2);
    const labelY = startY + ((endY - startY) / 2) - 8;
    const toneClass = edge.kind === 'selected' ? 'status-ready' : 'status-pending';
    return `
      <path class="graph-edge memory-graph-edge ${toneClass}" d="M ${startX} ${startY} C ${midX} ${startY}, ${midX} ${endY}, ${endX} ${endY}" marker-end="url(#memory-arrow)"></path>
      <text class="graph-edge-label" x="${labelX}" y="${labelY}">${escapeHtml(edge.relation || edge.kind || 'linked')}</text>
    `;
  }).join('');

  const selectedReasons = Array.isArray(workflowMemory.selectedReasons) ? workflowMemory.selectedReasons : [];

  return `
    <div class="memory-graph-meta">
      <div class="timeline-meta-row">Selected reasons: ${escapeHtml(selectedReasons.length > 0 ? selectedReasons.join(' · ') : '-')}</div>
    </div>
    <div class="graph-shell memory-graph-shell" data-graph-kind="memory">
      <svg class="graph-overlay memory-graph-overlay" viewBox="0 0 ${escapeHtml(String(svgWidth))} ${escapeHtml(String(svgHeight))}" preserveAspectRatio="xMidYMin meet" aria-hidden="true">
        <defs>
          <marker id="memory-arrow" markerWidth="10" markerHeight="10" refX="7" refY="5" orient="auto" markerUnits="strokeWidth">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor"></path>
          </marker>
        </defs>
        ${edgeMarkup}
      </svg>
      <div class="memory-lanes">
        ${lanes.map((lane) => {
          const laneNodes = nodesByLane.get(lane) || [];
          if (laneNodes.length === 0) {
            return '';
          }
          return `
            <section class="memory-lane memory-lane-${escapeHtml(lane)}">
              <div class="dag-column-label">${escapeHtml(laneLabels[lane] || lane)}</div>
              <div class="memory-lane-body">
                ${laneNodes.map((node) => renderMemoryNode(node, options.selectedMemoryId)).join('')}
              </div>
            </section>
          `;
        }).join('')}
      </div>
    </div>
  `;
}

function renderMemoryNode(node, selectedMemoryId) {
  if (node.kind === 'task') {
    return `
      <article class="memory-node task ${node.taskId === selectedMemoryId ? 'selected' : ''}">
        <div class="chain-node-header">
          <strong>${escapeHtml(node.label || node.taskId || 'Task')}</strong>
          <span class="badge">${escapeHtml(node.status || 'selected')}</span>
        </div>
        <div class="chain-node-meta">${escapeHtml(node.taskId ? `task ${node.taskId}` : 'selected task')}</div>
      </article>
    `;
  }

  const memoryId = node.memoryId || '';
  return `
    <article class="memory-node lane-${escapeHtml(node.lane || 'selected')} ${memoryId === selectedMemoryId ? 'selected' : ''}" data-memory-id="${escapeHtml(memoryId)}" role="button" tabindex="0" aria-label="Inspect memory ${escapeHtml(node.label || memoryId || 'memory')}">
      <div class="chain-node-header">
        <strong>${escapeHtml(truncateText(node.label || memoryId || 'Memory', 48))}</strong>
        <span class="badge">${escapeHtml(node.lane || 'memory')}</span>
      </div>
      <div class="chain-node-meta">${escapeHtml(memoryId || '-')}</div>
      <div class="chain-node-summary">${escapeHtml(node.summary || summarizeMatchedBy(node.matchedBy) || '-')}</div>
    </article>
  `;
}

function renderMemoryInspector(workflowMemory, memoryDetails) {
  if (!workflowMemory) {
    return renderEmptyState('Select a task with recalled memories.');
  }

  const selectedNode = getSelectedMemoryNode(workflowMemory);
  if (!selectedNode) {
    return renderEmptyState('Select a memory node to inspect linked context and events.');
  }

  const statefulMemory = memoryDetails?.memory || null;
  const links = Array.isArray(memoryDetails?.links) ? memoryDetails.links : [];
  const events = Array.isArray(memoryDetails?.events) ? memoryDetails.events : [];
  const matchedBy = selectedNode.matchedBy || statefulMemory?.matchedBy || null;

  return `
    <div class="event-inspector memory-inspector">
      <div class="event-inspector-header">
        <div>
          <div class="timeline-title">${escapeHtml(selectedNode.label || statefulMemory?.title || selectedNode.memoryId || 'Memory')}</div>
          <div class="timeline-source">${escapeHtml(compactParts([
            selectedNode.memoryId || statefulMemory?.memoryId || null,
            selectedNode.lane || null,
            statefulMemory?.status || null
          ]))}</div>
        </div>
        <span class="badge">${escapeHtml(links.length ? `${links.length} links` : 'memory')}</span>
      </div>
      ${renderInspectorSection('Summary', selectedNode.summary || statefulMemory?.summary || '-')}
      ${renderInspectorSection('Matched by', formatStructuredValue(matchedBy))}
      ${renderInspectorSection('Links', formatStructuredValue(links.slice(0, 12)))}
      ${renderInspectorSection('Events', formatStructuredValue(events.slice(0, 12)))}
      ${renderInspectorSection('Memory state', formatStructuredValue(memoryDetails || selectedNode))}
    </div>
  `;
}

function renderInspectorSection(label, value) {
  return `
    <div class="inspector-section">
      <div class="inspector-label">${escapeHtml(label)}</div>
      <pre class="inspector-payload">${escapeHtml(value == null || value === '' ? '-' : String(value))}</pre>
    </div>
  `;
}

function buildConnectorToneClass(sourceStatus, targetStatus) {
  if (sourceStatus === 'blocked' || targetStatus === 'blocked') {
    return 'status-blocked';
  }
  if (sourceStatus === 'doing' || targetStatus === 'doing' || sourceStatus === 'ready' || targetStatus === 'ready') {
    return 'status-ready';
  }
  if (sourceStatus === 'done' && targetStatus === 'done') {
    return 'status-done';
  }
  return 'status-pending';
}

function buildWorkflowDagLayout(workflowDetails) {
  const tasks = workflowDetails.tasks || [];
  const dependencies = (workflowDetails.dependencies || []).filter((dependency) => dependency.predecessorTaskId && dependency.successorTaskId);
  const tasksById = new Map(tasks.map((task) => [task.taskId, task]));
  const predecessorIdsByTask = new Map(tasks.map((task) => [task.taskId, []]));

  for (const dependency of dependencies) {
    if (!tasksById.has(dependency.predecessorTaskId) || !tasksById.has(dependency.successorTaskId)) {
      continue;
    }
    predecessorIdsByTask.get(dependency.successorTaskId).push(dependency.predecessorTaskId);
  }

  const memo = new Map();
  const visiting = new Set();

  function getDepth(taskId) {
    if (memo.has(taskId)) {
      return memo.get(taskId);
    }

    if (visiting.has(taskId)) {
      return 0;
    }

    visiting.add(taskId);
    const predecessors = predecessorIdsByTask.get(taskId) || [];
    const depth = predecessors.length === 0
      ? 0
      : Math.max(...predecessors.map((predecessorTaskId) => getDepth(predecessorTaskId))) + 1;
    visiting.delete(taskId);
    memo.set(taskId, depth);
    return depth;
  }

  const columns = [];
  for (const task of tasks) {
    const depth = getDepth(task.taskId);
    if (!columns[depth]) {
      columns[depth] = [];
    }
    columns[depth].push(task);
  }

  for (const column of columns) {
    if (!column) {
      continue;
    }
    column.sort((left, right) => {
      if ((left.sequenceNo || 0) !== (right.sequenceNo || 0)) {
        return (left.sequenceNo || 0) - (right.sequenceNo || 0);
      }
      return String(left.taskId || '').localeCompare(String(right.taskId || ''));
    });
  }

  return {
    columns: columns.filter(Boolean),
    dependencies
  };
}

function renderWorkflowTaskNode(task, selectedTaskId, index) {
  const summary = task.blockedReason || task.doneSummary || task.lastError || task.instruction || '-';
  return `
    <article class="dag-node ${buildStatusClass(task.status)} ${task.taskId === selectedTaskId ? 'selected' : ''}">
      <div class="chain-node-header">
        <strong>${escapeHtml(task.title || task.taskId || `Task ${index + 1}`)}</strong>
        <span class="badge ${task.status === 'blocked' ? 'danger' : ''}">${escapeHtml(task.status || 'unknown')}</span>
      </div>
      <div class="chain-node-meta">${escapeHtml(compactParts([
        task.taskId ? `task ${task.taskId}` : null,
        Number.isInteger(task.sequenceNo) ? `#${task.sequenceNo}` : null,
        task.ownerAgentId ? `owner ${task.ownerAgentId}` : null
      ]))}</div>
      <div class="chain-node-summary">${escapeHtml(summary)}</div>
    </article>
  `;
}

function renderChainStages(chainDetails, selectedStageId) {
  if (!chainDetails) {
    return renderEmptyState('Loading chain stages...');
  }

  if (chainDetails.error) {
    return renderEmptyState(`Chain stages unavailable: ${chainDetails.error}`);
  }

  const stages = chainDetails.stages || [];
  if (stages.length === 0) {
    return '<div class="stage-list-empty">No chain stages.</div>';
  }

  return `
    <div class="stage-list">
      ${stages.map((stage, index) => renderChainStageItem(stage, index, selectedStageId)).join('')}
    </div>
  `;
}

function renderChainStageItem(stage, index, selectedStageId) {
  const summary = stage.status === 'blocked'
    ? stage.blockedReason
    : stage.doneSummary;
  const metaParts = [
    `#${index + 1}`,
    stage.workflowId ? `workflow ${stage.workflowId}` : null,
    stage.ownerAgentId ? `owner ${stage.ownerAgentId}` : null,
    stage.assignmentStatus && stage.assignmentStatus !== 'unassigned' ? `assignment ${stage.assignmentStatus}` : null
  ].filter(Boolean);

  return `
    <article class="stage-card ${stage.stageId === selectedStageId ? 'selected' : ''} ${stage.status === 'blocked' ? 'blocked' : ''}">
      <div class="stage-card-header">
        <strong>${escapeHtml(stage.title || stage.stageId || `Stage ${index + 1}`)}</strong>
        <span class="badge ${stage.status === 'blocked' ? 'danger' : ''}">${escapeHtml(stage.status || 'unknown')}</span>
      </div>
      <div class="stage-card-meta">${escapeHtml(metaParts.join(' · ') || '-')}</div>
      <div class="stage-card-summary">${escapeHtml(summary || stage.instruction || '-')}</div>
    </article>
  `;
}

function renderDetailsBlock(title, body) {
  return `
    <section class="details-block">
      <h3>${escapeHtml(title)}</h3>
      ${body}
    </section>
  `;
}

async function ensureSelectedObservabilityDetails(force = false) {
  await ensureSelectedChainDetails(force);
  await ensureSelectedWorkflowDetails(force);
  await ensureSelectedWorkflowMemory(force);
  await ensureSelectedMemoryDetails(force);
}

async function ensureSelectedChainDetails(force = false) {
  const chainId = getSelectedAssignment()?.chainId || getSelectedHandoff()?.chainId || null;
  if (!chainId || (!force && state.chainDetailsById[chainId])) {
    return;
  }

  try {
    const payload = await fetchJson(AdminApiRoutes.chain(chainId, {
      includeRunLogs: true,
      includeReruns: true,
      includeRevisions: true,
      includeOutputs: false,
      limit: 50
    }));
    state.chainDetailsById[chainId] = payload.chainState || null;
  } catch (error) {
    state.chainDetailsById[chainId] = {
      chain: {
        chainId,
        status: 'error'
      },
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function ensureSelectedWorkflowDetails(force = false) {
  const workflowId = getSelectedWorkflowId();
  if (!workflowId || (!force && state.workflowDetailsById[workflowId])) {
    return;
  }

  try {
    const payload = await fetchJson(AdminApiRoutes.workflow(workflowId, {
      includeRunLogs: true,
      includeReruns: true,
      includeRevisions: true,
      includeOutputs: true,
      limit: 50
    }));
    state.workflowDetailsById[workflowId] = mergeWorkflowMonitorState(payload.workflowState, payload.monitorState);
  } catch (error) {
    state.workflowDetailsById[workflowId] = {
      workflow: {
        workflowId,
        status: 'error'
      },
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function applyFilters() {
  state.filters.workflowId = workflowIdFilterInput.value.trim();
  state.filters.chainId = chainIdFilterInput.value.trim();
  state.filters.blockedOnly = blockedOnlyFilterInput.checked;
  state.filters.includeTestData = includeTestDataFilterInput.checked;
  state.filters.includeHistory = includeHistoryFilterInput.checked;
  void refresh();
}

function clearFilters() {
  state.filters.workflowId = '';
  state.filters.chainId = '';
  state.filters.blockedOnly = false;
  state.filters.includeTestData = false;
  state.filters.includeHistory = false;
  syncFilterInputs();
  void refresh();
}

function syncFilterInputs() {
  workflowIdFilterInput.value = state.filters.workflowId;
  chainIdFilterInput.value = state.filters.chainId;
  blockedOnlyFilterInput.checked = state.filters.blockedOnly;
  includeTestDataFilterInput.checked = state.filters.includeTestData;
  includeHistoryFilterInput.checked = state.filters.includeHistory;
}

function buildStateQueryParams() {
  const params = new URLSearchParams();
  params.set('includeTestData', state.filters.includeTestData ? 'true' : 'false');
  params.set('includeHistory', state.filters.includeHistory ? 'true' : 'false');
  if (state.filters.workflowId) {
    params.set('workflowId', state.filters.workflowId);
  }
  if (state.filters.chainId) {
    params.set('chainId', state.filters.chainId);
  }
  if (state.filters.blockedOnly) {
    params.set('assignmentStatus', 'blocked');
  }
  return params;
}

function buildActionContext() {
  return {
    includeTestData: state.filters.includeTestData,
    includeHistory: state.filters.includeHistory,
    ...(state.filters.workflowId ? { workflowId: state.filters.workflowId } : {}),
    ...(state.filters.chainId ? { chainId: state.filters.chainId } : {})
  };
}

function syncSelection(payload) {
  const agents = payload?.agents || [];
  const assignments = payload?.assignments || [];
  const handoffs = payload?.handoffs || [];

  if (state.selectedAgentId && !agents.some((agent) => agent.agentId === state.selectedAgentId)) {
    state.selectedAgentId = null;
  }

  if (state.selectedAssignmentId && !assignments.some((assignment) => assignment.assignmentId === state.selectedAssignmentId)) {
    state.selectedAssignmentId = null;
  }

  if (state.selectedHandoffId && !handoffs.some((handoff) => handoff.handoffId === state.selectedHandoffId)) {
    state.selectedHandoffId = null;
  }
}

function getSelectedAgent() {
  return (state.latest?.agents || []).find((item) => item.agentId === state.selectedAgentId) || null;
}

function getSelectedAssignment() {
  return (state.latest?.assignments || []).find((item) => item.assignmentId === state.selectedAssignmentId) || null;
}

function getSelectedHandoff() {
  return (state.latest?.handoffs || []).find((item) => item.handoffId === state.selectedHandoffId) || null;
}

function getSelectedStageId() {
  return getSelectedAssignment()?.stageId || getSelectedHandoff()?.stageId || null;
}

function getSelectedTaskId() {
  return getSelectedAssignment()?.taskId || getSelectedHandoff()?.taskId || null;
}

function getSelectedWorkflowMemoryKey() {
  const workflowId = getSelectedWorkflowId();
  const taskId = getSelectedTaskId();
  if (!workflowId || !taskId) {
    return '';
  }
  return `${workflowId}:${taskId}`;
}

function getSelectedWorkflowMemory() {
  const key = getSelectedWorkflowMemoryKey();
  if (!key) {
    return null;
  }
  return state.workflowMemoryByKey[key] || null;
}

function ensureSelectedMemorySelection(workflowMemory) {
  const nodes = workflowMemory?.graph?.nodes || [];
  const memoryNodes = nodes.filter((node) => node.kind === 'memory' && node.memoryId);
  if (memoryNodes.length === 0) {
    state.selectedMemoryId = null;
    return;
  }
  if (!state.selectedMemoryId || !memoryNodes.some((node) => node.memoryId === state.selectedMemoryId)) {
    state.selectedMemoryId = memoryNodes[0].memoryId;
  }
}

function getSelectedMemoryNode(workflowMemory = getSelectedWorkflowMemory()) {
  if (!workflowMemory || !state.selectedMemoryId) {
    return null;
  }
  return (workflowMemory.graph?.nodes || []).find((node) => node.memoryId === state.selectedMemoryId) || null;
}

function getSelectedMemoryDetails() {
  if (!state.selectedMemoryId) {
    return null;
  }
  return state.memoryDetailsById[state.selectedMemoryId] || null;
}

async function ensureSelectedWorkflowMemory(force = false) {
  const workflowId = getSelectedWorkflowId();
  const taskId = getSelectedTaskId();
  const key = getSelectedWorkflowMemoryKey();
  if (!workflowId || !taskId || !key || (!force && state.workflowMemoryByKey[key])) {
    return;
  }

  try {
    const payload = await fetchJson(AdminApiRoutes.workflowMemory(workflowId, {
      taskId,
      limit: 12
    }));
    state.workflowMemoryByKey[key] = payload.memoryState || null;
  } catch (error) {
    state.workflowMemoryByKey[key] = {
      workflowId,
      taskId,
      error: error instanceof Error ? error.message : String(error),
      graph: {
        nodes: [],
        edges: []
      }
    };
  }
}

async function ensureSelectedMemoryDetails(force = false) {
  const workflowMemory = getSelectedWorkflowMemory();
  ensureSelectedMemorySelection(workflowMemory);
  const memoryId = state.selectedMemoryId;
  if (!memoryId || (!force && state.memoryDetailsById[memoryId])) {
    return;
  }

  try {
    const payload = await fetchJson(AdminApiRoutes.memory(memoryId, {
      includeEvents: true,
      includeLinks: true,
      limit: 12
    }));
    state.memoryDetailsById[memoryId] = payload.memoryState || null;
  } catch (error) {
    state.memoryDetailsById[memoryId] = {
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function summarizeMatchedBy(matchedBy) {
  if (!matchedBy || typeof matchedBy !== 'object') {
    return '';
  }

  return Object.entries(matchedBy)
    .filter(([, value]) => value === true || (Array.isArray(value) && value.length > 0))
    .map(([key]) => humanizeAction(key) || key)
    .join(' · ');
}

function getSelectedChainId() {
  return getSelectedAssignment()?.chainId || getSelectedHandoff()?.chainId || state.filters.chainId || null;
}

function getSelectedChainDetails() {
  return getChainDetailsById(getSelectedChainId());
}

function getSelectedWorkflowId() {
  const assignment = getSelectedAssignment();
  const handoff = getSelectedHandoff();

  if (assignment?.workflowId) {
    return assignment.workflowId;
  }

  if (handoff?.workflowId) {
    return handoff.workflowId;
  }

  if (state.filters.workflowId) {
    return state.filters.workflowId;
  }

  const stageId = getSelectedStageId();
  const chainDetails = getSelectedChainDetails();
  if (stageId) {
    const stage = (chainDetails?.stages || []).find((item) => item.stageId === stageId);
    if (stage?.workflowId) {
      return stage.workflowId;
    }
  }

  if (chainDetails?.nextStage?.workflowId) {
    return chainDetails.nextStage.workflowId;
  }

  return null;
}

function mergeWorkflowMonitorState(workflowState, monitorState) {
  if (!workflowState) {
    return null;
  }

  return {
    ...workflowState,
    monitorState: monitorState || workflowState.monitorState || null
  };
}

function getSelectedWorkflowDetails() {
  return getWorkflowDetailsById(getSelectedWorkflowId());
}

function getChainDetailsById(chainId) {
  if (!chainId) {
    return null;
  }
  return state.chainDetailsById[chainId] || null;
}

function getWorkflowDetailsById(workflowId) {
  if (!workflowId) {
    return null;
  }
  return state.workflowDetailsById[workflowId] || null;
}

function setStatus(text) {
  statusBar.textContent = text;
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload?.message || `Request failed: ${response.status}`);
  }
  return payload;
}

function renderEmptyState(text) {
  return `<div class="stage-list-empty">${escapeHtml(text)}</div>`;
}

function buildStatusClass(status) {
  return status ? `status-${String(status).toLowerCase()}` : '';
}

function compactParts(parts) {
  return parts.filter(Boolean).join(' · ');
}

function normalizeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function summarizeStructuredValue(value) {
  if (value == null || value === '') {
    return '';
  }

  const text = typeof value === 'string'
    ? value
    : JSON.stringify(value);

  return truncateText(text.replaceAll(/\s+/g, ' ').trim(), 220);
}

function truncateText(text, maxLength) {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

function humanizeAction(action) {
  if (!action) {
    return '';
  }

  return String(action)
    .replaceAll(/[_-]+/g, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim()
    .replace(/^./, (character) => character.toUpperCase());
}

function inferEventTone(action, message, payload) {
  const haystack = `${action || ''} ${message || ''} ${JSON.stringify(payload || {})}`.toLowerCase();
  if (haystack.includes('blocked') || haystack.includes('error') || haystack.includes('fail')) {
    return 'danger';
  }
  if (haystack.includes('resume') || haystack.includes('reassign') || haystack.includes('rerun')) {
    return 'accent';
  }
  if (haystack.includes('done') || haystack.includes('complete') || haystack.includes('handoff') || haystack.includes('verify')) {
    return 'success';
  }
  if (haystack.includes('skip')) {
    return 'muted';
  }
  return 'info';
}

function formatTimestamp(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString();
}

function formatStructuredValue(value) {
  if (value == null || value === '') {
    return '-';
  }

  if (typeof value === 'string') {
    return value;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function escapeHtml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
