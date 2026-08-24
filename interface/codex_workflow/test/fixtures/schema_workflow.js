export const meta = { name: 'schema-fixture' };

const value = await agent(args.prompt, { label: 'schema-fixture', schema: args.schema });
return { eval_dir: args.eval_dir, value };
