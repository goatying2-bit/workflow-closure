import { getAgentStore, initializeAgentStore } from '../index.js';
import { buildClaudeRuntimeRegisterAgentInput, getClaudeRuntimeProfile } from './claude-runtime-profile.js';

export async function ensureClaudeRuntimeAgent(profile = getClaudeRuntimeProfile()) {
  await initializeAgentStore({ dbPath: profile.dbPath });
  const agentStore = getAgentStore({ dbPath: profile.dbPath });
  const input = buildClaudeRuntimeRegisterAgentInput(profile);
  const existing = agentStore.listAgents({ limit: 1000 }).find((agent) => agent.agentId === input.agentId);

  const agent = existing
    ? agentStore.updateAgent(input)
    : agentStore.registerAgent(input);

  return {
    status: existing ? 'updated' : 'registered',
    agent
  };
}
