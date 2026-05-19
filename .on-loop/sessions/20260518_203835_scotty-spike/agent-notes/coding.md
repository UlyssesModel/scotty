# Coding Agent Notes — Phase Scotty-A spike

## Summary

Implemented the six-file ACP-client spike per the architect's spec and the orchestrator's plan. Source is split into `scotty.tsx` (Ink UI, lifecycle, signal handlers) and `acp-client.ts` (JSON-RPC 2.0 client with NDJSON framing, request/response correlation, default-deny inbound dispatch, and a 1 MiB line-buffer cap). All wire shapes follow the architect's live-probed contract: `protocolVersion: 1`, snake_case `sessionUpdate` discriminator, `session/cancel` as a notification (no id), `session/close` as a request.

The spike honors every NQ constraint, verified by direct grep:

- NQ-1 — no `child_process`, no `exec(`, no `execSync`, no `spawnSync` in source. Only `Bun.spawn`.
- NQ-2 — `package.json` lists exactly `ink`, `ink-text-input`, `react` as runtime deps; `@types/react` and `@types/node` as dev deps.
- NQ-3 — no `fetch(`, no `node:net`/`http`/`https`/`dgram`/`tls`, no `undici`, no `ws` imports.
- NQ-4 — debug log is hard-coded to `./.scotty.log` (relative under CWD). No absolute-path writes.
- NQ-5 — no `@mirepoix/*` imports.
- NQ-6 — no telemetry/sentry/posthog/mixpanel/segment.io references.
- NQ-7 — no Anthropic/OpenAI/Google/Azure/Bedrock strings; no cloud-provider env vars read.

## Files created (line counts)

| Path (in worktree) | Lines | Purpose |
|---|---:|---|
| `package.json` | 20 | Pinned deps + scripts + `"type":"module"` |
| `acp-client.ts` | 623 | JSON-RPC 2.0 client + ACP wire types + `parseGooseCmd` |
| `scotty.tsx` | 672 | Ink UI + lifecycle + signal handlers |
| `README.md` | 184 | Install/run/env vars/MS-1..MS-6 verification recipes/security notes (replaced the 2-line seed) |
| `.gitignore` | 5 | `node_modules/`, `*.log`, `.scotty.log`, `.DS_Store`, `bun.lockb` |

**`bun.lock` — NOT created.** See "Open issues for tester" below.

## Decisions (kept inside the spec envelope)

- **Split implementation.** Used both `scotty.tsx` and `acp-client.ts` per architect's recommendation; the allowlist's tolerant reading permits this. Rationale: testability and grep-able boundaries between transport and UI.
- **`parseGooseCmd` lives in `acp-client.ts`.** It's exported so `scotty.tsx` is the only place reading env vars, but the logic is co-located with the client to keep the env-driven argv assembly testable in isolation later.
- **`AcpRpcError` class.** I added a small `Error` subclass (`code`, `data`) so the UI can special-case Goose's "Missing provider" response (AOQ-2) without re-parsing message strings. Not in the architect's exported-types list, but it's a private helper-style addition — does not change the wire contract.
- **`current_mode_update` notification IS handled** in `scotty.tsx` (the architect spec mentions rendering "other variants" as gray debug; for `current_mode_update` specifically we update the header's mode badge since that's what FR-3 shows). All remaining variants (`user_message_chunk`, `available_commands_update`, `config_option_update`, `session_info_update`, `usage_update`) fall through to the "render as `event: <sessionUpdate>` in gray" path.
- **Debug log via `Bun.file().writer({ append: true })`.** The writer is held open for the process lifetime; `flush()` is called on `waitUntilExit` resolution. Path is the literal string `./.scotty.log` so it cannot escape CWD (NQ-4).
- **Signal handlers register `process.exit(130/143)`.** After awaiting `client.shutdown()`, the SIGINT/SIGTERM/SIGHUP handlers force-exit so Bun doesn't hang on dangling I/O handles. The `exit` handler does a synchronous best-effort `killSync()` (it cannot await).

## Deviations from the architect spec / plan

