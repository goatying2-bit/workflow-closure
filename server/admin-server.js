import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createMultiAgentCoordinator,
  initializeChainStore,
  getChainStore,
  getWorkflowStore,
  buildCoordinatorAssignmentInput,
  buildCoordinatorExecutionInput,
  buildCoordinatorResumeInput,
  buildCoordinatorRuntimeOptions,
  buildCoordinatorStateInput,
  buildCoordinatorStateView,
  buildSharedRuntimeOptions
} from '../index.js';
import {
  createWorkflowTaskSourceRef,
  createWorkflowAssignmentSourceRef
} from '../internal.js';
import { getMemoryStore, initializeMemoryStore } from '../storage/memories.js';
import { withDbLock } from '../storage/db.js';
import {
  ADMIN_API_PATHS,
  ADMIN_API_PREFIXES,
  ADMIN_API_SUFFIXES
} from './admin-api-routes.js';

import {
  ADMIN_BACKEND_API_CONFIG,
  ADMIN_SERVER_DEFAULT_HOST,
  ADMIN_SERVER_DEFAULT_PORT,
  buildAdminServerUrl
} from './admin-server-config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const adminDir = path.join(__dirname, 'admin');

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store'
};

export async function createAdminServer(options = {}) {
  const args = { ...options };
  const runtimeOptions = buildSharedRuntimeOptions(args);
  const coordinatorOptions = await buildCoordinatorRuntimeOptions(args, runtimeOptions);
  const coordinator = await createMultiAgentCoordinator(coordinatorOptions);
  const chainStore = getChainStore(coordinatorOptions);
  const workflowStore = getWorkflowStore(coordinatorOptions);
  await initializeMemoryStore(coordinatorOptions);
  const memoryStore = getMemoryStore(coordinatorOptions);

  const server = http.createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url || '/', `http://${request.headers.host || ADMIN_BACKEND_API_CONFIG.server.host}`);
      const pathname = requestUrl.pathname;

      if (request.method === 'GET' && pathname === ADMIN_API_PATHS.coordinatorState) {
        const state = coordinator.getCoordinatorState(buildQueryArgs(requestUrl));
        return writeJson(response, 200, {
          status: 'ok',
          ...buildCoordinatorStateView({
            state,
            data: createRuntimeDbData(runtimeOptions)
          })
        });
      }

      if (request.method === 'GET' && pathname === ADMIN_API_PATHS.liveUpdates) {
        return handleLiveUpdates({
          request,
          response,
          coordinator,
          chainStore,
          workflowStore,
          queryArgs: buildQueryArgs(requestUrl)
        });
      }

      if (request.method === 'GET' && pathname.startsWith(ADMIN_API_PREFIXES.chains)) {
        const chainId = decodeURIComponent(pathname.slice(ADMIN_API_PREFIXES.chains.length));
        const queryArgs = buildQueryArgs(requestUrl);
        const chainState = buildAdminChainState(chainStore, workflowStore, chainId, queryArgs);
        return writeJson(response, 200, {
          status: 'ok',
          chainState
        });
      }

      if (request.method === 'GET' && pathname.startsWith(ADMIN_API_PREFIXES.workflows)) {
        const workflowPath = pathname.slice(ADMIN_API_PREFIXES.workflows.length);
        const memorySuffix = ADMIN_API_SUFFIXES.workflowMemory;
        const monitorSuffix = ADMIN_API_SUFFIXES.workflowMonitor;
        const queryArgs = buildQueryArgs(requestUrl);

        if (workflowPath.endsWith(memorySuffix)) {
          const workflowId = decodeURIComponent(workflowPath.slice(0, -memorySuffix.length));
          const workflowState = attachRuntimeToWorkflowState(buildAdminWorkflowState(workflowStore, workflowId, queryArgs), runtimeOptions);
          const memoryState = buildAdminWorkflowMemoryState({
            workflowState,
            workflowId,
            memoryStore,
            queryArgs,
            boundary: coordinatorOptions
          });
          return writeJson(response, 200, {
            status: 'ok',
            memoryState
          });
        }

        if (workflowPath.endsWith(monitorSuffix)) {
          const workflowId = decodeURIComponent(workflowPath.slice(0, -monitorSuffix.length));
          const workflowState = attachRuntimeToWorkflowState(buildAdminWorkflowState(workflowStore, workflowId, {
            ...queryArgs,
            includeRunLogs: true,
            includeOutputs: true
          }), runtimeOptions);
          const monitorState = buildWorkflowMonitorState(workflowState, queryArgs);
          return writeJson(response, 200, {
            status: 'ok',
            monitorState,
            ...createRuntimeDbData(runtimeOptions)
          });
        }

        const workflowId = decodeURIComponent(workflowPath);
        const workflowState = attachRuntimeToWorkflowState(buildAdminWorkflowState(workflowStore, workflowId, queryArgs), runtimeOptions);
        const monitorState = buildWorkflowMonitorState(workflowState, queryArgs);
        return writeJson(response, 200, {
          status: 'ok',
          workflowState,
          monitorState
        });
      }

      if (request.method === 'GET' && pathname.startsWith(ADMIN_API_PREFIXES.memories)) {
        const memoryId = decodeURIComponent(pathname.slice(ADMIN_API_PREFIXES.memories.length));
        const queryArgs = buildQueryArgs(requestUrl);
        const memoryState = memoryStore.getMemoryState(memoryId, {
          includeEvents: queryArgs.includeEvents === true,
          includeLinks: queryArgs.includeLinks !== false,
          limit: queryArgs.limit
        });
        return writeJson(response, 200, {
          status: 'ok',
          memoryState
        });
      }

      if (request.method === 'POST' && pathname === ADMIN_API_PATHS.assignNextWork) {
        const body = await readJsonBody(request);
        const result = await withDbLock(runtimeOptions.dbPath, async () => coordinator.assignNextWork(buildCoordinatorAssignmentInput(body)));
        const state = coordinator.getCoordinatorState(buildCoordinatorStateInput(body));
        return writeJson(response, 200, {
          status: result.status,
          result,
          ...buildCoordinatorStateView({
            state,
            data: createRuntimeDbData(runtimeOptions)
          })
        });
      }

      if (request.method === 'POST' && pathname === ADMIN_API_PATHS.runNextAssignment) {
        const body = await readJsonBody(request);
        const result = await withDbLock(runtimeOptions.dbPath, async () => coordinator.runNextAssignment(buildCoordinatorExecutionInput(body)));
        const state = coordinator.getCoordinatorState(buildCoordinatorStateInput(body));
        return writeJson(response, 200, {
          status: result.status,
          result,
          ...buildCoordinatorStateView({
            state,
            data: createRuntimeDbData(runtimeOptions)
          })
        });
      }

      if (request.method === 'POST' && pathname === ADMIN_API_PATHS.resumeAssignedWork) {
        const body = await readJsonBody(request);
        const result = await withDbLock(runtimeOptions.dbPath, async () => coordinator.resumeAssignedWork(buildCoordinatorResumeInput(body)));
        const state = coordinator.getCoordinatorState(buildCoordinatorStateInput(body));
        return writeJson(response, 200, {
          status: result.status,
          mode: result.mode || null,
          result,
          ...buildCoordinatorStateView({
            state,
            data: createRuntimeDbData(runtimeOptions)
          })
        });
      }

      if (request.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
        return writeStatic(response, path.join(adminDir, 'index.html'), 'text/html; charset=utf-8');
      }

      if (request.method === 'GET' && pathname === '/api-routes.js') {
        return writeStatic(response, path.join(adminDir, 'api-routes.js'), 'application/javascript; charset=utf-8');
      }

      if (request.method === 'GET' && pathname === '/db-scope-config.js') {
        return writeStatic(response, path.join(adminDir, 'db-scope-config.js'), 'application/javascript; charset=utf-8');
      }

      if (request.method === 'GET' && pathname === '/app.js') {
        return writeStatic(response, path.join(adminDir, 'app.js'), 'application/javascript; charset=utf-8');
      }

      if (request.method === 'GET' && pathname === '/styles.css') {
        return writeStatic(response, path.join(adminDir, 'styles.css'), 'text/css; charset=utf-8');
      }

      writeJson(response, 404, {
        status: 'not_found',
        message: 'Not found.'
      });
    } catch (error) {
      writeJson(response, 500, {
        status: 'error',
        message: error instanceof Error ? error.message : String(error)
      });
    }
  });

  return {
    server,
    runtimeOptions,
    coordinator,
    async listen(port = ADMIN_SERVER_DEFAULT_PORT, host = ADMIN_SERVER_DEFAULT_HOST) {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve();
        });
      });
      return {
        port,
        host,
        url: buildAdminServerUrl({ host, port })
      };
    },
    async close() {
      await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  };
}

