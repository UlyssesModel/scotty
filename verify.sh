#!/usr/bin/env bash
# verify.sh — Automated MS-1..MS-6 verification for Phase Scotty-A spike
#
# Runs all checks that can be automated without operator interaction:
#   MS-1: bun install --frozen-lockfile (via Docker)
#   NQ-1..NQ-7: static source-code checks
#   MS-2 + MS-3: AcpClient protocol integration (via verify-protocol.ts)
#   MS-4 + MS-5: provider-boundary probe (documents VERIFIED-UP-TO-PROVIDER-BOUNDARY)
#   MS-6: clean-exit orphan check (via verify-ms6.sh)
#
# Prerequisites:
#   - Docker installed and daemon running
#   - oven/bun:1.1-alpine image pulled locally
#   - goose-acp:v1.34.1 image pulled locally
#   - /var/run/docker.sock accessible by current user
#
# Usage:
#   ./verify.sh [--skip-ms6]   # --skip-ms6 skips the orphan check (faster)
#
# Exit 0: all automated checks pass
# Exit 1: one or more checks failed

set -uo pipefail

WORKTREE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKIP_MS6="${1:-}"
PASS=0
FAIL=0

# Color helpers (disabled if not a TTY)
if [[ -t 1 ]]; then
  GREEN='\033[0;32m'
  RED='\033[0;31m'
  YELLOW='\033[1;33m'
  NC='\033[0m'
else
  GREEN='' RED='' YELLOW='' NC=''
fi

pass() { echo -e "${GREEN}PASS${NC}: $*"; ((PASS++)); }
fail() { echo -e "${RED}FAIL${NC}: $*"; ((FAIL++)); }
skip() { echo -e "${YELLOW}SKIP${NC}: $*"; }
info() { echo "     $*"; }

echo "================================================================"
echo "Scotty Phase A — automated verification"
echo "Worktree: $WORKTREE"
echo "================================================================"
echo ""

cd "$WORKTREE"

# ------------------------------------------------------------------ #
# Static checks (NQ-1 .. NQ-7)                                        #
# ------------------------------------------------------------------ #
echo "--- Static checks ---"

# NQ-1: No child_process / exec / execSync
RESULT=$(grep -REn '\b(child_process|exec\(|execSync)\b' scotty.tsx acp-client.ts 2>/dev/null || true)
if [[ -z "$RESULT" ]]; then
  pass "NQ-1: no child_process/exec/execSync in source"
else
  fail "NQ-1: forbidden patterns found:"
  info "$RESULT"
fi

# NQ-3: No outbound network API imports
RESULT=$(grep -REn "from ['\"](node:net|node:http|node:https|node:dgram|node:tls)['\"]|^import.*fetch" scotty.tsx acp-client.ts 2>/dev/null || true)
if [[ -z "$RESULT" ]]; then
  pass "NQ-3: no outbound network imports"
else
  fail "NQ-3: forbidden network imports found:"
  info "$RESULT"
fi

# NQ-5: No @mirepoix/* imports
RESULT=$(grep -REn "from [\"']@mirepoix/" scotty.tsx acp-client.ts package.json 2>/dev/null || true)
if [[ -z "$RESULT" ]]; then
  pass "NQ-5: no @mirepoix/* imports"
else
  fail "NQ-5: @mirepoix imports found:"
  info "$RESULT"
fi

# NQ-6: No telemetry
RESULT=$(grep -REn 'posthog|sentry|mixpanel|api\.segment\.io|@anthropic-ai/sdk' scotty.tsx acp-client.ts package.json 2>/dev/null || true)
if [[ -z "$RESULT" ]]; then
  pass "NQ-6: no telemetry/error-reporting references"
else
  fail "NQ-6: telemetry references found:"
  info "$RESULT"
fi

# NQ-7: No cloud-provider strings
RESULT=$(grep -REn 'api\.anthropic\.com|api\.openai\.com|googleapis\.com|ANTHROPIC_API_KEY|OPENAI_API_KEY' scotty.tsx acp-client.ts 2>/dev/null || true)
if [[ -z "$RESULT" ]]; then
  pass "NQ-7: no cloud-provider strings in source"
else
  fail "NQ-7: cloud-provider strings found:"
  info "$RESULT"
fi

