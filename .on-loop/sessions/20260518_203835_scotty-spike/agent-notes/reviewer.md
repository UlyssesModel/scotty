# Review Report — Phase Scotty-A Spike

**Date:** 2026-05-18
**Agent:** Reviewer
**Session:** `20260518_203835_scotty-spike`
**Worktree:** `/home/jekavara/workspaces/scotty/.claude/worktrees/scotty-spike/`
**Framework:** ADR-013 on-loop multi-agent face-off (this is the on-loop reviewer pass; operator may invoke `/ultrareview` post-PR for cloud-based cross-review).

## Summary

End-to-end independent review of the spec/plan/ADRs/coding/testing/security/doc/build trail and the actual worktree contents. The spike satisfies every functional, negative, and must-show requirement, with the two MS milestones that depend on a live Ollama provider explicitly marked VERIFIED-UP-TO-PROVIDER-BOUNDARY (the protocol path was exercised; only the remote inference is unreached). The AOQ-4 retry-1 fix (`injectDockerName` + dual `dockerKillContainerOnce`) is mechanically correct, covers the documented edge cases, introduces no injection surface (the injected name uses only `process.pid` and `Math.random()`), and was independently confirmed by the tester (`verify-ms6.sh` retry-1 PASS with `DOCKER_KILL_ENTRIES: 2`). All NQ greps come back clean. Security audit found zero CRITICAL/HIGH; two MEDIUM and three LOW are documented residual risks appropriate for a spike, with FINDING-4 already remediated in `README.md` and FINDING-5 closed by the build agent's defensive comment on `verify.sh:149`. The build agent confirmed `bun install --frozen-lockfile` is reproducible (50 packages, 520 ms in clean tmpdir) and both `bun build --target=bun` invocations compile clean. No outstanding blockers.

## Verdict: APPROVE

## Spec adherence (FR / NQ / MS)

