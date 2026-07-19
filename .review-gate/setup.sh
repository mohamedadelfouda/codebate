#!/usr/bin/env bash
# Per-clone setup for review-gate. Git hooks are NOT shared by a clone on their
# own — each clone must point git at the versioned hooks directory once. Run this
# after cloning a repo that has review-gate installed:
#   bash setup.sh
set -euo pipefail
ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
[ -n "$ROOT" ] || { echo "❌ not inside a git repo." >&2; exit 1; }
cd "$ROOT"
if [ ! -d .githooks ]; then
  echo "❌ no .githooks/ directory here — is review-gate installed in this repo?" >&2; exit 1
fi
CUR="$(git config --local --get core.hooksPath 2>/dev/null || true)"
if [ -n "$CUR" ] && [ "$CUR" != ".githooks" ]; then
  echo "⚠ core.hooksPath is already '$CUR' (husky/another manager)." >&2
  echo "  NOT overriding it — that would disable your existing hooks. To enforce review-gate," >&2
  echo "  in $CUR/pre-commit:" >&2
  echo "    ROOT=\"\$(git rev-parse --show-toplevel)\"" >&2
  echo "    bash \"\$ROOT/.review-gate/review-gate.sh\" precommit || exit \$?" >&2
  echo "  in $CUR/pre-push:" >&2
  echo "    ROOT=\"\$(git rev-parse --show-toplevel)\"" >&2
  echo "    bash \"\$ROOT/.review-gate/review-gate.sh\" prepush || exit \$?" >&2
  exit 1
fi
git config core.hooksPath .githooks
chmod +x .githooks/* 2>/dev/null || true
echo "✓ core.hooksPath = .githooks — review-gate is now active for this clone."
echo "  (commit/push will be gated per .review-gate/gate.config.json)"
