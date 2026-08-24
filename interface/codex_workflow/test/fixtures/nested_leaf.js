export const meta = { name: 'nested-leaf' };

const result = await agent(
  `FAKE_RESULT=${JSON.stringify(args.result)}\nFAKE_DELAY_MS=${args.delay_ms || 0}`,
  {
    label: `nested:${args.result.id}`,
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
return result;
