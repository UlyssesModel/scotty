# Implementation Plan — Phase Scotty-A (ACP Client Spike)

**Session:** `20260518_203835_scotty-spike`
**Branch:** `on-loop/scotty-spike`
**Worktree:** `/home/jekavara/workspaces/scotty/.claude/worktrees/scotty-spike/`
**Spec:** `.on-loop/sessions/20260518_203835_scotty-spike/agent-notes/architect.md`
**Source spec:** `specs/scotty-spike-spec.md`

This plan derives from the architect agent's spec (Appendix A live-probe transcript verifies all wire shapes). It is sequenced so the coding agent can produce a working spike in one pass, then tester / security / doc+build / reviewer run against the result.

---

## Phase ordering

1. **CODE** — produce 6 files in worktree per file allowlist (see "Files to produce" below).
2. **TEST** — manual + scripted MS-1..MS-6 verification; up to 3 retries back to CODE.
3. **SECURITY** — static grep checks (NQ-1, NQ-3, NQ-6, NQ-7 enforcement) + dep audit + the 8 STRIDE concerns from spec §"Security Considerations"; up to 2 retries.
4. **DOC + BUILD** — parallel. Doc writes/extends `README.md` with MS verification scripts + security notes. Build sets up `.gitignore`, ensures `bun install` reproducible from `bun.lock`, optional Makefile/`bun run` scripts.
5. **REVIEW** — ADR-013 multi-agent face-off; up to 2 retries.
6. **GIT** — stage, commit, push, `gh pr create`.

---

## Files to produce (worktree, all within spec file allowlist)

| File | Phase | Notes |
|---|---|---|
| `package.json` | CODE | `"type":"module"`, pinned ink ^5.0.1, ink-text-input ^6.0.0, react ^18.3.1; devDep `@types/react`; scripts: `start`, `dev`, `verify` |
| `scotty.tsx` | CODE | Ink UI entry — header / conversation / input; integrates AcpClient; Ctrl-C handler |
| `acp-client.ts` | CODE | JSON-RPC 2.0 client, NDJSON framing, request/response correlation, default-deny inbound, EventTarget for `session/update` |
| `README.md` | CODE seeded + DOC expanded | Install, run, env vars, MS-1..MS-6 verification, security warnings |
| `.gitignore` | CODE | `node_modules/`, `*.log`, `.scotty.log`, `.DS_Store` |
| `bun.lock` | CODE (via `bun install`) | Committed text lockfile |

**Out of allowlist (do not create unless type errors block CODE):** `tsconfig.json`, `src/`, test framework files. If `tsconfig.json` becomes necessary, treat as an allowlist amendment and document in PR body.

---

## CODE phase — must-implement checklist (from architect handoff)

### Wire protocol — exact shapes (verified by live probe 2026-05-18)

