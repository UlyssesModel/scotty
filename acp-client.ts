/**
 * acp-client.ts — JSON-RPC 2.0 client for Goose's Agent Client Protocol (ACP) server,
 * speaking newline-delimited JSON (NDJSON) over a Bun.spawn'd subprocess's stdio.
 *
 * Verified against `goose-acp:v1.34.1` (Goose 1.34.1) — see architect.md Appendix A.
 *
 * Design constraints honored here:
 *   - NQ-1: Bun.spawn only. No node:cp module, no exec-family calls.
 *   - NQ-3: No outbound sockets. The ACP transport is the subprocess's stdio.
 *   - NQ-6: No telemetry / phone-home / update checks.
 *   - S3:  1 MiB per-line cap on the inbound buffer.
 *   - S4:  per-line try/catch around JSON.parse; default-deny inbound request handler
 *           that replies with JSON-RPC -32601 to anything we don't implement so Goose
 *           never deadlocks waiting on a server-to-client request.
 *
 * This module exports the AcpClient class and the ACP wire types. It does NOT import
 * or render any UI; that is `scotty.tsx`'s job. AcpClient extends EventTarget so the
 * UI layer subscribes via addEventListener.
 */

// ---------------------------------------------------------------------------
// Exported wire types (per architect.md §"Exported types from acp-client.ts")
// ---------------------------------------------------------------------------

export type ProtocolVersion = 1;

export interface InitializeRequestParams {
  protocolVersion: 1;
  clientCapabilities: {
    fs?: { readTextFile?: boolean; writeTextFile?: boolean };
    terminal?: boolean;
  };
}

export interface InitializeResult {
  protocolVersion: number; // expect 1, warn if other
  agentCapabilities: {
    loadSession?: boolean;
    promptCapabilities?: { image?: boolean; audio?: boolean; embeddedContext?: boolean };
    mcpCapabilities?: { http?: boolean; sse?: boolean };
    sessionCapabilities?: { list?: object; close?: object };
    auth?: object;
  };
  authMethods?: Array<{ id: string; name: string; description?: string }>;
}

export interface McpServerConfig {
  // Empty for Phase A — Scotty does not configure MCP servers itself.
  // Goose's own config decides which extensions/servers it runs.
  [k: string]: unknown;
}

export interface NewSessionParams {
  cwd: string;
  mcpServers: McpServerConfig[];
  additionalDirectories?: string[];
}

export interface NewSessionResult {
  sessionId: string;
  modes: {
    currentModeId: string;
    availableModes: Array<{ id: string; name: string; description?: string }>;
  };
}

export type ContentBlock =
  | { type: "text"; text: string; annotations?: object }
  | { type: "image"; data: string; mimeType: string }
  | { type: "audio"; data: string; mimeType: string }
  | { type: "resource"; resource: { uri: string; text?: string; blob?: string; mimeType?: string } };

export interface PromptParams {
  sessionId: string;
  prompt: ContentBlock[];
}

export interface PromptResult {
  stopReason: "end_turn" | "max_tokens" | "cancelled" | string;
}

// Internally-tagged union on `sessionUpdate`. Variants are snake_case per the live probe.
export type SessionUpdate =
  | { sessionUpdate: "user_message_chunk"; content: ContentBlock }
  | { sessionUpdate: "agent_message_chunk"; content: ContentBlock }
  | { sessionUpdate: "agent_thought_chunk"; content: ContentBlock }
  | {
      sessionUpdate: "tool_call";
      toolCallId: string;
      title?: string;
      kind?: string;
      status?: "pending" | "in_progress" | "completed" | "failed";
      content?: ContentBlock[];
      locations?: Array<{ path: string; line?: number }>;
      rawInput?: unknown;
      rawOutput?: unknown;
    }
  | {
      sessionUpdate: "tool_call_update";
      toolCallId: string;
      status?: "pending" | "in_progress" | "completed" | "failed";
      content?: ContentBlock[];
      rawOutput?: unknown;
    }
  | { sessionUpdate: "current_mode_update"; currentModeId: string }
  | { sessionUpdate: "available_commands_update"; availableCommands: unknown[] }
  | { sessionUpdate: "config_option_update"; key: string; value: unknown }
  | { sessionUpdate: "session_info_update"; [k: string]: unknown }
  | { sessionUpdate: "usage_update"; [k: string]: unknown };