function createRuntimeDbData(runtimeOptions = {}) {
  return {
    runtime: {
      dbPath: runtimeOptions.dbPath || null,
      dbPathSource: runtimeOptions.dbPathSource || null,
      dbScopeLabel: runtimeOptions.dbScopeLabel || null,
      dbProfile: runtimeOptions.dbProfile || null,
      workspacePath: runtimeOptions.workspacePath || null,
      workspaceKey: runtimeOptions.workspaceKey || null,
      cliPath: path.resolve(path.join(__dirname, '..', 'cli.js'))
    }
  };
}

function attachRuntimeToWorkflowState(workflowState, runtimeOptions) {
  if (!workflowState || typeof workflowState !== 'object') {
    return workflowState;
  }

  return {
    ...workflowState,
    ...createRuntimeDbData(runtimeOptions)
  };
}

function buildAdminChainState(chainStore, workflowStore, chainId, queryArgs) {
  const chainQuery = {
    ...(queryArgs.includeRunLogs != null ? { includeRunLogs: queryArgs.includeRunLogs } : {}),
    ...(queryArgs.limit != null ? { limit: queryArgs.limit } : {}),
    ...(queryArgs.offset != null ? { offset: queryArgs.offset } : {})
  };
  const chainState = chainStore.getChainState(chainId, chainQuery);
  const workflowStates = buildChainWorkflowStates(workflowStore, chainState.stages || [], queryArgs);

  if (queryArgs.includeReruns !== false) {
    chainState.reruns = chainStore.listChainReruns(chainId, queryArgs);
  }

  if (queryArgs.includeRevisions !== false) {
    chainState.stageRevisions = chainStore.listStageRevisions({
      chainId,
      ...(queryArgs.stageId ? { stageId: queryArgs.stageId } : {}),
      ...(queryArgs.rerunId ? { rerunId: queryArgs.rerunId } : {}),
      ...(queryArgs.limit != null ? { limit: queryArgs.limit } : {})
    });
  }

  if (workflowStates.length > 0) {
    chainState.workflowStates = workflowStates;
  }

  return chainState;
}