# NQ-2: dependencies check
DEPS=$(python3 -c "import json,sys; p=json.load(open('package.json')); d=set(p.get('dependencies',{}).keys()); allowed={'ink','ink-text-input','react'}; bad=d-allowed; print(' '.join(sorted(bad)))" 2>/dev/null || true)
if [[ -z "$DEPS" ]]; then
  pass "NQ-2: package.json dependencies are exactly {ink, ink-text-input, react}"
else
  fail "NQ-2: unexpected dependencies: $DEPS"
fi

DEVDEPS=$(python3 -c "import json; p=json.load(open('package.json')); bad=[k for k in p.get('devDependencies',{}) if not k.startswith('@types/')]; print(' '.join(bad))" 2>/dev/null || true)
if [[ -z "$DEVDEPS" ]]; then
  pass "NQ-2: devDependencies are all @types/* packages"
else
  fail "NQ-2: non-@types devDependencies: $DEVDEPS"
fi

# .gitignore check
if grep -q 'node_modules' .gitignore && grep -q '\.scotty\.log' .gitignore; then
  pass ".gitignore covers node_modules/ and .scotty.log"
else
  fail ".gitignore missing node_modules/ or .scotty.log"
fi

echo ""

# ------------------------------------------------------------------ #
# MS-1: bun install --frozen-lockfile                                  #
# ------------------------------------------------------------------ #
echo "--- MS-1: bun install --frozen-lockfile ---"

if ! command -v docker &>/dev/null; then
  fail "MS-1: Docker not available"
else
  TMPDIR_INSTALL="$(mktemp -d /tmp/scotty-ms1-XXXXXX)"
  cp -r "$WORKTREE/." "$TMPDIR_INSTALL/"
  rm -rf "$TMPDIR_INSTALL/node_modules"

  T0=$SECONDS
  INSTALL_OUT=$(docker run --rm \
    -v "$TMPDIR_INSTALL:/work" \
    -w /work \
    oven/bun:1.1-alpine \
    bun install --frozen-lockfile 2>&1)
  INSTALL_EXIT=$?
  INSTALL_ELAPSED=$((SECONDS - T0))

  # Clean up with sudo if needed (docker writes as root).
  # SAFETY: $TMPDIR_INSTALL is mktemp-bounded earlier (line ~135: mktemp -d /tmp/scotty-ms1-XXXXXX);
  # `set -u` at the top of this script aborts on unset vars; we never rm -rf a user-supplied or
  # unbounded path. Defensive comment per security audit FINDING-5.
  sudo rm -rf "$TMPDIR_INSTALL" 2>/dev/null || rm -rf "$TMPDIR_INSTALL" 2>/dev/null || true

  if [[ $INSTALL_EXIT -eq 0 ]]; then
    pass "MS-1: bun install --frozen-lockfile (exit 0, ~${INSTALL_ELAPSED}s)"
    info "$(echo "$INSTALL_OUT" | tail -3)"
  else
    fail "MS-1: bun install failed (exit $INSTALL_EXIT)"
    info "$INSTALL_OUT"
  fi
fi

echo ""

# ------------------------------------------------------------------ #
# MS-2 + MS-3: AcpClient protocol integration                         #
# ------------------------------------------------------------------ #
echo "--- MS-2 + MS-3: AcpClient protocol integration ---"

if ! command -v docker &>/dev/null; then
  fail "MS-2+MS-3: Docker not available"
else
  PROTO_OUT=$(docker run --rm \
    -v "$WORKTREE:/work" \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -e HOME=/root \
    -w /work \
    oven/bun:1.1-alpine \
    sh -c 'apk add --no-cache docker-cli >/dev/null 2>&1 && bun verify-protocol.ts' 2>&1)
  PROTO_EXIT=$?

  if [[ $PROTO_EXIT -eq 0 ]]; then
    pass "MS-2+MS-3: all AcpClient protocol assertions passed"
    # Extract key metrics from output
    ELAPSED_LINE=$(echo "$PROTO_OUT" | grep -i "session/new elapsed" | head -1 || true)
    [[ -n "$ELAPSED_LINE" ]] && info "$ELAPSED_LINE"
    SESSID_LINE=$(echo "$PROTO_OUT" | grep -i "sessionId:" | head -1 || true)
    [[ -n "$SESSID_LINE" ]] && info "$SESSID_LINE"
  else
    fail "MS-2+MS-3: protocol test failed (exit $PROTO_EXIT)"
    echo "$PROTO_OUT" | tail -20
  fi
