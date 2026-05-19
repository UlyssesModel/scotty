# ADR-004: ACP protocol version negotiation — send `1`, verify echo

**Status:** Accepted.
**Date:** 2026-05-18
**Phase:** Scotty-A spike.

## Context

The architect prompt (and earlier Track 2 validation notes) stated that Goose returns `protocolVersion: 0` in response to `initialize`. The implication was that Phase A should lock to `0`.

The architect ran an independent live probe to validate this claim. Findings:

- Sending `initialize` with `params.protocolVersion: 0` → Goose responds with `result.protocolVersion: 0`.
- Sending `initialize` with `params.protocolVersion: 1` → Goose responds with `result.protocolVersion: 1`.

In other words, **Goose `1.34.1` echoes back whatever protocolVersion the client requests**. There is no real negotiation happening; Goose accepts both `0` and `1`. This means the earlier "Goose returns 0" observation simply reflects that the earlier probe sent `0`.

The binary's symbol table (`strings /usr/local/bin/goose` of the image) shows struct schemas like `InitializeRequest with 4 elements`, `NewSessionRequest with 4 elements`, etc., consistent with ACP's current `protocolVersion: 1` schema. The `loadSession`, `promptCapabilities`, `mcpCapabilities`, `sessionCapabilities` fields in the `agentCapabilities` response object all correspond to ACP v1 features.

We therefore must choose: send `0`, send `1`, or send some other value.

## Decision

**Send `protocolVersion: 1` in `initialize`. After response, verify `result.protocolVersion === 1`. If it differs, log a warning to stderr (and `.scotty.log` if debug is on) but proceed.**

The verification is light-touch: we proceed even with a mismatch, because:

- A future Goose that downgrades to `0` is probably still wire-compatible (the schemas are identical for the spike's narrow surface).
- A hypothetical future Goose returning `2` may still be backward-compatible for the methods we use.
- The warning gives downstream operators the signal to investigate without blocking the spike.

## Alternatives considered

### Send `0`

- **Pros:** Matches the earlier Track 2 observation.
- **Cons:** Misleading — Track 2's observation was an artifact of the probe, not an authoritative protocol version. `0` is not a real ACP protocol version per the upstream spec. Future Goose versions may stop accepting `0`.
- **Decision driver:** Choose the version that aligns with the binary's actual schemas and the upstream ACP spec.

### Send `"1.0"` as a string

- **Pros:** Some docs sample show string version literals.
- **Cons:** The Goose binary's struct shows `protocolVersion: u32` (an integer); sending a string would fail deserialization. Live probe confirms integer.
- **Decision driver:** Wire fidelity.

### Implement full negotiation (try `1`, fall back to `0` on error)

- **Pros:** Defensive against version mismatch.
- **Cons:** Adds branching to startup; we have no Goose version that errors on `1`; YAGNI for the spike.
- **Decision driver:** Spike scope; verify-and-warn is sufficient.

## Consequences

**Positive:**

- Aligned with what the binary's schemas actually expect.
- Forward-compatible: if Goose adds `protocolVersion: 2`, Scotty's verify-and-warn behavior surfaces the divergence at startup.
- One-line implementation (`if (result.protocolVersion !== 1) console.warn(...)`).

**Negative / trade-offs:**

- If a hypothetical Goose 1.40.x changes wire shape under `protocolVersion: 1` (e.g., a field rename), Scotty will silently break — the version number alone won't catch that. The mitigation is integration testing (which is MS-3 / MS-4 / MS-5 in the spike).
- We're "negotiating" with a server that just echoes. If we later integrate with a strict ACP implementation (e.g., a non-Goose ACP agent that enforces a min version), our default of `1` will be the right choice; if such an agent requires `0`, the operator can patch Scotty.

**Reversibility:** Trivial. Change `protocolVersion: 1` to whatever's required. The verify-and-warn helper makes the swap a one-line code change.

## References

- Live probe transcript: `architect.md` Appendix A — two separate `initialize` runs with `0` and `1` showing echo behavior.
- Goose binary symbol table strings (Appendix A): struct schemas consistent with ACP v1.
- ACP spec (informational): https://agentclientprotocol.dev/ (current published version describes `protocolVersion: 1`).
