export const meta = { name: 'parallel-fixture' };

phase('Fixture');
log('fixture log on stderr');
const results = await parallel(args.jobs.map((job) => async () => {
  if (job.nested) {
    return workflow(
      { scriptPath: './nested_leaf.js' },
      { result: job.result, delay_ms: job.delay_ms, agent_timeout_ms: args.agent_timeout_ms },
    );
  }
  return agent(
    `FAKE_RESULT=${JSON.stringify(job.result)}\nFAKE_DELAY_MS=${job.delay_ms || 0}`,
    {
      label: `direct:${job.result.id}`,
      schema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          index: { type: 'number' },
          details: { type: 'object', additionalProperties: true },
        },
        required: ['id', 'index'],
        additionalProperties: true,
      },
    },
  );
}));
return { eval_dir: args.eval_dir, results };
