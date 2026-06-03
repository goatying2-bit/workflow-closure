export const ADMIN_API_PREFIXES = Object.freeze({
  chains: '/api/chains/',
  workflows: '/api/workflows/',
  memories: '/api/memories/'
});

export const ADMIN_API_SUFFIXES = Object.freeze({
  workflowMemory: '/memory',
  workflowMonitor: '/monitor'
});

export const ADMIN_API_PATHS = Object.freeze({
  coordinatorState: '/api/coordinator-state',
  liveUpdates: '/api/live-updates',
  assignNextWork: '/api/assign-next-work',
  runNextAssignment: '/api/run-next-assignment',
  resumeAssignedWork: '/api/resume-assigned-work'
});

export const buildAdminApiPath = Object.freeze({
  coordinatorState(params) {
    return withQuery(ADMIN_API_PATHS.coordinatorState, params);
  },
  liveUpdates(params) {
    return withQuery(ADMIN_API_PATHS.liveUpdates, params);
  },
  chain(chainId, params) {
    return withQuery(`${ADMIN_API_PREFIXES.chains}${encodePathSegment(chainId)}`, params);
  },
  workflow(workflowId, params) {
    return withQuery(`${ADMIN_API_PREFIXES.workflows}${encodePathSegment(workflowId)}`, params);
  },
  workflowMemory(workflowId, params) {
    return withQuery(`${ADMIN_API_PREFIXES.workflows}${encodePathSegment(workflowId)}${ADMIN_API_SUFFIXES.workflowMemory}`, params);
  },
  workflowMonitor(workflowId, params) {
    return withQuery(`${ADMIN_API_PREFIXES.workflows}${encodePathSegment(workflowId)}${ADMIN_API_SUFFIXES.workflowMonitor}`, params);
  },
  memory(memoryId, params) {
    return withQuery(`${ADMIN_API_PREFIXES.memories}${encodePathSegment(memoryId)}`, params);
  }
});

export function withQuery(path, params) {
  const query = buildQueryString(params);
  return query ? `${path}?${query}` : path;
}

function buildQueryString(params) {
  if (!params) {
    return '';
  }

  const searchParams = new URLSearchParams();
  const entries = params instanceof URLSearchParams
    ? params.entries()
    : Object.entries(params);

  for (const [key, value] of entries) {
    appendQueryValue(searchParams, key, value);
  }

  return searchParams.toString();
}

function appendQueryValue(searchParams, key, value) {
  if (Array.isArray(value)) {
    for (const item of value) {
      appendQueryValue(searchParams, key, item);
    }
    return;
  }

  if (value == null || value === '') {
    return;
  }

  searchParams.append(key, String(value));
}

function encodePathSegment(value) {
  return encodeURIComponent(String(value));
}
