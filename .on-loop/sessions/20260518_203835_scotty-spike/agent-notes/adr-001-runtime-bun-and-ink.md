# ADR-001: Runtime — Bun + Ink + TypeScript

**Status:** Accepted (architect phase, locks in spec NQ-1/NQ-2 and OQ-3/OQ-4).
**Date:** 2026-05-18
**Phase:** Scotty-A spike.

## Context

The Scotty Phase A spike must be an interactive TUI that drives the Goose ACP server as a JSON-RPC 2.0 subprocess. The spike's source `specs/scotty-spike-spec.md` mandates (NQ-1) "Bun-native subprocess primitive only — no `child_process`, no Node child process" and (NQ-2) "Minimal deps — `ink`, `ink-text-input`, `react` only". The architectural decision to build Scotty as a TypeScript + Bun + Ink ACP client comes from `mirepoix-business-model.md v1.3` and the Mirepoix-Co-as-ACP-server play; this ADR locks the per-spike implications.

Candidate runtimes considered:

1. **Bun + Ink + TypeScript** (proposed)
2. Node + Ink + TypeScript (with ts-node or tsx loader)
3. Python + Textual or Python + Rich
4. Rust + ratatui
5. Go + bubbletea

## Decision

**Bun + Ink + TypeScript with `.tsx` JSX source files**, no transpile step, no `tsconfig.json` unless type errors force one. Specifically:

- **Runtime:** Bun (latest stable, `bun --version` ≥ 1.1.x at time of writing).
- **UI framework:** `ink ^5.0.1` (the React-for-CLI library).
- **Input control:** `ink-text-input ^6.0.0` (peer-compatible with ink 5.x).
- **React (peer):** `react ^18.3.1` (ink 5.x peer requirement).
- **Source format:** `.tsx` (JSX, not hyperscript). Bun parses and runs `.tsx` directly with zero config.
- **Subprocess API:** `Bun.spawn({ cmd: argv, stdin: "pipe", stdout: "pipe", stderr: "pipe" })`. NO `child_process`, NO `execa`, NO `cross-spawn`.
- **Type checking:** Ad-hoc via `bun tsc --noEmit` (optional, not part of CI for the spike); no `tsconfig.json` committed unless concrete type-resolution errors require one. If added, it becomes an allowlist amendment and must be noted in the PR.

## Alternatives considered

### Node + Ink + TypeScript

- **Pros:** Wider deployment surface; the Ink ecosystem assumes Node.
- **Cons:** Requires `tsx` or `ts-node` or a build step to run `.tsx`; needs `child_process` which violates NQ-1 (we'd have to introduce a `Bun.spawn`-shaped shim or wait for Node's `child_process.spawn` parity issues to surface). Node also doesn't have built-in `EventTarget`-friendly stream APIs as tight as Bun's, requiring more boilerplate.
- **Decision driver:** NQ-1 explicitly rules this out.

### Python + Textual

- **Pros:** Mature TUI framework; the wider mirepoix ecosystem already has Python skill.
- **Cons:** NQ-1 forbids Python; the Goose-as-subprocess + ACP-client target language was chosen by Mirepoix architecture to be TypeScript (so the future ACP client logic can compose into `@mirepoix/cli` or web targets without re-implementation).
- **Decision driver:** NQ-1 forbids; strategic Mirepoix decision pre-empts it anyway.

### Rust + ratatui

- **Pros:** Fastest, zero-dep binary, no GC pauses on TUI redraw.
- **Cons:** Slower iteration for a spike; Mirepoix's TS ecosystem skill outweighs Rust; team has higher TS velocity at this maturity level.
- **Decision driver:** Velocity for a spike; strategic alignment with future `@mirepoix/cli` integration via shared TS types.

### Go + bubbletea

- **Pros:** Single static binary, good TUI lib, fast.
- **Cons:** Same velocity argument as Rust; no shared types with future Mirepoix TS targets.
- **Decision driver:** Same as Rust.

### `.tsx` JSX vs hyperscript `h(...)`

- **Pros of hyperscript:** No JSX dependency in tooling; pure JS interop; smaller mental model.
- **Pros of JSX:** Idiomatic React (operator-readable); Bun parses `.tsx` natively (zero config); resolves OQ-3 unambiguously; downstream phases (Scotty-B/C/D) plan more complex layouts that benefit from JSX nesting.
- **Decision:** JSX `.tsx`. Spec OQ-3 says "default to JSX unless implementation discovers a friction"; we adopt the default.

### `package.json` pinned vs ad-hoc

- **Pros of `bun --silent` ad-hoc install:** Less config.
- **Pros of pinned `package.json` + committed `bun.lock`:** Reproducible installs across operators; CI-friendly; standard hygiene; resolves OQ-4.
- **Decision:** Pinned `package.json` + committed `bun.lock` per `bun install --save-text-lockfile`.

## Consequences

**Positive:**

- Zero transpile step → operator runs `bun scotty.tsx` directly. Matches MS-2 ("`bun scotty.tsx` launches the Ink UI without runtime error").
- `Bun.spawn` returns a `Subprocess` with `stdin: WritableStream`, `stdout: ReadableStream`, `stderr: ReadableStream` — clean async-iteration ergonomics for the JSON-RPC read loop.
- Minimal dependency surface (3 production deps + 1 devDep) → small audit surface, low CVE risk, fast `bun install` (sub-second on a warm cache).
- TypeScript types catch ACP wire-shape mistakes statically at IDE-time, even without committing a `tsconfig.json`.
- Aligned with Mirepoix's downstream phases — when Scotty integrates into `@mirepoix/cli` (Scotty-C+), the TS source is reusable.

**Negative / trade-offs:**

- Bun is younger than Node. If a critical Bun bug blocks the spike, the fix path is "wait for upstream" not "switch runtime". Mitigation: pin to a known-good Bun version in README install instructions.
- Deploying Scotty to non-Linux hosts is harder (Bun macOS and Windows support exists but is less battle-tested). Spike is Linux-only; cross-platform support is a Phase Scotty-B+ concern.
- No `tsconfig.json` means IDE LSP relies on Bun's bundled types and ambient `react`/`ink` types — usually fine, but if a contributor's IDE shows phantom errors, the fallback is to add `tsconfig.json` later.
- Ink + React + Bun is a relatively new combination; edge cases (e.g., React 18 concurrent mode in TUI, key handling under tmux) may surface. Spike's narrow scope (header / pane / input) avoids most.

**Reversibility:** High. If Bun proves untenable mid-spike, the same source can run under Node + `tsx` loader with `child_process.spawn` (violating NQ-1 — would require an explicit spec amendment). Going the other direction (Bun → Rust/Go) is a full rewrite.

## References

- `specs/scotty-spike-spec.md` — NQ-1, NQ-2, OQ-3, OQ-4.
- `mirepoix-business-model.md v1.3` — Mirepoix-Co-as-ACP-server play.
- Bun docs: https://bun.com/docs/api/spawn (`Bun.spawn` API; behavior of `stdin`/`stdout`/`stderr` piping).
- Ink docs: https://github.com/vadimdemedes/ink (React 18, Node ≥ 18; works under Bun).