function buildChainWorkflowStates(workflowStore, stages, queryArgs) {
  const workflowIds = Array.from(new Set(
    (stages || [])
      .map((stage) => stage?.workflowId || null)
      .filter(Boolean)
  ));

  return workflowIds.map((workflowId) => buildAdminWorkflowState(workflowStore, workflowId, queryArgs));
}

function buildAdminWorkflowState(workflowStore, workflowId, queryArgs) {
  const workflowQuery = {
    ...(queryArgs.includeRunLogs != null ? { includeRunLogs: queryArgs.includeRunLogs } : {}),
    ...(queryArgs.limit != null ? { limit: queryArgs.limit } : {}),
    ...(queryArgs.offset != null ? { offset: queryArgs.offset } : {})
  };
  const workflowState = workflowStore.getWorkflowState(workflowId, workflowQuery);

  if (queryArgs.includeReruns !== false) {
    workflowState.reruns = workflowStore.listWorkflowReruns(workflowId, queryArgs);
  }

  if (queryArgs.includeRevisions !== false) {
    workflowState.taskRevisions = workflowStore.listTaskRevisions({
      workflowId,
      ...(queryArgs.taskId ? { taskId: queryArgs.taskId } : {}),
      ...(queryArgs.rerunId ? { rerunId: queryArgs.rerunId } : {}),
      ...(queryArgs.limit != null ? { limit: queryArgs.limit } : {})
    });
  }

  if (queryArgs.includeOutputs !== false) {
    workflowState.taskOutputs = workflowStore.listTaskOutputs({
      workflowId,
      ...(queryArgs.taskId ? { taskId: queryArgs.taskId } : {}),
      ...(queryArgs.limit != null ? { limit: queryArgs.limit } : {})
    });
  }

  return workflowState;
}

function buildWorkflowMonitorState(workflowState, queryArgs = {}) {
  const tasks = Array.isArray(workflowState?.tasks) ? workflowState.tasks : [];
  const runLogs = Array.isArray(workflowState?.runLogs) ? workflowState.runLogs : [];
  const taskOutputs = Array.isArray(workflowState?.taskOutputs) ? workflowState.taskOutputs : [];
  const tasksById = new Map(tasks.map((task) => [task.taskId, task]));
  const nowMs = Date.now();
  const limit = Number.isInteger(queryArgs.limit) && queryArgs.limit > 0 ? queryArgs.limit : 50;
  const taskBoard = tasks.map((task) => buildMonitorTaskRow(task, nowMs));
  const activeWindows = taskBoard.filter((task) => task.status === 'doing' && task.leaseOwner);
  const workers = buildMonitorWorkers(activeWindows, nowMs);

  return {
    workflowId: workflowState?.workflow?.workflowId || null,
    generatedAt: new Date(nowMs).toISOString(),
    summary: {
      workerCount: workers.length,
      activeWindowCount: activeWindows.filter((window) => window.leaseState === 'active').length,
      expiredWindowCount: activeWindows.filter((window) => window.leaseState === 'expired').length,
      taskCountsByStatus: countBy(taskBoard, 'status')
    },
    activeWindows,
    workers,
    taskBoard,
    recentEvents: runLogs
      .slice(-limit)
      .reverse()
      .map((log) => buildMonitorEvent(log, tasksById)),
    recentOutputs: taskOutputs
      .slice(0, limit)
      .map((output) => buildMonitorOutput(output, tasksById))
  };
}

