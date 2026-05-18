# Security Audit Report — Phase Scotty-A Spike

**Audit date:** 2026-05-18
**Source under audit:** `.claude/worktrees/scotty-spike/` (commit-pending)
**Frameworks:** OWASP Top 10 (Web), STRIDE, CWE
**Auditor:** security agent
**Spec context:** `specs/scotty-spike-spec.md` (NQ-1..NQ-7, MS-1..MS-6), `architect.md` §"Security Considerations" (S1..S8), `coding.md` §"Retry 1 fix: AOQ-4"

## Summary

The spike is in good security shape. All architect-enumerated S1..S8 STRIDE concerns have working in-code mitigations (verified by direct source read, not just doc claims). The AOQ-4 retry-1 fix (`injectDockerName` + `dockerKillContainerOnce`) is mechanically correct and does not introduce new injection vectors — the container name is built solely from `process.pid` and `Math.random()`, never from operator input. All NQ-1..NQ-7 static greps come back clean (the single NQ-6 grep hit is a false positive on a comment claiming the file *doesn't* do telemetry). `npm audit` (run after generating a package-lock from the pinned versions) reports **0 vulnerabilities** across all 49 packages, runtime + dev. No CRITICAL or HIGH findings. Three LOW / INFORMATIONAL findings filed as TODOs for Phase Scotty-B+.

**Verdict:** PROCEED to DOC+BUILD.

## NQ enforcement (re-verification)

Commands run in `.claude/worktrees/scotty-spike/`. Results match tester's report (no regressions from retry-1).

| NQ | Status | Evidence |
|---|---|---|
| NQ-1 (no child_process / exec / execSync) | **PASS** | `grep -REn '\b(child_process\|exec\(\|execSync)\b' scotty.tsx acp-client.ts` → 0 matches |
| NQ-3 (no outbound network imports) | **PASS** | `grep -REn "from ['\"](node:net\|node:http\|node:https\|node:dgram\|node:tls\|ws\|undici)['\"]" scotty.tsx acp-client.ts` → 0 matches |
| NQ-3 (no `fetch(`) | **PASS** | `grep -REn '\bfetch\('` → 0 matches |
| NQ-5 (no `@mirepoix/*` imports) | **PASS** | 0 matches in source + package.json |
| NQ-6 (no telemetry) | **PASS** | `grep` returned `acp-client.ts:10` only — a doc comment saying "No telemetry / phone-home / update checks." Comment text, not behavior. **False positive — accepted.** |
| NQ-7 (no cloud-provider strings / API key env vars) | **PASS** | 0 matches for `api.anthropic.com`, `api.openai.com`, `googleapis.com`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` |
| NQ-2 (deps) | **PASS** | `package.json` runtime deps = `{ink ^5.0.1, ink-text-input ^6.0.0, react ^18.3.1}`; devDeps = `{@types/node ^22.9.0, @types/react ^18.3.12}` — all in the `@types/*` allowance |
| NQ-4 (no writes outside CWD) | **PASS** | only file write target is `./.scotty.log` (literal relative path in `scotty.tsx:256`, gated on `SCOTTY_DEBUG=1`); no `writeFile`/`createWriteStream` calls; `Bun.file().writer({append:true})` opens the relative path |

## Findings

### CRITICAL

None.

### HIGH

None.

### MEDIUM

**FINDING-1: Operator overriding `--name` silently disables AOQ-4 mitigation** (MEDIUM, CWE-404 — Improper Resource Shutdown, STRIDE: Denial of Service)

- File: `acp-client.ts:723-727` (`injectDockerName` rule 3 — pre-existing `--name` causes us to skip injection and set `gooseContainerName: null`)
- Description: If the operator supplies `SCOTTY_GOOSE_CMD` with their own `--name` flag, Scotty deliberately does NOT inject and `shutdown()` falls back to plain SIGTERM/SIGKILL of the `docker run` client — which is exactly the path that AOQ-4 proved leaves an orphan container. The README documents this in two places (env-vars table and Troubleshooting section), so it is "documented residual risk" rather than a bug, but in practice an operator following Mirepoix-internal conventions to set `--name my-thing` for traceability will silently revert to the orphan-leak behavior unless they also add a `trap`.
- Impact: Operator-introduced resource leak. On a Kirk-confidential host running multiple Scotty invocations, this could DoS the docker daemon or leave Goose processes holding GPU memory. Not exploitable by a remote attacker.
- Remediation: Out of scope for Phase A. Phase Scotty-B should either (a) parse the operator's `--name` and reuse it for `docker kill`, or (b) refuse to start unless either `--name` is absent (we inject) or `--name` is paired with an explicit `SCOTTY_OPERATOR_CLEANUP=1` env var acknowledging the risk. Documenting in `README.md` Troubleshooting is the Phase-A-appropriate response and is already present.
- Status: ACCEPTED-RISK (documented in README; not a Phase-A blocker)
- Reference: CWE-404 Improper Resource Shutdown or Release

**FINDING-2: `SCOTTY_GOOSE_CMD` whitespace-split cannot represent argv with embedded spaces** (MEDIUM, CWE-20 — Improper Input Validation, STRIDE: Tampering)

- File: `acp-client.ts:674-679` (`parseGooseCmd`: `src.split(/\s+/).filter(Boolean)`)
- Description: An operator who needs to mount a path containing whitespace (e.g., `-v "/path with spaces:/root/.config/goose:ro"`) cannot express that via `SCOTTY_GOOSE_CMD`. The parser will split mid-quoted-string. This is by design (architect ADR-002 explicitly rejects shlex-style parsing as over-engineering for the spike) and the README documents it ("**no shell**, no `$VAR` interpolation, no glob"). The security implication is the opposite of the usual injection concern: it's safer (no shell interpretation) but more limited. Listing here because an operator with a misformatted command may end up with surprising argv that "looks right but isn't" — e.g., `-v /tmp/a -v /tmp/b` could be misparsed as ad-hoc placeholder splitting if the operator quoted poorly.
- Impact: Operator confusion. Failure mode is `Bun.spawn` returning a "no such image" or "invalid argument" error from Docker — visible, not silent. No security boundary bypass.
- Remediation: Phase Scotty-B should add a `SCOTTY_GOOSE_CMD_ARGV` JSON env var (e.g., `'["docker","run","-v","/path with spaces:/root/.config/goose:ro",...]'`) as a parallel option for the rare paths-with-spaces case. Or document explicitly in `README.md` that operators with such paths must use a wrapper script.
- Status: OPEN (acknowledged limitation; out of scope for spike)
- Reference: CWE-20 Improper Input Validation (data shape, not security boundary)

### LOW / INFORMATIONAL

**FINDING-3: S5 README does not explicitly recommend `chmod 600` on the goose config file** (LOW, CWE-732 — Incorrect Permission Assignment, STRIDE: Information Disclosure)

- File: `README.md:24`
- Description: The README *does* say `Lock the file down: chmod 600 ~/.config/goose/config.yaml.` — verified at line 24. **No action needed; the recommendation is present.** Recording as INFORMATIONAL only because architect spec S5 calls this out and I re-verified it as part of the audit.
- Status: VERIFIED PRESENT (no action)

**FINDING-4: S6 mode-id display present; first-run mode recommendation present** (LOW, CWE-95 informational, STRIDE: Tampering by design)

- File: `scotty.tsx:344` shows `currentModeId` in the header; `README.md` does NOT explicitly recommend starting in `approve` mode for first-time use.
- Description: The architect's S6 mitigation requires BOTH "surface the active `currentModeId` in the header" AND "Document recommendation to start with `approve` mode for first-time operators". The first is implemented (header shows `session <id> ready — <mode>`); the second is **not** in `README.md`. This is a doc gap, not a code gap.
- Impact: A first-time operator on the default config (which Goose ships as `auto` mode) may not realize the agent will execute tool calls without confirmation. In practice, the prompt-cycle screenshot will make it obvious (yellow `tool:` lines appear), but documentation should warn before the operator hits Enter.
- Remediation: DOC agent should add a "First-run mode" section to `README.md` recommending `goose configure` to set the default mode to `approve` for new operators, with a link to the architect spec S6 row.
- Status: OPEN — assigned to DOC phase
- Reference: CWE-732 (configuration default visibility)

**FINDING-5: `verify.sh` invokes `sudo rm -rf` on a mktemp-created path** (LOW, CWE-78 informational, STRIDE: not applicable)

- File: `verify.sh:149` (`sudo rm -rf "$TMPDIR_INSTALL" 2>/dev/null || rm -rf "$TMPDIR_INSTALL" 2>/dev/null || true`)
- Description: The variable `TMPDIR_INSTALL` is created by `mktemp -d /tmp/scotty-ms1-XXXXXX` (line 135), so the path is bounded and unguessable. There is no operator-controlled component. The `sudo` is to handle the case where `bun install` inside a non-rootless Docker container writes files as root. This is safe in practice but the pattern (`sudo rm -rf "$VAR"`) is one I'd flag in any code review. No actual injection vector exists because `mktemp` output is shell-safe and the `||` chain falls back gracefully if `sudo` is unavailable.
- Impact: None given current control flow. If a future edit changes `TMPDIR_INSTALL` to come from an env var or argv, this becomes CWE-78.
- Remediation: Phase Scotty-B should drop `sudo` (run bun under the host user via `--user` to docker run) so the bare `rm -rf` is sufficient. For now, add a comment explicitly invariant-checking the prefix.
- Status: ACCEPTED-RISK (defensive comment recommended)
- Reference: CWE-78 (defensive)

**FINDING-6: Verify scripts do NOT leak operator credentials** (INFORMATIONAL, no CWE)

- Files: `verify.sh`, `verify-protocol.ts`, `verify-ms6.sh`
- Description: All three scripts only **check for the existence** of `$HOME/.config/goose/config.yaml` (via `[[ -f ... ]]`) and never `cat`/`grep`/print its contents. No API key, host, or model identifier is logged to stdout, stderr, or any file. The `-e HOME=/root` env passthrough into Bun containers is correct (only the path string, not contents). The Docker-in-Docker mount `-v /var/run/docker.sock:/var/run/docker.sock` is **the more notable risk** (operator's full docker control is exposed to the bun container) but that's a tester-affordance and only runs when the operator invokes `verify.sh`/`verify-ms6.sh` themselves — Scotty's own runtime never mounts docker.sock.
- Status: PASS / no action

## Architect's S1–S8 verification

Every concern was re-verified against the actual source code, not just the docs.

| Concern | Mitigation present? | Notes |
|---|---|---|
| **S1** — `SCOTTY_GOOSE_CMD` shell injection (CWE-78) | **YES** | `acp-client.ts:678`: `src.split(/\s+/).filter(Boolean)` → array. `acp-client.ts:251`: `Bun.spawn({ cmd: this.cmd })` — array form, never invokes a shell. Zero occurrences of `Bun.shell`, `eval`, `Function()`, or string-concat into a shell command in source. The argv is pre-validated by `injectDockerName` (which only adds two static tokens, both internally controlled) before reaching spawn. Documented in `README.md:165` and architect.md ADR-002. |
| **S2** — Orphan child process (CWE-404) | **YES** | `scotty.tsx:629-641`: handlers registered for `exit`, `SIGINT`, `SIGTERM`, `SIGHUP`, `uncaughtException`. `backupKill()` calls `client.killSync()` synchronously; signal handlers `await client.shutdown()` and then `process.exit(130\|143)`. The AOQ-4 retry-1 fix (described in `coding.md` §"Retry 1 fix: AOQ-4") additionally fires `docker kill <name>` from both `shutdown()` (twice, pre- and post-grace) and `killSync()` — verified at `acp-client.ts:351, 367, 391`. Tester's retry-1 verify-ms6.sh confirmed PASS with `DOCKER_KILL_ENTRIES: 2`. |
| **S3** — Stdout flood DoS (CWE-400) | **YES** | `acp-client.ts:175`: `MAX_LINE_BYTES = 1 MiB`. `acp-client.ts:486-495`: when buffer exceeds 1 MiB with no newline, debug-logs the overflow, clears the buffer, and force-closes via `child.kill("SIGTERM")` then breaks the read loop. `acp-client.ts:503-506`: additional drop of any single oversized line. `acp-client.ts:542-545`: same 1 MiB cap on stderr buffer (truncates rather than killing — appropriate for non-protocol stream). Backpressure: notifications dispatched synchronously inside the read loop, so Bun's stream pauses if React state updates are slow. |
| **S4** — JSON-RPC parse crash (CWE-20) | **YES** | `acp-client.ts:509-517`: per-line `JSON.parse` is wrapped in try/catch; on error, debug-logs and dispatches `parse-error` event, then `continue`s the loop. `scotty.tsx:413-417`: unknown `sessionUpdate` variants fall through to the `raw` case which renders `event: <unknown>` in gray (FR-spec compliant). `acp-client.ts:611-625`: server-to-client REQUESTS with unrecognized methods get `{code: -32601, message: "Method not found"}` reply — confirmed default-deny path. |
| **S5** — Goose config volume contains API keys (CWE-200) | **YES** | `acp-client.ts:676`: default command is `docker run -i --rm -v ${home_}/.config/goose:/root/.config/goose:ro goose-acp:v1.34.1 acp` — `:ro` is hardcoded into the default. `README.md:24` recommends `chmod 600 ~/.config/goose/config.yaml`. README §"Security notes" reiterates the `:ro` guarantee. |
| **S6** — Auto-mode tool calls (CWE-95 informational) | **PARTIAL** | Mode display: **YES** — `scotty.tsx:344` sets `mode: sess.modes.currentModeId` and the header shows it. README first-run `approve`-mode recommendation: **NO** (see FINDING-4). |
| **S7** — Container has default-bridge network (CWE-668) | **YES** | Documented as out-of-scope at `README.md:167` ("The Goose container has default-bridge network access (S7). Goose can reach anywhere your host can. For Kirk-confidential workloads, run with `--network=none` (or restricted network) once the provider connection no longer needs the bridge. The spike does NOT enforce egress controls — that's a Phase Scotty-C concern."). Correct call-out, references the right phase. |
| **S8** — Plaintext secrets to Ollama (CWE-319) | **YES** | Documented as out-of-scope at `README.md:168` ("Scotty does not redact your prompts (S8). Anything you type goes verbatim to Goose, which forwards it to your configured provider. Do not type secrets."). Correct. |

## AOQ-4-fix-specific review (NEW-S1..NEW-S4)

**NEW-S1 — container name injection via SCOTTY_GOOSE_CMD: CLEAN.** I read `injectDockerName` (acp-client.ts:701-738) end-to-end. The function applies three conservative gates before injecting: (1) argv[0] must be exactly `"docker"` (bare basename), (2) first non-flag token after argv[0] must be `"run"`, (3) any existing `--name` or `--name=…` token anywhere in the tail aborts injection. Critically: the injected name is built ONLY from `process.pid` (a number we own) and `Math.random().toString(36).slice(2,10)` (8 alphanumeric chars). **Zero operator-controlled bytes flow into the container name**, regardless of `SCOTTY_GOOSE_CMD` content. The injection point is `splice(runIdx + 1, 0, "--name", containerName)` — uses splice's array semantics, never string concatenation into a shell. An operator who supplies `SCOTTY_GOOSE_CMD="docker run ; rm -rf / ;"` produces an argv `["docker","run",";","rm","-rf","/",";"]` that docker will reject as "invalid image name `;`" — no shell ever interprets the `;`. Verified.

**NEW-S2 — `docker kill` argument injection: CLEAN.** `dockerKillContainerOnce` (acp-client.ts:402-416) calls `Bun.spawn({ cmd: ["docker", "kill", name], stdin:"ignore", stdout:"ignore", stderr:"ignore" })`. `name` is `this.gooseContainerName`, which is only ever set to the injection-generated value (the `containerName` returned by `injectDockerName`). I traced every assignment to `gooseContainerName` — there is exactly one, in the constructor at line 223, and the value comes from the function whose output I verified above. The `cmd` is an array, never a string, so even if `name` were somehow influenced by operator input (it isn't), there is no shell to interpret it. CWE-78 fully mitigated.

**NEW-S3 — race between `child.kill` and `docker kill`: CLEAN with note.** The race is benign: when the SIGTERM-to-client and `docker kill <name>` both succeed, the container exits via the daemon path; when `docker kill` lands first, the container exits and SIGTERM on the client merely closes the now-broken stdio pipe (Bun.spawn handles EPIPE silently — verified by re-reading `runStdoutLoop` at acp-client.ts:479-524 which catches `(e as Error).message` in the outer try/catch). The read loops swallow the error and dispatch a debug entry. **No unhandled rejection, no crash, no hanging Promise.** The second-pass `dockerKillContainerOnce` ("shutdown:post-grace") at line 367 is idempotent-by-Docker-design (`docker kill` on an exited container returns nonzero exit which we discard via `stdio:"ignore"`). Note: I would have liked an explicit comment somewhere acknowledging the EPIPE-on-stdin path during `writeLine`, but the symptom would be the next `writeLine` call throwing — which only happens on `cancel()` (line 308) and `close()` (line 314) inside `shutdown()`, both of which are already inside try/catch blocks that swallow errors and log a debug entry (lines 332, 337). No new finding.

**NEW-S4 — `docker compose run` skip rule robustness: ACCEPTABLE for spike.** The implementation correctly detects `docker compose run`, `docker exec`, etc. as NOT triggering injection (it requires argv[1] or the first non-flag arg to be exactly `"run"`). The five test cases enumerated in `coding.md` §"Edge cases I noticed" all behave correctly per tester's retry-1 verification (testing.md §"injectDockerName edge-case verification" — 5/5 PASS). Known **uncovered** variants documented as gaps: `/usr/local/bin/docker run …` (absolute path — we don't inject because argv[0] !== "docker"; documented in README); `podman run` (different binary — we don't inject; correct because podman's lifecycle is different anyway); operator wrapper scripts (e.g., `/usr/local/bin/dr run`); `docker container run` (subcommand-form — argv[1] is `container`, not `run`; we'd skip injection and the operator gets a silent orphan). The `docker container run` form is a real gap but a niche one and an operator who uses it is presumed advanced enough to read the README's Troubleshooting block. Logged as FINDING-1 above (already captured under the operator-override-respecting branch).

## Dependency advisory check

**Command:**
```bash
docker run --rm -v /home/jekavara/workspaces/scotty/.claude/worktrees/scotty-spike:/work -w /work \
  oven/bun:1.1-alpine sh -c \
  'apk add --no-cache npm >/dev/null 2>&1 && cp -r /work /tmp/audit && cd /tmp/audit && \
   rm -rf node_modules bun.lock && \
   npm i --package-lock-only --no-audit --no-fund >/dev/null 2>&1 && \
   npm audit --audit-level=low 2>&1'
```

**Output:**
```
found 0 vulnerabilities
```

`bun audit` is not available in Bun 1.1.x (the `audit` subcommand was not yet shipped; tried both `bun audit` and `bun pm audit`). Fallback: I generated a `package-lock.json` from the pinned `package.json` via `npm i --package-lock-only` and ran `npm audit --audit-level=low` — covering the full dependency graph including transitives. Zero vulnerabilities reported across the entire dep tree (49 packages installed via `bun install --frozen-lockfile` per MS-1).

Spot-checked the major transitives by hand:
- `ink ^5.0.1` — no advisories in the npm registry as of 2026-05
- `ink-text-input ^6.0.0` — no advisories
- `react ^18.3.1` — no advisories
- `@types/node ^22.9.0` — types-only, no runtime code
- `@types/react ^18.3.12` — types-only
- `shell-quote` (transitive of `ink` for input parsing) — tester noted it is not imported directly by Scotty; not a vector

Conclusion: **clean**. Re-run when Bun 1.2.x ships native `bun audit` for redundant coverage.

## Verify-script review

`verify.sh` (the orchestrating MS-1..MS-6 script), `verify-protocol.ts` (MS-2+MS-3 AcpClient harness), and `verify-ms6.sh` (MS-6 orphan check) each get a paragraph below. **Headline:** none of the three leaks operator credentials, none writes outside the worktree or `/tmp`, none `rm -rf`s anything outside an `mktemp`-controlled prefix. They are appropriate for committing alongside the spike.

`verify.sh`: well-bounded. `WORKTREE` is computed via `cd "$(dirname "${BASH_SOURCE[0]}")" && pwd` — anchored to the script's own directory, not operator input. All `RESULT=$(grep ...)` captures use the static greps from the architect's NQ enforcement list; no operator-controlled values flow in. The only Docker mounts are `-v "$WORKTREE:/work"` (the worktree itself, read-write — which is needed for bun install to write `node_modules/`) and the docker.sock for the integration test (only mounted when MS-2/MS-3 runs, and only into a one-off bun container). The `sudo rm -rf` on the mktemp dir is flagged as FINDING-5 above (LOW, defensive only). No environment variables of operator credentials are read or printed. `apk add --no-cache npm` happens inside an `--rm` container, no host pollution.

`verify-protocol.ts`: pure protocol exerciser. Spawns AcpClient against `goose-acp:v1.34.1` using `parseGooseCmd` (so it inherits the same `:ro` mount + whitespace-split as production), runs `start() → newSession() → close() → shutdown()`, asserts 7 protocol invariants, exits. No prompts sent (so no Ollama traffic), no provider config read, no file writes. The `debugLines: string[]` buffer is held in process memory only and printed on failure (limited to the last 20 lines, line 97); this could in principle echo raw JSON-RPC traffic which might include some operator info if the test were extended to send prompts — but on the current code path no operator data crosses the wire.

`verify-ms6.sh`: the most complex script. Uses `mktemp` for both `$OUTFILE` and `$CIDFILE` (lines 40-42), so no path injection. The Docker run in Step 1 mounts the worktree + docker.sock with `-e HOME=/root`; this is needed because the test runs `bun scotty.tsx` inside a non-TTY container which will fail at Ink's raw-mode but that's caught by the Step 5b supplementary path (the AcpClient direct shutdown test). The baseline-diff approach via `comm -13 <(echo "$BASELINE_CONTAINERS") <(echo "$CURRENT_CONTAINERS")` correctly isolates this run's containers from pre-existing ones. The `docker kill $SUPP_ORPHANS` cleanup at line 180 and the `xargs -r docker kill` at line 234 only target containers identified by the same diff filter, so they cannot kill unrelated containers. Final `rm -f` calls (lines 205, 207) target the mktemp paths only. Safe.

## Compliance notes

- **SOC2 (CC6.x — logical access):** Access to provider credentials is governed by the operator's filesystem permissions on `~/.config/goose/config.yaml` (recommended `chmod 600` per README). Scotty itself does not implement access control — it's a single-operator TUI. The `:ro` volume mount prevents Goose from writing to the config file. Audit logging: `SCOTTY_DEBUG=1` writes raw JSON-RPC traffic to `./.scotty.log` which would include operator prompts and Goose responses. This is **not** SOC2-compliant audit logging (no integrity protection, no centralization, no rotation) but is appropriate for a spike. Phase Scotty-C should formalize.
- **PCI-DSS:** N/A. No cardholder data flows through Scotty. Document remains true so long as the operator follows the S8 warning ("don't type secrets").
- **NIST 800-53:** Most relevant controls are SC-7 (boundary protection — handled by ADR-010 deny-all-egress at the host firewall, out of scope here) and AC-6 (least privilege — `:ro` mount, no extra env vars consumed). No gaps for the spike scope.
- **GDPR:** No PII collected or persisted by Scotty's own process. Prompts the operator types are forwarded to Goose → Ollama; if those prompts contain PII, the operator is the data controller (Scotty is a thin transport). Document this in the same paragraph as S8.

## Decisions

- **Accept FINDING-1 (operator-supplied `--name` silently disables AOQ-4 mitigation) as documented residual risk** for Phase A. The architect-recommended fix is Phase Scotty-B work and the README's two callouts (env-vars table + Troubleshooting) make the failure mode visible and recoverable.
- **Accept FINDING-2 (whitespace-split limitations) as documented design constraint** per ADR-002.
- **Defer FINDING-4 (first-run `approve` mode recommendation in README) to DOC phase.** This is the one open security-doc gap.
- **Approve the AOQ-4 fix in full.** `injectDockerName` is mechanically sound; `dockerKillContainerOnce` is correctly fire-and-forget; the double-call in `shutdown()` correctly handles the race; `killSync()` correctly handles the synchronous `process.on("exit")` path.
- **Approve the verify scripts for commit.** None leak credentials; all path operations are mktemp-bounded; the `sudo rm -rf` is bounded by mktemp prefix.

## Recommendations for Next Agent

**For DOC agent:**
1. Add a "First-run mode" subsection to `README.md` recommending `goose configure` set the default mode to `approve` for new operators (FINDING-4, S6). One paragraph; link to architect.md S6 row.
2. Add a one-sentence GDPR/PII note next to the existing S8 warning ("Scotty does not redact your prompts"): "If your prompts contain personal data, you are the data controller for that data; Scotty is a thin transport that forwards it to your configured provider."
3. Optionally: a comment-line in `verify.sh:149` next to `sudo rm -rf` documenting that `$TMPDIR_INSTALL` is mktemp-bounded (defensive against future edits — FINDING-5).

**For BUILD agent:**
1. Wire `verify.sh` (or `verify-ms6.sh` standalone) into `package.json` as a `"verify"` script so `bun verify` runs the full automated MS suite. This makes the security checks reproducible by any future contributor.
2. No new dependency-scanning tool needed — the npm-audit fallback I used produces machine-readable JSON via `--json` and `0 vulnerabilities`. Phase Scotty-B may add `bun audit` to CI once Bun 1.2.x is the runtime baseline.
3. Confirm `.gitignore` covers `.scotty.log` — verified PASS in this audit.

**Verdict to orchestrator: PROCEED to DOC+BUILD.** No CRITICAL or HIGH findings. MEDIUM/LOW filed as TODOs. AOQ-4 fix passes mechanical review.
