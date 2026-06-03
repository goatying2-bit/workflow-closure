export const POLLUTION_POLICY_VERSION = 1;

export const POLLUTION_POLICY_LAYERS = Object.freeze([
  Object.freeze({
    id: 'source-classification',
    order: 1,
    scope: 'context-input',
    ownerModule: 'runner/context-hygiene.js',
    purpose: 'Classify task outputs, memories, and context items before they can influence a prompt.',
    sourceTrust: ['authoritative', 'validated', 'workflow-generated', 'reference', 'recovery-only', 'quarantined'],
    promptBoundary: 'Only promptAllowed items may enter prompt construction; quarantined items are blocked.',
    persistBoundary: 'Classification metadata may be written as hygiene metadata; source content is not rewritten here.',
    artifactBoundary: 'No artifact writes happen in this layer.',
    retentionBoundary: 'No retention decisions happen in this layer.',
    verification: ['context-smoke-test', 'context-pollution-stress-test']
  }),
  Object.freeze({
    id: 'prompt-filtering',
    order: 2,
    scope: 'prompt-input',
    ownerModule: 'runner/prompt-builder.js',
    purpose: 'Apply hygiene classifications when building task prompts.',
    sourceTrust: ['current task facts win over reference context', 'repair-only evidence is only visible to repair tasks'],
    promptBoundary: 'Filtered memories, context items, and predecessor outputs are excluded from prompt text.',
    persistBoundary: 'Prompt text records only the filtered view seen by the agent.',
    artifactBoundary: 'No artifact writes happen in this layer.',
    retentionBoundary: 'No retention decisions happen in this layer.',
    verification: ['runner-smoke-test', 'context-smoke-test', 'context-pollution-stress-test']
  }),
  Object.freeze({
    id: 'persistence-sanitization',
    order: 3,
    scope: 'db-memory-context-checkpoint',
    ownerModule: 'runner/pollution-gateway.js',
    purpose: 'Sanitize raw adapter diagnostics before persistence.',
    sourceTrust: ['transient upstream diagnostics are quarantined', 'successful adapter payloads are preserved'],
    promptBoundary: 'Sanitized persisted records prevent raw transient diagnostics from returning through later recall.',
    persistBoundary: 'Adapter payloads, run logs, task outputs, checkpoint inputs, recovery payloads, and lifecycle writes pass through sanitizers.',
    artifactBoundary: 'Sanitized task output specs are passed to artifact materialization.',
    retentionBoundary: 'No retention decisions happen in this layer.',
    verification: ['claude-code-adapter-smoke-test', 'pollution-stress-test']
  }),
  Object.freeze({
    id: 'artifact-routing',
    order: 4,
    scope: 'workspace-files',
    ownerModule: 'runner/task-capture.js + storage/workflows.js',
    purpose: 'Convert structured results into task outputs and materialize artifacts inside the workspace only.',
    sourceTrust: ['task output metadata carries artifactRef and storageStatus', 'missing workspace/content skips file writes'],
    promptBoundary: 'Downstream prompt access still goes through source classification and prompt filtering.',
    persistBoundary: 'Task output rows store path, metadata, storage status, and artifact references.',
    artifactBoundary: 'Generated paths stay under artifacts/workflows; explicit paths must remain inside workspace.',
    retentionBoundary: 'Generated runtime artifact roots are ignored by Git and audited by data hygiene.',
    verification: ['result-routing-smoke-test', 'runner-smoke-test']
  }),
  Object.freeze({
    id: 'retention-cleanup',
    order: 5,
    scope: 'runtime-data-lifecycle',
    ownerModule: 'storage/data-hygiene.js + scripts/data-hygiene.js + .gitignore',
    purpose: 'Separate real, test, debug, and ephemeral workflow data from code changes and default views.',
    sourceTrust: ['real data is protected', 'test/debug data is hidden by default', 'runtime workspace DBs are inspect-only by default'],
    promptBoundary: 'Archived/test/debug workflows are excluded from default workflow lists before being reused operationally.',
    persistBoundary: 'Workflow metadata stores dataClass, retention, generatedBy, archivedAt, and archiveReason.',
    artifactBoundary: 'Cleanable runtime artifact targets can be dry-run audited before deletion.',
    retentionBoundary: 'Only cleanable generated artifacts/test workspaces are auto-clean candidates; profile/workspace DBs require manual intent.',
    verification: ['node --check scripts/data-hygiene.js', 'scripts/data-hygiene.js --runtime-artifacts']
  })
]);

export function listPollutionPolicyLayers() {
  return POLLUTION_POLICY_LAYERS.map((layer) => ({ ...layer }));
}

export function getPollutionPolicyLayer(layerId) {
  return listPollutionPolicyLayers().find((layer) => layer.id === layerId) || null;
}