export interface SessionNotification {
  sessionId: string;
  update: SessionUpdate;
}

export interface CancelNotification {
  sessionId: string;
}

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 envelopes (internal)
// ---------------------------------------------------------------------------

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

interface JsonRpcResponseOk {
  jsonrpc: "2.0";
  id: number;
  result: unknown;
}

interface JsonRpcResponseErr {
  jsonrpc: "2.0";
  id: number;
  error: { code: number; message: string; data?: unknown };
}

type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcResponseOk
  | JsonRpcResponseErr;

// ---------------------------------------------------------------------------
// Error class for surfacing JSON-RPC errors with code + data preserved.
// ---------------------------------------------------------------------------

export class AcpRpcError extends Error {
  code: number;
  data: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "AcpRpcError";
    this.code = code;
    this.data = data;
  }
}

// ---------------------------------------------------------------------------
// The client.
// ---------------------------------------------------------------------------

/** Maximum length of a single inbound line. S3 / NQ-: defense against flooding. */
const MAX_LINE_BYTES = 1024 * 1024;

/** Maximum wait for an in-flight close ack on shutdown (ms). */
const CLOSE_ACK_TIMEOUT_MS = 1000;

/** Grace period between SIGTERM and SIGKILL on shutdown (ms). */
const SIGKILL_GRACE_MS = 500;

type PendingResolver = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
};

export interface AcpClientOptions {
  /** Argv array passed verbatim to Bun.spawn. Pre-split, no shell. */
  cmd: string[];
  /** Optional debug-log writer; receives one entry per inbound/outbound message. */
  onDebug?: (entry: string) => void;
}

export class AcpClient extends EventTarget {
  private readonly cmd: string[];
  private readonly onDebug?: (entry: string) => void;
  private child: ReturnType<typeof Bun.spawn> | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingResolver>();
  private closed = false;
  private stdoutDone: Promise<void> | null = null;
  private stderrDone: Promise<void> | null = null;
  private exitWatcher: Promise<void> | null = null;
  /**
   * AOQ-4 mitigation: if the resolved argv is a Docker `run` invocation that does NOT
   * already carry an operator-supplied `--name`, we inject a unique `--name` and
   * remember it here so `shutdown()` (and the synchronous `process.on(...)` backup
   * handlers) can issue `docker kill <name>` to terminate the actual container —
   * not just the `docker run` client process, which would otherwise leave an
   * orphaned container alive. Null means we did NOT inject (either the argv is not
   * docker, or the operator supplied their own `--name`).
   */
  private readonly gooseContainerName: string | null;

  constructor(opts: AcpClientOptions) {
    super();
    if (!Array.isArray(opts.cmd) || opts.cmd.length === 0) {
      throw new Error("AcpClient: cmd must be a non-empty argv array");
    }
    const { cmd, containerName } = injectDockerName(opts.cmd);
    this.cmd = cmd;
    this.gooseContainerName = containerName;
    this.onDebug = opts.onDebug;
  }

