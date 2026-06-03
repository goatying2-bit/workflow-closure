export default {
  async getRules() {
    return {
      rules: [
        {
          title: 'CLI runner rule',
          text: '先列出关键事实，再输出结论。',
          priority: 10
        }
      ],
      metadata: {
        ruleProvider: 'cli-runner-smoke'
      }
    };
  }
};
