import {
  ADMIN_API_PATHS,
  ADMIN_API_PREFIXES,
  ADMIN_API_SUFFIXES,
  buildAdminApiPath
} from './admin-api-routes.js';

export const ADMIN_SERVER_DEFAULT_HOST = '127.0.0.1';
export const ADMIN_SERVER_DEFAULT_PORT = 3001;

export const ADMIN_SERVER_ENV_KEYS = Object.freeze({
  host: 'HOST',
  port: 'PORT'
});

export const ADMIN_FRONTEND_SERVER_CONFIG = Object.freeze({
  host: ADMIN_SERVER_DEFAULT_HOST,
  port: ADMIN_SERVER_DEFAULT_PORT
});

export const ADMIN_BACKEND_SERVER_CONFIG = Object.freeze({
  host: ADMIN_SERVER_DEFAULT_HOST,
  port: ADMIN_SERVER_DEFAULT_PORT
});

export const ADMIN_BACKEND_API_CONFIG = Object.freeze({
  server: ADMIN_BACKEND_SERVER_CONFIG,
  paths: ADMIN_API_PATHS,
  prefixes: ADMIN_API_PREFIXES,
  suffixes: ADMIN_API_SUFFIXES,
  buildPath: buildAdminApiPath
});

export function resolveAdminServerListenOptions(options = {}) {
  const env = options.env || process.env;
  const host = getOptionalText(options.host)
    || getOptionalText(env[ADMIN_SERVER_ENV_KEYS.host])
    || ADMIN_BACKEND_SERVER_CONFIG.host;
  const port = resolvePort(options.port, env[ADMIN_SERVER_ENV_KEYS.port], ADMIN_BACKEND_SERVER_CONFIG.port);

  return { host, port };
}

export function buildAdminServerUrl(options = {}) {
  const host = getOptionalText(options.host) || ADMIN_BACKEND_SERVER_CONFIG.host;
  const port = resolvePort(options.port, ADMIN_BACKEND_SERVER_CONFIG.port);
  return `http://${host}:${port}`;
}

function resolvePort(...values) {
  for (const value of values) {
    if (value == null || value === '') {
      continue;
    }

    const port = Number(value);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      throw new Error(`Invalid admin server port: ${value}`);
    }
    return port;
  }

  return ADMIN_BACKEND_SERVER_CONFIG.port;
}

function getOptionalText(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}
