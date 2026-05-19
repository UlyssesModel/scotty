/**
 * scotty.tsx — Ink UI entry point for the Phase Scotty-A ACP client spike.
 *
 * Three regions:
 *   - header (1 line):       status — "connecting…" / "session <id> ready — <mode>" /
 *                            "prompting…" / "error: <msg>" / "goose exited (code N)"
 *   - conversation (flex):   scrolling list of events
 *   - input (1 line):        `ink-text-input`, prefixed with "> "
 *
 * Lifecycle:
 *   1. parse SCOTTY_GOOSE_CMD via parseGooseCmd (no shell)
 *   2. instantiate AcpClient with the argv
 *   3. await start() → initialize
 *   4. await newSession(process.cwd())
 *   5. wire session-update / stderr / exit listeners
 *   6. on Enter: send session/prompt, append to conversation, disable input until done
 *   7. on Ctrl-C: cancel → close → SIGTERM → 500 ms grace → SIGKILL → app.exit
 *   8. process.on("exit"|"SIGTERM"|"SIGHUP"|"SIGINT"|"uncaughtException") backups
 *
 * Constraints honored: NQ-1 (Bun.spawn only, AcpClient does that), NQ-2 (only ink /
 * ink-text-input / react), NQ-3 (no network APIs imported here), NQ-4 (debug log
 * always under process.cwd()).
 */

import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Box, Text, useApp, useInput, render } from "ink";
import TextInput from "ink-text-input";
import {
  AcpClient,
  AcpRpcError,
  parseGooseCmd,
  type ContentBlock,
  type InitializeResult,
  type NewSessionResult,
  type SessionNotification,
  type SessionUpdate,
} from "./acp-client";

// ---------------------------------------------------------------------------
// Conversation model
// ---------------------------------------------------------------------------

type EventEntry =
  | { kind: "user"; id: string; text: string }
  | { kind: "agent"; id: string; text: string }
  | { kind: "thought"; id: string; text: string }
  | {
      kind: "tool";
      id: string;
      toolCallId: string;
      title: string;
      argSummary: string;
      status: string;
      output?: string;
    }
  | { kind: "info"; id: string; text: string }
  | { kind: "error"; id: string; text: string }
  | { kind: "raw"; id: string; tag: string };

interface ConvState {
  events: EventEntry[];
  // Bubble of the in-flight assistant turn so contiguous `agent_message_chunk`
  // notifications append into one entry rather than fragmenting.
  currentAgentId: string | null;
  currentThoughtId: string | null;
}

type ConvAction =
  | { type: "user"; text: string }
  | { type: "agent_chunk"; text: string }
  | { type: "thought_chunk"; text: string }
  | { type: "turn_done" }
  | {
      type: "tool_call";
      toolCallId: string;
      title: string;
      argSummary: string;
      status: string;
    }
  | { type: "tool_update"; toolCallId: string; status?: string; output?: string }
  | { type: "info"; text: string }
  | { type: "error"; text: string }
  | { type: "raw"; tag: string };

let eventIdCounter = 0;
const nextEventId = (): string => `e${++eventIdCounter}`;

const initialConv: ConvState = {
  events: [],
  currentAgentId: null,
  currentThoughtId: null,
};

