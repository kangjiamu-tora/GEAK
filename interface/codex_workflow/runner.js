#!/usr/bin/env node
'use strict';

const {
  AdapterError,
  CodexWorkflowRuntime,
  atomicPersistResult,
} = require('./runtime');

function fail(code, message, exitCode = 1) {
  process.stderr.write(`GEAK_CODEX_ERROR code=${code} message=${String(message).replace(/\s+/g, ' ')}\n`);
  process.exitCode = exitCode;
}

async function readStdin() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk.toString();
  return input;
}

async function main() {
  const major = Number.parseInt(process.versions.node.split('.')[0], 10);
  if (!Number.isInteger(major) || major < 18) {
    throw new AdapterError(
      'adapter_failure',
      `Node.js 18 or newer is required; found ${process.versions.node}`,
    );
  }

  let request;
  try {
    request = JSON.parse(await readStdin());
  } catch (error) {
    throw new AdapterError('adapter_failure', 'runner stdin must be one JSON object', error);
  }
  if (
    request === null
    || typeof request !== 'object'
    || Array.isArray(request)
    || typeof request.script_path !== 'string'
    || request.args === null
    || typeof request.args !== 'object'
    || Array.isArray(request.args)
  ) {
    throw new AdapterError(
      'adapter_failure',
      'runner request must be {"script_path": string, "args": object}',
    );
  }

  const runtime = new CodexWorkflowRuntime();
  let stopping = false;
  const stop = (signal, exitCode) => {
    if (stopping) return;
    stopping = true;
    runtime.shutdown().finally(() => process.exit(exitCode));
  };
  process.on('SIGTERM', () => stop('SIGTERM', 143));
  process.on('SIGINT', () => stop('SIGINT', 130));

  try {
    const result = await runtime.run(request.script_path, request.args);
    if (result === null || typeof result !== 'object' || Array.isArray(result)) {
      throw new AdapterError('invalid_workflow_output', 'top-level workflow must return a JSON object');
    }
    const encoded = JSON.stringify(result);
    if (typeof encoded !== 'string') {
      throw new AdapterError('invalid_workflow_output', 'workflow return is not JSON serializable');
    }
    atomicPersistResult(result, request.args);
    process.stdout.write(`${encoded}\n`);
  } finally {
    await runtime.shutdown();
  }
}

main().catch((error) => {
  const code = error && error.code ? error.code : 'adapter_failure';
  fail(code, error && error.stack ? error.stack : error);
});
