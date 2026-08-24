'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');

const {
  AdapterError,
  CodexWorkflowRuntime,
  validateSchemaDefinition,
  validateValue,
} = require('../runtime');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const RUNNER = path.join(ROOT, 'interface', 'codex_workflow', 'runner.js');
const FAKE_CODEX = path.join(__dirname, 'fake_codex.js');
const FIXTURES = path.join(__dirname, 'fixtures');
fs.chmodSync(FAKE_CODEX, 0o755);

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'geak-codex-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function runRunner(request, extraEnv = {}, options = {}) {
  const child = spawn(process.execPath, [RUNNER], {
    cwd: ROOT,
    detached: Boolean(options.detached),
    env: {
      ...process.env,
      GEAK_CODEX_BIN: FAKE_CODEX,
      GEAK_CODEX_MAX_AGENTS: '8',
      ...extraEnv,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdin.end(JSON.stringify(request));
  const completion = new Promise((resolve) => {
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { child, completion };
}

function readEvents(logPath) {
  if (!fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
}

async function waitFor(check, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail('condition did not become true before timeout');
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

test('nested workflows share FIFO concurrency and Promise.all preserves ordering', async (t) => {
  const dir = tempDir(t);
  const logPath = path.join(dir, 'fake.jsonl');
  const evalDir = path.join(dir, 'eval');
  const jobs = [
    { nested: true, delay_ms: 180, result: { id: 'a', index: 0, details: { lane: 0 } } },
    { nested: false, delay_ms: 40, result: { id: 'b', index: 1 } },
    { nested: true, delay_ms: 20, result: { id: 'c', index: 2 } },
    { nested: false, delay_ms: 10, result: { id: 'd', index: 3 } },
  ];
  const { completion } = runRunner({
    script_path: path.join(FIXTURES, 'parallel_workflow.js'),
    args: { eval_dir: evalDir, agent_timeout_ms: 10000, jobs },
  }, {
    GEAK_CODEX_MAX_AGENTS: '2',
    GEAK_FAKE_CODEX_LOG: logPath,
  });
  const result = await completion;
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).results.map((item) => item.id), ['a', 'b', 'c', 'd']);
  assert.match(result.stderr, /phase: Fixture/);
  assert.match(result.stderr, /fixture log on stderr/);
  assert.equal(result.stdout.trim().split('\n').length, 1);

  const events = readEvents(logPath);
  const startOrder = events.filter((event) => event.event === 'start').map((event) => {
    const match = event.prompt.match(/^FAKE_RESULT=(.+)$/m);
    return JSON.parse(match[1]).id;
  });
  assert.deepEqual(new Set(startOrder.slice(0, 2)), new Set(['a', 'b']));
  assert.deepEqual(startOrder.slice(2), ['c', 'd']);
  let active = 0;
  let maximum = 0;
  for (const event of events) {
    if (event.event === 'start') maximum = Math.max(maximum, ++active);
    else if (event.event === 'end') active -= 1;
  }
  assert.equal(maximum, 2);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(evalDir, 'workflow_return.json'), 'utf8')).results,
    JSON.parse(result.stdout).results,
  );
});

test('prompt compatibility, model, sandbox, and writable directories reach Codex', async (t) => {
  const dir = tempDir(t);
  const logPath = path.join(dir, 'fake.jsonl');
  const extra = path.join(dir, 'extra');
  fs.mkdirSync(extra);
  const schema = {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['ok', 'no'] },
      optional: { type: 'string' },
      free: { type: 'object', additionalProperties: true },
    },
    required: ['status'],
    additionalProperties: false,
  };
  const { completion } = runRunner({
    script_path: path.join(FIXTURES, 'schema_workflow.js'),
    args: {
      eval_dir: path.join(dir, 'eval'),
      exp_root: path.join(dir, 'exp'),
      kernel_path: path.join(dir, 'kernel.py'),
      state_dir: path.join(dir, 'state'),
      prompt: 'FAKE_RESULT={"status":"ok","free":{"new_key":3}}',
      schema,
    },
  }, {
    GEAK_CODEX_MODEL: 'fake-model',
    GEAK_CODEX_SANDBOX: 'workspace-write',
    GEAK_CODEX_ADD_DIRS: extra,
    GEAK_FAKE_CODEX_LOG: logPath,
  });
  const result = await completion;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).value.free.new_key, 3);
  const start = readEvents(logPath).find((event) => event.event === 'start');
  for (const text of ['`Bash`', '`Read`', '`Write`', '`WebSearch`', '`WebFetch`', '`StructuredOutput`']) {
    assert.match(start.prompt, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(start.prompt, /Original GEAK schema/);
  assert.ok(start.argv.includes('--approve-for-me'));
  assert.deepEqual(start.argv.slice(start.argv.indexOf('--model'), start.argv.indexOf('--model') + 2), [
    '--model', 'fake-model',
  ]);
  const addDirs = start.argv.flatMap((item, index) => item === '--add-dir' ? [start.argv[index + 1]] : []);
  for (const expected of [path.join(dir, 'eval'), path.join(dir, 'exp'), path.join(dir, 'kernel.py'), path.join(dir, 'state'), extra]) {
    assert.ok(addDirs.includes(expected), `${expected} missing from ${JSON.stringify(addDirs)}`);
  }
});

