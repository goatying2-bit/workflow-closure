import {
  RELEASABLE_ASSIGNMENT_STATUSES,
  buildAssignmentReason,
  getLatestAssignmentForTarget,
  loadAssignmentTarget,
  normalizeOptionalText,
  resolveBlockedTarget,
  resolveCandidateForAssignment,
  retargetOpenHandoffs,
  updateTargetAssignment
} from './shared.js';

export function createAssignmentService({ agentStore, workflowStore, chainStore, routingPolicy }) {
  return {
    assignNextWork(input = {}) {
      return assignNextWork({ input, agentStore, workflowStore, chainStore, routingPolicy });
    },
    markAssignmentAccepted(input) {
      return markAssignmentAccepted({ ...input, agentStore, workflowStore, chainStore });
    },
    markAssignmentResumed(input) {
      return markAssignmentResumed({ ...input, agentStore, workflowStore, chainStore });
    },
    releaseAssignmentForReassign(input) {
      return releaseAssignmentForReassign({ ...input, agentStore, workflowStore, chainStore });
    },
    finalizeAssignmentAfterRun(input) {
      return finalizeAssignmentAfterRun({ ...input, agentStore });
    },
    getLatestAssignmentForTarget(target) {
      return getLatestAssignmentForTarget(agentStore, target);
    },
    loadAssignmentTarget(input) {
      return loadAssignmentTarget({ ...input, workflowStore, chainStore });
    },
    resolveBlockedTarget(input = {}) {
      return resolveBlockedTarget({ input, workflowStore, chainStore });
    }
  };
}

function assignNextWork({ input, agentStore, workflowStore, chainStore, routingPolicy }) {
  const candidate = resolveCandidateForAssignment({ input, workflowStore, chainStore });
  if (!candidate) {
    return {
      status: 'idle',
      reason: 'no_ready_work',
      assignment: null,
      agent: null,
      target: null
    };
  }

  const activeAssignment = agentStore.getLatestActiveAssignmentForTarget({
    targetType: candidate.targetType,
    targetId: candidate.targetId
  });
  if (activeAssignment) {
    const assignedAgent = agentStore.getAgent(activeAssignment.agentId);
    return {
      status: 'assigned',
      reason: activeAssignment.reason,
      assignment: activeAssignment,
      agent: assignedAgent,
      target: loadAssignmentTarget({ assignment: activeAssignment, workflowStore, chainStore })
    };
  }

  const agent = routingPolicy.selectAgentForCandidate({ input, candidate });
  if (!agent) {
    return {
      status: 'idle',
      reason: 'no_available_agent',
      assignment: null,
      agent: null,
      target: candidate
    };
  }

  const assignmentReason = normalizeOptionalText(input.reason)
    || buildAssignmentReason(candidate, agent);
  const assignment = createAssignmentForCandidate({
    candidate,
    agent,
    assignmentReason,
    agentStore,
    workflowStore,
    chainStore
  });

  retargetOpenHandoffs({ agentStore, candidate, agentId: agent.agentId });

  return {
    status: 'assigned',
    reason: assignmentReason,
    assignment,
    agent,
    target: loadAssignmentTarget({ assignment, workflowStore, chainStore })
  };
}

function createAssignmentForCandidate({ candidate, agent, assignmentReason, agentStore, workflowStore, chainStore }) {
  updateTargetAssignment({
    candidate,
    ownerAgentId: agent.agentId,
    assignmentStatus: 'assigned',
    assignmentReason,
    workflowStore,
    chainStore,
    action: candidate.targetType === 'stage' ? 'chain_stage_assigned_by_coordinator' : 'task_assigned_by_coordinator',
    message: `${candidate.targetType === 'stage' ? 'Stage' : 'Task'} "${candidate.title}" assigned to agent "${agent.agentId}".`,
    payload: {
      ownerAgentId: agent.agentId,
      preferredRole: candidate.preferredRole,
      requiredCapabilities: candidate.requiredCapabilities,
      assignmentReason
    }
  });

  return agentStore.createAssignment({
    targetType: candidate.targetType,
    targetId: candidate.targetId,
    workflowId: candidate.workflowId,
    chainId: candidate.chainId,
    stageId: candidate.stageId,
    agentId: agent.agentId,
    status: 'assigned',
    reason: assignmentReason,
    payload: {
      title: candidate.title,
      preferredRole: candidate.preferredRole,
      requiredCapabilities: candidate.requiredCapabilities,
      targetStatus: candidate.status,
      taskId: candidate.taskId || null
    }
  });
}

