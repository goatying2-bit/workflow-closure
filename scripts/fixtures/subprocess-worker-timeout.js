setTimeout(() => {
  process.stdout.write(JSON.stringify({
    status: 'done',
    doneSummary: 'late success'
  }));
}, 5000);
