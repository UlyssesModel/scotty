/**
 * verify-protocol.ts — MS-2 + MS-3 protocol integration harness
 *
 * Exercises AcpClient directly (no Ink UI rendering) against the real
 * goose-acp:v1.34.1 Docker image.  Verifies:
 *   - MS-2: AcpClient.start() completes, protocolVersion === 1
 *   - MS-3: initialize → session/new completes in < 5000 ms
 *
 * Assertions:
 *   - start() returns InitializeResult with protocolVersion === 1
 *   - newSession(process.cwd()) returns a non-empty sessionId string
 *   - elapsed time from start() call to newSession() completion < 5000 ms
 *   - close(sessionId) resolves without error
 *   - shutdown() terminates the child cleanly
 *
 * Exit 0 on all assertions passing; non-zero on any failure.
 *
 * Invocation (from outside: from host via docker run --rm with docker.sock):
 *   docker run --rm \
 *     -v <worktree>:/work \
 *     -v /var/run/docker.sock:/var/run/docker.sock \
 *     -v $HOME/.config/goose:/root/.config/goose:ro \
 *     -w /work \
 *     -e HOME=/root \
 *     oven/bun:1.1-alpine \
 *     sh -c 'apk add --no-cache docker-cli >/dev/null 2>&1 && bun verify-protocol.ts'
 */

import { AcpClient, parseGooseCmd } from "./acp-client";
import type { InitializeResult, NewSessionResult } from "./acp-client";

// ---------------------------------------------------------------------------
// Minimal assertion helpers — no test framework needed.
// ---------------------------------------------------------------------------

let failures = 0;
let checks = 0;

function assert(cond: boolean, msg: string): void {
  checks++;
  if (!cond) {
    failures++;
    console.error(`  FAIL: ${msg}`);
  } else {
    console.log(`  PASS: ${msg}`);
  }
}

function assertEq<T>(actual: T, expected: T, label: string): void {
  assert(actual === expected, `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function assertTruthy(val: unknown, label: string): void {
  assert(!!val, `${label}: expected truthy, got ${JSON.stringify(val)}`);
}

function assertLt(actual: number, limit: number, label: string): void {
  assert(actual < limit, `${label}: expected < ${limit}, got ${actual}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("verify-protocol.ts — MS-2 + MS-3 AcpClient integration test");
  console.log("============================================================");

  // Resolve the Goose command.  Inside the Docker-in-Docker setup, SCOTTY_GOOSE_CMD
  // may be overridden.  We pass HOME=/root so the default command mounts
  // /root/.config/goose (the path the outer -v mount lands at).
  const cmd = parseGooseCmd(process.env.SCOTTY_GOOSE_CMD, process.env.HOME ?? "/root");
  console.log(`\nGoose cmd: ${cmd.join(" ")}`);

  const debugLines: string[] = [];
  const client = new AcpClient({
    cmd,
    onDebug: (line) => debugLines.push(line),
  });

  // Forward stderr from Goose to our console so failures are visible.
  client.addEventListener("stderr", (ev) => {
    const line = (ev as CustomEvent<string>).detail;
    process.stderr.write(`[goose stderr] ${line}\n`);
  });

  console.log("\n--- MS-2 + MS-3: initialize handshake ---");

  const t0 = Date.now();
  let initResult: InitializeResult;
  try {
    initResult = await client.start();
  } catch (e) {
    console.error(`FATAL: client.start() threw: ${(e as Error).message}`);
    if (debugLines.length > 0) {
      console.error("Debug log:");
      for (const l of debugLines.slice(-20)) console.error(`  ${l}`);
    }
    process.exit(1);
  }

  const initElapsed = Date.now() - t0;
  console.log(`  initialize elapsed: ${initElapsed} ms`);

  assertEq(initResult.protocolVersion, 1, "protocolVersion");
  assertTruthy(initResult.agentCapabilities, "agentCapabilities present");

  // --- MS-3: session/new ---
  console.log("\n--- MS-3: session/new ---");

  let sessResult: NewSessionResult;
  try {
    sessResult = await client.newSession(process.cwd());
  } catch (e) {
    console.error(`FATAL: client.newSession() threw: ${(e as Error).message}`);
    await client.shutdown();
    process.exit(1);
  }

  const totalElapsed = Date.now() - t0;
  console.log(`  session/new elapsed (total from start): ${totalElapsed} ms`);

  assertTruthy(sessResult.sessionId && sessResult.sessionId.length > 0, "sessionId non-empty");
  assertTruthy(sessResult.modes?.currentModeId, "modes.currentModeId present");
  assertLt(totalElapsed, 5000, "initialize + session/new within 5000 ms (MS-3)");

  console.log(`  sessionId: ${sessResult.sessionId}`);
  console.log(`  mode: ${sessResult.modes.currentModeId}`);

  // --- session/close ---
  console.log("\n--- session/close ---");
  try {
    await client.close(sessResult.sessionId);
    assert(true, "session/close resolved cleanly");
  } catch (e) {
    assert(false, `session/close threw: ${(e as Error).message}`);
  }

  // --- shutdown ---
  console.log("\n--- shutdown ---");
  try {
    await client.shutdown();
    assert(true, "shutdown() completed without throwing");
  } catch (e) {
    assert(false, `shutdown() threw: ${(e as Error).message}`);
  }

  // --- Summary ---
  console.log(`\n============================================================`);
  console.log(`Results: ${checks - failures}/${checks} checks passed`);
  if (failures > 0) {
    console.error(`FAIL — ${failures} assertion(s) failed`);
    process.exit(1);
  } else {
    console.log("PASS — all assertions satisfied");
    process.exit(0);
  }
}

main().catch((err) => {
  console.error(`Unhandled error: ${err?.stack ?? String(err)}`);
  process.exit(1);
});
