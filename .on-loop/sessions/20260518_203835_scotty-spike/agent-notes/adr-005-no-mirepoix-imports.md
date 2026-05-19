# ADR-005: No `@mirepoix/*` imports in Phase A

**Status:** Accepted.
**Date:** 2026-05-18
**Phase:** Scotty-A spike. (Gate for future monorepo-fold decision.)

## Context

Mirepoix is the parent monorepo (`UlyssesModel/kavara-mirepoix-internal`) that owns `@mirepoix/cli`, `@mirepoix/agents`, `@mirepoix/types`, and related packages. Scotty's eventual home — in-monorepo as `@mirepoix/scotty` (or similar), or stand-alone as `UlyssesModel/scotty` — is an architectural question that Mirepoix leadership has scoped to a future phase. Phase A is explicitly experimental: prove the ACP protocol integration works against Goose, then decide where Scotty lives based on the spike's outcome.

The source spec (`specs/scotty-spike-spec.md` NQ-5) is unambiguous:

> Spike must NOT import from any `@mirepoix/*` package in this Phase. Spike is an experimental ACP client living in a separate repo (`UlyssesModel/scotty`); folding into the Mirepoix monorepo is a later decision.

This ADR restates that constraint and documents the gate for the future fold decision.

## Decision

**Phase A (this spike) ships zero `@mirepoix/*` imports.** Scotty is fully self-contained in `UlyssesModel/scotty`. Its `package.json` lists no `@mirepoix/*` dependencies. No source file may have `import … from "@mirepoix/anything"`.

**Enforcement (reviewer agent):**

```bash
! grep -rE 'from\s+["'\'']@mirepoix/' scotty.tsx acp-client.ts 2>/dev/null
```

The grep must return no matches. If it does, the PR is blocked.

**Gate for the future fold decision (post-spike):**

A later phase (Scotty-B, -C, or -D, depending on Mirepoix planning) will decide whether to:

1. **Stay stand-alone.** Continue developing Scotty as `UlyssesModel/scotty`, with its own release cadence, depending only on public npm packages. Mirepoix code consumes Scotty via npm install (or git submodule).
2. **Fold into the Mirepoix monorepo.** Move Scotty's source under `kavara-mirepoix-internal/packages/scotty/`, publish as `@mirepoix/scotty`, and start using `@mirepoix/types` (for shared ACP types), `@mirepoix/cli` (for shared command parsing), etc.

The criteria for that decision (informational; this ADR doesn't decide them):

- Does Scotty's TUI need to share state or types with `@mirepoix/cli` (the non-interactive task-style invocation)? If yes → fold.
- Does Mirepoix's CI/CD make it easier to release a monorepo package or a stand-alone repo? Depends on tooling.
- Does the spike outcome warrant productionising? If the spike reveals fundamental ACP integration problems → maybe Scotty stays a research artifact.
- Does Mirepoix's deny-all-egress story (ADR-010 of the parent monorepo) demand tight coupling between Scotty's container-runner logic and Mirepoix's sandboxing primitives? If yes → fold.

The decision is **not** this ADR's; this ADR only documents the gate.

## Alternatives considered

### Allow `@mirepoix/types` imports for shared ACP types

- **Pros:** Avoids duplicating the `SessionUpdate` / `PromptParams` / `InitializeResult` type definitions if `@mirepoix/types` ever adds them.
- **Cons:** Violates NQ-5; `@mirepoix/types` doesn't currently export ACP types (those are net-new for Scotty); creates a circular planning dependency where we'd need to ship `@mirepoix/types` updates before Scotty.
- **Decision driver:** NQ-5 explicit prohibition. Phase A duplicates the types in `acp-client.ts` and accepts that.

### Allow `@mirepoix/cli` integration as a "task-style" backup mode

- **Pros:** Lets Scotty fall back to non-interactive Goose usage if the TUI is unavailable (e.g., not a TTY).
- **Cons:** Violates NQ-5; out of spike scope; the spike's MS-2..MS-6 all assume TTY operation.
- **Decision driver:** NQ-5; spike scope.

### Pre-commit to fold (move to monorepo immediately)

- **Pros:** Avoids the migration cost later.
- **Cons:** The whole point of the spike is to learn whether ACP integration is even tractable. Pre-committing assumes the spike succeeds. Mirepoix architecture has explicitly scoped this as a "later decision".
- **Decision driver:** Mirepoix architectural intent.

## Consequences

**Positive:**

- Scotty's source has zero coupling to Mirepoix's release cadence and zero exposure to monorepo build complexity.
- The spike can ship independently and quickly.
- The fold decision is deferred to when there's actual data (spike outcome, integration needs).
- Reviewer agent can enforce NQ-5 with a single grep.

**Negative / trade-offs:**

- ACP type definitions duplicate in `scotty/acp-client.ts` what may eventually live in `@mirepoix/types`. If Phase A succeeds, the fold will involve a one-time deduplication. Cost: small (the types are ~80 lines).
- Scotty's deny-all-egress posture is enforced per-process (NQ-3 grep) rather than via a shared `@mirepoix/sandbox` runtime. Acceptable for the spike's threat model.
- Operators running both `@mirepoix/cli` and Scotty have two separate npm installs. Acceptable for the spike's audience (internal Kavara folks doing PyTorch → Rust translations).

**Reversibility:** High. The fold-decision phase has explicit migration steps: move source under `packages/scotty/`, change `package.json` name, update import paths. The grep-enforced NQ-5 is the only ratchet; relaxing it later is a single ADR.

## References

- `specs/scotty-spike-spec.md` — NQ-5.
- `mirepoix-business-model.md v1.3` — Mirepoix-Co-as-ACP-server play.
- CLAUDE.md (commit 1a83a67 of `kavara-mirepoix-internal`) — spec-resolution convention defers production architecture decisions until on-loop produces an outcome PR.
- ADR-010 of `kavara-mirepoix-internal` — deny-all-egress; the longer-term Mirepoix sandbox story.
