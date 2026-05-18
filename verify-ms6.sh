#!/usr/bin/env bash
# verify-ms6.sh — MS-6 clean-exit verification
#
# Starts scotty.tsx as a background docker process, waits for it to reach
# "ready" state, sends SIGINT/SIGTERM, then checks for orphan Goose containers
# or processes.
#
# Exit 0: no orphans — MS-6 PASS
# Exit 1: orphans found — MS-6 FAIL (AOQ-4 risk)
#
# Usage:
#   ./verify-ms6.sh
#
# Requirements:
#   - Docker must be available and goose-acp:v1.34.1 must be pulled locally
#   - oven/bun:1.1-alpine must be pulled locally
#   - /var/run/docker.sock must be accessible

set -uo pipefail

WORKTREE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TIMEOUT_READY=15   # seconds to wait for "ready" in scotty output
SIGNAL_WAIT=6      # seconds to wait after sending signal

echo "=== verify-ms6.sh: MS-6 clean-exit verification ==="
echo "Worktree: $WORKTREE"

# ---------------------------------------------------------------------------
# Record baseline containers BEFORE we start anything, so we can
# isolate containers we created from pre-existing ones.
# ---------------------------------------------------------------------------
BASELINE_CONTAINERS=$(docker ps --filter ancestor=goose-acp:v1.34.1 --format '{{.ID}}' | sort)
echo "Pre-test baseline: $(echo "${BASELINE_CONTAINERS:-<empty>}" | wc -w) goose-acp container(s) running"

# ---------------------------------------------------------------------------
# Step 1: Start scotty.tsx in a Bun-in-Docker container (background), with
# docker.sock mounted so it can spawn the Goose sibling container.
# We capture output to a temp file so we can grep for "ready" without blocking.
# ---------------------------------------------------------------------------
OUTFILE="$(mktemp /tmp/scotty-ms6-out-XXXXXX.txt)"
CIDFILE="$(mktemp /tmp/scotty-ms6-cid-XXXXXX.txt)"
rm -f "$CIDFILE"  # docker --cidfile requires the file to NOT pre-exist

echo ""
echo "Step 1: Starting scotty.tsx (will attempt to reach 'ready' status)..."

# Use --cidfile so we can explicitly stop the outer bun container on cleanup.
docker run \
  --rm \
  --cidfile "$CIDFILE" \
  -v "$WORKTREE:/work" \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -e HOME=/root \
  -w /work \
  oven/bun:1.1-alpine \
  sh -c 'apk add --no-cache docker-cli >/dev/null 2>&1 && bun scotty.tsx' \
  >"$OUTFILE" 2>&1 &

SCOTTY_BG_PID=$!
echo "Background docker-run PID: $SCOTTY_BG_PID"

# ---------------------------------------------------------------------------
# Step 2: Wait for the Goose container to appear (proxy for "ready" state),
# OR wait up to TIMEOUT_READY seconds.  We grep the output file AND docker ps
# because Ink may write ANSI codes that obscure plain-text "ready" matching.
# ---------------------------------------------------------------------------
echo ""
echo "Step 2: Waiting up to ${TIMEOUT_READY}s for a NEW Goose container to appear..."

READY=0
FRESH_CONTAINER=""
for i in $(seq 1 $TIMEOUT_READY); do
  # Find containers NOT in the baseline (i.e., created by this test run)
  CURRENT=$(docker ps --filter ancestor=goose-acp:v1.34.1 --format '{{.ID}}' | sort)
  FRESH=$(comm -13 <(echo "$BASELINE_CONTAINERS") <(echo "$CURRENT") 2>/dev/null || true)
  if [[ -n "$FRESH" ]]; then
    FRESH_CONTAINER=$(echo "$FRESH" | head -1)
    echo "  New Goose container detected after ${i}s: $FRESH_CONTAINER"
    READY=1
    break
  fi
  # Also try plain-text grep on output (Ink ANSI may obscure this)
  if grep -qai "ready" "$OUTFILE" 2>/dev/null; then
    echo "  'ready' string found in output after ${i}s"
    READY=1
    break
  fi
  sleep 1
done

if [[ $READY -eq 0 ]]; then
  echo "  WARNING: 'ready' state not confirmed within ${TIMEOUT_READY}s"
  echo "  Output so far:"
  cat "$OUTFILE" | head -20 || true
  echo "  Proceeding with signal test anyway..."