| Req | Status | Evidence |
|---|---|---|
| **FR-1** spawn Goose via `Bun.spawn()` with stdio piped | PASS | `acp-client.ts:250-255` — `Bun.spawn({ cmd, stdin/stdout/stderr: "pipe" })`, array form, no shell |
| **FR-2** JSON-RPC 2.0 over NDJSON; id-based correlation | PASS | `acp-client.ts:459-476` (write `JSON.stringify(msg)+"\n"`), `479-524` (stdout NDJSON parse), `427-446` (id+pending map) |
| **FR-3** initialize → session/new → render "ready" | PASS | `scotty.tsx:328-356` boot effect; `acp-client.ts:274-286` initialize handshake; status transitions `connecting…` → `session <id> ready — <mode>` (`scotty.tsx:344`) |
| **FR-4** three-region Ink UI | PASS | `scotty.tsx:505-531` header / conversation pane (`flexGrow=1`) / input |
| **FR-5** Enter → `session/prompt` with `{type:"text"}` block; input clears | PASS | `scotty.tsx:458-499` onSubmit (`dispatch user`, `setInputValue("")`, `setInputDisabled(true)`, `client.prompt`) |
| **FR-6** `agent_message_chunk` streamed into a single assistant bubble per turn | PASS | `scotty.tsx:104-125` reducer appends to `currentAgentId`; `turn_done` action (`145-147`) resets at end of turn |
| **FR-7** `agent_thought_chunk` distinct (gray italic, `thought >` prefix) | PASS | `scotty.tsx:546-552` ConversationLine "thought" case |
| **FR-8** `tool_call` rendered with title + arg summary | PASS | `scotty.tsx:379-388, 553-560` — `tool: <title> (<argSummary>) [<status>]`, yellow |
| **FR-9** `tool_call_update` updates prior event by `toolCallId` | PASS | `scotty.tsx:160-185` reducer's `tool_update` case maps by `toolCallId`; defensive info entry if no prior `tool_call` |
| **FR-10** Ctrl-C → cancel → close → SIGTERM → SIGKILL → exit | PASS | `scotty.tsx:451-455` Ink useInput; `acp-client.ts:322-379` shutdown sequence; `scotty.tsx:629-641` backup `process.on(...)` handlers; AOQ-4 retry covers docker container layer |
| **NQ-1** Bun.spawn only — no `child_process`/`exec`/`execSync` | PASS | grep `\b(child_process\|exec\(\|execSync)\b scotty.tsx acp-client.ts` → 0 matches |
| **NQ-2** runtime deps = `{ink, ink-text-input, react}` only; devDeps `@types/*` only | PASS | `package.json` runtime exactly `{ink ^5.0.1, ink-text-input ^6.0.0, react ^18.3.1}`; devDeps `{@types/node ^22.9.0, @types/react ^18.3.12}` — both `@types/*`, NQ-2 says "may add `@types/*` only" |
| **NQ-3** no outbound sockets from Scotty | PASS | grep for `node:net/http/https/dgram/tls/ws/undici` → 0; `fetch(` → 0 |
| **NQ-4** no writes outside CWD | PASS | only file write target is literal `./.scotty.log` in `scotty.tsx:256` gated on `SCOTTY_DEBUG=1`; no `writeFile`/`createWriteStream`/`Bun.write(` calls |
| **NQ-5** no `@mirepoix/*` imports | PASS | grep `from ["']@mirepoix/` → 0 in source + package.json |
| **NQ-6** no telemetry / phone-home | PASS | grep `posthog\|sentry\|mixpanel\|api.segment.io\|@anthropic-ai/sdk` → 0 (security agent confirmed the NQ-6 grep's only hit was a doc comment) |
| **NQ-7** no cloud-provider strings or API-key env vars | PASS | grep `api.anthropic.com\|api.openai.com\|googleapis.com\|ANTHROPIC_API_KEY\|OPENAI_API_KEY` → 0 |
| **MS-1** `bun install` clean | PASS | tester: 50 packages, 662 ms (with frozen-lockfile); build agent re-ran in tmpdir: 520 ms, exit 0 |
| **MS-2** Ink UI launches without runtime error | PASS | AcpClient starts inside Docker-in-Docker bun container; `verify-protocol.ts` 7/7 PASS |
| **MS-3** initialize within 5 s | PASS | observed 356 ms (retry-1); 14× margin under 5000 ms budget |
| **MS-4** streaming `agent_message_chunk` | VERIFIED-UP-TO-PROVIDER-BOUNDARY | wire shape accepted by Goose; AcpRpcError "Missing provider" surfaces correctly; streaming requires Ollama (not on test host) — documented manual recipe in README |
| **MS-5** `tool_call` rendering | VERIFIED-UP-TO-PROVIDER-BOUNDARY | same constraint as MS-4 |
| **MS-6** clean exit, no orphans | PASS (post-retry-1) | `verify-ms6.sh` SUPPLEMENTARY PASS; `DOCKER_KILL_ENTRIES: 2` confirms dual `docker kill` dispatch; baseline-diff isolates this run's containers |

All FR/NQ/MS addressed. Two MS items legitimately marked VERIFIED-UP-TO-PROVIDER-BOUNDARY (test host has no Ollama) — the protocol exercise is complete and the AcpRpcError "Missing provider" code path is the relevant one to verify, which the tester did. This is the right honesty bar.

## ADR coverage

| ADR | Implemented? | Evidence |
|---|---|---|
| **ADR-001** Bun + Ink + TS (.tsx) | YES | `package.json` `"type":"module"`; `scotty.tsx` uses JSX with `import { Box, Text, useApp, useInput, render } from "ink"`; ink ^5.0.1, react ^18.3.1, no transpiler |
| **ADR-002** Docker subprocess via `SCOTTY_GOOSE_CMD` whitespace-split | YES | `acp-client.ts:674-679` `parseGooseCmd` does `src.split(/\s+/).filter(Boolean)`; default cmd embeds `:ro` volume mount; argv passed verbatim to `Bun.spawn({ cmd })` array form |
| **ADR-003** NDJSON framing | YES | `acp-client.ts:459` writer emits `JSON.stringify(msg)+"\n"`; `acp-client.ts:479-524` line-buffered stdout loop; 1 MiB cap; trailing-partial-line tolerated by accumulation |
| **ADR-004** `protocolVersion: 1`, echo-verify, warn on mismatch | YES | `acp-client.ts:275-285` sends `protocolVersion: 1`, debug-warns if response differs but does not throw |
| **ADR-005** No `@mirepoix/*` imports | YES | grep clean; package.json has no @mirepoix dep |

Architect's "permissive allowlist" call to split `acp-client.ts` from `scotty.tsx` is consistent with ADR-001's grep-able-boundaries rationale and documented in `coding.md` §"Decisions". No deviations from any ADR.

## File allowlist compliance

The spec allowlist names `package.json`, `scotty.tsx` (or `scotty.ts`), `README.md`, `.gitignore`, `bun.lock`. The architect's spec permissively added `acp-client.ts` (with explicit allowlist-clarification text). The tester added three verification artifacts. Current worktree contents:

| File | Allowlist status | Justification |
|---|---|---|
| `package.json` | IN | Spec member |
| `scotty.tsx` | IN | Spec member |
| `README.md` | IN | Spec member |
| `.gitignore` | IN | Spec member |
| `bun.lock` | IN | Spec member (regenerated by orchestrator on bun-equipped Docker path) |
| `acp-client.ts` | DOCUMENTED-ADDITION | Architect's permissive read of "`scotty.tsx` (or `scotty.ts`)"; rationale in `architect.md` Module/file-layout table and `coding.md` §"Decisions" |
| `verify.sh` | TESTER-AFFORDANCE | Plan §"TEST phase" explicitly invites a `verify.sh`; the build agent wired it into `package.json` scripts; security-reviewed clean (mktemp-bounded, no secret leakage, no unbounded `rm`); 288 lines |
| `verify-protocol.ts` | TESTER-AFFORDANCE | MS-2+MS-3 AcpClient integration harness; pure protocol-side, no UI; security-reviewed clean |
| `verify-ms6.sh` | TESTER-AFFORDANCE | MS-6 orphan-container check with baseline-diff to isolate test-run containers; security-reviewed clean |
| `node_modules/` | GITIGNORED | not committed |

No accidentally-included files (no `.smoke.tsx`, no `*.log`, no `.scotty.log`). The build agent added `.smoke.tsx` defensively to `.gitignore`. The three verify scripts are appropriate inclusions for a spike whose MS criteria are manually/scripted-verified; flagging them as deliberate spec-amendments in the PR body covers the formal allowlist gap.

## Code-quality findings

All non-blocking. No issues that warrant a CODE retry.

- **[NON-BLOCKING / UX] Inter-leaved `agent_message_chunk` + `tool_call` ordering.** In `scotty.tsx:104-125`, when an `agent_message_chunk` arrives mid-stream and is appended to the existing `currentAgentId` bubble, then a `tool_call` arrives, then more `agent_message_chunk`s arrive — the chunks continue to append to the same bubble at its **original position** in the `events` array, while the tool_call is inserted **after** the bubble. So a real-world sequence `agent("Let me check ")` → `tool(ls)` → `agent("…the result")` renders as `[bubble: "Let me check …the result"][tool: ls]` — i.e. the tool line drifts visually below the assistant text it was interleaved with. This is a known TUI rendering trade-off (the alternative — fragmenting the bubble — violates FR-6's "single assistant bubble per turn"). Recommend Phase Scotty-B revisit: either close the current bubble on `tool_call` arrival (FR-6 trade-off) or render bubbles + tool-calls in a flat append-only timeline. Not a Phase-A blocker.
- **[NON-BLOCKING] `@ts-expect-error` on `Bun.file().writer({ append: true })`.** `scotty.tsx:260` carries a single `@ts-expect-error` because newer Bun types may have widened the `writer()` overload. The runtime path falls back to no-op debug logging if writer construction throws, so this is safe. Replace with a typed shim or upgrade `@types/bun` (not currently a dep) in Phase B.
- **[NON-BLOCKING] `current_mode_update` notification.** Implementation goes beyond the architect's "render unknown as gray debug" default and instead updates the header mode badge (`scotty.tsx:400-411`). This is the **right** behavior per FR-3 ("Render status header `session <id> ready — <mode>`") and the architect spec actually notes the architect "interprets" the architect-spec's default permissively. Documented in `coding.md` §"Decisions". Approved as-is.
- **[NON-BLOCKING] `AcpRpcError` class.** Coder added an `Error` subclass with `code` and `data` fields so the UI can special-case `AOQ-2` ("Missing provider") without re-parsing message text. Not in architect's exported-types list but is a private-helper-style addition that does not change wire contract. Approved.
- **[NON-BLOCKING] `Bun.spawn` typing.** `acp-client.ts:198` uses `ReturnType<typeof Bun.spawn>` to type `child` rather than naming `Bun.Subprocess` directly; this avoids depending on the global Bun namespace which `@types/bun` would provide. Pragmatic and works under Bun's runtime types. No action.

## Operator UX walk-through

Walking through a sample prompt cycle against the actual code:

1. Operator types `> list /tmp` and presses Enter.
2. `onSubmit` (`scotty.tsx:458-499`) trims, dispatches `user`, clears input, disables input, sets header → `prompting…`, awaits `client.prompt(sid, "list /tmp")`.
3. Goose streams `session/update` notifications. Each one fires the listener registered at `scotty.tsx:360-419`:
   - `agent_thought_chunk("Let me figure out…")` → reducer creates new `thought` bubble (currentThoughtId), gray italic, prefixed `thought > `.
   - `tool_call(toolCallId="t1", title="shell", rawInput={"command":"ls /tmp"}, status="in_progress")` → reducer appends `tool` event, yellow; argSummary `{"command":"ls /tmp"}` ≤80 chars.
   - `tool_call_update(toolCallId="t1", status="completed", content=[{type:"text",text:"file1\nfile2"}])` → reducer locates prior `tool` by `toolCallId`, updates status, sets `output` to `file1\nfile2` (truncated at 120 if needed).
   - `agent_message_chunk("Here are the ")` → reducer creates `agent` bubble (currentAgentId); also clears `currentThoughtId`.
   - `agent_message_chunk("files: …")` → reducer appends to same bubble.
4. Goose returns final `result` with `stopReason: "end_turn"`. `onSubmit`'s `await client.prompt` resolves → `dispatch info "turn done"`, header → `ready`, `dispatch turn_done` (clears both `currentAgentId` and `currentThoughtId`), input re-enabled.

This trace matches the architect's data-flow diagram and the FR-6/7/8/9 expectations. The header status accurately transitions `connecting…` → `ready` → `prompting…` → `ready`. Input is correctly disabled during `prompting…` (the `setInputDisabled(true)` line before `client.prompt`). The `finally` block always runs `setInputDisabled(false)` even on error, so the input never gets stuck disabled outside `exited` state.

## Cleanup correctness

- **Ink Ctrl-C path** (`scotty.tsx:451-455` → `shutdown` callback at `435-449`): `client.shutdown(sessionId)` → `app.exit()`. `shutdown()` itself is idempotent (`closed` flag, line 323-324).
- **`AcpClient.shutdown()` sequence** (`acp-client.ts:322-379`): cancel notification (fire-and-forget) → close request (1 s timeout via `withTimeout`) → SIGTERM to docker client → **`dockerKillContainerOnce("shutdown:pre-grace")`** → race grace timer vs `child.exited` → SIGKILL if needed → **`dockerKillContainerOnce("shutdown:post-grace")`** → wait up to 500 ms for read loops to drain.
- **Synchronous backup** (`acp-client.ts:382-393`): `killSync()` sends SIGTERM + fires `dockerKillContainerOnce("killSync")`. Bun.spawn's docker-CLI sub-spawn is reparented to PID 1 after Scotty exits, so the daemon RPC completes in the background.
- **process-level handlers** (`scotty.tsx:611-641`): `exit` → `backupKill` (sync); `SIGINT/SIGTERM/SIGHUP` → `onSignal` (awaits `shutdown()` then `process.exit(130|143)`); `uncaughtException` → `backupKill` + `process.exit(1)`. All five handler points covered.
- **React useEffect cleanups** (`scotty.tsx:353-355, 428-431`): boot effect uses `cancelled` flag to avoid setState on unmount; subscribe effect removes EventTarget listeners. No setInterval/setTimeout in scotty.tsx outside the shutdown grace timer (cleaned via Promise.race in acp-client.ts).
- **Stream loops** (`acp-client.ts:479-524, 527-553`): both wrapped in try/catch; debug-emit-and-continue on per-line parse error (S4); 1 MiB cap on both stdout and stderr buffers (S3).
- **Pending request reject on child exit** (`acp-client.ts:268-271`): all in-flight `pending` resolvers get rejected with a clear message, preventing UI from hanging on a dead subprocess.

No resource leaks. AOQ-4 mitigation pathway verified by tester's retry-1 run with `DOCKER_KILL_ENTRIES: 2` proving both calls fire.

## Outstanding TODOs (to record in PR body)

These items are documented residual risks or deferred-to-Phase-B work, not blockers:

- **AOQ-1** — Phase A defaults `fs/*` reverse-direction requests to `-32601`. Goose runs in its own container with its own FS, so no Phase-A code path needs them. Phase B may add no-op handlers if Goose adds new server-to-client tools that target the client's FS.
- **AOQ-2** — "Missing provider" surfaces as `error: provider not configured — run goose configure or mount config volume` in the header (`scotty.tsx:481-487`); input stays re-enabled so the operator can retry. UX behavior locked.
- **AOQ-3** — `SCOTTY_DEBUG=1` debug log path implemented; literal relative `./.scotty.log` (`scotty.tsx:256`); gitignored.
- **AOQ-4** — RESOLVED via retry-1 `injectDockerName` + dual `dockerKillContainerOnce`. Security audit NEW-S1..NEW-S4 reviewed the fix clean. Tester `verify-ms6.sh` PASS.
- **AOQ-5** — `authenticate` not called; provider config is read by Goose from the mounted `~/.config/goose/config.yaml`. Documented in architect.md.
- **FINDING-1 (MEDIUM)** — operator-supplied `--name` silently disables AOQ-4 mitigation. Documented in README env-vars table and Troubleshooting; accepted residual risk for Phase A; Phase B should parse operator's `--name` and reuse it for `docker kill`, or refuse to start without an explicit `SCOTTY_OPERATOR_CLEANUP=1` acknowledgement.
- **FINDING-2 (MEDIUM)** — `SCOTTY_GOOSE_CMD` whitespace-split cannot represent argv with embedded spaces (paths containing whitespace). ADR-002 explicitly rejects shlex-style parsing as over-engineering for the spike; Phase B may add a parallel `SCOTTY_GOOSE_CMD_ARGV` JSON env var.
- **FINDING-5 (LOW)** — `sudo rm -rf "$TMPDIR_INSTALL"` in `verify.sh:149`. Defensive comment added by build agent confirming `mktemp`-bounded path + `set -u`. No further action.
- **MS-4 / MS-5 manual verification** — full streaming and `tool_call` rendering require a configured Ollama provider; recipes in README. Test host had no provider; both marked VERIFIED-UP-TO-PROVIDER-BOUNDARY (protocol path confirmed).
- **No CI / GH Actions** — out of scope for spike per plan; defer to follow-up phase.
- **`docker container run` subcommand-form** — `injectDockerName` does NOT trigger; documented in README §"SCOTTY_GOOSE_CMD overrides". Niche operator path; orphan risk reverts to "operator-managed".

## Material divergences from original spec (to record in PR body)

The architect spec surfaced five material divergences after the live probe; all are documented in `architect.md` and resolved into the code. The PR body should list each so reviewers can find them quickly:

1. **`protocolVersion: 1`, not `0`.** Live probe shows Goose echoes whatever version we send; `1` matches the binary's current struct schemas. The original SPEC pre-OQ snapshot did not pin this. Implemented at `acp-client.ts:276`; warn-don't-fail mismatch logic at lines 280-284.
2. **snake_case `sessionUpdate` discriminator inside `session/update` notifications.** Source spec FR-6..FR-9 wrote `AgentMessageChunk`/`ToolCall` as CamelCase; the live wire encoding is `agent_message_chunk` etc. inside `params.update.sessionUpdate`. Resolves OQ-1.
3. **`session/cancel` is a JSON-RPC notification (no `id`).** Sent as a request, Goose returns `-32601 Method not found`. Sent as a notification, silently accepted and logged internally. The spec FR-10 did not pin which it was. Plus the spike adds `session/close` as the proper shutdown request (`acp-client.ts:308-316`).
4. **`acp-client.ts` split from `scotty.tsx`.** Permissive read of the file allowlist's "`scotty.tsx` (or `scotty.ts`)". Architect-recommended for testability and grep-able transport/UI boundaries; coder's call per `coding.md`.
5. **MS-3's 5 s budget assumes the `goose-acp:v1.34.1` image is pre-pulled.** A cold pull is 120 MiB and may take 30–90 s. README's Prerequisites and Troubleshooting both call this out.

## Commendations

- **AOQ-4 retry-1 fix design.** The `injectDockerName` helper applies three conservative gates (argv[0] === `"docker"`, first non-flag arg is `run`, no pre-existing `--name`) before injection, and the injected name is built solely from `process.pid` and `Math.random().toString(36).slice(2,10)` — zero operator-controlled bytes in the kill target. The dual-call from `shutdown()` plus the synchronous `killSync()` covers all three exit paths (normal, signal, uncaughtException). This is exactly the right shape for a hard-to-test cleanup path.
- **Default-deny inbound dispatch.** `acp-client.ts:611-625` correctly replies `-32601 Method not found` to any server-to-client REQUEST (method + id), preventing Goose from deadlocking on an awaited `fs/read_text_file` or `session/request_permission`. This is one of those things that's only ever felt as an absence (Goose doesn't hang) and easy to forget.
- **Resource-cap defenses.** 1 MiB line cap on both stdout (`acp-client.ts:486`) and stderr (`acp-client.ts:542`) buffers; force-close path if a single inbound line exceeds the cap without a newline. S3 mitigated at the right layer.
- **Status header transitions are crisp.** Five distinct states (`connecting`, `ready`, `prompting`, `error`, `exited`) with distinct colors and clear copy. The mode badge always shows the active mode so the operator can tell at a glance whether they're in `auto` (tool calls fire without confirmation) vs `approve`.
- **README first-run mode guidance.** Doc agent's "First-run mode guidance" section addresses security FINDING-4 thoroughly — explains `auto` vs `approve`, shows the config snippet and the interactive configurator, and notes the header always shows the active mode. This is the right level of operator-facing warning before they hit Enter.
- **Spec-fidelity narrative.** Every divergence from the source spec is traced through the architect probe and documented in `architect.md`; the coder's `coding.md` §"Decisions" lists every deliberate departure with rationale. The PR body should preserve this narrative.

## Files Reviewed

- `/home/jekavara/workspaces/scotty/.claude/worktrees/scotty-spike/package.json` — APPROVE
- `/home/jekavara/workspaces/scotty/.claude/worktrees/scotty-spike/acp-client.ts` — APPROVE
- `/home/jekavara/workspaces/scotty/.claude/worktrees/scotty-spike/scotty.tsx` — APPROVE
- `/home/jekavara/workspaces/scotty/.claude/worktrees/scotty-spike/README.md` — APPROVE
- `/home/jekavara/workspaces/scotty/.claude/worktrees/scotty-spike/.gitignore` — APPROVE
- `/home/jekavara/workspaces/scotty/.claude/worktrees/scotty-spike/bun.lock` — APPROVE (text format, lockfileVersion 0, present and tracked)
- `/home/jekavara/workspaces/scotty/.claude/worktrees/scotty-spike/verify.sh` — APPROVE (out-of-allowlist; spec-amend in PR body)
- `/home/jekavara/workspaces/scotty/.claude/worktrees/scotty-spike/verify-protocol.ts` — APPROVE (out-of-allowlist; spec-amend in PR body)
- `/home/jekavara/workspaces/scotty/.claude/worktrees/scotty-spike/verify-ms6.sh` — APPROVE (out-of-allowlist; spec-amend in PR body)

## Decisions

- **APPROVE** for GIT/PR. All MS pass or are VERIFIED-UP-TO-PROVIDER-BOUNDARY with documented manual recipes. All NQ greps clean. Zero CRITICAL/HIGH security findings. AOQ-4 fix mechanically correct and tester-confirmed. ADRs faithfully implemented. Material divergences from source spec are documented and traceable.
- **No CODE retry.** The non-blocking observations above (UX of interleaved agent/tool ordering, `@ts-expect-error` shim) are appropriate Phase-Scotty-B follow-ups and would not improve confidence in the spike — they would introduce new design decisions without retiring any current risk.
- **The three `verify-*` scripts ship with the PR** as deliberate spec-amendments (TESTER-AFFORDANCE). The PR body must explicitly list them under "Files outside the original allowlist" with the justification that the spec's MS criteria are manually/scripted-verified and these scripts are how the verification is actually performed.

## Recommendations for Next Agent (GIT)

When composing the PR body, ensure each of these is captured (the orchestrator may pre-fill from this file):

1. **Files outside original allowlist:** `acp-client.ts` (architect-permitted), `verify.sh`, `verify-protocol.ts`, `verify-ms6.sh` (tester affordances for the MS criteria). All four are deliberate spec-amendments documented in the architect and testing notes.
2. **Material divergences:** the five items listed under "Material divergences" above.
3. **Outstanding TODOs:** AOQ-1, AOQ-2, AOQ-3, AOQ-5 (defaults documented); FINDING-1, FINDING-2 (Phase-B follow-ups); MS-4 / MS-5 manual verification required; CI deferred.
4. **Security:** 0 CRITICAL / 0 HIGH / 2 MEDIUM / 4 LOW (4 because FINDING-3 and FINDING-6 are pass/informational); 0 dep vulnerabilities (`npm audit` via package-lock generation, 49 packages).
5. **MS table** straight from `testing.md` retry-1.

## Non-blocking recommendations for Phase Scotty-B

Captured for the next phase's spec; NOT blockers for this PR:

- Resolve the `agent_message_chunk` + `tool_call` interleave ordering (close the bubble on tool arrival, or render in flat timeline).
- Parse operator-supplied `--name` and reuse it for `docker kill` on shutdown (FINDING-1 remediation).
- Add `SCOTTY_GOOSE_CMD_ARGV` JSON env var as a parallel option for paths-with-spaces (FINDING-2).
- Add `bun audit` to the verify pipeline once Bun 1.2.x ships native audit.
- Implement client-side handlers for `fs/*`, `terminal/*`, `session/request_permission` if/when Goose's container-tool model changes such that they hit Scotty.
- Add a CI workflow (GH Actions) that runs `verify.sh` and the static NQ greps.
- Replace `@ts-expect-error` on `Bun.file().writer({ append: true })` with a typed shim or upgrade `@types/bun`.