1. **`bun.lock` is missing.** Bun is not installed on this host (no `bun`, `node`, `npm`, `tsc`, or `deno` in PATH and the on-loop classifier blocked downloading the bun installer). I could not run `bun install --save-text-lockfile`, and I refuse to hand-fabricate a lockfile because it would be wrong on first read and would damage reproducibility. **Tester must run `bun install --save-text-lockfile` on a bun-equipped host and commit the resulting `bun.lock`.** All `package.json` ranges are caret-pinned per ADR-001 / NQ-2, so the lockfile generation should be deterministic.
2. **No dry compile check executed.** Same reason — no Bun/tsc in this environment. I did a static review of both files for syntax and obvious type-mismatch issues; everything looks correct against the ACP-client types and ink 5.x's exported surface. Tester must run `bun build --target=bun scotty.tsx --outfile=/dev/null` (or `bun check`) and report any actual TS/syntax diagnostics back.
3. **No `tsconfig.json` created.** Stayed within the allowlist. Bun handles `.tsx` natively. If type-checking surfaces diagnostics that require a config (e.g., needing `"jsx": "react-jsx"` or `"moduleResolution": "bundler"`), treat as a spec amendment.

Beyond those, the implementation follows the architect spec exactly:
- NDJSON framing with 1 MiB line cap and force-close on overflow (S3).
- `protocolVersion: 1` outbound; warn (don't fail) on mismatch.
- `session/new` with `cwd: process.cwd(), mcpServers: []`; `sessionId` + `modes.currentModeId` stored.
- `session/cancel` is a **notification** (no `id`); `session/close` is a request with a 1 s ack timeout.
- Ctrl-C sequence: cancel → close → SIGTERM → 500 ms grace → SIGKILL → `app.exit()`.
- Process-level handlers (`exit`, `SIGINT`, `SIGTERM`, `SIGHUP`, `uncaughtException`) kill the child even if Ink is unresponsive.
- Default-deny: any inbound server-to-client REQUEST (method + id) gets `{-32601, "Method not found"}` so Goose doesn't deadlock awaiting an `fs/read_text_file` reply.
- `SCOTTY_DEBUG=1` appends raw I/O + Goose stderr + parse errors to `./.scotty.log`.

## Issues found / fixed during coding

- [LOW] My initial `acp-client.ts` header comment mentioned `child_process` and `exec` literally for clarity. That tripped the NQ-1 grep pattern. I rewrote the comment so the regex `\b(child_process|exec\(|execSync)\b` matches zero lines.

## Open issues for the tester (and orchestrator)

1. **MUST regenerate `bun.lock`** by running `bun install --save-text-lockfile` inside the worktree, then commit it. This is the largest gap in this handoff.
2. **MUST run the dry compile check** (`bun build --target=bun scotty.tsx --outfile=/dev/null`) to surface any real TS/syntax errors. If any appear, the tester should bounce them back to CODE (or fix small things in-place and document).
3. **AOQ-4 — signal propagation through `docker run -i`.** The straightforward Ctrl-C path is implemented (cancel → close → SIGTERM → SIGKILL on the `docker run` process). It is **NOT** verified that Docker actually forwards SIGTERM to the in-container `goose acp` PID 1 in time. If MS-6 leaves an orphan container, the recommended workaround (documented in `README.md` Troubleshooting) is to capture the container ID via `--cidfile` in `SCOTTY_GOOSE_CMD` and `docker kill <cid>` it explicitly on shutdown. If the tester sees orphans, this is the next CODE iteration.
4. **MS-4 / MS-5 require a configured Ollama provider** at `~/.config/goose/config.yaml`. If the tester's host has no provider configured, MS-4/MS-5 will be marked "manual verification required" and the AOQ-2 "Missing provider" path becomes the relevant code-path to test instead. The UI surfaces this as `error: provider not configured — run goose configure or mount config volume` and remains responsive (session stays ready, operator can retry).
5. **MS-3 5 s budget** assumes `goose-acp:v1.34.1` is pre-pulled. Cold-pull paths can take 30–90 s. README documents this; tester should pre-pull before timing.
6. **Goose may also send `fs/write_text_file`, `terminal/*`, or `session/request_permission` requests** to the client. The default-deny handler will reply `-32601` for all of these. In Goose's containerized deployment, this is unobservable because Goose has its own filesystem inside the container — but tools that depend on the client-side FS will fail silently from Goose's perspective. **For Phase A this is by design.** Tester should NOT report this as a bug.

## Environment notes the orchestrator should know

- `bun install` did **NOT** run (no bun binary).
- Dry compile check did **NOT** run (same).
- Source files are in their final intended form modulo any real TS diagnostics the tester surfaces. I deliberately did not invent `bun.lock` because committing a fabricated lockfile would be worse than not having one.

## Recommendations for the next agent (tester)

1. Run `bun install` (this implicitly creates `bun.lock` and `node_modules`); commit `bun.lock`.
2. Run `bun build --target=bun scotty.tsx --outfile=/dev/null` for a syntax/type sanity pass — fix or escalate any diagnostics.
3. Walk MS-1 through MS-6 per the README recipes. For MS-6 specifically, run it twice — once with a session that was idle when Ctrl-C arrived, and once with an in-flight `session/prompt`. Verify `ps auxf | grep -E '(docker run -i --rm.*goose-acp|goose acp)'` is empty and `docker ps --filter ancestor=goose-acp:v1.34.1` is empty in both cases.
4. If MS-6 leaks an orphan container, file the `--cidfile` follow-up as the next CODE retry (architect's AOQ-4 mitigation).
5. Confirm `.scotty.log` only appears in CWD when `SCOTTY_DEBUG=1` and is gitignored.

---

## Remediation (Retry 0)

No remediation yet — this is the initial CODE pass.

---

## Retry 1 fix: AOQ-4

### Why

Tester confirmed MS-6 FAIL: `AcpClient.shutdown()` killed the `docker run` CLIENT process but the goose-acp container kept running. The `docker run` CLI is a thin client that connects to the Docker daemon over `/var/run/docker.sock`; the daemon owns the container lifecycle. SIGTERM/SIGKILL of the client only severs the stdio bridge — it does NOT signal the container, so `--rm` never fires.

### What changed

**`acp-client.ts`** (~70 lines added/modified):

1. **New exported helper `injectDockerName(argv)`** at the bottom of the file:
   - Returns `{ cmd: string[], containerName: string | null }`.
   - Triggers ONLY when `argv[0] === "docker"` (bare basename — does not trigger on `/usr/local/bin/docker` or operator wrappers, by design) AND the first non-flag token after `docker` is `run` AND no `--name` / `--name=…` token is present anywhere in the tail.
   - When triggered: injects `--name scotty-goose-<pid>-<8-char-base36-rand>` immediately after `run`. Uniqueness is per-process and across concurrent Scotty instances on the same host.
   - When NOT triggered: returns argv verbatim with `containerName: null`. This is the operator-override-respecting path — we never fight an operator-supplied name.

2. **`AcpClient` constructor** calls `injectDockerName(opts.cmd)` and stores both the final argv and the container name (or null) on `this.gooseContainerName`.

3. **New public method `getGooseContainerName()`** returns the injected name (or null) so `scotty.tsx` could fire `docker kill` from its own backup handlers if needed — though in practice `killSync()` already does this.

4. **New private method `dockerKillContainerOnce(reason)`**: fire-and-forget `Bun.spawn({ cmd: ["docker", "kill", <name>], stdio: all-ignored })`. Bun.spawn is synchronous-init — the call returns immediately while the daemon RPC happens async — which is exactly what we need for both `shutdown()` and the synchronous `killSync()` backup. The reason string is logged via `debug()` for traceability. No-op if `gooseContainerName` is null.

5. **`shutdown()` sequence** now fires `dockerKillContainerOnce` TWICE:
   - After `SIGTERM` to the client and BEFORE the 500ms grace timer (covers the common case where the container exits cleanly via the kill).
   - After SIGKILL of the client (idempotent — `docker kill` on an already-stopped container is a benign error which we swallow). This second call handles the race where the first lost to a slow daemon connection.

6. **`killSync()`** (used by `process.on("exit")` backup handler) also calls `dockerKillContainerOnce`. Both are synchronous-init from the caller's POV, so this works inside a non-awaiting `exit` handler.

**`README.md`** (3 sections updated):
- `SCOTTY_GOOSE_CMD` row in the env-vars table: explains injection rules and the operator-override caveat.
- MS-6 verification block: replaced the "Known risk" sidebar with the AOQ-4 mitigation summary.
- Troubleshooting: rewrote the orphan-container entry to point operators to the operator-supplied-`--name` failure mode and the one-off cleanup command.

**`scotty.tsx`** — not modified. The existing `backupKill` -> `client.killSync()` chain already fires `docker kill` now via the killSync change. The existing `onSignal` -> `await client.shutdown()` already fires the dual `docker kill` calls. The existing `uncaughtException` -> `backupKill` already covers that path too. No new code paths were needed in the UI layer.

**`verify-ms6.sh`** — not modified. Its filter `docker ps --filter ancestor=goose-acp:v1.34.1` still matches because the new `--name` injection does not change the image ancestor. The supplementary test (Step 5b) directly drives `AcpClient.start() → newSession() → shutdown()` which is exactly the path the fix hardens.

### Compile checks

```
bun build --target=bun acp-client.ts --outfile=/dev/null
  → null 11.86 KB, [7ms] bundle 1 modules
bun build --target=bun scotty.tsx --outfile=/dev/null --external=react-devtools-core
  → null 1078.80 KB, [78ms] bundle 516 modules
```

Both ran clean inside `oven/bun:1.1-alpine`.

### Edge cases I noticed

- **Operator's argv = `/usr/local/bin/docker run …`**: argv[0] is not exactly `"docker"`, so we skip injection. Documented in README. Operators using an absolute path are presumed to know what they're doing.
- **Operator pre-supplies `--name some-custom-name` at any position after `run`**: we scan the full tail for `--name` / `--name=…`, find it, skip injection, set `gooseContainerName = null`. `shutdown()` then falls back to plain SIGTERM/SIGKILL of the client (the orphan risk reverts to "open if operator doesn't add their own cleanup"). README tells operators to either omit `--name` or pair theirs with a cleanup hook.
- **`-name` (single dash) or `--Name` (capitalised)**: not recognised by Docker, but also not detected by our scan. Docker would reject the invocation anyway, so this is a non-issue.
- **`--name=value` form**: handled — we check `t.startsWith("--name=")`.
- **`docker --debug run …`** (global flags between `docker` and `run`): our "first non-flag" scan correctly skips `--debug` and finds `run` at index 2. Injection still works.
- **`docker compose run …`**: argv[1] is `compose`, not `run`. We skip injection. This is correct — `compose run` has its own lifecycle.
- **Race after `Bun.spawn` of `docker kill`**: the inner `docker kill` itself spawns a short-lived `docker` CLI process. If Scotty is killed by SIGKILL before that process completes the daemon RPC, the kill may not land. The architectural fix is `process.on("exit")` running `killSync()` which is fire-and-forget anyway — Bun.spawn returns BEFORE the kernel exits Scotty, so the docker CLI is reparented to init (PID 1) and completes its RPC there. Verified by re-reading Bun.spawn's docs: by default the child is detached after spawn returns.

### Out-of-scope changes

None. Only `acp-client.ts` and `README.md` were modified. No new dependencies. No protocol behavior changes. No UI rendering changes. No verification script changes.

### Recommendations for tester re-run

1. Re-run `verify-ms6.sh`. The "Step 5b" direct-AcpClient path should now report `SUPPLEMENTARY PASS: AcpClient.shutdown() cleaned up container`.
2. Optionally also confirm the injected name shows up by setting `SCOTTY_DEBUG=1` and grepping `.scotty.log` for `docker kill scotty-goose-`.
3. Optionally test the operator-override path: `SCOTTY_GOOSE_CMD="docker run --rm --name my-goose -i goose-acp:v1.34.1 acp" verify-ms6.sh`. This SHOULD still produce an orphan (by design — we deferred to the operator), which exercises the "no-injection" branch and confirms it's not breaking the normal path.
