'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const SUPPORTED_SCHEMA_KEYS = new Set([
  'type', 'properties', 'required', 'additionalProperties', 'items', 'enum',
]);
const SUPPORTED_TYPES = new Set([
  'array', 'boolean', 'integer', 'null', 'number', 'object', 'string',
]);
const TRANSPORT_SCHEMA = {
  type: 'object',
  properties: { result_json: { type: 'string' } },
  required: ['result_json'],
  additionalProperties: false,
};
const COMPATIBILITY_INSTRUCTION = `## GEAK tool compatibility
- \`Bash\` means Codex shell execution.
- \`Read\` and \`Write\` mean Codex filesystem operations.
- \`WebSearch\` and \`WebFetch\` mean the available Codex web/network tools.
- The literal \`StructuredOutput\` tool is not required. The GEAK compatibility runtime transports and validates your final result.

Follow the original GEAK role and task instructions below exactly.`;

class AdapterError extends Error {
  constructor(code, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'AdapterError';
    this.code = code;
  }
}

class FifoSemaphore {
  constructor(limit) {
    this.limit = limit;
    this.active = 0;
    this.waiters = [];
  }

  acquire() {
    return new Promise((resolve) => {
      const enter = () => {
        this.active += 1;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          this.active -= 1;
          const next = this.waiters.shift();
          if (next) next();
        });
      };
      if (this.active < this.limit) enter();
      else this.waiters.push(enter);
    });
  }

  async use(fn) {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

function positiveInteger(value, fallback, name) {
  if (value == null || String(value).trim() === '') return fallback;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new AdapterError('adapter_failure', `${name} must be a positive integer`);
  }
  return parsed;
}

function optionalNonNegativeInteger(value, name) {
  if (value == null || String(value).trim() === '') return null;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new AdapterError('adapter_failure', `${name} must be a non-negative integer`);
  }
  return parsed;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateSchemaDefinition(schema, location = '$schema') {
  if (!isPlainObject(schema)) {
    throw new AdapterError('adapter_failure', `${location} must be an object`);
  }
  for (const keyword of Object.keys(schema)) {
    if (!SUPPORTED_SCHEMA_KEYS.has(keyword)) {
      throw new AdapterError(
        'adapter_failure',
        `${location} uses unsupported schema keyword ${JSON.stringify(keyword)}`,
      );
    }
  }
  if (typeof schema.type !== 'string' || !SUPPORTED_TYPES.has(schema.type)) {
    throw new AdapterError('adapter_failure', `${location}.type is missing or unsupported`);
  }
  if ('enum' in schema && (!Array.isArray(schema.enum) || schema.enum.length === 0)) {
    throw new AdapterError('adapter_failure', `${location}.enum must be a non-empty array`);
  }

  if (schema.type === 'object') {
    if ('properties' in schema && !isPlainObject(schema.properties)) {
      throw new AdapterError('adapter_failure', `${location}.properties must be an object`);
    }
    if ('required' in schema && !Array.isArray(schema.required)) {
      throw new AdapterError('adapter_failure', `${location}.required must be an array`);
    }
    if (
      'additionalProperties' in schema
      && typeof schema.additionalProperties !== 'boolean'
    ) {
      throw new AdapterError(
        'adapter_failure',
        `${location}.additionalProperties must be a boolean`,
      );
    }
    const properties = schema.properties || {};
    for (const required of schema.required || []) {
      if (typeof required !== 'string' || !Object.hasOwn(properties, required)) {
        throw new AdapterError(
          'adapter_failure',
          `${location}.required names undeclared property ${JSON.stringify(required)}`,
        );
      }
    }
    for (const [name, child] of Object.entries(properties)) {
      validateSchemaDefinition(child, `${location}.properties[${JSON.stringify(name)}]`);
    }
  } else if ('properties' in schema || 'required' in schema || 'additionalProperties' in schema) {
    throw new AdapterError(
      'adapter_failure',
      `${location} uses object-only keywords with type ${schema.type}`,
    );
  }

  if (schema.type === 'array') {
    if ('items' in schema) validateSchemaDefinition(schema.items, `${location}.items`);
  } else if ('items' in schema) {
    throw new AdapterError(
      'adapter_failure',
      `${location} uses array-only keyword "items" with type ${schema.type}`,
    );
  }
}

function valuesEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validateValue(value, schema, location = '$') {
  const typeOk = {
    array: Array.isArray(value),
    boolean: typeof value === 'boolean',
    integer: Number.isInteger(value),
    null: value === null,
    number: typeof value === 'number' && Number.isFinite(value),
    object: isPlainObject(value),
    string: typeof value === 'string',
  }[schema.type];
  if (!typeOk) {
    throw new AdapterError(
      'adapter_failure',
      `${location} must have type ${schema.type}; received ${Array.isArray(value) ? 'array' : typeof value}`,
    );
  }
  if ('enum' in schema && !schema.enum.some((item) => valuesEqual(item, value))) {
    throw new AdapterError(
      'adapter_failure',
      `${location} must be one of ${JSON.stringify(schema.enum)}`,
    );
  }
  if (schema.type === 'object') {
    const properties = schema.properties || {};
    for (const required of schema.required || []) {
      if (!Object.hasOwn(value, required)) {
        throw new AdapterError('adapter_failure', `${location}.${required} is required`);
      }
    }
    for (const [name, child] of Object.entries(properties)) {
      if (Object.hasOwn(value, name)) validateValue(value[name], child, `${location}.${name}`);
    }
    if (schema.additionalProperties === false) {
      for (const name of Object.keys(value)) {
        if (!Object.hasOwn(properties, name)) {
          throw new AdapterError(
            'adapter_failure',
            `${location} contains disallowed property ${JSON.stringify(name)}`,
          );
        }
      }
    }
  } else if (schema.type === 'array' && schema.items) {
    value.forEach((item, index) => validateValue(item, schema.items, `${location}[${index}]`));
  }
  return value;
}