function markAssignmentAccepted({ assignment, target, agent, agentStore, workflowStore, chainStore }) {
  updateTargetAssignment({
    candidate: target,
    ownerAgentId: agent.agentId,
    assignmentStatus: 'accepted',
    assignmentReason: assignment.reason,
    workflowStore,
    chainStore,
    action: target.targetType === 'stage' ? 'chain_stage_assignment_accepted' : 'task_assignment_accepted',
    message: `${target.targetType === 'stage' ? 'Stage' : 'Task'} "${target.title}" accepted by agent "${agent.agentId}".`,
    payload: {
      assignmentId: assignment.assignmentId,
      agentId: agent.agentId,
      assignmentReason: assignment.reason,
      taskId: target.taskId || null,
      resumedTaskId: target.targetType === 'stage' ? target.taskId || null : null
    }
  });

  return agentStore.updateAssignment({
    assignmentId: assignment.assignmentId,
    status: 'accepted',
    reason: assignment.reason,
    payload: {
      ...assignment.payload,
      acceptedBy: agent.agentId,
      taskId: target.taskId || assignment.payload?.taskId || null,
      resumedTaskId: target.targetType === 'stage'
        ? target.taskId || assignment.payload?.resumedTaskId || assignment.payload?.taskId || null
        : null
    }
  });
}

function markAssignmentResumed({ target, assignment, input, agentStore, workflowStore, chainStore }) {
  if (!assignment) {
    return null;
  }

  const reason = normalizeOptionalText(input.reason)
    || normalizeOptionalText(input.message)
    || `Resumed blocked ${target.targetType} "${target.title}".`;
  const taskId = target.taskId || assignment.payload?.taskId || null;
  const resumedTaskId = target.targetType === 'stage'
    ? target.taskId || assignment.payload?.resumedTaskId || assignment.payload?.taskId || null
    : null;

  updateTargetAssignment({
    candidate: target,
    ownerAgentId: assignment.agentId,
    assignmentStatus: 'assigned',
    assignmentReason: reason,
    workflowStore,
    chainStore,
    action: target.targetType === 'stage' ? 'chain_stage_resume_prepared' : 'task_resume_prepared',
    message: `${target.targetType === 'stage' ? 'Stage' : 'Task'} "${target.title}" resumed and reassigned to agent "${assignment.agentId}".`,
    payload: {
      assignmentId: assignment.assignmentId,
      agentId: assignment.agentId,
      taskId,
      resumedTaskId,
      resumeMessage: normalizeOptionalText(input.message),
      resumePayload: input.payload ?? null
    }
  });

  return agentStore.createAssignment({
    targetType: target.targetType,
    targetId: target.targetId,
    workflowId: target.workflowId,
    chainId: target.chainId,
    stageId: target.stageId,
    agentId: assignment.agentId,
    status: 'assigned',
    reason,
    payload: {
      ...assignment.payload,
      title: target.title,
      preferredRole: target.preferredRole,
      requiredCapabilities: target.requiredCapabilities,
      targetStatus: target.status,
      previousAssignmentId: assignment.assignmentId,
      resumedFromAssignmentId: assignment.assignmentId,
      resumedFromStatus: assignment.status,
      taskId,
      resumedTaskId,
      resumeMessage: normalizeOptionalText(input.message),
      resumePayload: input.payload ?? null
    }
  });
}

function releaseAssignmentForReassign({ target, assignment, input, agentStore, workflowStore, chainStore }) {
  updateTargetAssignment({
    candidate: target,
    ownerAgentId: null,
    assignmentStatus: 'released',
    assignmentReason: normalizeOptionalText(input.reason) || `Released ${target.targetType} "${target.title}" for reassignment.`,
    workflowStore,
    chainStore,
    action: target.targetType === 'stage' ? 'chain_stage_assignment_released' : 'task_assignment_released',
    message: `${target.targetType === 'stage' ? 'Stage' : 'Task'} "${target.title}" released for reassignment.`,
    payload: {
      previousAssignmentId: assignment?.assignmentId || null,
      previousAgentId: assignment?.agentId || target.ownerAgentId || null
    }
  });

  if (assignment && RELEASABLE_ASSIGNMENT_STATUSES.has(assignment.status)) {
    agentStore.updateAssignment({
      assignmentId: assignment.assignmentId,
      status: 'released',
      reason: normalizeOptionalText(input.reason) || `Released for reassignment after blocked ${target.targetType}.`,
      payload: {
        ...assignment.payload,
        releasedForReassign: true,
        nextAgentId: normalizeOptionalText(input.agentId)
      }
    });
  }
}

function finalizeAssignmentAfterRun({ agentStore, assignment, agent, target, status, payload }) {
  const nextStatus = status === 'done'
    ? 'completed'
    : status === 'blocked'
      ? 'blocked'
      : 'accepted';

  return agentStore.updateAssignment({
    assignmentId: assignment.assignmentId,
    agentId: agent.agentId,
    status: nextStatus,
    reason: nextStatus === 'completed'
      ? `${target.targetType === 'stage' ? 'Stage' : 'Task'} "${target.title}" completed by agent "${agent.agentId}".`
      : nextStatus === 'blocked'
        ? `${target.targetType === 'stage' ? 'Stage' : 'Task'} "${target.title}" blocked while assigned to agent "${agent.agentId}".`
        : assignment.reason,
    payload
  });
}

export { resolveBlockedTarget };