  /**
   * Returns the injected Docker container name (if any) so external code can
   * also fire `docker kill` from synchronous `process.on("exit")` backup paths.
   */
  getGooseContainerName(): string | null {
    return this.gooseContainerName;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Spawn the subprocess and complete the ACP `initialize` handshake.
   * Returns the InitializeResult.
   *
   * Per FR-3: verifies result.protocolVersion === 1, but does not throw on
   * mismatch; emits a debug entry and proceeds (Goose echoes whatever we send).
   */
  async start(): Promise<InitializeResult> {
    if (this.child) throw new Error("AcpClient.start(): already started");

    // Bun.spawn — array form, NO shell, NO interpolation.
    this.child = Bun.spawn({
      cmd: this.cmd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    this.debug(`spawn ${JSON.stringify(this.cmd)} pid=${this.child.pid ?? "?"}`);

    // Pump stdout (NDJSON dispatch) and stderr (line-buffered, emit "stderr" events).
    this.stdoutDone = this.runStdoutLoop(this.child.stdout as ReadableStream<Uint8Array>);
    this.stderrDone = this.runStderrLoop(this.child.stderr as ReadableStream<Uint8Array>);

    // Watch process exit so the UI can react.
    this.exitWatcher = this.child.exited.then((code) => {
      this.debug(`child exited code=${code}`);
      this.dispatchEvent(new CustomEvent("exit", { detail: { code } }));
      // Reject any still-pending requests so the UI doesn't hang forever.
      for (const [, p] of this.pending) {
        p.reject(new Error(`acp: goose subprocess exited (code ${code}) before response`));
      }
      this.pending.clear();
    });

    // Initialize handshake.
    const initParams: InitializeRequestParams = {
      protocolVersion: 1,
      clientCapabilities: {},
    };
    const init = (await this.request("initialize", initParams)) as InitializeResult;
    if (init.protocolVersion !== 1) {
      this.debug(
        `warn: server downgraded protocolVersion to ${init.protocolVersion}; proceeding`,
      );
    }
    return init;
  }

  /** Send `session/new` and return the result (sessionId + modes). */
  async newSession(cwd: string): Promise<NewSessionResult> {
    const params: NewSessionParams = { cwd, mcpServers: [] };
    return (await this.request("session/new", params)) as NewSessionResult;
  }

  /** Send a text-only `session/prompt` and await the final result envelope. */
  async prompt(sessionId: string, text: string): Promise<PromptResult> {
    const params: PromptParams = {
      sessionId,
      prompt: [{ type: "text", text }],
    };
    return (await this.request("session/prompt", params)) as PromptResult;
  }

  /**
   * Fire-and-forget `session/cancel` notification (NO id). Confirmed by live
   * probe: sending this as a request returns -32601 Method not found;
   * sending as a notification is silently accepted.
   */
  cancel(sessionId: string): void {
    const params: CancelNotification = { sessionId };
    this.notify("session/cancel", params);
  }

  /** Send `session/close` and await the `{}` ack. */
  async close(sessionId: string): Promise<void> {
    await this.request("session/close", { sessionId });
  }

  /**
   * Full shutdown: close session if id provided, SIGTERM, then SIGKILL after grace.
   * Safe to call multiple times.
   */
  async shutdown(sessionId?: string): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    // Best-effort cancel + close. We swallow errors because the subprocess
    // may already be gone (e.g., on a panic exit).
    if (sessionId && this.child && this.isAlive()) {
      try {
        this.cancel(sessionId);
      } catch (e) {
        this.debug(`shutdown: cancel notify failed: ${(e as Error).message}`);
      }
      try {
        await withTimeout(this.close(sessionId), CLOSE_ACK_TIMEOUT_MS);
      } catch (e) {
        this.debug(`shutdown: close ack timed out or failed: ${(e as Error).message}`);
      }
    }

    if (this.child && this.isAlive()) {
      try {
        this.child.kill("SIGTERM");
      } catch (e) {
        this.debug(`shutdown: SIGTERM failed: ${(e as Error).message}`);
      }
      // AOQ-4: SIGTERM to the `docker run` CLIENT does NOT stop the running
      // container — the Docker daemon owns the container's lifecycle. Fire a
      // `docker kill <name>` in parallel with the grace timer. Fire-and-forget;
      // we deliberately do not await Bun.spawn's `exited` promise here.
      this.dockerKillContainerOnce("shutdown:pre-grace");
      // Race a grace timer against process exit; SIGKILL if still alive.
      const exited = this.child.exited.then(() => true).catch(() => true);
      const graceTimer = new Promise<false>((r) => setTimeout(() => r(false), SIGKILL_GRACE_MS));
      const exitedInTime = await Promise.race([exited, graceTimer]);
      if (!exitedInTime && this.isAlive()) {
        try {
          this.child.kill("SIGKILL");
        } catch (e) {
          this.debug(`shutdown: SIGKILL failed: ${(e as Error).message}`);
        }
      }
      // Second, idempotent `docker kill` after SIGKILL of the client — covers the
      // race where the first `docker kill` lost to a slow daemon connection or
      // where the container only just registered. `docker kill` on an
      // already-exited container is a no-op error which we swallow.
      this.dockerKillContainerOnce("shutdown:post-grace");
    }

    // Wait briefly for stream loops to finish so we don't leak read-loops.
    try {
      await Promise.race([
        Promise.all([this.stdoutDone, this.stderrDone, this.exitWatcher]),
        new Promise((r) => setTimeout(r, 500)),
      ]);
    } catch {
      // ignore
    }
  }

  /** Synchronous best-effort kill — for process.on('exit') backup handlers. */
  killSync(): void {
    if (!this.child) return;
    try {
      this.child.kill("SIGTERM");
    } catch {
      // ignore
    }
    // AOQ-4: also fire `docker kill` synchronously (Bun.spawn returns immediately;
    // the daemon RPC completes in the background even after `process.exit`).
    this.dockerKillContainerOnce("killSync");
    // We cannot await in 'exit' handlers; the OS will reap the child shortly.
  }

  /**
   * Fire-and-forget `docker kill <name>` if we injected a container name.
   * Synchronous-init: Bun.spawn returns immediately; the daemon call runs async.
   * Stdio is fully detached/ignored so we don't accidentally hang or leak fds.
   * No-op if no name was injected (operator's argv was not docker, or already
   * carried its own `--name`).
   */
  private dockerKillContainerOnce(reason: string): void {
    const name = this.gooseContainerName;
    if (!name) return;
    try {
      Bun.spawn({
        cmd: ["docker", "kill", name],
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
      this.debug(`docker kill ${name} dispatched (${reason})`);
    } catch (e) {
      this.debug(`docker kill ${name} failed (${reason}): ${(e as Error).message}`);
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private isAlive(): boolean {
    return !!this.child && this.child.killed !== true && this.child.exitCode == null;
  }

  /** Send a JSON-RPC request and await its matching response. */
  private request<T = unknown>(method: string, params?: unknown): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!this.child || !this.isAlive()) {
        reject(new Error(`acp: cannot send "${method}", child is not alive`));
        return;
      }
      const id = this.nextId++;
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
      });
      const msg: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
      try {
        this.writeLine(msg);
      } catch (e) {
        this.pending.delete(id);
        reject(e as Error);
      }
    });
  }

