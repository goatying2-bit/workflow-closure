import fs from 'node:fs';
import path from 'node:path';

export const DB_PATH_SOURCES = Object.freeze({
  explicit: 'explicit',
  profile: 'profile',
  workspace: 'workspace',
  default: 'default'
});

export const DB_SCOPE_LABELS = Object.freeze({
  [DB_PATH_SOURCES.explicit]: 'explicit-db-path',
  [DB_PATH_SOURCES.profile]: 'isolated-db-profile',
  [DB_PATH_SOURCES.workspace]: 'default-workspace-db',
  [DB_PATH_SOURCES.default]: 'default-global-db'
});

export function getDbScopeLabel(dbPathSource) {
  return DB_SCOPE_LABELS[dbPathSource] || DB_SCOPE_LABELS[DB_PATH_SOURCES.default];
}

export function formatRuntimeDbScope(runtime = null) {
  const source = runtime?.dbPathSource || DB_PATH_SOURCES.default;
  const label = runtime?.dbScopeLabel || getDbScopeLabel(source);

  if (source === DB_PATH_SOURCES.profile) {
    return `独立 profile 数据 / ${label}`;
  }

  if (source === DB_PATH_SOURCES.explicit) {
    return `独立指定数据库 / ${label}`;
  }

  if (source === DB_PATH_SOURCES.workspace) {
    return `默认 workspace 数据 / ${label}`;
  }

  return `默认全局数据 / ${label}`;
}

export function createRuntimeRecoverySelector(runtime = {}) {
  if (runtime?.dbProfile) {
    return { dbProfile: runtime.dbProfile };
  }

  if (runtime?.dbPathSource === DB_PATH_SOURCES.explicit && runtime.dbPath) {
    return { dbPath: runtime.dbPath };
  }

  if (runtime?.workspacePath) {
    return { workspacePath: runtime.workspacePath };
  }

  return {};
}

export function listDbProfiles({ profilesRoot, resolveDbTarget }) {
  if (!profilesRoot || typeof resolveDbTarget !== 'function' || !fs.existsSync(profilesRoot)) {
    return [];
  }

  return fs.readdirSync(profilesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const profileTarget = resolveDbTarget({ dbProfile: entry.name });
      return {
        dbProfile: profileTarget.dbProfile,
        dbPath: profileTarget.dbPath,
        exists: fs.existsSync(profileTarget.dbPath)
      };
    });
}

export function resolveDbProfilesRoot({ resolveDbTarget }) {
  const profileRoot = path.dirname(resolveDbTarget({ dbProfile: 'profile-root-probe' }).dbPath);
  return path.dirname(profileRoot);
}
