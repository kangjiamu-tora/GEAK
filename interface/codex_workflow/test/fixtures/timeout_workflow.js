export const meta = { name: 'timeout-fixture' };

const value = await agent(
  `FAKE_RESULT={"ok":true}\nFAKE_DELAY_MS=${args.delay_ms}`,
  {
    label: 'timeout-fixture',
    schema: {
      type: 'object',
      properties: { ok: { type: 'boolean' } },
      required: ['ok'],
      additionalProperties: false,
    },
  },
);
return { eval_dir: args.eval_dir, value };