function convReducer(state: ConvState, action: ConvAction): ConvState {
  switch (action.type) {
    case "user": {
      const e: EventEntry = { kind: "user", id: nextEventId(), text: action.text };
      return {
        events: [...state.events, e],
        currentAgentId: null,
        currentThoughtId: null,
      };
    }
    case "agent_chunk": {
      if (state.currentAgentId) {
        // Append to the most recent assistant bubble.
        return {
          ...state,
          events: state.events.map((e) =>
            e.kind === "agent" && e.id === state.currentAgentId
              ? { ...e, text: e.text + action.text }
              : e,
          ),
        };
      }
      const id = nextEventId();
      const e: EventEntry = { kind: "agent", id, text: action.text };
      return {
        ...state,
        events: [...state.events, e],
        currentAgentId: id,
        // A new agent bubble ends any in-flight thought bubble.
        currentThoughtId: null,
      };
    }
    case "thought_chunk": {
      if (state.currentThoughtId) {
        return {
          ...state,
          events: state.events.map((e) =>
            e.kind === "thought" && e.id === state.currentThoughtId
              ? { ...e, text: e.text + action.text }
              : e,
          ),
        };
      }
      const id = nextEventId();
      const e: EventEntry = { kind: "thought", id, text: action.text };
      return {
        ...state,
        events: [...state.events, e],
        currentThoughtId: id,
      };
    }
    case "turn_done": {
      return { ...state, currentAgentId: null, currentThoughtId: null };
    }
    case "tool_call": {
      const id = nextEventId();
      const e: EventEntry = {
        kind: "tool",
        id,
        toolCallId: action.toolCallId,
        title: action.title,
        argSummary: action.argSummary,
        status: action.status,
      };
      return { ...state, events: [...state.events, e] };
    }
    case "tool_update": {
      // FR-9: locate prior tool_call by toolCallId and update its status/output.
      let updated = false;
      const next = state.events.map((e) => {
        if (e.kind === "tool" && e.toolCallId === action.toolCallId) {
          updated = true;
          return {
            ...e,
            status: action.status ?? e.status,
            output: action.output ?? e.output,
          };
        }
        return e;
      });
      if (!updated) {
        // Defensive: if we never saw the originating tool_call, append a debug
        // entry rather than silently dropping the update.
        const id = nextEventId();
        next.push({
          kind: "info",
          id,
          text: `tool_call_update for unknown toolCallId=${action.toolCallId} status=${action.status ?? "?"}`,
        });
      }
      return { ...state, events: next };
    }
    case "info": {
      const e: EventEntry = { kind: "info", id: nextEventId(), text: action.text };
      return { ...state, events: [...state.events, e] };
    }
    case "error": {
      const e: EventEntry = { kind: "error", id: nextEventId(), text: action.text };
      return { ...state, events: [...state.events, e] };
    }
    case "raw": {
      const e: EventEntry = { kind: "raw", id: nextEventId(), tag: action.tag };
      return { ...state, events: [...state.events, e] };
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function textFromContent(content: ContentBlock | undefined): string {
  if (!content) return "";
  if (content.type === "text") return content.text;
  if (content.type === "image") return `[image ${content.mimeType}]`;
  if (content.type === "audio") return `[audio ${content.mimeType}]`;
  if (content.type === "resource") return `[resource ${content.resource.uri}]`;
  return "";
}

function summarizeArgs(rawInput: unknown): string {
  if (rawInput == null) return "";
  let s: string;
  try {
    s = typeof rawInput === "string" ? rawInput : JSON.stringify(rawInput);
  } catch {
    s = String(rawInput);
  }
  if (s.length > 80) return s.slice(0, 79) + "…";
  return s;
}

function toolTitle(u: Extract<SessionUpdate, { sessionUpdate: "tool_call" }>): string {
  return u.title ?? u.kind ?? u.toolCallId ?? "tool";
}

function toolOutputPreview(content: ContentBlock[] | undefined, rawOutput: unknown): string | undefined {
  if (content && content.length > 0) {
    const joined = content.map(textFromContent).join("");
    if (joined.length > 0) {
      return joined.length > 120 ? joined.slice(0, 119) + "…" : joined;
    }
  }
  if (rawOutput != null) {
    return summarizeArgs(rawOutput);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Debug log: optional `./.scotty.log` file under CWD (NQ-4).
// ---------------------------------------------------------------------------

interface DebugSink {
  write(entry: string): void;
  flush(): Promise<void> | void;
}

function makeDebugSink(): DebugSink | null {
  if (process.env.SCOTTY_DEBUG !== "1") return null;
  // Bun.file().writer() is an append-friendly sink that lives in CWD.
  // We intentionally write a relative path so we cannot escape CWD (NQ-4).
  const path = "./.scotty.log";
  try {
    // Bun provides Bun.file + .writer(); .write(string) appends if we open with append mode.
    // The simplest portable approach: open a FileSink in append mode.
    // @ts-expect-error — Bun.file().writer accepts append in newer Bun; falling back if not.
    const sink = Bun.file(path).writer({ append: true });
    return {
      write(entry: string) {
        const ts = new Date().toISOString();
        sink.write(`${ts} ${entry}\n`);
      },
      async flush() {
        try {
          await sink.flush?.();
        } catch {
          // ignore
        }
      },
    };
  } catch {
    // Fall back to no-op — never crash because debug logging is unavailable.
    return null;
  }
}

// ---------------------------------------------------------------------------
// Status header model
// ---------------------------------------------------------------------------

type Status =
  | { kind: "connecting" }
  | { kind: "ready"; sessionId: string; mode: string }
  | { kind: "prompting"; sessionId: string; mode: string }
  | { kind: "error"; message: string; sessionId?: string; mode?: string }
  | { kind: "exited"; code: number | null };

function renderStatus(s: Status): { color: string; text: string } {
  switch (s.kind) {
    case "connecting":
      return { color: "yellow", text: "connecting…" };
    case "ready":
      return { color: "green", text: `session ${s.sessionId} ready — ${s.mode}` };
    case "prompting":
      return { color: "cyan", text: `prompting… (${s.sessionId} — ${s.mode})` };
    case "error":
      return { color: "red", text: `error: ${s.message}` };
    case "exited":
      return { color: "red", text: `goose exited (code ${s.code ?? "?"})` };
  }
}

// ---------------------------------------------------------------------------
// The App component
// ---------------------------------------------------------------------------

interface AppProps {
  client: AcpClient;
}

function App({ client }: AppProps): React.ReactElement {
  const app = useApp();
  const [conv, dispatch] = useReducer(convReducer, initialConv);
  const [status, setStatus] = useState<Status>({ kind: "connecting" });
  const [inputValue, setInputValue] = useState("");
  const [inputDisabled, setInputDisabled] = useState(true);

  // Persist sessionId + mode so we can re-render & shutdown cleanly.
  const sessionIdRef = useRef<string | null>(null);
  const modeRef = useRef<string>("?");
  const shuttingDownRef = useRef(false);

  // ---- Boot: initialize + new session ----
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const init: InitializeResult = await client.start();
        if (cancelled) return;
        if (init.protocolVersion !== 1) {
          dispatch({
            type: "info",
            text: `warn: server protocolVersion=${init.protocolVersion} (expected 1)`,
          });
        }
        const sess: NewSessionResult = await client.newSession(process.cwd());
        if (cancelled) return;
        sessionIdRef.current = sess.sessionId;
        modeRef.current = sess.modes.currentModeId;
        setStatus({ kind: "ready", sessionId: sess.sessionId, mode: sess.modes.currentModeId });
        setInputDisabled(false);
      } catch (e) {
        if (cancelled) return;
        const msg = e instanceof AcpRpcError ? `${e.message} (rpc ${e.code})` : (e as Error).message;
        setStatus({ kind: "error", message: msg });
        dispatch({ type: "error", text: `startup failed: ${msg}` });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client]);

  // ---- Subscribe to client events ----
  useEffect(() => {
    const onSessionUpdate = (ev: Event) => {
      const notif = (ev as CustomEvent<SessionNotification>).detail;
      const u = notif.update;
      switch (u.sessionUpdate) {
        case "agent_message_chunk": {
          const text = textFromContent(u.content);
          if (text.length > 0) dispatch({ type: "agent_chunk", text });
          break;
        }
        case "agent_thought_chunk": {
          const text = textFromContent(u.content);
          if (text.length > 0) dispatch({ type: "thought_chunk", text });
          break;
        }
        case "user_message_chunk": {
          // We already showed the user message when they pressed Enter; emit as debug only.
          dispatch({ type: "raw", tag: "user_message_chunk" });
          break;
        }
        case "tool_call": {
          const argSummary = summarizeArgs(u.rawInput);
          dispatch({
            type: "tool_call",
            toolCallId: u.toolCallId,
            title: toolTitle(u),
            argSummary,
            status: u.status ?? "pending",
          });
          break;
        }
        case "tool_call_update": {
          const output = toolOutputPreview(u.content, u.rawOutput);
          dispatch({
            type: "tool_update",
            toolCallId: u.toolCallId,
            status: u.status,
            output,
          });
          break;
        }
        case "current_mode_update": {
          modeRef.current = u.currentModeId;
          if (sessionIdRef.current) {
            // Refresh header to reflect the new mode if we're ready/idle.
            setStatus((s) => {
              if (s.kind === "ready") return { ...s, mode: u.currentModeId };
              if (s.kind === "prompting") return { ...s, mode: u.currentModeId };
              return s;
            });
          }
          dispatch({ type: "info", text: `mode → ${u.currentModeId}` });
          break;
        }
        default: {
          // FR-spec: render unknown variants as `event: <sessionUpdate>` in gray.
          dispatch({ type: "raw", tag: u.sessionUpdate });
          break;
        }
      }
    };
    const onExit = (ev: Event) => {
      const { code } = (ev as CustomEvent<{ code: number | null }>).detail;
      setStatus({ kind: "exited", code });
      setInputDisabled(true);
    };

    client.addEventListener("session-update", onSessionUpdate);
    client.addEventListener("exit", onExit);
    return () => {
      client.removeEventListener("session-update", onSessionUpdate);
      client.removeEventListener("exit", onExit);
    };
  }, [client]);

  // ---- Ctrl-C handling ----
  const shutdown = useCallback(async () => {
    if (shuttingDownRef.current) return;
    shuttingDownRef.current = true;
    const sid = sessionIdRef.current ?? undefined;
    try {
      await client.shutdown(sid);
    } catch {
      // ignore — shutdown is best-effort
    }
    try {
      app.exit();
    } catch {
      // ignore — Ink may be already torn down
    }
  }, [app, client]);

  useInput((_input, key) => {
    if (key.ctrl && (_input === "c" || _input === "C")) {
      void shutdown();
    }
  });

  // ---- Submit prompt ----
  const onSubmit = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) {
        setInputValue("");
        return;
      }
      const sid = sessionIdRef.current;
      if (!sid) {
        dispatch({ type: "error", text: "no active session — cannot send prompt" });
        return;
      }
      dispatch({ type: "user", text: trimmed });
      setInputValue("");
      setInputDisabled(true);
      setStatus({ kind: "prompting", sessionId: sid, mode: modeRef.current });
      try {
        const res = await client.prompt(sid, trimmed);
        dispatch({ type: "info", text: `turn done (${res.stopReason})` });
        setStatus({ kind: "ready", sessionId: sid, mode: modeRef.current });
      } catch (e) {
        if (e instanceof AcpRpcError) {
          // Special-case Goose's "Missing provider" surface (AOQ-2).
          const missingProvider =
            typeof e.data === "string" && e.data.toLowerCase().includes("missing provider");
          const msg = missingProvider
            ? "provider not configured — run goose configure or mount config volume"
            : `${e.message} (rpc ${e.code}${e.data ? `: ${typeof e.data === "string" ? e.data : JSON.stringify(e.data)}` : ""})`;
          dispatch({ type: "error", text: msg });
          setStatus({ kind: "error", message: msg, sessionId: sid, mode: modeRef.current });
        } else {
          const msg = (e as Error).message;
          dispatch({ type: "error", text: msg });
          setStatus({ kind: "error", message: msg, sessionId: sid, mode: modeRef.current });
        }
      } finally {
        dispatch({ type: "turn_done" });
        setInputDisabled(false);
      }
    },
    [client],
  );

  // ---- Render ----
  const headerLine = useMemo(() => renderStatus(status), [status]);

  return (
    <Box flexDirection="column" width="100%" height="100%">
      {/* Header */}
      <Box flexShrink={0}>
        <Text bold color={headerLine.color}>
          {headerLine.text}
        </Text>
      </Box>

      {/* Conversation pane */}
      <Box flexDirection="column" flexGrow={1} marginTop={1} marginBottom={1}>
        {conv.events.map((e) => (
          <ConversationLine key={e.id} entry={e} />
        ))}
      </Box>

      {/* Input */}
      <Box flexShrink={0}>
        <Text>{inputDisabled ? "… " : "> "}</Text>
        {inputDisabled ? (
          <Text dimColor>
            {status.kind === "exited" ? "(goose has exited; press Ctrl-C to quit)" : "(working…)"}
          </Text>
        ) : (
          <TextInput value={inputValue} onChange={setInputValue} onSubmit={onSubmit} />
        )}
      </Box>
    </Box>
  );
}

