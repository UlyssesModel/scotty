# Build Report

## Reproducibility (bun install --frozen-lockfile in fresh dir)
- Result: PASS
- Packages installed: 50 (5 direct + 45 transitive; `ls node_modules/ | wc -l` = 45 directories + .bin = 46 entries; bun reports 50 including root)
- Time: 520ms (Docker container cold start adds ~940ms wall-clock; bun install proper = 520ms)
- Lockfile: `bun.lock` (text format) resolves correctly from scratch — no network required beyond what was already in the frozen lock
- Ownership: `bun.lock` is jekavara:jekavara (correct; not root from Docker)

## Dry compile
- acp-client.ts: PASS — 7ms, 11.86 KB (1 module bundled; exit 0)
- scotty.tsx (with --external=react-devtools-core): PASS — 86ms, 1078.80 KB (516 modules bundled; exit 0)
- No errors or warnings from either compile invocation.

## .gitignore
- Status: modified — added `.smoke.tsx` defensive entry
- Pre-existing entries all confirmed correct: `node_modules/`, `*.log`, `.scotty.log` (redundant with `*.log` but explicit), `.DS_Store`, `bun.lockb` (binary lockfile excluded; text `bun.lock` committed)
- Added: `.smoke.tsx` — defensive exclusion for orchestrator temp files

## package.json
- Scripts before: `start`, `dev`
- Scripts after: `start`, `dev`, `verify`, `build-check`
- Added `"verify": "./verify.sh"` — `verify.sh` is executable (`-rwxr-xr-x`); no new dependencies introduced; makes the automated MS-1..MS-6 suite runnable via `bun run verify`
- Added `"build-check": "bun build --target=bun scotty.tsx --outfile=/dev/null --external=react-devtools-core"` — drives the dry-compile check; no new dependencies; useful for pre-commit or manual validation

## Worktree state
- git status: `README.md` modified (documentation phase changes); all spike source files untracked and ready to stage: `.gitignore`, `acp-client.ts`, `bun.lock`, `package.json`, `scotty.tsx`, `verify-ms6.sh`, `verify-protocol.ts`, `verify.sh`
- No stray temp files: `find -maxdepth 1 -name "*.smoke.*" -o -name ".smoke.*" -o -name "*.tmp"` returned nothing
- bun.lock ownership: jekavara:jekavara (correct; prior Docker runs used `sudo chown` cleanup — already applied by tester)
- node_modules/ present in worktree (not staged, covered by .gitignore)

## Recommendation
PROCEED to REVIEW. Reproducibility PASS, both dry compiles PASS, .gitignore complete, package.json scripts sensible. Worktree is clean and committable — all spec-allowlist files present, no stray artifacts.
