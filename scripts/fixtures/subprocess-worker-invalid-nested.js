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
    doneSummary: `subprocess invalid nested：${task.title || 'unknown-task'}`,
    handoff: {
      summary: 'invalid nested handoff',
      artifacts: [null]
    }
  }));
});