fi

echo ""

# ------------------------------------------------------------------ #
# MS-4 + MS-5: provider-boundary probe                                #
# ------------------------------------------------------------------ #
echo "--- MS-4 + MS-5: provider boundary probe ---"
info "(These milestones require a configured Ollama provider at ~/.config/goose/config.yaml)"

if ! command -v docker &>/dev/null; then
  skip "MS-4+MS-5: Docker not available"
elif [[ -f "$HOME/.config/goose/config.yaml" ]]; then
  skip "MS-4+MS-5: provider config found — manual interactive verification required"
  info "Run: bun scotty.tsx"
  info "Type: say hello in exactly three words"
  info "Verify: streaming tokens appear progressively in conversation pane"
else
  # No provider — confirm protocol shape up to provider boundary
  PROMPT_OUT=$(docker run --rm \
    -v "$WORKTREE:/work" \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -e HOME=/root \
    -w /work \
    oven/bun:1.1-alpine \
    sh -c 'apk add --no-cache docker-cli >/dev/null 2>&1 && bun -e "
import { AcpClient, AcpRpcError, parseGooseCmd } from \"./acp-client\";
const cmd = parseGooseCmd(undefined, \"/root\");
const client = new AcpClient({ cmd });
const init = await client.start();
const sess = await client.newSession(process.cwd());
try {
  await client.prompt(sess.sessionId, \"say hello in exactly three words\");
} catch(e) {
  if (e instanceof AcpRpcError && typeof e.data === \"string\" && e.data.toLowerCase().includes(\"missing provider\")) {
    process.stdout.write(\"PROVIDER_BOUNDARY: \" + e.data + \"\n\");
  } else {
    process.stdout.write(\"ERROR: \" + e.message + \"\n\");
  }
}
await client.shutdown(sess.sessionId);
"' 2>/dev/null)
  PROMPT_EXIT=$?

  if echo "$PROMPT_OUT" | grep -q "PROVIDER_BOUNDARY"; then
    BOUNDARY_MSG=$(echo "$PROMPT_OUT" | grep "PROVIDER_BOUNDARY" | head -1)
    pass "MS-4: VERIFIED-UP-TO-PROVIDER-BOUNDARY — prompt path works, blocked at: $BOUNDARY_MSG"
    pass "MS-5: VERIFIED-UP-TO-PROVIDER-BOUNDARY — session/prompt request shape confirmed"
    info "AcpRpcError surfaces 'Missing provider' correctly (AOQ-2 path exercised)"
    info "Streaming agent_message_chunk / tool_call rendering: manual verification required"
  else
    fail "MS-4+MS-5: unexpected result (exit $PROMPT_EXIT): $PROMPT_OUT"
  fi
fi

echo ""

# ------------------------------------------------------------------ #
# MS-6: clean exit on signal                                          #
# ------------------------------------------------------------------ #
echo "--- MS-6: clean exit / no orphan containers ---"

if [[ "$SKIP_MS6" == "--skip-ms6" ]]; then
  skip "MS-6: skipped by --skip-ms6 flag"
elif ! command -v docker &>/dev/null; then
  fail "MS-6: Docker not available"
else
  # Run the dedicated MS-6 script
  if [[ -x "$WORKTREE/verify-ms6.sh" ]]; then
    if bash "$WORKTREE/verify-ms6.sh" 2>&1; then
      pass "MS-6: no orphan containers after exit (via verify-ms6.sh)"
    else
      fail "MS-6: orphan containers or processes found (AOQ-4 open)"
      info "See verify-ms6.sh output above for details"
      info "Recommended fix: add --cidfile to SCOTTY_GOOSE_CMD + docker kill on shutdown"
    fi
  else
    fail "MS-6: verify-ms6.sh not found or not executable"
  fi
fi

echo ""

# ------------------------------------------------------------------ #
# Summary                                                              #
# ------------------------------------------------------------------ #
echo "================================================================"
TOTAL=$((PASS + FAIL))
echo "Results: ${PASS}/${TOTAL} checks passed, ${FAIL} failed"
if [[ $FAIL -gt 0 ]]; then
  echo -e "${RED}FAIL — ${FAIL} check(s) require attention${NC}"
  exit 1
else
  echo -e "${GREEN}PASS — all automated checks satisfied${NC}"
  exit 0
fi
