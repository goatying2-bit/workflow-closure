import { createClaudeCodeAdapter } from '../index.js';
import { getClaudeRuntimeProfile } from './claude-runtime-profile.js';

const profile = getClaudeRuntimeProfile();

export default createClaudeCodeAdapter({
  command: profile.command,
  args: profile.commandArgs,
  cwd: profile.workspacePath,
  env: {
    WORKFLOW_CLOSURE_CLAUDE_WORKSPACE_PATH: profile.workspacePath,
    WORKFLOW_CLOSURE_CLAUDE_DB_PATH: profile.dbPath
  },
  timeoutMs: profile.timeoutMs,
  systemInstruction: profile.systemInstruction,
  simpleCoordinatorBypass: true
});