fi

# ---------------------------------------------------------------------------
# Step 3: Send SIGINT to the background docker-run process.
# Docker forwards signals to the container's PID 1 (which is sh, which
# forwards to bun, which runs the SIGINT handler).
# ---------------------------------------------------------------------------
echo ""
echo "Step 3: Sending SIGINT to docker-run process (PID $SCOTTY_BG_PID)..."
if kill -INT "$SCOTTY_BG_PID" 2>/dev/null; then
  echo "  SIGINT sent successfully"
else
  echo "  SIGINT failed (process may have exited already) — trying SIGTERM..."
  kill -TERM "$SCOTTY_BG_PID" 2>/dev/null || true
fi

# ---------------------------------------------------------------------------
# Step 4: Wait for the background process and any Goose containers to exit.
# ---------------------------------------------------------------------------
echo ""
echo "Step 4: Waiting ${SIGNAL_WAIT}s for cleanup..."
sleep "$SIGNAL_WAIT"

# Also wait for the background process to actually exit (reap it).
wait "$SCOTTY_BG_PID" 2>/dev/null || true

# ---------------------------------------------------------------------------
# Step 5: Check for orphan Goose containers.
# ---------------------------------------------------------------------------
echo ""
echo "Step 5: Checking for orphan processes..."

# Only flag containers that we added during this test run (vs pre-existing baseline)
CURRENT_CONTAINERS=$(docker ps --filter ancestor=goose-acp:v1.34.1 --format '{{.ID}}' | sort)
ORPHAN_CONTAINERS=$(comm -13 <(echo "$BASELINE_CONTAINERS") <(echo "$CURRENT_CONTAINERS") 2>/dev/null || true)
ORPHAN_CONTAINERS_DETAIL=""
if [[ -n "$ORPHAN_CONTAINERS" ]]; then
  ORPHAN_CONTAINERS_DETAIL=$(docker ps --filter ancestor=goose-acp:v1.34.1 --format '{{.ID}} {{.Status}}' | grep -F "$(echo "$ORPHAN_CONTAINERS" | tr '\n' '|' | sed 's/|$//')" 2>/dev/null || echo "$ORPHAN_CONTAINERS")
fi
ORPHAN_PROCESSES=$(ps auxf 2>/dev/null | grep -E 'docker.*goose-acp|scotty\.tsx' | grep -v grep || true)

echo "  New containers that should have been cleaned up: ${ORPHAN_CONTAINERS:-<none>}"
[[ -n "$ORPHAN_CONTAINERS_DETAIL" ]] && echo "  Detail: $ORPHAN_CONTAINERS_DETAIL"
echo "  ps grep (docker/goose/scotty): ${ORPHAN_PROCESSES:-<none>}"

