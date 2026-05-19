# ADR-002: Goose deployment — Docker subprocess with overridable `SCOTTY_GOOSE_CMD`

**Status:** Accepted.
**Date:** 2026-05-18
**Phase:** Scotty-A spike.

## Context

The Phase A spike needs to spawn Goose as a stdio-piped child process. Two facts constrain how:

1. **Native Goose does not run on this host.** The architect verified that the upstream Goose Linux binary requires a newer glibc/libstdc++ than Rocky 9 ships. Earlier deployment attempts (Track 2 on 2026-05-18) confirmed `goose-acp:v1.34.1` (the Docker image) is the only working path.
2. **The deployment surface will diversify.** Future Mirepoix builder hosts may run Debian/Ubuntu with a new-enough glibc to support native Goose; CI runners may run a different container runtime (e.g., Podman); development laptops may want to substitute a local `goose` build.

Therefore the spike must:

- Default to the working Docker invocation on Rocky 9 hosts;
- Allow operators on other host shapes to substitute a different command **without code changes**;
- Avoid invoking a shell (which would open a CWE-78 command-injection path if anyone ever interpolates user data into the command string);
- Mount the operator's pre-configured `~/.config/goose` into the container so Goose has its provider config without an interactive `goose configure` step inside the container.

The architect prompt asked us to choose between (a) mounting a pre-configured volume vs (b) documenting a one-time `docker run -it goose-acp:v1.34.1 configure` setup. We chose (a) because it fits the "operator runs `bun scotty.tsx` and it works" workflow with no pre-launch ritual beyond `goose configure` on the host once (which the operator does for `goose` anyway, even when not using Scotty).

## Decision

**Goose runs as a Docker subprocess. The exact command is controlled by env var `SCOTTY_GOOSE_CMD`. The default is a `docker run` invocation that mounts `~/.config/goose` read-only into the container.**

### Default command

```
docker run -i --rm -v $HOME/.config/goose:/root/.config/goose:ro goose-acp:v1.34.1 acp
```

Reasoning for each flag:

