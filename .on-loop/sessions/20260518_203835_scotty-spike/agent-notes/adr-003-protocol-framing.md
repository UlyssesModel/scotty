# ADR-003: JSON-RPC framing — newline-delimited JSON (NDJSON)

**Status:** Accepted.
**Date:** 2026-05-18
**Phase:** Scotty-A spike.

## Context

JSON-RPC 2.0 specifies the message envelope but **not** the wire framing — how to delimit one message from the next on a byte-stream transport like stdio. Two conventional framings dominate:

1. **Newline-delimited JSON (NDJSON):** each message is a single JSON object terminated by `\n`. The message body MUST NOT contain a literal newline (it can — JSON allows whitespace in strings — but by convention serializers emit `JSON.stringify` which doesn't pretty-print).
2. **LSP-style Content-Length framing:** each message is prefixed by `Content-Length: <bytes>\r\n\r\n` and the message body follows as raw bytes. This is the framing the Language Server Protocol uses, and it tolerates embedded newlines in the JSON.

Scotty must choose one to implement. The architect ran a live probe against `goose-acp:v1.34.1` to observe the actual framing Goose uses on the wire.

## Decision

**Newline-delimited JSON (NDJSON).** Each request, response, and notification is a single JSON object on a single line, terminated by `\n`. No `Content-Length` headers.

### Wire shape

Sending:
```
<JSON object as one line>\n
<JSON object as one line>\n
```

Reading:
- Buffer incoming bytes from `child.stdout`;
- On each `\n`, take the preceding bytes, attempt `JSON.parse`, dispatch the resulting object;
- Discard empty lines (defensive — Goose doesn't emit any but we shouldn't crash if it did).

### Implementation sketch

```ts
async function readLoop(client: AcpClient, stdout: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of stdout) {
    buf += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (!line.trim()) continue;
      if (line.length > 1024 * 1024) {
        // Defensive cap; should never happen in normal operation
        console.warn("acp: line exceeds 1 MiB, truncating");
        continue;
      }
      try {
        const msg = JSON.parse(line);
        client.dispatch(msg);
      } catch (e) {
        // Log to .scotty.log if debug, otherwise emit a stderr event
        client.dispatchEvent(new CustomEvent("parse-error", { detail: { line, error: e } }));
      }
    }
  }
}
```

Writing:

```ts
function send(stdin: WritableStreamDefaultWriter<Uint8Array>, msg: object) {
  const line = JSON.stringify(msg) + "\n";
  stdin.write(new TextEncoder().encode(line));
}
```

## Evidence — live probe

Direct observation of `docker run -i --rm goose-acp:v1.34.1 acp` reveals NDJSON framing. Three responses returned to three requests:

```
{"jsonrpc":"2.0","result":{"protocolVersion":1,"agentCapabilities":...},"id":1}
{"jsonrpc":"2.0","result":{"sessionId":"20260518_1","modes":...},"id":2}
{"jsonrpc":"2.0","result":{"sessions":[]},"id":3}
```

Each on a single line, no Content-Length header, no `\r\n\r\n` separator, no any preamble. The implementation in `goose-acp` (binary symbol table reveals `Sending JSON-RPC message` / `Received JSON-RPC message` logs in the dispatch actor) confirms the runtime uses line-oriented JSON.

## Alternatives considered

### LSP-style Content-Length

- **Pros:** Tolerates embedded newlines in JSON; what LSP/MCP-over-stdio use; well-known to operators.
- **Cons:** Goose does not emit it. Implementing this client-side would require us to ALSO accept NDJSON (since that's what Goose sends), so we'd have two parsers — pointless.
- **Decision driver:** Goose's actual framing.

### Sentinel-byte framing (NUL-delimited, ASCII RS-delimited)

- **Pros:** Robust to JSON containing newlines.
- **Cons:** Niche; not what Goose uses; would not interoperate.
- **Decision driver:** Interop.

### Length-prefix with no header (raw 32-bit length)

- **Pros:** Compact.
- **Cons:** Not what Goose uses; harder to debug (not human-readable in `cat`).
- **Decision driver:** Interop + debuggability.

## Consequences

**Positive:**

- Trivial to implement (~30 lines).
- Trivial to debug: `cat /tmp/.scotty.log` shows readable JSON-RPC traffic.
- Interoperates with Goose's actual emit format.
- No edge cases with binary content (images/audio are base64-encoded strings inside the JSON, so still safe under JSON.stringify).

**Negative / trade-offs:**

- If Goose ever switches to Content-Length (e.g., to support multi-megabyte image content with embedded newlines in some future version), Scotty would need to update. Mitigation: detect the `Content-Length:` preamble at the first byte of stdout and switch parser if present. Out of scope for the spike — but adding a one-line detection is cheap.
- If `JSON.stringify` ever produces a string containing a literal `\n` (it doesn't — `\n` in string values is encoded as `\\n`), the wire would break. JSON.stringify never emits raw `\n` outside of pretty-printing, which we don't use.
- A buffer flooding attack (Goose emits a single 1-GiB line without `\n`) would OOM the client. Mitigation: the 1-MiB-per-line cap above.

**Reversibility:** High. The parser sits behind the `AcpClient` class — swapping framing is local.

## References

- Live probe transcript: `architect.md` Appendix A.
- JSON-RPC 2.0 spec: https://www.jsonrpc.org/specification (does not specify framing).
- LSP base protocol (the framing we are NOT using): https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#baseProtocol.
- ACP spec (Goose's ACP server implementation): Goose source `crates/goose/src/acp/server/dispatch.rs` (referenced in binary symbol table).