function parseBooleanOne(value) {
  return String(value == null ? '' : value).trim() === '1';
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class CodexWorkflowRuntime {
  constructor(options = {}) {
    this.root = fs.realpathSync(options.root || path.resolve(__dirname, '..', '..'));
    this.env = options.env || process.env;
    this.stderr = options.stderr || process.stderr;
    this.codexBin = String(this.env.GEAK_CODEX_BIN || 'codex').trim() || 'codex';
    this.model = String(this.env.GEAK_CODEX_MODEL || '').trim();
    this.sandbox = String(this.env.GEAK_CODEX_SANDBOX || 'workspace-write').trim();
    if (!new Set(['read-only', 'workspace-write', 'danger-full-access']).has(this.sandbox)) {
      throw new AdapterError(
        'adapter_failure',
        `GEAK_CODEX_SANDBOX has unsupported value ${JSON.stringify(this.sandbox)}`,
      );
    }
    this.bypass = parseBooleanOne(this.env.GEAK_CODEX_BYPASS);
    this.timeoutOverrideMs = optionalNonNegativeInteger(
      this.env.GEAK_CODEX_AGENT_TIMEOUT_MS,
      'GEAK_CODEX_AGENT_TIMEOUT_MS',
    );
    this.killGraceMs = positiveInteger(
      options.killGraceMs == null ? 10000 : options.killGraceMs,
      10000,
      'killGraceMs',
    );
    this.semaphore = new FifoSemaphore(positiveInteger(
      this.env.GEAK_CODEX_MAX_AGENTS,
      8,
      'GEAK_CODEX_MAX_AGENTS',
    ));
    this.active = new Set();
    this.shuttingDown = false;
    this.probePromise = null;
    this.topArgs = {};
  }

  _log(message) {
    this.stderr.write(`[geak-codex] ${String(message)}\n`);
  }

  _resolveScript(scriptPath, callingScript = null) {
    if (typeof scriptPath !== 'string' || !scriptPath.trim()) {
      throw new AdapterError('adapter_failure', 'workflow scriptPath must be a non-empty string');
    }
    const base = callingScript ? path.dirname(callingScript) : this.root;
    const candidate = path.resolve(base, scriptPath);
    let real;
    try {
      real = fs.realpathSync(candidate);
    } catch (error) {
      throw new AdapterError(
        'adapter_failure',
        `workflow script does not exist: ${candidate}`,
        error,
      );
    }
    const relative = path.relative(this.root, real);
    if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
      throw new AdapterError(
        'adapter_failure',
        `workflow script is outside the GEAK repository root: ${real}`,
      );
    }
    return real;
  }

  _compile(scriptPath) {
    const source = fs.readFileSync(scriptPath, 'utf8');
    const rewritten = source.replace(/^(\uFEFF?\s*)export\s+const\s+meta\b/, '$1const meta');
    if (rewritten === source) {
      throw new AdapterError(
        'adapter_failure',
        `workflow must begin with an export const meta declaration: ${scriptPath}`,
      );
    }
    try {
      return new AsyncFunction(
        'args', 'agent', 'workflow', 'parallel', 'phase', 'log',
        `"use strict";\n${rewritten}\n//# sourceURL=${scriptPath}`,
      );
    } catch (error) {
      throw new AdapterError(
        'adapter_failure',
        `failed to compile workflow ${scriptPath}: ${error.message}`,
        error,
      );
    }
  }

  compileWorkflow(scriptPath) {
    const resolved = this._resolveScript(scriptPath);
    this._compile(resolved);
    return resolved;
  }

  async probeCodex() {
    if (this.probePromise) return this.probePromise;
    this.probePromise = (async () => {
      const outcome = await this._runChild(['exec', '--help'], '', 30000);
      if (outcome.spawnError && outcome.spawnError.code === 'ENOENT') {
        throw new AdapterError(
          'missing_codex_cli',
          `Codex CLI not found: ${this.codexBin}`,
          outcome.spawnError,
        );
      }
      if (outcome.timedOut || outcome.code !== 0) {
        throw new AdapterError(
          'adapter_failure',
          `could not probe "${this.codexBin} exec --help": ${outcome.stderr.slice(-2000)}`,
        );
      }
      const help = `${outcome.stdout}\n${outcome.stderr}`;
      const required = [
        '--ephemeral', '--color', '--output-last-message', '--output-schema',
        '--sandbox', '--add-dir',
        this.bypass ? '--dangerously-bypass-approvals-and-sandbox' : '--approve-for-me',
      ];
      if (this.model) required.push('--model');
      const missing = required.filter((flag) => !help.includes(flag));
      if (missing.length) {
        throw new AdapterError(
          'adapter_failure',
          `Codex CLI is missing required exec flags: ${missing.join(', ')}`,
        );
      }
    })();
    return this.probePromise;
  }

  _leafTimeoutMs(scriptPath, args) {
    if (Object.hasOwn(args, 'agent_timeout_ms')) {
      const explicit = optionalNonNegativeInteger(args.agent_timeout_ms, 'args.agent_timeout_ms');
      return explicit === 0 ? 0 : Math.max(1, explicit - 1000);
    }
    const selected = this.timeoutOverrideMs != null
      ? this.timeoutOverrideMs
      : (path.basename(scriptPath) === 'e2e_workflow.js'
        ? (String(args.fast_mode) === 'true' ? 2700000 : 7200000)
        : 3600000);
    return selected === 0 ? 0 : Math.max(1, selected - 1000);
  }

  _writableDirectories(args) {
    const candidates = [];
    for (const source of [this.topArgs, args]) {
      if (!isPlainObject(source)) continue;
      for (const key of ['eval_dir', 'exp_root', 'kernel_path', 'state_dir']) {
        const raw = source[key];
        if (typeof raw !== 'string' || !raw.trim()) continue;
        let resolved = path.resolve(this.root, raw);
        try {
          if (fs.statSync(resolved).isFile()) resolved = path.dirname(resolved);
        } catch (_) {
          // The workflow may create eval/state directories after the leaf starts.
        }
        candidates.push(resolved);
      }
    }
    for (const raw of String(this.env.GEAK_CODEX_ADD_DIRS || '').split(path.delimiter)) {
      if (raw.trim()) candidates.push(path.resolve(this.root, raw.trim()));
    }
    const seen = new Set();
    return candidates.filter((candidate) => {
      const normalized = path.normalize(candidate);
      if (normalized === this.root || seen.has(normalized)) return false;
      seen.add(normalized);
      return true;
    });
  }

  _agentPrompt(prompt, schema) {
    const original = typeof prompt === 'string' ? prompt : JSON.stringify(prompt);
    if (!schema) return `${COMPATIBILITY_INSTRUCTION}\n\n${original}`;
    return `${COMPATIBILITY_INSTRUCTION}\n\n${original}\n\n`
      + '## GEAK final-result transport\n'
      + 'Your final response must be one JSON object with exactly one key, `result_json`. '
      + '`result_json` must be a JSON-encoded string whose decoded value satisfies the original GEAK schema below. '
      + 'Do not place the decoded result directly in the envelope and do not add prose outside it.\n\n'
      + `Original GEAK schema:\n\`\`\`json\n${JSON.stringify(schema, null, 2)}\n\`\`\``;
  }

  async _invokeAgent(prompt, options, scriptPath, args) {
    const schema = options && options.schema;
    if (schema) validateSchemaDefinition(schema);
    await this.probeCodex();

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'geak-codex-'));
    const lastMessage = path.join(tempDir, 'last-message.json');
    const transportPath = path.join(tempDir, 'transport-schema.json');
    const argv = ['exec', '-', '--ephemeral', '--color', 'never', '-C', this.root];
    if (this.model) argv.push('--model', this.model);
    if (this.bypass) argv.push('--dangerously-bypass-approvals-and-sandbox');
    else argv.push('--sandbox', this.sandbox, '--approve-for-me');
    for (const writable of this._writableDirectories(args)) argv.push('--add-dir', writable);
    if (schema) {
      fs.writeFileSync(transportPath, `${JSON.stringify(TRANSPORT_SCHEMA)}\n`, 'utf8');
      argv.push('--output-schema', transportPath);
    }
    argv.push('--output-last-message', lastMessage);

    try {
      const timeoutMs = this._leafTimeoutMs(scriptPath, args);
      const outcome = await this._runChild(argv, this._agentPrompt(prompt, schema), timeoutMs);
      if (outcome.timedOut) {
        this._log(`${(options && options.label) || 'agent'} timed out after ${timeoutMs}ms`);
        return null;
      }
      if (outcome.spawnError && outcome.spawnError.code === 'ENOENT') {
        throw new AdapterError(
          'missing_codex_cli',
          `Codex CLI not found: ${this.codexBin}`,
          outcome.spawnError,
        );
      }
      if (outcome.spawnError || outcome.code !== 0) {
        const detail = (outcome.stderr || outcome.stdout || String(outcome.spawnError || '')).slice(-4000);
        throw new AdapterError(
          'codex_cli_failure',
          `codex exec failed (rc=${outcome.code}, signal=${outcome.signal || 'none'}): ${detail}`,
          outcome.spawnError,
        );
      }
      let raw;
      try {
        raw = fs.readFileSync(lastMessage, 'utf8').trim();
      } catch (error) {
        throw new AdapterError(
          'codex_cli_failure',
          'codex exec did not write --output-last-message',
          error,
        );
      }
      if (!schema) return raw;

      let envelope;
      try {
        envelope = JSON.parse(raw);
      } catch (error) {
        throw new AdapterError(
          'adapter_failure',
          `Codex returned malformed transport JSON: ${raw.slice(-2000)}`,
          error,
        );
      }
      validateValue(envelope, TRANSPORT_SCHEMA, '$transport');
      let result;
      try {
        result = JSON.parse(envelope.result_json);
      } catch (error) {
        throw new AdapterError(
          'adapter_failure',
          'Codex transport result_json is not valid JSON',
          error,
        );
      }
      return validateValue(result, schema);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }

  _registerChild(child) {
    const record = {
      child,
      exited: false,
      completion: null,
    };
    record.completion = new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let spawnError = null;
      child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
      child.once('error', (error) => { spawnError = error; });
      child.once('close', (code, signal) => {
        record.exited = true;
        this.active.delete(record);
        resolve({ code, signal, stdout, stderr, spawnError, timedOut: false });
      });
    });
    this.active.add(record);
    return record;
  }

  async _runChild(argv, input, timeoutMs) {
    if (this.shuttingDown) {
      throw new AdapterError('adapter_failure', 'Codex workflow runtime is shutting down');
    }
    let child;
    try {
      child = spawn(this.codexBin, argv, {
        cwd: this.root,
        env: this.env,
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      return {
        code: null, signal: null, stdout: '', stderr: '', spawnError: error, timedOut: false,
      };
    }
    const record = this._registerChild(child);
    child.stdin.on('error', () => {});
    child.stdin.end(input);
    if (!(timeoutMs > 0)) return record.completion;

    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
    });
    const outcome = await Promise.race([record.completion, timeout]);
    clearTimeout(timer);
    if (!outcome.timedOut) return outcome;
    await this._terminateRecord(record);
    const exited = await record.completion;
    return { ...exited, timedOut: true };
  }

  _signalRecord(record, signal) {
    if (record.exited || !record.child.pid) return;
    try {
      process.kill(-record.child.pid, signal);
    } catch (error) {
      if (error.code !== 'ESRCH') {
        try { record.child.kill(signal); } catch (_) {}
      }
    }
  }

  async _terminateRecord(record) {
    if (record.exited) return;
    this._signalRecord(record, 'SIGTERM');
    await Promise.race([record.completion, delay(this.killGraceMs)]);
    if (!record.exited) {
      this._signalRecord(record, 'SIGKILL');
      await record.completion;
    }
  }

  async shutdown() {
    this.shuttingDown = true;
    await Promise.all([...this.active].map((record) => this._terminateRecord(record)));
  }

  async _executeWorkflow(scriptPath, args, callingScript = null) {
    if (!isPlainObject(args)) {
      throw new AdapterError('adapter_failure', 'workflow args must be a JSON object');
    }
    const resolved = this._resolveScript(scriptPath, callingScript);
    const fn = this._compile(resolved);
    const agent = (prompt, options = {}) => this.semaphore.use(
      () => this._invokeAgent(prompt, options, resolved, args),
    );
    const workflow = (descriptor, nestedArgs = {}) => {
      if (!isPlainObject(descriptor) || typeof descriptor.scriptPath !== 'string') {
        throw new AdapterError(
          'adapter_failure',
          'workflow() requires { scriptPath: string }',
        );
      }
      return this._executeWorkflow(descriptor.scriptPath, nestedArgs, resolved);
    };
    const parallel = (thunks) => {
      if (!Array.isArray(thunks) || thunks.some((thunk) => typeof thunk !== 'function')) {
        throw new AdapterError('adapter_failure', 'parallel() requires an array of thunks');
      }
      return Promise.all(thunks.map((thunk) => Promise.resolve().then(thunk)));
    };
    const phase = (name) => this._log(`phase: ${name}`);
    const log = (message) => this._log(message);
    return fn(args, agent, workflow, parallel, phase, log);
  }

  async run(scriptPath, args) {
    this.topArgs = args;
    await this.probeCodex();
    return this._executeWorkflow(scriptPath, args);
  }
}

function atomicPersistResult(result, args) {
  const evalDir = isPlainObject(result) && typeof result.eval_dir === 'string' && result.eval_dir
    ? result.eval_dir
    : (isPlainObject(args) && typeof args.eval_dir === 'string' ? args.eval_dir : '');
  if (!evalDir) return null;
  fs.mkdirSync(evalDir, { recursive: true });
  const target = path.join(evalDir, 'workflow_return.json');
  const temporary = path.join(evalDir, `.workflow_return.json.${process.pid}.tmp`);
  fs.writeFileSync(temporary, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, target);
  return target;
}

module.exports = {
  AdapterError,
  CodexWorkflowRuntime,
  COMPATIBILITY_INSTRUCTION,
  TRANSPORT_SCHEMA,
  atomicPersistResult,
  validateSchemaDefinition,
  validateValue,
};