| Flag | Why |
|---|---|
| `-i` | Attach stdin so Scotty can write JSON-RPC requests. (No `-t` — we don't want a pseudo-TTY; ACP is line-buffered text.) |
| `--rm` | Auto-remove the container on exit so we don't accumulate stopped containers. Pairs with the `Bun.spawn` lifecycle. |
| `-v $HOME/.config/goose:/root/.config/goose:ro` | Mount provider config read-only. Goose reads it at startup; container can't tamper with it. The `:ro` is a defense against a hypothetical container-escape modifying host secrets. |
| `goose-acp:v1.34.1` | Pinned image tag (NOT `:latest`). Reproducibility. |
| `acp` | The Goose subcommand that starts the ACP server on stdio. |

### Env-var override mechanism

Scotty reads `SCOTTY_GOOSE_CMD` at startup:

```ts
const rawCmd = process.env.SCOTTY_GOOSE_CMD
  ?? `docker run -i --rm -v ${process.env.HOME}/.config/goose:/root/.config/goose:ro goose-acp:v1.34.1 acp`;
const argv = rawCmd.split(/\s+/).filter(Boolean);
const child = Bun.spawn({ cmd: argv, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
```

### Whitespace-split parse strategy

`SCOTTY_GOOSE_CMD` is split on ASCII whitespace (`.split(/\s+/).filter(Boolean)`). **No shell interpretation. No quoted-arg parsing. No `$VAR` expansion** beyond the resolution of `$HOME` we perform when constructing the default.

This is sufficient for every realistic command shape an operator would supply:

- `docker run -i --rm -v /home/me/.config/goose:/root/.config/goose:ro goose-acp:v1.34.1 acp` ✅
- `podman run -i --rm goose-acp:v1.34.1 acp` ✅
- `/usr/local/bin/goose acp` ✅ (native install on a host that supports it)
- `goose acp --with-builtin developer` ✅
- `ssh builder@10.0.0.5 goose acp` ✅ (run Goose on a remote host)

Cases the spike does NOT support (and explicitly documents as out of scope):

- Args containing whitespace (`/path/with spaces/goose`) — would need shlex.
- Args containing shell quoting (`"--option=value with space"`) — would need shlex.
- Shell pipes/redirections (`docker run ... acp | tee /tmp/log`) — would need a shell wrapper.

If any of those become necessary, the operator can write a wrapper shell script and point `SCOTTY_GOOSE_CMD=/path/to/wrapper.sh`. This is documented in the README.

### Why not shlex-style parsing

- Adds a dependency (no built-in shlex in Bun/Node; would need a tiny implementation or a package — both violate NQ-2).
- For the spike's realistic argv shapes, whitespace-split is correct.
- The fallback (wrapper script) covers any case we missed.
- Per Open Question raised in the architect prompt: "If you think a different split strategy is warranted, justify it in an ADR." We do not think it's warranted; whitespace-split + wrapper-script escape hatch is the simplest correct solution.

## Alternatives considered

### (b) One-time `docker run -it goose-acp:v1.34.1 configure` and persist a named volume

- **Pros:** No host-FS dependency in the run command.
- **Cons:** Requires the operator to perform a one-time interactive setup with the container; the configure data lives in a Docker volume which is harder to back up, inspect, or rotate than `~/.config/goose/config.yaml`. Operator who already uses `goose` from the CLI has the host config and would re-do it.
- **Decision driver:** (a) is more ergonomic for an operator who already uses Goose; one source of truth for provider config.

### Building Goose from source on the host

- **Pros:** No container.
- **Cons:** Requires Rust toolchain + many systems deps; doesn't address the glibc/libstdc++ root cause for the official binary; introduces drift between operators.
- **Decision driver:** Spike scope. Out of scope.

### Using `--cap-drop=ALL --network=...` to constrain the container

- **Pros:** Defense-in-depth — limits what Goose can do.
- **Cons:** Adds complexity; the spike's threat model trusts Goose (which the operator has chosen to run); Mirepoix's broader deny-all-egress story (per ADR-010 in the parent monorepo) addresses this for production, not for the spike.
- **Decision driver:** Out of scope for the spike. Reviewer / security agent should note this as a follow-up.

### Bare `goose acp` without docker

- **Pros:** Simpler default.
- **Cons:** Fails on Rocky 9 (the canonical deployment host). The default must work out of the box.
- **Decision driver:** The default must work on the deployment host.

## Consequences

**Positive:**

- Default works on Rocky 9 with zero ceremony beyond `docker pull goose-acp:v1.34.1` (or local build) + `goose configure` on the host once.
- Future hosts (Debian/Ubuntu with native Goose, Podman hosts, remote SSH-tunneled Goose) work by setting one env var.
- No shell, no injection vector — the parse is whitespace-split into argv, passed directly to `Bun.spawn`.
- Container auto-cleanup via `--rm` aligns with MS-6 ("no orphan child process after exit").
- Provider config is read-only mounted, defending against accidental tampering by the container.

**Negative / trade-offs:**

- MS-3's 5-second initialize budget assumes the image is already pulled. Cold pull on first run will exceed it. README must call this out.
- Docker socket access is required for the operator's user (group `docker`). Documented in README.
- Goose runs as `root` inside the container (default `goose-acp:v1.34.1` image entrypoint). If the operator's threat model objects, they can run a Goose-built-as-non-root image and override `SCOTTY_GOOSE_CMD`. Out of scope for spike.
- AOQ-4 (signal propagation through `docker run`): SIGTERM from Bun.spawn to the docker client may not always be cleanly relayed to PID 1 in the container. Mitigation: send `session/cancel` notification first, then `session/close` request (which Goose handles gracefully), then SIGTERM, then SIGKILL after 500ms. If MS-6 still fails, fall back to capturing the container ID via `--cidfile=/tmp/scotty-$$.cid` and `docker kill` explicitly. Defer to CODE phase to confirm and document.

**Reversibility:** High. Switching the default to native `goose acp` is a one-line change; the env-var override is the same mechanism in both directions.

## References

- Track 2 validation transcript (2026-05-18) — verified the Docker invocation works against Goose 1.34.1.
- Live probe (Appendix A of `architect.md`) — confirms `goose-acp:v1.34.1 acp` responds to `initialize` and `session/new` over stdio.
- ADR-010 of `kavara-mirepoix-internal` — deny-all-egress play (informational; not enforced for the spike).