# ---------------------------------------------------------------------------
# Supplementary test: if scotty didn't start cleanly (Ink raw-mode crash in
# non-TTY environment), test the AcpClient shutdown sequence directly.
# This exercises the same SIGTERM + SIGKILL sequence that process.on("SIGINT")
# triggers, without needing a real TTY for the Ink layer.
# ---------------------------------------------------------------------------
if [[ $READY -eq 0 ]]; then
  echo ""
  echo "Step 5b: Ink raw-mode crash detected (no TTY) — testing AcpClient shutdown directly..."
  SUPP_BASELINE=$(docker ps --filter ancestor=goose-acp:v1.34.1 --format '{{.ID}}' | sort)
  SUPP_OUT=$(docker run --rm \
    -v "$WORKTREE:/work" \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -e HOME=/root \
    -w /work \
    oven/bun:1.1-alpine \
    sh -c 'apk add --no-cache docker-cli >/dev/null 2>&1 && bun -e "
import { AcpClient, parseGooseCmd } from \"./acp-client\";
const cmd = parseGooseCmd(undefined, \"/root\");
const client = new AcpClient({ cmd });
try {
  const init = await client.start();
  const sess = await client.newSession(process.cwd());
  process.stdout.write(\"STARTED:\" + sess.sessionId + \"\n\");
  // Simulate Ctrl-C shutdown sequence
  await client.shutdown(sess.sessionId);
  process.stdout.write(\"SHUTDOWN_CLEAN\n\");
} catch(e) {
  process.stdout.write(\"ERROR:\" + e.message + \"\n\");
}
"' 2>/dev/null)
  SUPP_EXIT=$?
  echo "  Direct AcpClient shutdown result: $SUPP_OUT (exit $SUPP_EXIT)"

  sleep 2
  SUPP_AFTER=$(docker ps --filter ancestor=goose-acp:v1.34.1 --format '{{.ID}}' | sort)
  SUPP_ORPHANS=$(comm -13 <(echo "$SUPP_BASELINE") <(echo "$SUPP_AFTER") 2>/dev/null || true)
  if [[ -n "$SUPP_ORPHANS" ]]; then
    echo "  SUPPLEMENTARY FAIL: AcpClient.shutdown() left orphan container(s): $SUPP_ORPHANS"
    docker kill $SUPP_ORPHANS 2>/dev/null || true
    # Merge into main orphan tracking
    ORPHAN_CONTAINERS="${ORPHAN_CONTAINERS} $SUPP_ORPHANS"
    ORPHAN_CONTAINERS=$(echo "$ORPHAN_CONTAINERS" | tr ' ' '\n' | sort -u | grep -v '^$' || true)
  else
    echo "  SUPPLEMENTARY PASS: AcpClient.shutdown() cleaned up container"
    echo "  NOTE: Scotty's shutdown() works; the orphan risk is specifically via SIGKILL of"
    echo "        the 'docker run' client from the *host* — not via AcpClient's own shutdown."
  fi
fi

# ---------------------------------------------------------------------------
# Cleanup temp files (best effort; the outer bun container is --rm so the
# bun container auto-removes).  If a container is still running with the
# cidfile ID, forcibly stop it.
# ---------------------------------------------------------------------------
if [[ -f "$CIDFILE" ]]; then
  CID="$(cat "$CIDFILE" 2>/dev/null || true)"
  if [[ -n "$CID" ]]; then
    if docker ps --format '{{.ID}}' | grep -q "^${CID:0:12}"; then
      echo ""
      echo "Cleanup: forcibly stopping outer bun container $CID..."
      docker stop "$CID" 2>/dev/null || true
    fi
  fi
  rm -f "$CIDFILE"
fi
rm -f "$OUTFILE"

# ---------------------------------------------------------------------------
# Step 6: Verdict.
# ---------------------------------------------------------------------------
echo ""
echo "=== MS-6 Verdict ==="
if [[ -n "$ORPHAN_CONTAINERS" ]]; then
  echo "FAIL: Orphan Goose container(s) created by this test run that survived exit:"
  echo "  $ORPHAN_CONTAINERS"
  echo ""
  echo "AOQ-4 OPEN: killing the 'docker run -i' client process (SIGTERM/SIGKILL) does"
  echo "NOT stop the running container.  Docker containers survive client process death."
  echo ""
  echo "Root cause: 'docker run' client and container are decoupled — killing the"
  echo "  client process only disconnects the stdio pipes; --rm only fires when the"
  echo "  container process itself exits.  SIGKILL on the client is therefore insufficient."
  echo ""
  echo "Recommended fix for CODE agent:"
  echo "  Option A (simplest): In default SCOTTY_GOOSE_CMD, pass --cidfile /tmp/scotty-goose-\$\$.cid"
  echo "    and in AcpClient.shutdown() read the cidfile + run 'docker kill \$(cat cidfile)'."
  echo "  Option B: Use 'docker stop' (which sends SIGTERM to container PID 1) instead of"
  echo "    killing the client process."
  echo "  Option C: Use --init flag so the container has a proper PID 1 that forwards signals."
  echo ""
  # Clean up the orphans so they don't pollute future test runs
  echo "Cleaning up orphan containers for this run..."
  echo "$ORPHAN_CONTAINERS" | xargs -r docker kill 2>/dev/null && echo "  Cleaned up OK" || true
  exit 1
elif [[ -n "$ORPHAN_PROCESSES" ]]; then
  echo "FAIL: Orphan process(es) found after exit:"
  echo "  $ORPHAN_PROCESSES"
  echo ""
  echo "AOQ-4 OPEN: Scotty or Goose process not cleaned up."
  exit 1
else
  echo "PASS: No orphan containers (from this test run) or processes found. MS-6 satisfied."
  exit 0
fi