  /** Send a JSON-RPC notification (no id, no response expected). */
  private notify(method: string, params?: unknown): void {
    if (!this.child || !this.isAlive()) {
      this.debug(`notify: skipped "${method}" (child not alive)`);
      return;
    }
    const msg: JsonRpcNotification = { jsonrpc: "2.0", method, params };
    this.writeLine(msg);
  }

  /** NDJSON write: one JSON object + '\n'. NEVER embeds a newline. */
  private writeLine(msg: JsonRpcMessage): void {
    if (!this.child) throw new Error("acp: writeLine before spawn");
    const line = JSON.stringify(msg) + "\n";
    // JSON.stringify never emits raw '\n' in string values (encodes as \\n);
    // the only '\n' in `line` is our terminator. Belt-and-suspenders check:
    if (line.indexOf("\n") !== line.length - 1) {
      throw new Error("acp: refusing to write a line containing an embedded newline");
    }
    this.debug(`> ${line.slice(0, line.length - 1)}`);
    const stdin = this.child.stdin as
      | WritableStreamDefaultWriter<Uint8Array>
      | { write(s: string | Uint8Array): unknown }
      | undefined;
    if (!stdin) throw new Error("acp: child stdin is not piped");
    const enc = new TextEncoder().encode(line);
    // Bun's child.stdin is a FileSink with .write(string|Uint8Array) — works either way.
    (stdin as { write(s: Uint8Array): unknown }).write(enc);
  }

