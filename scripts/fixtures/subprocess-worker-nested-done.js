const chunks = [];

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  chunks.push(chunk);
});
process.stdin.on('end', () => {
  const request = JSON.parse(chunks.join('') || '{}');
  const task = request.input?.task || {};
  process.stdout.write(JSON.stringify({
    status: 'done',
    doneSummary: `subprocess nested done：${task.title || 'unknown-task'}`,
    payload: {
      worker: 'nested-done',
      taskId: task.taskId || null,
      outputs: [
        {
          kind: 'artifact',
          name: 'implementation-note',
          contentText: 'nested output content',
          path: 'artifacts/nested-output.txt',
          metadata: {
            source: 'fixture'
          }
        }
      ]
    },
    handoff: {
      summary: 'nested handoff summary',
      artifacts: ['artifacts/nested-output.txt'],
      decisions: ['validated nested contract'],
      openQuestions: [],
      risks: [],
      recommendedNextRole: 'reviewer',
      sourceRef: 'fixture://subprocess-worker-nested-done'
    },
    taskOutputs: [
      {
        kind: 'result',
        name: 'nested-top-level-output',
        content: 'top-level output content',
        metadata: {
          level: 'top'
        }
      }
    ]
  }));
});