test('bypass mode is explicit and omits the normal approval sandbox flags', async (t) => {
  const dir = tempDir(t);
  const logPath = path.join(dir, 'fake.jsonl');
  const schema = {
    type: 'object',
    properties: { ok: { type: 'boolean' } },
    required: ['ok'],
    additionalProperties: false,
  };
  const { completion } = runRunner({
    script_path: path.join(FIXTURES, 'schema_workflow.js'),
    args: {
      eval_dir: path.join(dir, 'eval'),
      prompt: 'FAKE_RESULT={"ok":true}',
      schema,
    },
  }, {
    GEAK_CODEX_BYPASS: '1',
    GEAK_FAKE_CODEX_LOG: logPath,
  });
  const result = await completion;
  assert.equal(result.code, 0, result.stderr);
  const argv = readEvents(logPath).find((event) => event.event === 'start').argv;
  assert.ok(argv.includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.ok(!argv.includes('--approve-for-me'));
  assert.ok(!argv.includes('--sandbox'));
});

test('a missing Codex executable is classified before workflow execution', async (t) => {
  const dir = tempDir(t);
  const { completion } = runRunner({
    script_path: path.join(FIXTURES, 'schema_workflow.js'),
    args: { eval_dir: path.join(dir, 'eval'), prompt: 'unused', schema: { type: 'string' } },
  }, { GEAK_CODEX_BIN: path.join(dir, 'missing-codex') });
  const result = await completion;
  assert.equal(result.code, 1);
  assert.match(result.stderr, /GEAK_CODEX_ERROR code=missing_codex_cli/);
});

test('schema definitions reject drift and values enforce the GEAK subset', () => {
  assert.throws(
    () => validateSchemaDefinition({ type: 'string', minLength: 1 }),
    (error) => error instanceof AdapterError && /unsupported schema keyword/.test(error.message),
  );
  const schema = {
    type: 'object',
    properties: {
      required_name: { type: 'string' },
      values: { type: 'array', items: { type: 'number' } },
    },
    required: ['required_name'],
    additionalProperties: false,
  };
  validateSchemaDefinition(schema);
  assert.deepEqual(validateValue({ required_name: 'x', values: [1, 2] }, schema), {
    required_name: 'x', values: [1, 2],
  });
  assert.throws(() => validateValue({ required_name: 'x', extra: true }, schema), /disallowed/);
  assert.throws(() => validateValue({ values: [1, 'bad'] }, schema), /required_name is required/);
});

test('malformed transport and local schema mismatch fail visibly', async (t) => {
  const dir = tempDir(t);
  const schema = {
    type: 'object',
    properties: { ok: { type: 'boolean' } },
    required: ['ok'],
    additionalProperties: false,
  };
  const malformed = runRunner({
    script_path: path.join(FIXTURES, 'schema_workflow.js'),
    args: { eval_dir: path.join(dir, 'a'), prompt: 'FAKE_RESULT={"ok":true}', schema },
  }, { GEAK_FAKE_MALFORMED: '1' });
  const malformedResult = await malformed.completion;
  assert.equal(malformedResult.code, 1);
  assert.match(malformedResult.stderr, /malformed transport JSON/);

  const mismatch = runRunner({
    script_path: path.join(FIXTURES, 'schema_workflow.js'),
    args: { eval_dir: path.join(dir, 'b'), prompt: 'FAKE_RESULT={"ok":"yes"}', schema },
  });
  const mismatchResult = await mismatch.completion;
  assert.equal(mismatchResult.code, 1);
  assert.match(mismatchResult.stderr, /must have type boolean/);
});

test('Codex CLI failures reject so workflow retry logic remains authoritative', async (t) => {
  const dir = tempDir(t);
  const logPath = path.join(dir, 'fake.jsonl');
  const { completion } = runRunner({
    script_path: path.join(FIXTURES, 'retry_workflow.js'),
    args: { eval_dir: path.join(dir, 'eval') },
  }, {
    GEAK_FAKE_FAIL_ONCE_FILE: path.join(dir, 'failed-once'),
    GEAK_FAKE_CODEX_LOG: logPath,
  });
  const result = await completion;
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).value, { ok: true });
  assert.equal(readEvents(logPath).filter((event) => event.event === 'start').length, 2);
  assert.match(result.stderr, /attempt 1 failed/);
});