  /** Read loop for stdout: NDJSON parse + dispatch. */
  private async runStdoutLoop(stdout: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for await (const chunk of stdout as unknown as AsyncIterable<Uint8Array>) {
        buf += decoder.decode(chunk, { stream: true });
        // Defensive: cap buffer growth before any newline.
        if (buf.length > MAX_LINE_BYTES && buf.indexOf("\n") === -1) {
          this.debug(`error: inbound line exceeds ${MAX_LINE_BYTES} bytes without newline; force-closing`);
          buf = "";
          // Force-close: S3. Sending SIGTERM to the offending child.
          try {
            this.child?.kill("SIGTERM");
          } catch {
            // ignore
          }
          break;
        }
        let idx: number;
        while ((idx = buf.indexOf("\n")) !== -1) {
          const rawLine = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          const line = rawLine.replace(/\r$/, "");
          if (!line.trim()) continue;
          if (line.length > MAX_LINE_BYTES) {
            this.debug(`warn: dropping oversized inbound line (${line.length} bytes)`);
            continue;
          }
          this.debug(`< ${line}`);
          let parsed: unknown;
          try {
            parsed = JSON.parse(line);
          } catch (e) {
            this.debug(`warn: JSON parse error on line: ${(e as Error).message}`);
            this.dispatchEvent(
              new CustomEvent("parse-error", { detail: { line, error: (e as Error).message } }),
            );
            continue;
          }
          this.handleInbound(parsed);
        }
      }
    } catch (e) {
      this.debug(`stdout loop error: ${(e as Error).message}`);
    }
  }

  /** Read loop for stderr: emit line-by-line as "stderr" events for the debug log. */
  private async runStderrLoop(stderr: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for await (const chunk of stderr as unknown as AsyncIterable<Uint8Array>) {
        buf += decoder.decode(chunk, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, idx).replace(/\r$/, "");
          buf = buf.slice(idx + 1);
          if (line.length > 0) {
            this.dispatchEvent(new CustomEvent("stderr", { detail: line }));
          }
        }
        // Cap stderr buffer too.
        if (buf.length > MAX_LINE_BYTES) {
          this.dispatchEvent(new CustomEvent("stderr", { detail: buf.slice(0, MAX_LINE_BYTES) }));
          buf = "";
        }
      }
      if (buf.length > 0) {
        this.dispatchEvent(new CustomEvent("stderr", { detail: buf }));
      }
    } catch (e) {
      this.debug(`stderr loop error: ${(e as Error).message}`);
    }
  }

  /**
   * Dispatch a parsed inbound JSON-RPC message.
   *
   * - response with id → match against `this.pending` and resolve/reject
   * - notification (method, no id) → dispatch as event (session/update) or log
   * - request (method + id) → DEFAULT-DENY: reply with -32601 Method not found
   *   (we have no server-to-client method handlers in Phase A; replying prevents
   *   Goose from deadlocking on awaited responses)
   */
  private handleInbound(raw: unknown): void {
    if (!isObject(raw)) {
      this.debug(`warn: dropping non-object inbound message`);
      return;
    }
    const msg = raw as Record<string, unknown>;
    const hasId = Object.prototype.hasOwnProperty.call(msg, "id") && msg.id !== null;
    const hasMethod = typeof msg.method === "string";
    const hasResult = Object.prototype.hasOwnProperty.call(msg, "result");
    const hasError = Object.prototype.hasOwnProperty.call(msg, "error");

    if (hasId && (hasResult || hasError)) {
      // Response.
      const id = msg.id as number;
      const pending = this.pending.get(id);
      if (!pending) {
        this.debug(`warn: response for unknown id=${id}; dropping`);
        return;
      }
      this.pending.delete(id);
      if (hasError) {
        const err = msg.error as { code: number; message: string; data?: unknown };
        pending.reject(new AcpRpcError(err.code, err.message, err.data));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    if (hasMethod && !hasId) {
      // Notification.
      const method = msg.method as string;
      if (method === "session/update") {
        const params = msg.params as SessionNotification | undefined;
        if (params && isObject(params)) {
          this.dispatchEvent(
            new CustomEvent("session-update", { detail: params }),
          );
        } else {
          this.debug(`warn: session/update with non-object params`);
        }
      } else {
        this.debug(`info: unhandled inbound notification "${method}"`);
      }
      return;
    }

    if (hasMethod && hasId) {
      // Server-to-client REQUEST. Default-deny.
      const method = msg.method as string;
      this.debug(`info: server-to-client request "${method}" id=${msg.id} — replying -32601`);
      const reply: JsonRpcResponseErr = {
        jsonrpc: "2.0",
        id: msg.id as number,
        error: { code: -32601, message: "Method not found" },
      };
      try {
        this.writeLine(reply);
      } catch (e) {
        this.debug(`warn: failed to send -32601 reply: ${(e as Error).message}`);
      }
      return;
    }

    this.debug(`warn: dropping malformed JSON-RPC message`);
  }

  /** Internal: forward a debug line both to the optional sink and as a "debug" event. */
  private debug(entry: string): void {
    try {
      this.onDebug?.(entry);
    } catch {
      // never let a debug-sink failure crash the read loop
    }
    this.dispatchEvent(new CustomEvent("debug", { detail: entry }));
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/**
 * Parse SCOTTY_GOOSE_CMD into an argv[]. No shell, no glob, no $VAR interpolation.
 * The only env var we expand is `${HOME}` in the default command string (handled
 * by the caller, not here). This function is pure whitespace-split.
 *
 * Exported for use by `scotty.tsx` so the entry point's env-parsing logic stays
 * testable.
 */
export function parseGooseCmd(envValue: string | undefined, home: string | undefined): string[] {
  const home_ = home && home.length > 0 ? home : "/tmp";
  const defaultCmd = `docker run -i --rm -v ${home_}/.config/goose:/root/.config/goose:ro goose-acp:v1.34.1 acp`;
  const src = envValue && envValue.trim().length > 0 ? envValue : defaultCmd;
  return src.split(/\s+/).filter(Boolean);
}

/**
 * AOQ-4: detect a `docker run …` invocation that has NO `--name` flag, and
 * inject `--name scotty-goose-<pid>-<rand>` immediately after the `run`
 * subcommand. Returns the (possibly augmented) argv plus the chosen container
 * name (null if no injection happened).
 *
 * Detection rules (deliberately conservative):
 *   1. argv[0] must be exactly `docker` (basename match — no `/usr/local/bin/docker`).
 *      If the operator points SCOTTY_GOOSE_CMD at a wrapper or a native goose
 *      binary, we do NOTHING (the orphan-container concern doesn't apply).
 *   2. The first non-flag argument after `docker` must be `run`. Anything else
 *      (`exec`, `compose`, etc.) → no injection.
 *   3. We scan ALL remaining tokens for any form of name flag: `--name`,
 *      `--name=…`, or `--name <value>`. If present, we leave argv alone.
 *      This is safe even if `--name` appears AFTER the image name, because
 *      Docker rejects that anyway — we still avoid double-injection.
 *
 * The generated name is `scotty-goose-<pid>-<8-char-random>` for uniqueness
 * across concurrent Scotty processes on the same host.
 */
export function injectDockerName(argv: string[]): {
  cmd: string[];
  containerName: string | null;
} {
  if (argv.length === 0) return { cmd: argv, containerName: null };
  // Rule 1: bare `docker` only — not `/usr/.../docker`, not a wrapper.
  if (argv[0] !== "docker") return { cmd: argv, containerName: null };
  // Rule 2: first non-flag arg must be `run`.
  let runIdx = -1;
  for (let i = 1; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith("-")) continue;
    runIdx = i;
    break;
  }
  if (runIdx === -1 || argv[runIdx] !== "run") {
    return { cmd: argv, containerName: null };
  }
  // Rule 3: any pre-existing `--name`? Scan everything after `run` until we
  // hit what looks like the image name. Because operators could place `--name`
  // unconventionally we scan the WHOLE tail — false-positive bias is fine here
  // (we'd rather skip injection than double-name a container).
  for (let i = runIdx + 1; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--name" || t.startsWith("--name=")) {
      return { cmd: argv, containerName: null };
    }
  }
  // Build a process-unique name. `process.pid` is a number; toString(36) gives
  // us 8 alphanumeric chars from a fresh Math.random() draw for the suffix.
  const containerName = `scotty-goose-${process.pid}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
  // Inject `--name <containerName>` immediately after `run`.
  const next = argv.slice();
  next.splice(runIdx + 1, 0, "--name", containerName);
  return { cmd: next, containerName };
}