function ConversationLine({ entry }: { entry: EventEntry }): React.ReactElement {
  switch (entry.kind) {
    case "user":
      return (
        <Text color="cyan">
          <Text bold>{"> "}</Text>
          {entry.text}
        </Text>
      );
    case "agent":
      return <Text color="white">{entry.text}</Text>;
    case "thought":
      return (
        <Text color="gray" italic>
          {"thought > "}
          {entry.text}
        </Text>
      );
    case "tool": {
      const sumPart = entry.argSummary ? ` (${entry.argSummary})` : "";
      const outPart = entry.output ? `  -> ${entry.output}` : "";
      return (
        <Text color="yellow">
          {`tool: ${entry.title}${sumPart} [${entry.status}]${outPart}`}
        </Text>
      );
    }
    case "info":
      return <Text color="blue">{`info: ${entry.text}`}</Text>;
    case "error":
      return <Text color="red">{`error: ${entry.text}`}</Text>;
    case "raw":
      return (
        <Text color="gray" dimColor>
          {`event: ${entry.tag}`}
        </Text>
      );
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function main(): void {
  const argv = parseGooseCmd(process.env.SCOTTY_GOOSE_CMD, process.env.HOME);
  if (!process.env.HOME && (process.env.SCOTTY_GOOSE_CMD ?? "").trim().length === 0) {
    // We fell back to /tmp for the volume mount path; warn on stderr.
    process.stderr.write(
      "scotty: warning — HOME env var unset; using /tmp/.config/goose for the default volume mount path\n",
    );
  }

  const debugSink = makeDebugSink();

  const client = new AcpClient({
    cmd: argv,
    onDebug: debugSink ? (entry) => debugSink.write(entry) : undefined,
  });

  if (debugSink) {
    // Forward Goose stderr lines + parse errors to the debug file too.
    client.addEventListener("stderr", (ev) => {
      const line = (ev as CustomEvent<string>).detail;
      debugSink.write(`stderr: ${line}`);
    });
    client.addEventListener("parse-error", (ev) => {
      const { line, error } = (ev as CustomEvent<{ line: string; error: string }>).detail;
      debugSink.write(`parse-error: ${error} :: ${line}`);
    });
  }

  // ---- Process-level backup cleanup handlers (S2) ----
  // These run if the React layer is unresponsive or if Scotty exits abnormally.
  // They are SYNCHRONOUS-friendly (best-effort kill) because 'exit' handlers
  // cannot await.
  const backupKill = () => {
    try {
      client.killSync();
    } catch {
      // ignore
    }
  };
  const onSignal = async (sig: NodeJS.Signals) => {
    try {
      await client.shutdown();
    } catch {
      // ignore
    } finally {
      // Re-raise default behavior: exit with conventional 128 + signal number.
      // Using a small process.exit so Bun does not hang on lingering handles.
      process.exit(sig === "SIGINT" ? 130 : 143);
    }
  };
  process.on("exit", backupKill);
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  process.on("SIGHUP", onSignal);
  process.on("uncaughtException", (err) => {
    try {
      process.stderr.write(`scotty: uncaughtException: ${err?.stack ?? String(err)}\n`);
    } catch {
      // ignore
    }
    backupKill();
    process.exit(1);
  });

  // exitOnCtrlC: false — we run our own Ctrl-C handler (cancel → close → SIGTERM/SIGKILL)
  // inside the App via useInput, then call app.exit() ourselves. Letting Ink's default
  // handler win would kill the React tree before the cleanup sequence finishes.
  const { waitUntilExit } = render(<App client={client} />, { exitOnCtrlC: false });

  waitUntilExit().then(
    async () => {
      // React tree unmounted (either via app.exit() or natural end). Make sure
      // the child is gone before we return control to the shell.
      try {
        await client.shutdown();
      } catch {
        // ignore
      }
      if (debugSink) await debugSink.flush();
    },
    async (err) => {
      process.stderr.write(`scotty: Ink exited with error: ${err?.stack ?? String(err)}\n`);
      try {
        await client.shutdown();
      } catch {
        // ignore
      }
      if (debugSink) await debugSink.flush();
      process.exit(1);
    },
  );
}

main();