function buildMonitorTaskRow(task, nowMs) {
  return {
    taskId: task.taskId,
    title: task.title,
    status: task.status,
    sequence: task.sequence,
    ownerAgentId: task.ownerAgentId || null,
    preferredRole: task.preferredRole || null,
    assignmentStatus: task.assignmentStatus || null,
    leaseOwner: task.leaseOwner || null,
    leaseExpiresAt: task.leaseExpiresAt || null,
    leaseState: getLeaseState(task, nowMs),
    startedAt: task.startedAt || null,
    completedAt: task.completedAt || null,
    updatedAt: task.updatedAt || null,
    attemptCount: task.attemptCount || 0,
    blockedReason: task.blockedReason || null,
    doneSummary: task.doneSummary || null,
    hasHandoff: Boolean(task.handoff),
    handoffSummary: normalizeOptionalText(task.handoff?.summary)
  };
}

function buildMonitorWorkers(activeWindows, nowMs) {
  const workersById = new Map();

  for (const window of activeWindows) {
    const workerId = window.leaseOwner;
    if (!workersById.has(workerId)) {
      workersById.set(workerId, {
        workerId,
        leaseState: 'unknown',
        activeTaskCount: 0,
        taskIds: [],
        tasks: [],
        roles: [],
        ownerAgentIds: [],
        earliestStartedAt: null,
        latestUpdatedAt: null,
        nearestLeaseExpiresAt: null,
        leaseExpiresInMs: null
      });
    }

    const worker = workersById.get(workerId);
    worker.activeTaskCount += 1;
    worker.taskIds.push(window.taskId);
    worker.tasks.push({
      taskId: window.taskId,
      title: window.title,
      status: window.status,
      preferredRole: window.preferredRole,
      ownerAgentId: window.ownerAgentId,
      leaseExpiresAt: window.leaseExpiresAt,
      leaseState: window.leaseState
    });
    if (window.preferredRole && !worker.roles.includes(window.preferredRole)) {
      worker.roles.push(window.preferredRole);
    }
    if (window.ownerAgentId && !worker.ownerAgentIds.includes(window.ownerAgentId)) {
      worker.ownerAgentIds.push(window.ownerAgentId);
    }
    worker.earliestStartedAt = minTimestamp(worker.earliestStartedAt, window.startedAt);
    worker.latestUpdatedAt = maxTimestamp(worker.latestUpdatedAt, window.updatedAt);
    worker.nearestLeaseExpiresAt = minTimestamp(worker.nearestLeaseExpiresAt, window.leaseExpiresAt);
  }

  return [...workersById.values()].map((worker) => {
    const leaseStates = worker.tasks.map((task) => task.leaseState);
    const expiresMs = worker.nearestLeaseExpiresAt ? Date.parse(worker.nearestLeaseExpiresAt) : NaN;
    return {
      ...worker,
      leaseState: leaseStates.includes('active') ? 'active' : leaseStates.includes('expired') ? 'expired' : 'unknown',
      leaseExpiresInMs: Number.isFinite(expiresMs) ? expiresMs - nowMs : null
    };
  }).sort((a, b) => a.workerId.localeCompare(b.workerId));
}

function buildMonitorEvent(log, tasksById) {
  const task = tasksById.get(log.taskId);
  const payload = log.payload && typeof log.payload === 'object' && !Array.isArray(log.payload)
    ? log.payload
    : {};

  return {
    logId: log.logId,
    taskId: log.taskId || null,
    taskTitle: task?.title || null,
    action: log.action,
    message: log.message,
    leaseOwner: normalizeOptionalText(payload.leaseOwner) || normalizeOptionalText(payload.expectedLeaseOwner),
    nextStatus: normalizeOptionalText(payload.nextStatus),
    previousStatus: normalizeOptionalText(payload.previousStatus),
    outputCount: Array.isArray(payload.taskOutputs) ? payload.taskOutputs.length : 0,
    createdAt: log.createdAt
  };
}

function buildMonitorOutput(output, tasksById) {
  const task = tasksById.get(output.taskId);
  return {
    outputId: output.outputId,
    taskId: output.taskId,
    taskTitle: task?.title || null,
    kind: output.kind,
    name: output.name || null,
    contentPreview: buildTextPreview(output.content),
    path: output.path || null,
    createdAt: output.createdAt,
    workerId: normalizeOptionalText(output.metadata?.workerId),
    outputRoute: normalizeOptionalText(output.metadata?.outputRoute),
    captureSource: normalizeOptionalText(output.metadata?.captureSource)
  };
}

function getLeaseState(task, nowMs) {
  if (task.status !== 'doing' || !task.leaseOwner) {
    return null;
  }

  if (!task.leaseExpiresAt) {
    return 'unknown';
  }

  const expiresMs = Date.parse(task.leaseExpiresAt);
  if (!Number.isFinite(expiresMs)) {
    return 'unknown';
  }

  return expiresMs > nowMs ? 'active' : 'expired';
}

