export const meta = { name: 'retry-fixture' };

let value = null;
for (let attempt = 0; attempt < 2; attempt++) {
  try {
    value = await agent(
      'FAKE_RESULT={"ok":true}',
      {
        label: 'retry-fixture',
        schema: {
          type: 'object',
          properties: { ok: { type: 'boolean' } },
          required: ['ok'],
          additionalProperties: false,
        },
      },
    );
    break;
  } catch (error) {
    log(`attempt ${attempt + 1} failed`);
  }
}
return { eval_dir: args.eval_dir, value };