- **NDJSON framing.** Each message is one JSON object + `\n`. No `Content-Length:` header.
- **Outbound `initialize`:**
  ```json
  {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{}}}
  ```
  Expect `result.protocolVersion === 1`; warn (don't fail) on mismatch.
- **Outbound `session/new`:**
  ```json
  {"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":"<process.cwd()>","mcpServers":[]}}
  ```
  Store `result.sessionId` and `result.modes.currentModeId`.
- **Outbound `session/prompt`:**
  ```json
  {"jsonrpc":"2.0","id":<n>,"method":"session/prompt","params":{"sessionId":"<id>","prompt":[{"type":"text","text":"<input>"}]}}
  ```
- **Outbound `session/cancel` (NOTIFICATION — no `id`):**
  ```json
  {"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":"<id>"}}
  ```
- **Outbound `session/close`:**
  ```json
  {"jsonrpc":"2.0","id":<n>,"method":"session/close","params":{"sessionId":"<id>"}}
  ```
- **Inbound `session/update` (notification, no `id`):** internally-tagged union on `params.update.sessionUpdate`. Variants: `agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`, `user_message_chunk`, `current_mode_update`, `available_commands_update`, `config_option_update`, `session_info_update`, `usage_update`.
- **Default-deny inbound requests:** any inbound message with both `method` AND `id` whose method is not in the (currently empty) supported set → reply with `{"jsonrpc":"2.0","id":<same>,"error":{"code":-32601,"message":"Method not found"}}`. Prevents Goose from hanging on `fs/read_text_file` or `session/request_permission` reverse-direction calls.

### Subprocess management

- `Bun.spawn({ cmd: argv, stdin: "pipe", stdout: "pipe", stderr: "pipe" })`.
- `SCOTTY_GOOSE_CMD` env var → `.split(/\s+/).filter(Boolean)` (NO shell, NO glob, NO interpolation).
- Default: `docker run -i --rm -v ${HOME}/.config/goose:/root/.config/goose:ro goose-acp:v1.34.1 acp` (resolve `${HOME}` from `process.env.HOME`).
- Ctrl-C handler (Ink `useInput`): `session/cancel` notification → `session/close` request (wait ≤1s for `{}` ack) → `child.kill("SIGTERM")` → 500ms grace → `child.kill("SIGKILL")` → `app.exit()`.
- Backup `process.on("exit"|"SIGTERM"|"SIGHUP"|"SIGINT"|"uncaughtException")` registers `child.kill` for cases where React layer is unresponsive. **AOQ-4 risk:** signal propagation through `docker run -i` may race — if MS-6 fails, fall back to capturing container ID via `--cidfile` + explicit `docker kill`.

### UI

- Three regions: header (1 line), conversation pane (flex-fill, scrolling), input (1 line, `ink-text-input`).
- Conversation events:
  - User prompt: cyan, `> <text>`
  - Agent message: white, joined per assistant turn (sequential `agent_message_chunk` notifications append to same bubble)
  - Agent thought: gray italic, `thought > <text>`
  - Tool call: yellow, `tool: <title || kind || toolCallId> (<argSummary>)`, status badge
  - Tool call update: locate by `toolCallId`, update status + appended content/output preview
  - Unknown variant: gray, `event: <sessionUpdate>` (debug)
- Header: `connecting…` → `session <id> ready — <mode>` → `prompting…` → `error: <msg>`.
- Input disabled while `prompting…`.

### Debug logging (AOQ-3)

- If `SCOTTY_DEBUG=1`: append all raw I/O lines + Goose stderr to `./.scotty.log` (relative — must NOT escape CWD per NQ-4).
- Off by default. `.gitignore` covers `.scotty.log`.

### Error handling

- `JSON.parse` errors per line → log to stderr handler, continue (S4).
- Parsed-line buffer cap: 1 MiB (S3).
- `session/prompt` returning `{error: {data: "Missing provider"}}` → header shows `error: provider not configured — run goose configure or mount config volume`, session stays ready, allow retry.
- Goose process exit (code event) → header shows `goose exited (code N)`, disable input.

---

## TEST phase — MS-1..MS-6 verification recipes

| MS | What | How to verify | Pass criteria |
|---|---|---|---|
| MS-1 | `bun install` clean | `cd <worktree> && bun install` | exit 0, `node_modules/` + `bun.lock` exist, no peer-dep warnings beyond ink's normal output |
| MS-2 | `bun scotty.tsx` launches | `bun scotty.tsx` (with image pulled) | Ink UI renders, header reads `connecting…` then `session <id> ready` within 5 s |
| MS-3 | `initialize` < 5 s | timestamp before launch, observe header transition | `connecting…` → `session <id> ready — <mode>` within 5000 ms (assumes image already pulled — README must call this out) |
| MS-4 | Streaming `agent_message_chunk` | type `"say hello in exactly three words"` + Enter (requires Ollama + provider config) | Tokens appear progressively in conversation pane, not as a single batched message |
| MS-5 | `tool_call` rendering | type `"list the files in /tmp"` + Enter | A yellow `tool:` line appears in conversation pane before agent's text response |
| MS-6 | Clean exit on Ctrl-C | press Ctrl-C during/after a session; then `ps auxf \| grep -E 'docker\|goose'` | No `goose` or `docker run` PIDs remain; `docker ps` shows no orphan container |

**TEST agent should also:**
- Write a `verify.sh` (or `package.json` `"verify"` script) that automates MS-1, MS-2 (launch + grep for "ready" via timeout-bounded run), and MS-6 (post-exit `ps`/`docker ps` check). MS-4/MS-5 require a configured provider — document as manual verification.
- Capture transcripts in `.on-loop/sessions/.../agent-notes/testing.md`.

---

## SECURITY phase — checklist (from architect spec §"Security Considerations")

| # | Check | How |
|---|---|---|
| NQ-1 | No `child_process` / `exec` | `grep -REn '\b(child_process\|exec\(\|execSync)\b' scotty.tsx acp-client.ts` → must be empty |
| NQ-3 | No outbound socket APIs in Scotty | grep `node:net\|node:http\|node:https\|node:dgram\|node:tls\|fetch(\|undici\|ws` in source → must be empty |
| NQ-5 | No `@mirepoix/*` imports | `grep -RE "from ['\"]@mirepoix/" .` → empty |
| NQ-6 | No telemetry | grep `posthog\|sentry\|mixpanel\|api\.segment\.io` → empty |
| NQ-7 | No cloud-provider strings | grep `api\.anthropic\.com\|api\.openai\.com\|googleapis\.com\|ANTHROPIC_API_KEY\|OPENAI_API_KEY` → empty |
| S1 | `SCOTTY_GOOSE_CMD` injection-safe | confirm split → `Bun.spawn({cmd: argv})` (array form), no shell; documented in README |
| S2 | Orphan child cleanup | confirm `process.on(...)` registrations; visual review |
| S3 | Stdout flood guard | confirm 1 MiB line buffer cap exists in `acp-client.ts` |
| S4 | Parse-error resilience | confirm try/catch around `JSON.parse`; unknown method dispatch → `-32601` |
| S5 | Config mount read-only | confirm default `SCOTTY_GOOSE_CMD` uses `:ro` |
| dep | `bun audit` (or npm advisory check) on pinned versions | run; document findings |

Surface CRITICAL/HIGH findings as blockers (max 2 retries to CODE).

---

## DOC phase

Extend `README.md` (initial draft seeded by coder) to cover:

- Why Scotty exists (one-paragraph context referencing Phase Scotty-A spec).
- Prerequisites: Bun ≥ 1.1, Docker, `goose-acp:v1.34.1` image present (`docker images | grep goose-acp`), `~/.config/goose/config.yaml` with Ollama provider configured at `http://10.128.0.16:11434` model `qwen2.5-coder:32b-instruct`.
- Install: `bun install`.
- Run: `bun scotty.tsx` (or `bun start`).
- Env vars: `SCOTTY_GOOSE_CMD` (default + override examples), `SCOTTY_DEBUG=1` (writes `.scotty.log`), `HOME` (used to resolve the config volume mount).
- MS-1..MS-6 verification recipes (copy from this plan).
- Security notes: S1 (whitespace-split, no shell), S5 (config mounted `:ro`, contains API keys), S7 (container has default-bridge network — Goose can reach anywhere), S8 (don't type secrets — Scotty doesn't redact).
- Troubleshooting: cold image pull > 5 s (MS-3 budget), "Missing provider" error → run `docker run -it goose-acp:v1.34.1 configure` once, signal propagation issue (AOQ-4) workaround.
- Out-of-scope reminder pointing to Scotty-B/C/D.

---

## BUILD phase

- Ensure `.gitignore` covers `node_modules/`, `*.log`, `.scotty.log`, `.DS_Store`, `bun.lockb`.
- Verify `bun install` is reproducible from committed `bun.lock`.
- Optionally add `package.json` scripts:
  - `"start": "bun scotty.tsx"`
  - `"dev": "SCOTTY_DEBUG=1 bun scotty.tsx"`
  - `"verify": "./verify.sh"` (if created in TEST)
- No CI workflow files are in the file allowlist; defer GH Actions setup to a follow-up phase (out of scope for spike).

---

## REVIEW phase — ADR-013 multi-agent face-off criteria

Reviewer must confirm:

1. **Spec adherence:** all FR-1..FR-10, NQ-1..NQ-7, MS-1..MS-6 addressed; deviations documented (notably the snake_case wire encoding and the spec-text CamelCase event names — the architect doc resolves this).
2. **ADR coverage:** decisions match ADR-001..005; if coder deviated (e.g., inlined `acp-client.ts` into `scotty.tsx`), confirm rationale recorded.
3. **No scope creep:** files outside allowlist? new dependencies? extra subprocess machinery? all rejected unless justified in PR body.
4. **Wire protocol correctness:** outbound shapes match Appendix A; default-deny for inbound requests is present; `session/cancel` sent as notification not request.
5. **Cleanup correctness:** Ctrl-C path + `process.on(...)` backup cleanup; AOQ-4 risk documented if MS-6 was unstable.
6. **Code quality:** TypeScript types from architect spec §"Exported types"; no `any` where a concrete type fits; clear separation of UI (React/Ink) from protocol (`AcpClient`).
7. **Operator UX:** header status transitions are correct; tool call rendering is legible; thought chunks visually distinguished.

If REQUEST_CHANGES → retry CODE (max 2).

---

## GIT phase

From within the worktree:

1. `cd .claude/worktrees/scotty-spike`
2. Stage explicit paths from `changes.log`:
   ```
   git add package.json scotty.tsx acp-client.ts README.md .gitignore bun.lock
   ```
   (plus `verify.sh` and `tsconfig.json` if present — explicit add only, never `-A`)
3. From repo root, stage session audit:
   ```
   cd /home/jekavara/workspaces/scotty
   git add .on-loop/sessions/20260518_203835_scotty-spike/ .on-loop/index.json
   git -C .claude/worktrees/scotty-spike commit -m "<HEREDOC summary>"
   ```
   _Note:_ the session dir is at the repo root, the spike files are inside the worktree. Two `git add` invocations, one commit per location. **Worktree commit is the one pushed to `on-loop/scotty-spike`.** The repo-root session-dir add is committed separately on `main` only at completion — or, more cleanly, committed inside the worktree too since it shares the same git dir.

   **Resolution (simpler):** since the worktree shares the same `.git/` and history with the repo root, a single commit from inside the worktree, with `git add` against absolute paths (or repo-root-relative via `git -C <repo-root>`), captures both. The orchestrator handles this.

4. `git push -u origin on-loop/scotty-spike`
5. `gh pr create --title "Phase Scotty-A: ACP client spike" --body <HEREDOC>` — body includes:
   - Summary
   - Files changed
   - MS-1..MS-6 test results (from TEST phase)
   - Security findings (from SECURITY phase)
   - ADR list with one-line summaries
   - Material spec divergences (the 5 surfaced after SPEC):
     - `protocolVersion: 1` (negotiated echo, not `0`)
     - snake_case wire encoding inside `session/update`
     - `session/cancel` is a notification, plus added `session/close`
     - `acp-client.ts` split from `scotty.tsx`
     - MS-3 5s budget assumes pre-pulled image
   - Outstanding TODOs / open questions (AOQ-1..AOQ-5)
6. Store PR URL in `state.json`.

---

## Acceptance gate before COMPLETE

- All MS-1..MS-6 pass (or have documented WONTFIX with operator-acknowledged risk).
- No CRITICAL/HIGH security findings outstanding.
- Reviewer = APPROVE (or REQUEST_CHANGES retries exhausted with TODOs filed).
- PR open at `origin/on-loop/scotty-spike` with body per GIT phase above.
- `state.json.phase = "COMPLETE"`, `index.json` session entry updated with `completed_at` + `pr_url`.

---

## Risks / known issues

- **AOQ-4 — signal propagation through `docker run -i`**: real risk for MS-6. Coder implements straightforward path; tester MUST verify; if it fails, add `--cidfile` + explicit `docker kill <cid>` fallback.
- **Provider not configured** (MS-4/MS-5): the spike requires an operator-pre-configured `~/.config/goose/`. If TEST phase runs on a host without this, MS-4/MS-5 will be marked "manual verification required" and the PR body documents the gap.
- **Image not present** (MS-3 budget): if `goose-acp:v1.34.1` isn't local, first launch eats a docker pull. README documents the pre-pull step (`docker pull` or `docker build`).
- **No automated tests** in the spike (per architect spec — Phase A has no test framework, MS verification is manual / scripted). TEST agent should NOT introduce vitest/jest/etc.; that's a Phase B decision.

---

## Estimated outputs

- 6 files in worktree (per allowlist).
- 1 optional `verify.sh` if TEST agent finds value.
- Agent notes from coder, tester, security, doc, build, reviewer (each in `.on-loop/sessions/.../agent-notes/`).
- 1 commit on `on-loop/scotty-spike` covering both worktree files and the session audit dir.
- 1 PR.
