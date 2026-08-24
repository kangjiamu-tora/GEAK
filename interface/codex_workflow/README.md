# Codex Workflow thin adapter

This directory is GEAK's dependency-free Node.js compatibility runtime. It executes the existing trusted
Workflow JavaScript control flow and delegates only `agent()` leaves to separate `codex exec` processes.
The production workflow and role files are shared unchanged with Claude.

The supported public entry point remains:

```bash
GEAK_AGENT_BACKEND=codex python interface/run_e2e.py handoff.json result.json
```

Requirements:

- Node.js 18 or newer.
- A separately installed and authenticated Codex CLI whose `codex exec --help` exposes the flags the
  adapter probes at startup. GEAK does not install or authenticate Codex.
- The normal GPU, ROCm, profiler, model, and serving-backend requirements.

Configuration:

| Variable | Default | Meaning |
|---|---|---|
| `GEAK_CODEX_BIN` | `codex` | Codex executable. |
| `GEAK_NODE_BIN` | `node` | Node executable used by `run_e2e.py`. |
| `GEAK_CODEX_MODEL` | unset | Optional explicit model; unset uses Codex configuration. |
| `GEAK_CODEX_MAX_AGENTS` | `8` | Shared FIFO concurrency limit across nested workflows. |
| `GEAK_CODEX_SANDBOX` | `workspace-write` | Sandbox passed with `--approve-for-me`. |
| `GEAK_CODEX_BYPASS` | `0` | Set to `1` to bypass approvals and sandboxing. |
| `GEAK_CODEX_ADD_DIRS` | unset | OS path-separated extra writable directories. |
| `GEAK_CODEX_AGENT_TIMEOUT_MS` | workflow default | Override the per-leaf timeout; `0` disables it. |

`GEAK_CODEX_BYPASS=1` uses `--dangerously-bypass-approvals-and-sandbox`. Use it only on an externally
isolated GPU runner. The normal path uses `--sandbox workspace-write --approve-for-me`.

The runner reads one request object from stdin:

```json
{"script_path":"/absolute/path/to/e2e_workflow.js","args":{}}
```

Logs and phase events go to stderr. On success stdout contains exactly one JSON Workflow result. A successful
top-level result is also atomically written to `<eval_dir>/workflow_return.json` when an eval directory is
available.

The non-GPU suite validates the adapter contract with a fake Codex executable. Treat the backend as
production-ready only after the gated live Codex leaf, AMD GPU single-kernel, and constrained E2E checks pass
in the target runner environment.