function countBy(items, key) {
  return items.reduce((counts, item) => {
    const value = item?.[key] || 'unknown';
    counts[value] = (counts[value] || 0) + 1;
    return counts;
  }, {});
}

function minTimestamp(current, candidate) {
  if (!candidate) {
    return current;
  }

  if (!current) {
    return candidate;
  }

  return Date.parse(candidate) < Date.parse(current) ? candidate : current;
}

function maxTimestamp(current, candidate) {
  if (!candidate) {
    return current;
  }

  if (!current) {
    return candidate;
  }

  return Date.parse(candidate) > Date.parse(current) ? candidate : current;
}

function buildTextPreview(value, maxLength = 160) {
  const text = normalizeOptionalText(value);
  if (!text) {
    return null;
  }

  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function normalizeOptionalText(value) {
  if (value == null) {
    return null;
  }

  const text = String(value).trim();
  return text || null;
}


function buildAdminWorkflowMemoryState({ workflowState, workflowId, memoryStore, queryArgs, boundary }) {
  const task = resolveWorkflowMemoryTask(workflowState, queryArgs.taskId);
  const memoryBoundary = buildMemoryBoundary(boundary);
  const limit = queryArgs.limit ?? 8;

  if (!task) {
    return {
      workflowId,
      taskId: queryArgs.taskId || null,
      memoryEnabled: true,
      items: [],
      total: 0,
      exactItems: [],
      structuralItems: [],
      graphItems: [],
      semanticItems: [],
      selectedReasons: [],
      query: buildWorkflowMemoryQuery({
        workflowState,
        workflowId,
        task: null,
        exactItems: [],
        structuralItems: [],
        semanticItems: [],
        limit
      }),
      graph: {
        nodes: [],
        edges: []
      }
    };
  }

  const exactItems = enrichMemoryItems(
    memoryStore.recall({
      ...memoryBoundary,
      sourceRef: createWorkflowTaskSourceRef(workflowId, task.taskId),
      graph: false,
      limit
    }).items,
    {
      matchedBy: { exactSourceRef: true },
      authority: 'high'
    }
  );

  const structuralItems = dedupeMemoryItemsById(enrichMemoryItems(
    memoryStore.recall({
      ...memoryBoundary,
      workflowId,
      taskId: task.taskId,
      graph: false,
      limit: Math.max(limit, 4)
    }).items,
    {
      filter(item) {
        return isStructuredTaskMemoryMatch(item, workflowId, task.taskId);
      },
      matchedBy: { structural: true },
      authority: 'medium'
    }
  )).filter((item) => !exactItems.some((exactItem) => exactItem.memoryId === item.memoryId));

  const graphItems = dedupeMemoryItemsById(enrichMemoryItems(
    memoryStore.recall({
      ...memoryBoundary,
      workflowId,
      taskId: task.taskId,
      graph: true,
      limit: Math.max(limit, 4)
    }).items,
    {
      filter(item) {
        return Boolean(item?.matchedBy?.graph);
      },
      matchedBy: { graph: true },
      authority: 'medium'
    }
  )).filter((item) => !exactItems.some((exactItem) => exactItem.memoryId === item.memoryId)
    && !structuralItems.some((structuralItem) => structuralItem.memoryId === item.memoryId));

  const semanticText = buildTaskRecallText(workflowState, task);
  const semanticReservedSlots = resolveSemanticLaneLimit({
    enabled: Boolean(semanticText),
    limit
  });
  const seedItems = dedupeMemoryItemsById([...exactItems, ...structuralItems, ...graphItems]);
  const semanticCandidates = semanticReservedSlots > 0
    ? enrichMemoryItems(
      memoryStore.recall({
        ...memoryBoundary,
        text: semanticText,
        limit: Math.max(limit, 4)
      }).items,
      {
        matchedBy: { semantic: true },
        authority: 'low'
      }
    ).filter((item) => !seedItems.some((seedItem) => seedItem.memoryId === item.memoryId))
    : [];
  const semanticItems = semanticReservedSlots > 0
    ? semanticCandidates.slice(0, semanticReservedSlots)
    : [];
  const selectedSeedItems = seedItems.slice(0, Math.max(0, limit - semanticItems.length));
  const items = dedupeMemoryItemsById([...selectedSeedItems, ...semanticItems]).slice(0, limit);
  const graph = buildMemoryGraph(task, items);

  return {
    workflowId,
    taskId: task.taskId,
    memoryEnabled: true,
    items,
    total: items.length,
    exactItems,
    structuralItems,
    graphItems,
    semanticItems,
    selectedReasons: [...new Set(items.flatMap((item) => buildMemorySelectionReasons(item, {
      exactItems,
      structuralItems,
      graphItems,
      semanticItems
    })))],
    query: buildWorkflowMemoryQuery({
      workflowState,
      workflowId,
      task,
      exactItems,
      structuralItems,
      semanticItems,
      limit,
      semanticText
    }),
    graph
  };
}

function resolveWorkflowMemoryTask(workflowState, taskId) {
  const tasks = Array.isArray(workflowState?.tasks) ? workflowState.tasks : [];
  if (tasks.length === 0) {
    return null;
  }

  if (taskId) {
    return tasks.find((task) => task?.taskId === taskId) || null;
  }

  return tasks.find((task) => task?.status === 'running')
    || tasks.find((task) => task?.status === 'blocked')
    || tasks.find((task) => task?.status === 'pending')
    || tasks[0]
    || null;
}

function buildMemoryBoundary(boundary = {}) {
  return {
    scope: boundary.scope,
    projectKey: boundary.projectKey,
    workspacePath: boundary.workspacePath,
    sessionId: boundary.sessionId
  };
}

function enrichMemoryItems(items, options = {}) {
  if (!Array.isArray(items)) {
    return [];
  }

  return items
    .filter((item) => item?.status === 'active')
    .filter((item) => !options.filter || options.filter(item))
    .map((item) => ({
      ...item,
      matchedBy: {
        ...(item?.matchedBy || {}),
        ...(options.matchedBy || {})
      },
      authority: item?.authority || options.authority || null
    }));
}

function dedupeMemoryItemsById(items) {
  const output = [];
  const seen = new Set();

  for (const item of items || []) {
    if (!item?.memoryId || seen.has(item.memoryId)) {
      continue;
    }
    seen.add(item.memoryId);
    output.push(item);
  }

  return output;
}

function isStructuredTaskMemoryMatch(item, workflowId, taskId) {
  if (!item || item.workflowId !== workflowId || item.taskId !== taskId) {
    return false;
  }

  const taskSourceRef = createWorkflowTaskSourceRef(workflowId, taskId);
  const assignmentSourceRef = createWorkflowAssignmentSourceRef(workflowId, taskId);
  const sourceKind = item.sourceKind || null;
  const sourceRef = item.sourceRef || null;
  const subjectKind = item.subjectKind || null;
  const subjectRef = item.subjectRef || null;
  const isAssignmentMemory = sourceKind === 'workflow-assignment' || subjectKind === 'workflow-assignment';
  const isTaskMemory = sourceKind === 'workflow-task'
    || subjectKind === 'workflow-task'
    || sourceKind === 'workflow-task-rerun'
    || subjectKind === 'workflow-task-rerun';

  if (isAssignmentMemory) {
    return sourceRef === assignmentSourceRef || subjectRef === assignmentSourceRef;
  }

  if (isTaskMemory) {
    return sourceRef === taskSourceRef || subjectRef === taskSourceRef;
  }

  return false;
}

function buildTaskRecallText(workflowState, task) {
  const parts = [
    workflowState?.workflow?.goal,
    workflowState?.workflow?.instruction,
    task?.title,
    task?.description,
    task?.lastError
  ];
  const dependencies = Array.isArray(workflowState?.dependencies) ? workflowState.dependencies : [];
  const tasks = Array.isArray(workflowState?.tasks) ? workflowState.tasks : [];
  const predecessorSummaries = dependencies
    .filter((dependency) => dependency?.successorTaskId === task?.taskId)
    .map((dependency) => tasks.find((item) => item?.taskId === dependency?.predecessorTaskId))
    .filter((item) => item?.doneSummary)
    .map((item) => item.doneSummary);

  parts.push(...predecessorSummaries);
  return parts.filter(Boolean).join(' ');
}

function resolveSemanticLaneLimit(input = {}) {
  if (!input.enabled) {
    return 0;
  }

  if (input.limit == null) {
    return 4;
  }

  const limit = Number(input.limit) || 0;
  if (limit <= 0) {
    return 0;
  }

  return Math.min(4, Math.max(1, Math.floor(limit / 2)));
}

function buildWorkflowMemoryQuery({ workflowState, workflowId, task, exactItems, structuralItems, semanticItems, limit, semanticText }) {
  return {
    workflowId,
    taskId: task?.taskId || null,
    exactSourceRef: task ? createWorkflowTaskSourceRef(workflowId, task.taskId) : null,
    structural: task
      ? {
        workflowId,
        taskId: task.taskId
      }
      : null,
    graph: (exactItems.length + structuralItems.length) > 0,
    semanticReservedSlots: resolveSemanticLaneLimit({ enabled: Boolean(semanticText), limit }),
    semanticText: semanticItems.length > 0 ? semanticText : null,
    workflowStatus: workflowState?.workflow?.status || null
  };
}

function buildMemoryGraph(task, items) {
  const selectedItems = Array.isArray(items) ? items : [];
  const taskNodeId = task?.taskId ? `task:${task.taskId}` : 'task:selected';
  const nodes = [
    {
      id: taskNodeId,
      kind: 'task',
      lane: 'task',
      label: task?.title || task?.taskId || 'Selected task',
      taskId: task?.taskId || null,
      status: task?.status || null
    }
  ];
  const edges = [];
  const seenNodes = new Set([taskNodeId]);
  const seenEdges = new Set();

  for (const item of selectedItems) {
    if (!item?.memoryId) {
      continue;
    }

    const memoryNodeId = `memory:${item.memoryId}`;
    if (!seenNodes.has(memoryNodeId)) {
      seenNodes.add(memoryNodeId);
      nodes.push({
        id: memoryNodeId,
        kind: 'memory',
        lane: resolveMemoryLane(item, selectedItems),
        label: item.title || item.summary || item.memoryId,
        memoryId: item.memoryId,
        summary: item.summary || null,
        matchedBy: item.matchedBy || null,
        status: item.status || null
      });
    }

    pushGraphEdge(edges, seenEdges, {
      id: `${taskNodeId}->${memoryNodeId}`,
      source: taskNodeId,
      target: memoryNodeId,
      kind: 'selected',
      relation: resolveMemoryLane(item, selectedItems)
    });

    const seedIds = Array.isArray(item?.matchedBy?.graphSeedMemoryIds) ? item.matchedBy.graphSeedMemoryIds : [];
    const relations = Array.isArray(item?.matchedBy?.graphRelations) ? item.matchedBy.graphRelations : [];
    for (const seedMemoryId of seedIds) {
      if (!seedMemoryId) {
        continue;
      }
      const seedNodeId = `memory:${seedMemoryId}`;
      if (!seenNodes.has(seedNodeId)) {
        seenNodes.add(seedNodeId);
        nodes.push({
          id: seedNodeId,
          kind: 'memory',
          lane: 'linked',
          label: seedMemoryId,
          memoryId: seedMemoryId,
          summary: null,
          matchedBy: null,
          status: null
        });
      }
      pushGraphEdge(edges, seenEdges, {
        id: `${memoryNodeId}->${seedNodeId}`,
        source: memoryNodeId,
        target: seedNodeId,
        kind: 'memory-link',
        relation: relations[0] || 'linked'
      });
    }
  }

  return { nodes, edges };
}

function pushGraphEdge(edges, seenEdges, edge) {
  if (!edge?.source || !edge?.target) {
    return;
  }

  const key = edge.id || `${edge.source}->${edge.target}:${edge.kind || 'edge'}:${edge.relation || ''}`;
  if (seenEdges.has(key)) {
    return;
  }

  seenEdges.add(key);
  edges.push({
    id: key,
    ...edge
  });
}

function resolveMemoryLane(item, recalled) {
  const memoryId = item?.memoryId;
  if (!memoryId) {
    return 'selected';
  }

  if (Array.isArray(recalled) && recalled.some((entry) => entry?.memoryId === memoryId && entry?.matchedBy?.exactSourceRef)) {
    return 'exact';
  }

  if (item?.matchedBy?.structural) {
    return 'structural';
  }

  if (item?.matchedBy?.graph) {
    return 'graph';
  }

  if (item?.matchedBy?.semantic) {
    return 'semantic';
  }

  return 'selected';
}

function buildMemorySelectionReasons(item, recalled) {
  const reasons = [];
  const memoryId = item?.memoryId;

  if (memoryId && Array.isArray(recalled?.exactItems) && recalled.exactItems.some((exactItem) => exactItem?.memoryId === memoryId)) {
    reasons.push('exact-memory');
  }

  if (memoryId && Array.isArray(recalled?.structuralItems) && recalled.structuralItems.some((structuralItem) => structuralItem?.memoryId === memoryId)) {
    reasons.push('structural-memory');
  }

  if (memoryId && Array.isArray(recalled?.graphItems) && recalled.graphItems.some((graphItem) => graphItem?.memoryId === memoryId)) {
    reasons.push('graph-memory');
  }

  if (memoryId && Array.isArray(recalled?.semanticItems) && recalled.semanticItems.some((semanticItem) => semanticItem?.memoryId === memoryId)) {
    reasons.push('semantic-memory');
  }

  return reasons.length > 0 ? reasons : ['memory'];
}

function buildQueryArgs(requestUrl) {
  return {
    workflowId: requestUrl.searchParams.get('workflowId') || undefined,
    chainId: requestUrl.searchParams.get('chainId') || undefined,
    taskId: requestUrl.searchParams.get('taskId') || undefined,
    stageId: requestUrl.searchParams.get('stageId') || undefined,
    agentId: requestUrl.searchParams.get('agentId') || undefined,
    role: requestUrl.searchParams.get('role') || undefined,
    status: requestUrl.searchParams.get('status') || undefined,
    assignmentStatus: requestUrl.searchParams.get('assignmentStatus') || undefined,
    handoffStatus: requestUrl.searchParams.get('handoffStatus') || undefined,
    targetType: requestUrl.searchParams.get('targetType') || undefined,
    rerunId: requestUrl.searchParams.get('rerunId') || undefined,
    limit: parseOptionalNumber(requestUrl.searchParams.get('limit')),
    assignmentLimit: parseOptionalNumber(requestUrl.searchParams.get('assignmentLimit')),
    handoffLimit: parseOptionalNumber(requestUrl.searchParams.get('handoffLimit')),
    includeRunLogs: parseOptionalBoolean(requestUrl.searchParams.get('includeRunLogs')),
    includeTestData: parseOptionalBoolean(requestUrl.searchParams.get('includeTestData')),
    includeHistory: parseOptionalBoolean(requestUrl.searchParams.get('includeHistory')),
    includeReruns: parseOptionalBoolean(requestUrl.searchParams.get('includeReruns')),
    includeRevisions: parseOptionalBoolean(requestUrl.searchParams.get('includeRevisions')),
    includeOutputs: parseOptionalBoolean(requestUrl.searchParams.get('includeOutputs')),
    includeEvents: parseOptionalBoolean(requestUrl.searchParams.get('includeEvents')),
    includeLinks: parseOptionalBoolean(requestUrl.searchParams.get('includeLinks')),
    offset: parseOptionalNumber(requestUrl.searchParams.get('offset'))
  };
}

async function handleLiveUpdates({ request, response, coordinator, chainStore, workflowStore, queryArgs }) {
  const headers = {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive'
  };
  response.writeHead(200, headers);
  response.write(': connected\n\n');

  let closed = false;
  let previousSummary = '';
  let previousChain = '';
  let previousWorkflow = '';
  let timer = null;

  const close = () => {
    if (closed) {
      return;
    }
    closed = true;
    if (timer) {
      clearInterval(timer);
    }
    response.end();
  };

  request.on('close', close);
  response.on('close', close);
  response.on('error', close);

  const sendEvent = (type, payload) => {
    if (closed) {
      return;
    }
    response.write(`event: ${type}\n`);
    response.write(`data: ${JSON.stringify({
      time: new Date().toISOString(),
      ...payload
    })}\n\n`);
  };

  const emitSnapshot = () => {
    if (closed) {
      return;
    }

    const state = coordinator.getCoordinatorState(queryArgs);
    const summaryPayload = {
      status: 'ok',
      ...buildCoordinatorStateView({ state })
    };
    const summaryJson = JSON.stringify(summaryPayload);
    if (summaryJson !== previousSummary) {
      previousSummary = summaryJson;
      sendEvent('summary', summaryPayload);
    }

    if (queryArgs.chainId) {
      const chainState = buildAdminChainState(chainStore, workflowStore, queryArgs.chainId, {
        ...queryArgs,
        includeRunLogs: true,
        includeReruns: true,
        includeRevisions: true,
        includeOutputs: false,
        limit: queryArgs.limit ?? 50
      });
      const chainJson = JSON.stringify(chainState);
      if (chainJson !== previousChain) {
        previousChain = chainJson;
        sendEvent('chain', { chainState });
      }
    }

    if (queryArgs.workflowId) {
      const workflowState = buildAdminWorkflowState(workflowStore, queryArgs.workflowId, {
        ...queryArgs,
        includeRunLogs: true,
        includeReruns: true,
        includeRevisions: true,
        includeOutputs: true,
        limit: queryArgs.limit ?? 50
      });
      const monitorState = buildWorkflowMonitorState(workflowState, queryArgs);
      const workflowPayload = { workflowState, monitorState };
      const workflowJson = JSON.stringify(workflowPayload);
      if (workflowJson !== previousWorkflow) {
        previousWorkflow = workflowJson;
        sendEvent('workflow', workflowPayload);
      }
    }

    sendEvent('heartbeat', {
      chainId: queryArgs.chainId || null,
      workflowId: queryArgs.workflowId || null
    });
  };

  emitSnapshot();
  timer = setInterval(emitSnapshot, 1500);
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) {
    return {};
  }

  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Request body must be a JSON object.');
  }

  return parsed;
}

async function writeStatic(response, filePath, contentType) {
  const content = await fs.readFile(filePath);
  response.writeHead(200, {
    'content-type': contentType,
    'cache-control': 'no-store'
  });
  response.end(content);
}

function writeJson(response, statusCode, payload) {
  response.writeHead(statusCode, JSON_HEADERS);
  response.end(JSON.stringify(payload, null, 2));
}

function parseOptionalNumber(value) {
  if (value == null || value === '') {
    return undefined;
  }

  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new Error('Query parameter must be a number.');
  }

  return number;
}

function parseOptionalBoolean(value) {
  if (value == null || value === '') {
    return undefined;
  }

  if (value === 'true') {
    return true;
  }

  if (value === 'false') {
    return false;
  }

  throw new Error('Query parameter must be a boolean.');
}
