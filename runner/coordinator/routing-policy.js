import {
  DEFAULT_ASSIGNMENT_LIMIT,
  ACTIVE_AGENT_STATUSES,
  ACTIVE_ASSIGNMENT_STATUSES,
  buildAssignmentReason,
  normalizeOptionalText,
  normalizeStringArray,
  resolveRuntimeAdapter
} from './shared.js';

export function createRoutingPolicy({ agentStore, runtimeAdapters, resolveAgentAdapter }) {
  return {
    selectAgentForCandidate(input) {
      return selectAgentForCandidate({
        ...input,
        agentStore,
        runtimeAdapters,
        resolveAgentAdapter
      });
    },
    getActiveAssignmentCount(agentId) {
      return getActiveAssignmentCount(agentStore, agentId);
    },
    buildAssignmentReason(candidate, agent) {
      return buildAssignmentReason(candidate, agent);
    }
  };
}

export function selectAgentForCandidate({ input, candidate, agentStore, runtimeAdapters, resolveAgentAdapter }) {
  const requestedAgentId = normalizeOptionalText(input.agentId);
  if (requestedAgentId) {
    const agent = agentStore.getAgent(requestedAgentId);
    if (!agent) {
      throw new Error(`Agent not found: ${requestedAgentId}`);
    }
    if (!isAgentEligible({ agent, candidate, agentStore, runtimeAdapters, resolveAgentAdapter })) {
      throw new Error(`Agent "${requestedAgentId}" cannot accept ${candidate.targetType} "${candidate.title}".`);
    }
    return agent;
  }

  const agents = agentStore.listAgents({
    status: 'active',
    limit: DEFAULT_ASSIGNMENT_LIMIT
  }).filter((agent) => isAgentEligible({ agent, candidate, agentStore, runtimeAdapters, resolveAgentAdapter }));

  if (candidate.ownerAgentId) {
    const owner = agentStore.getAgent(candidate.ownerAgentId);
    if (owner && isAgentEligible({ agent: owner, candidate, agentStore, runtimeAdapters, resolveAgentAdapter })) {
      agents.unshift(owner);
    }
  }

  const ranked = dedupeAgents(agents).sort((left, right) => compareAgents({ left, right, candidate, agentStore }));
  return ranked[0] || null;
}

function compareAgents({ left, right, candidate, agentStore }) {
  const leftOwnerScore = left.agentId === candidate.ownerAgentId ? 0 : 1;
  const rightOwnerScore = right.agentId === candidate.ownerAgentId ? 0 : 1;
  if (leftOwnerScore !== rightOwnerScore) {
    return leftOwnerScore - rightOwnerScore;
  }

  const leftLoad = getActiveAssignmentCount(agentStore, left.agentId);
  const rightLoad = getActiveAssignmentCount(agentStore, right.agentId);
  if (leftLoad !== rightLoad) {
    return leftLoad - rightLoad;
  }

  const leftRoleScore = getRoleCompatibilityScore(left, candidate);
  const rightRoleScore = getRoleCompatibilityScore(right, candidate);
  if (leftRoleScore !== rightRoleScore) {
    return leftRoleScore - rightRoleScore;
  }

  return String(left.agentId).localeCompare(String(right.agentId));
}

function getRoleCompatibilityScore(agent, candidate) {
  const preferredRole = normalizeOptionalText(candidate.preferredRole);
  if (!preferredRole) {
    return 0;
  }

  return agent.role === preferredRole ? 0 : 1;
}

function isAgentEligible({ agent, candidate, agentStore, runtimeAdapters, resolveAgentAdapter }) {
  if (!agent || !ACTIVE_AGENT_STATUSES.has(agent.status)) {
    return false;
  }

  if (!resolveRuntimeAdapter({ agent, runtimeAdapters, resolver: resolveAgentAdapter })) {
    return false;
  }

  if (!hasRequiredRole(agent, candidate)) {
    return false;
  }

  if (!hasRequiredCapabilities(agent.capabilities, candidate.requiredCapabilities)) {
    return false;
  }

  return getActiveAssignmentCount(agentStore, agent.agentId) < agent.maxConcurrency;
}

function getActiveAssignmentCount(agentStore, agentId) {
  return agentStore.listAssignments({
    agentId,
    limit: DEFAULT_ASSIGNMENT_LIMIT
  }).filter((assignment) => ACTIVE_ASSIGNMENT_STATUSES.has(assignment.status)).length;
}

function hasRequiredRole(agent, candidate) {
  const requiredRole = normalizeOptionalText(candidate.preferredRole);
  if (!requiredRole) {
    return true;
  }

  return normalizeOptionalText(agent.role) === requiredRole;
}

function hasRequiredCapabilities(agentCapabilities, requiredCapabilities) {
  const available = new Set(normalizeStringArray(agentCapabilities));
  return normalizeStringArray(requiredCapabilities).every((capability) => available.has(capability));
}

function dedupeAgents(agents) {
  const seen = new Set();
  const items = [];

  for (const agent of agents) {
    if (!agent || seen.has(agent.agentId)) {
      continue;
    }
    seen.add(agent.agentId);
    items.push(agent);
  }

  return items;
}
