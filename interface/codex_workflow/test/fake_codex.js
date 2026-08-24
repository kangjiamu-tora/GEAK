#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { spawn } = require('node:child_process');

const argv = process.argv.slice(2);
if (argv[0] === 'exec' && argv.includes('--help')) {
  process.stdout.write([
    '--ephemeral', '--color', '--output-last-message', '--output-schema',
    '--sandbox', '--add-dir', '--approve-for-me',
    '--dangerously-bypass-approvals-and-sandbox', '--model',
  ].join('\n'));
  process.exit(0);
}

function option(name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : '';
}

function log(event, extra = {}) {
  const target = process.env.GEAK_FAKE_CODEX_LOG;
  if (!target) return;
  fs.appendFileSync(target, `${JSON.stringify({ event, pid: process.pid, ...extra })}\n`);
}

function defaultValue(schema, propertyName = '') {
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  if (propertyName === 'eval_dir') {
    return process.env.GEAK_FAKE_DEFAULT_EVAL_DIR || '/tmp/geak-fake-eval';
  }
  if (/correctness|smoke|parity/.test(propertyName)) return 'pass';
  switch (schema.type) {
    case 'object':
      return Object.fromEntries(Object.entries(schema.properties || {}).map(
        ([name, child]) => [name, defaultValue(child, name)],
      ));
    case 'array': return [];
    case 'boolean': return true;
    case 'number':
    case 'integer': return 1;
    case 'null': return null;
    case 'string': return 'value';
    default: throw new Error(`unsupported fake schema type ${schema.type}`);
  }
}

let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { prompt += chunk; });
process.stdin.on('end', async () => {
  const delayMatch = prompt.match(/^FAKE_DELAY_MS=(\d+)$/m);
  const resultMatch = prompt.match(/^FAKE_RESULT=(.+)$/m);
  const delayMs = delayMatch ? Number.parseInt(delayMatch[1], 10) : 0;
  log('start', { argv, prompt });

  const pidFile = process.env.GEAK_FAKE_SPAWN_CHILD_PID_FILE;
  if (pidFile) {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    });
    fs.writeFileSync(pidFile, String(child.pid));
  }

  const failOnce = process.env.GEAK_FAKE_FAIL_ONCE_FILE;
  if (failOnce) {
    try {
      const fd = fs.openSync(failOnce, 'wx');
      fs.closeSync(fd);
      process.stderr.write('intentional first-attempt failure\n');
      process.exit(9);
      return;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }

  if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
  const schemaMatch = prompt.match(/Original GEAK schema:\n```json\n([\s\S]*?)\n```/);
  const result = resultMatch
    ? JSON.parse(resultMatch[1])
    : (schemaMatch ? defaultValue(JSON.parse(schemaMatch[1])) : { ok: true });
  const output = process.env.GEAK_FAKE_MALFORMED === '1'
    ? '{malformed'
    : (option('--output-schema')
      ? JSON.stringify({ result_json: JSON.stringify(result) })
      : String(result));
  fs.writeFileSync(option('--output-last-message'), output);
  log('end', { result });
});