test('leaf timeout returns null and terminates the entire Codex process group', async (t) => {
  const dir = tempDir(t);
  const childPidFile = path.join(dir, 'child.pid');
  const { completion } = runRunner({
    script_path: path.join(FIXTURES, 'timeout_workflow.js'),
    args: {
      eval_dir: path.join(dir, 'eval'),
      agent_timeout_ms: 1200,
      delay_ms: 30000,
    },
  }, { GEAK_FAKE_SPAWN_CHILD_PID_FILE: childPidFile });
  const result = await completion;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).value, null);
  const childPid = Number.parseInt(fs.readFileSync(childPidFile, 'utf8'), 10);
  await waitFor(() => !processExists(childPid));
});

test('runner SIGTERM cleans active Codex child groups before exiting', async (t) => {
  const dir = tempDir(t);
  const childPidFile = path.join(dir, 'child.pid');
  const run = runRunner({
    script_path: path.join(FIXTURES, 'timeout_workflow.js'),
    args: {
      eval_dir: path.join(dir, 'eval'),
      agent_timeout_ms: 0,
      delay_ms: 30000,
    },
  }, { GEAK_FAKE_SPAWN_CHILD_PID_FILE: childPidFile }, { detached: true });
  await waitFor(() => fs.existsSync(childPidFile));
  const childPid = Number.parseInt(fs.readFileSync(childPidFile, 'utf8'), 10);
  process.kill(run.child.pid, 'SIGTERM');
  const result = await run.completion;
  assert.equal(result.code, 143, result.stderr);
  await waitFor(() => !processExists(childPid));
});

test('all unchanged GEAK workflow files compile and script escapes are rejected', () => {
  const runtime = new CodexWorkflowRuntime({
    root: ROOT,
    env: { ...process.env, GEAK_CODEX_BIN: FAKE_CODEX },
  });
  for (const relative of [
    'kernel_workflow/kernel_workflow.js',
    'kernel_workflow/kernel_lane.js',
    'e2e_workflow/e2e_workflow.js',
  ]) {
    assert.equal(runtime.compileWorkflow(relative), path.join(ROOT, relative));
  }
  assert.throws(() => runtime.compileWorkflow('/etc/passwd'), /outside the GEAK repository root/);
});

test('real kernel and E2E pass-through branches execute without source edits', async (t) => {
  const dir = tempDir(t);
  const common = {
    kernel_path: path.join(ROOT, 'interface', 'codex_workflow', 'test', 'fixtures'),
    budget: 0,
    gpu_ids: '0',
    agent_timeout_ms: 10000,
  };
  const kernel = runRunner({
    script_path: path.join(ROOT, 'kernel_workflow', 'kernel_workflow.js'),
    args: {
      ...common,
      workflow_dir: path.join(ROOT, 'kernel_workflow'),
      exp_root: path.join(dir, 'kernel-exp'),
      mode: 'optimize',
    },
  }, { GEAK_FAKE_DEFAULT_EVAL_DIR: path.join(dir, 'kernel-eval') });
  const kernelResult = await kernel.completion;
  assert.equal(kernelResult.code, 0, kernelResult.stderr);
  assert.equal(JSON.parse(kernelResult.stdout).mode, 'optimize');

  const e2e = runRunner({
    script_path: path.join(ROOT, 'e2e_workflow', 'e2e_workflow.js'),
    args: {
      ...common,
      workflow_dir: path.join(ROOT, 'e2e_workflow'),
      exp_root: path.join(dir, 'e2e-exp'),
      kernel_budget: 0,
    },
  }, { GEAK_FAKE_DEFAULT_EVAL_DIR: path.join(dir, 'e2e-kernel-eval') });
  const e2eResult = await e2e.completion;
  assert.equal(e2eResult.code, 0, e2eResult.stderr);
  const parsed = JSON.parse(e2eResult.stdout);
  assert.equal(parsed.mode, 'single_kernel');
  assert.equal(parsed.ran, true, parsed.note);
});
