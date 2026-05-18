# Phase Scotty-A — ACP Client Spike Spec

**Status:** v0 draft — for on-loop execution after Tracks 1+2 complete (Scotty repo archive + Goose install).
**Repo:** UlyssesModel/scotty (the new empty repo created in Track 1, post-archive of the minimal scotty.mjs).
**Phase:** Scotty-A (first build phase of Mirepoix v0.1.1 Scotty TUI sub-phase).
**Spec-resolution convention:** Per CLAUDE.md (commit 1a83a67 of kavara-mirepoix-internal), this spec is the pre-OQ snapshot; the PR body produced by on-loop is the resolved contract.

## Why this exists

Mirepoix v0.1.0 ships `@mirepoix/cli` as task-style invocation only — no interactive REPL, no streaming visibility, no mid-loop steering. For Mirepoix-secure use cases (Kirk-confidential PyTorch → Rust translation on scotty-gpu under deny-all-egress per ADR-010), an interactive TUI is required. Architectural decision per `mirepoix-business-model.md v1.3` and the Mirepoix-Co-as-ACP-server play: build Scotty as a TypeScript + Bun + Ink ACP client that talks to Goose's ACP server (which Goose runs as a subprocess).

This spike proves the protocol integration end-to-end. Hardens into v0.1.1 via Phases Scotty-B/C/D.

## Functional requirements (FR)

- **FR-1** — Spike must spawn `goose acp` as a child process via `Bun.spawn()` with stdio piping (stdin/stdout/stderr handles available to the parent).
- **FR-2** — Spike must implement a JSON-RPC 2.0 client over the subprocess stdio: outbound requests written as newline-delimited JSON to stdin; inbound responses + notifications read as newline-delimited JSON from stdout; request/response correlation via the JSON-RPC `id` field.
- **FR-3** — On startup, spike must send `initialize` then `session/new`, store the returned `sessionId`, and display "ready" status to the operator.
- **FR-4** — Operator-facing Ink UI must contain (at minimum): a status header at top, a scrolling conversation pane in the middle, and a text input prompt at the bottom.
- **FR-5** — When operator submits text via the prompt, spike must send `session/prompt` with the captured input and the active sessionId.
- **FR-6** — Spike must handle `AgentMessageChunk` notifications by streaming the chunk content into the conversation pane in real time (no buffering for the full response).
- **FR-7** — Spike must handle `AgentThoughtChunk` notifications by rendering thought content distinctly from assistant content (different color or prefix).
- **FR-8** — Spike must handle `ToolCall` notifications by rendering the tool invocation (name + args summary) as a visible event in the conversation flow.
- **FR-9** — Spike must handle `ToolCallUpdate` notifications by updating or appending status information about a previously-rendered tool call.
- **FR-10** — Operator Ctrl-C must send `session/cancel` to the Goose subprocess, then terminate the subprocess cleanly and exit the Ink app.

## Negative requirements (NQ)

- **NQ-1** — Spike must NOT use Python, Node's `child_process` module, or any non-Bun-native subprocess primitive. `Bun.spawn()` only.
- **NQ-2** — Spike must NOT depend on any npm package not strictly required for the Ink TUI + Bun runtime. Permitted dependencies: `ink`, `ink-text-input`, `react` (Ink's peer dependency). No additional libraries without explicit justification.
- **NQ-3** — Spike must NOT make any outbound network connection itself. The only egress permitted is whatever the Goose subprocess does (Goose's own configuration controls that; Scotty's process opens no sockets).
- **NQ-4** — Spike must NOT write any file outside its own working directory or implicitly outside the operator's chosen project directory. (Tool writes performed by the agent via Goose go wherever Goose dispatches them — that's outside Scotty's process scope.)
- **NQ-5** — Spike must NOT import from any `@mirepoix/*` package in this Phase. Spike is an experimental ACP client living in a separate repo (`UlyssesModel/scotty`); folding into the Mirepoix monorepo is a later decision.
- **NQ-6** — Spike must NOT include telemetry, error reporting to external services, update checks, or any phone-home mechanism.
- **NQ-7** — Spike must NOT include placeholder Anthropic/OpenAI/cloud-provider integration code. Goose is the only backend; Goose's provider configuration is the only place where the model provider is set.

## Must-show acceptance (MS)

- **MS-1** — `bun install` in the spike directory completes without error.
- **MS-2** — `bun scotty.tsx` launches the Ink UI without runtime error.
- **MS-3** — The Goose subprocess is spawned and responds to `initialize` within 5 seconds; the status header shows "session <id> ready" before the operator types anything.
- **MS-4** — Operator can type a prompt like `"say hello in exactly three words"` and observe streaming output from the configured Ollama model appearing in the conversation pane.
- **MS-5** — Operator can type a prompt requiring a tool call (e.g., `"list the files in /tmp"`) and observe a `ToolCall` notification rendered in the conversation pane before the agent's text response.
- **MS-6** — Operator pressing Ctrl-C cancels the in-flight session (if any), terminates the Goose subprocess (visible in `ps` after exit), and exits the Ink app cleanly with no orphan child process.

## Open questions (OQ)

- **OQ-1** — ACP method name casing: AAIF docs reference both CamelCase (`AgentMessageChunk`) and snake_case (`agent_message_chunk`) in different places. The spike should handle both defensively, OR confirm which Goose's current implementation uses by testing during architect phase and locking to that.
- **OQ-2** — Goose's actual response shape for `session/new`: the doc says `{ sessionId }` but actual response may have different field naming. Architect phase should probe with a real Goose subprocess and document the actual shape.
- **OQ-3** — Whether to use JSX (.tsx) or hyperscript (Ink `h(...)` calls) for the UI. JSX is more idiomatic; Bun handles .tsx natively. Default to JSX unless implementation discovers a friction.
- **OQ-4** — Whether spike directory should include a `package.json` with the three dependencies pinned to specific versions, or use Bun's `--silent` install mode. Default to a pinned package.json for reproducibility.

## File allowlist

Spike may create or modify these files only:

- `package.json`
- `scotty.tsx` (or `scotty.ts` if hyperscript chosen)
- `README.md`
- `.gitignore` (standard Node ignore)
- `bun.lock`

Spike must NOT modify anything in `@mirepoix/*` packages, `~/.claude/`, or any other Mirepoix-related path. Spike is fully self-contained in its own repo.

## Out of scope (deferred to Phase Scotty-B and beyond)

- Session persistence and resume (FR-6 from `scotty-requirements.md`)
- Multi-pane TUI layout
- File diff viewer for `edit` tool calls
- Slash command framework (`/file`, `/clear`, etc.)
- mise-en-place mode switcher
- on-loop slash command integration
- grill-with-docs invocation pattern
- Multiple parallel sessions

Get the spike working end-to-end first; layer additional features per `scotty-requirements.md` after.

## Deliverables

- `scotty.tsx` — the spike implementation
- `package.json` — dependencies pinned, scripts defined
- `README.md` — install + run instructions + the verification steps for MS-1 through MS-6
- `.gitignore`
- (Optional) `tsconfig.json` if Bun's defaults need overriding for type-checking purposes
