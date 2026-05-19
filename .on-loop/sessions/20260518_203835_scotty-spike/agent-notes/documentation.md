# Documentation Agent Notes

**Agent:** Documentation
**Session:** `20260518_203835_scotty-spike`
**Date:** 2026-05-18

## Summary

`README.md` in the worktree was expanded from 185 lines (coder seed) to 429 lines. All required sections are present. FINDING-4 (LOW) from the security audit is addressed. FINDING-5 (LOW) is out of scope for this agent (requires editing `verify.sh`, which is not in the README.md-only allowlist for this DOC pass).

## Sections added / modified

| Section | Status | Notes |
|---|---|---|
| Title + one-paragraph context | Modified | Expanded to reference `specs/scotty-spike-spec.md` explicitly; mention of architect.md |
| Prerequisites | Modified | Added `oven/bun:1.1-alpine` prereq; expanded Goose config example; added `chmod 600` note and link to Troubleshooting |
| Install | Modified | Added Docker-fallback `bun install` command for Rocky 9 hosts without native Bun |
| Run | Modified | Added Docker-fallback `docker run` invocation for `bun scotty.tsx`; noted required flags (`-it`, docker.sock mount, HOME env) |
| **First-run mode guidance (NEW)** | Added | Addresses FINDING-4 (S6): explains `auto` vs `approve`, shows how to set `mode: approve` in `config.yaml` and via `goose configure`, and states mode is read-only in this phase |
| Environment variables | Modified | Tightened prose; no new vars |
| **`SCOTTY_GOOSE_CMD` overrides (NEW)** | Added | Recipes for image-tag override and native-binary override; detailed `--name` caveat; trap workaround example; documents `docker container run` and absolute-path edge cases |
| Verification recipes (MS-1..MS-6) | Modified | Added `./verify.sh` and `./verify-ms6.sh` quick-run instructions; added Docker path for MS-1; added observed timing (356 ms); added MS-1..MS-6 results table from 2026-05-18 automated run; added provider-boundary note on MS-4/MS-5 |
| **Security notes** | Modified | Expanded S1 entry with the "invalid image name" exploit-attempt outcome to make the guarantee concrete; added **GDPR/data-handling note** (addresses security.md recommendation for S8 complement, FINDING-4 per-GDPR note); retained S5, S7, S8 |
| Troubleshooting | Modified | Added Ollama connectivity recipe (`curl` from inside container); added garbled Ink output entry; expanded orphan-container entry with `xargs` one-liner |
| **Architecture (NEW)** | Added | Mermaid diagram (copied from architect.md); prose summarizing trust boundaries; links to architect.md and ADRs |
| **Development (NEW)** | Added | Quick command reference for install, run, debug, verify |
| Out of scope | Modified | Appended Phase-A-specific deferred items from architect.md (network egress, fs/* handlers, mode switching) |

## How FINDING-4 (LOW) is addressed

FINDING-4 from `security.md` had two sub-requirements:

1. **First-run `approve` mode recommendation** — addressed by the new "First-run mode guidance" section. It explains `auto` mode's behavior (unconfirmed tool calls), recommends setting `mode: approve` before first use, shows the `config.yaml` snippet and the `goose configure` command, and notes that the header always shows the active mode.

2. **GDPR/PII note** — addressed in the "Security notes" section. Added a dedicated "GDPR / data-handling note" paragraph: states Scotty does not persist prompts, describes what `SCOTTY_DEBUG=1` logs, explains the data flow to Ollama, and frames the operator as data controller for any PII in prompts.

## How FINDING-5 (LOW) is NOT addressed here

FINDING-5 calls for adding a defensive invariant comment to `verify.sh:149` next to the `sudo rm -rf "$TMPDIR_INSTALL"` line, documenting that `$TMPDIR_INSTALL` is `mktemp`-bounded. This requires editing `verify.sh`, which is outside the README.md-only scope of this DOC task. The finding remains ACCEPTED-RISK as documented in `security.md`. The BUILD agent or a follow-up CODE pass should add the comment.

## Files modified

- `.claude/worktrees/scotty-spike/README.md` — expanded from 185 to 429 lines (see section table above)
- `.on-loop/sessions/20260518_203835_scotty-spike/changes.log` — appended one entry for this modification

## Issues / gaps noticed while documenting

- **`bun.lock` presence.** The changes.log records `bun install` was run by the orchestrator and `bun.lock` generated, but the coder's initial log entry marks it as SKIPPED. The file should be present in the worktree; if it is missing before the GIT phase, `bun install` must be re-run with `--save-text-lockfile`.
- **`acp-client.ts` allowlist status.** The spec's file allowlist names `scotty.tsx` (or `scotty.ts`) but not `acp-client.ts`. The architect noted this permissive reading. The README does not mention `acp-client.ts` as a browseable source file — this is intentional (the README is operator-facing, not developer-facing for this phase). If a CONTRIBUTING.md were permitted, that would be the right place; it is not in scope.
- **MS-4/MS-5 manual-only caveat.** The README now clearly marks these as requiring a live provider. If the operator does not have Ollama at `10.128.0.16:11434`, MS-4 and MS-5 cannot be demonstrated from the README alone. This is a known gap accepted by the spec.
- **`verify.sh` FINDING-5 comment.** As noted above, the `sudo rm -rf` defensive comment remains undone. LOW risk; deferred.

## Recommendations for next agent (REVIEWER / GIT)

- Verify `bun.lock` is present and committed in the worktree before the GIT phase.
- The README's Mermaid diagram uses `\n` inside node labels for line breaks — confirm the renderer in your Markdown viewer supports this (GitHub renders it correctly).
- The `--name` caveat in the overrides section references `docker container run` as a known un-injected variant; this is consistent with `security.md` NEW-S4 and does not require a code change.
- FINDING-5 (`verify.sh:149` comment) should be added by the next CODE-touching agent; it is a one-liner and will keep the `sudo rm -rf` pattern from becoming a footgun in future edits.
