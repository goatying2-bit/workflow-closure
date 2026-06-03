import { createWorkflowEngine } from '../core/workflow-engine.js';
import { initializeAgentStore, getAgentStore } from '../storage/agents.js';
import { initializeWorkflowStore, getWorkflowStore } from '../storage/workflows.js';
import { initializeChainStore, getChainStore } from '../storage/chains.js';
import { createAssignmentService } from './coordinator/assignment-service.js';
import { createExecutionDispatcher } from './coordinator/execution-dispatcher.js';
import { createRoutingPolicy } from './coordinator/routing-policy.js';
import { createCoordinatorStateReader } from './coordinator/coordinator-state.js';
import { normalizeRuntimeAdapters } from './coordinator/shared.js';

export async function createMultiAgentCoordinator(options = {}) {
  await initializeWorkflowStore(options);
  await initializeChainStore(options);
  await initializeAgentStore(options);

  const engine = options.engine || await createWorkflowEngine(options);
  const workflowHygieneMetadata = normalizeWorkflowHygieneMetadata(options.workflowHygieneMetadata);
  const workflowStore = options.workflowStore || getWorkflowStore(options);
  const chainStore = options.chainStore || getChainStore(options);
  const agentStore = options.agentStore || getAgentStore(options);
  const runtimeAdapters = normalizeRuntimeAdapters(options.agentAdapters);

  const routingPolicy = createRoutingPolicy({
    agentStore,
    runtimeAdapters,
    resolveAgentAdapter: options.resolveAgentAdapter
  });
  const assignmentService = createAssignmentService({
    agentStore,
    workflowStore,
    chainStore,
    routingPolicy
  });
  const dispatcher = createExecutionDispatcher({
    options: workflowHygieneMetadata ? { ...options, workflowHygieneMetadata } : options,
    engine,
    agentStore,
    workflowStore,
    chainStore,
    runtimeAdapters,
    assignmentService
  });
  const stateReader = createCoordinatorStateReader({
    engine,
    agentStore,
    workflowStore,
    chainStore,
    routingPolicy
  });

  return {
    registerAgent(input = {}) {
      const agent = agentStore.registerAgent(input);
      if (input.adapter) {
        runtimeAdapters.set(agent.agentId, input.adapter);
      }
      return agent;
    },
    async assignNextWork(input = {}) {
      return assignmentService.assignNextWork(input);
    },
    async runNextAssignment(input = {}) {
      return dispatcher.runNextAssignment(input);
    },
    async resumeAssignedWork(input = {}) {
      return dispatcher.resumeAssignedWork(input);
    },
    getCoordinatorState(input = {}) {
      return stateReader.getCoordinatorState(input);
    }
  };
}

function normalizeWorkflowHygieneMetadata(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}
