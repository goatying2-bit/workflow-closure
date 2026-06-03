import { createClaudeCodeAdapter } from '../../index.js';

export default createClaudeCodeAdapter({
  command: 'claude',
  args: ['--print'],
  timeoutMs: 120_000,
  systemInstruction: 'You are a workflow-closure adapter. Complete the assigned task and return only the required JSON result.'
});
