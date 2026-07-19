#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────
# review-gate — a tool-agnostic review + verify gate for git repositories.
#
# Enforces a "review before it lands" protocol at EITHER `git commit` time
# (default for local-only repos) OR `git push` time. Works with ANY actor that
# runs git — a terminal, a human, Claude Code, OpenAI Codex, Cursor, Windsurf,
# etc. — because the primary enforcement is a native git hook. AI tools also get
# a per-tool integration file so they run the review proactively.
#
# Mode is set per-repo in .review-gate/gate.config.json -> "gateMode":
#   "commit" → marker binds to the STAGED TREE; enforced by the pre-commit hook.
#   "push"   → marker binds to the HEAD commit;  enforced by the pre-push hook.
# The verify step (typecheck/lint/test) is also config-driven, so the same gate
# works for TypeScript, Python, Go, Rust, etc.
#
# THREAT MODEL — an HONESTY gate, not an adversarial sandbox. It makes the
# ACCIDENTAL skip impossible; a determined caller can still bypass it (e.g.
# `git commit --no-verify`, or by editing the config). Assumes a COOPERATIVE
# caller. For stronger, server-side enforcement, pair it with a CI check.
#
# Sub-commands:
#   precommit            git pre-commit hook entrypoint (commit mode). Aborts the
#                        commit unless a fresh marker matches the staged tree.
#   prepush              git pre-push hook entrypoint (push mode). Aborts the push
#                        unless a fresh marker matches HEAD.
#   check                Claude Code PreToolUse entrypoint (reads the tool JSON on
#                        stdin; emits a deny decision). A nicer, earlier block for
#                        Claude — additive on top of the git hook.
#   attest --ran <steps> Run AFTER the review. Computes which review/guard steps
#                        the diff REQUIRES and refuses the marker unless --ran
#                        covers them; then runs verify and writes the marker.
#
# Prerequisite: bash, git, and Python 3 as `python3`/`python` on PATH (or set
# REVIEW_GATE_PYTHON to an explicit interpreter). Python = JSON + safe arg parsing.
# ──────────────────────────────────────────────────────────────────────────

set -uo pipefail

MODE="${1:-check}"

GATE_SUBDIR=".review-gate"

# ---- helpers --------------------------------------------------------------

deny() {  # Claude Code deny (modern + legacy forms)
  python_cmd -c 'import json,sys
msg=sys.argv[1]
print(json.dumps({
  "decision":"block","reason":msg,
  "hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":msg}
}))' "$1"
  exit 0
}

repo_root() { git rev-parse --show-toplevel 2>/dev/null; }

# Run Python 3, discovered as $REVIEW_GATE_PYTHON (explicit override) → `python3`
# → `python` (some systems only ship the latter / a wrapped python3). Returns 127
# if none is present so callers can fail closed.
python_cmd() {
  if [ -n "${REVIEW_GATE_PYTHON:-}" ]; then "$REVIEW_GATE_PYTHON" "$@"
  elif command -v python3 >/dev/null 2>&1; then python3 "$@"
  elif command -v python >/dev/null 2>&1; then python "$@"
  else return 127; fi
}

read_gate_mode() {  # $1 = config path; prints push | commit | invalid
  python_cmd - "$1" <<'PY' 2>/dev/null || echo "invalid"
import json, os, sys
p = sys.argv[1]
if not os.path.exists(p):
    print("push"); raise SystemExit          # no config -> callers gate on existence
try:
    cfg = json.load(open(p))
except Exception:
    print("invalid"); raise SystemExit        # present but unparseable -> fail closed
gm = cfg.get("gateMode")
if gm is None:
    print("push")                                  # omitted -> documented default
else:
    m = str(gm).strip().lower()
    print(m if m in ("push", "commit") else "invalid")   # present but a typo -> fail closed
PY
}

# Run "$@" under a timeout when GNU `timeout` is available (Linux/Git-Bash); run
# as-is otherwise (e.g. stock macOS) — degrades to no-timeout, never errors.
_tmo() {
  if command -v timeout >/dev/null 2>&1; then timeout "$1" "${@:2}"; else shift; "$@"; fi
}

# Echo the verify config as shell var assignments (TYPECHECK_*/LINT_*/TEST_*/
# LINTABLE_EXT/CODE_EXT). Shared by attest and ci-verify so they run the SAME
# verify (incl. the same Node defaults when the verify block is omitted).
emit_verify_config() {  # $1 = config path
  python_cmd - "$1" <<'PY'
import json, sys, shlex
p = sys.argv[1]
try: cfg = json.load(open(p))
except Exception: cfg = {}
has_verify = "verify" in cfg
verify = cfg.get("verify") or {}
DEFAULTS = {
    "typecheck": {"cmd": "node_modules/.bin/tsc --noEmit", "perFile": False, "enabled": True},
    "lint":      {"cmd": "node_modules/.bin/eslint --max-warnings 0", "perFile": True, "enabled": True},
    "test":      {"cmd": "node_modules/.bin/vitest related --run", "perFile": True, "enabled": True},
}
def step(name):
    d = DEFAULTS[name]; s = verify.get(name)
    # If a 'verify' block is present (even an empty {}) but THIS step is omitted,
    # treat it as DISABLED (not Node-defaulted) — a Python/Go user who sets only
    # lint+test must not silently inherit the Node 'tsc' default for typecheck.
    if s is None: s = {"enabled": False} if has_verify else d
    cmd = s.get("cmd", d["cmd"]); perfile = s.get("perFile", d["perFile"])
    enabled = s.get("enabled", d["enabled"] if cmd else False)
    return cmd, perfile, enabled
def emit(n, v): print(f"{n}={shlex.quote(str(v))}")
for nm, pfx in (("typecheck","TYPECHECK"), ("lint","LINT"), ("test","TEST")):
    cmd, perfile, enabled = step(nm)
    emit(f"{pfx}_CMD", cmd); emit(f"{pfx}_PERFILE", "1" if perfile else "0"); emit(f"{pfx}_ENABLED", "1" if enabled else "0")
emit("LINTABLE_EXT", "|".join(cfg.get("lintableExtensions") or ["ts","tsx","js","jsx","mjs","cjs"]))
emit("CODE_EXT", "|".join(cfg.get("codeExtensions") or ["ts","tsx","js","jsx","mjs","cjs","sh","bash","py","rb","go","rs","sql"]))
PY
}

# Compute the block reason for the current binding. Echoes the (multi-line)
# reason on stdout, or NOTHING if the action is allowed. Uses globals ROOT,
# GATE_MODE. $1 = optional verdict (COMMIT_ALL triggers the unstaged-changes
# guard used only by the Claude `check` path — git hooks pass "").
gate_block_reason() {
  local verdict="${1:-}"
  local HEAD BRANCH MARKER ACTION RUN_HINT MARKER_INFO M_MODE M_HEAD M_TREE M_OK M_STATE CUR_TREE
  HEAD="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo "")"
  BRANCH="$(git -C "$ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "?")"
  MARKER="$ROOT/$GATE_SUBDIR/.gate/attest.json"
  ACTION="$([ "$GATE_MODE" = commit ] && echo commit || echo push)"

  if [ "$GATE_MODE" = commit ]; then
    RUN_HINT="Run the gate first: stage everything (git add -A), review the staged diff with the review agents + guard-skills, fix, then:
    bash $GATE_SUBDIR/review-gate.sh attest --ran review,clean-code,docs
attest binds the marker to the STAGED tree and runs verify; then 'git commit'. Re-staging different content invalidates the marker."
  else
    RUN_HINT="Run the gate first: review + fix, commit, then:
    bash $GATE_SUBDIR/review-gate.sh attest --ran review,clean-code,docs
attest binds the marker to HEAD and runs verify. Any new commit invalidates it."
  fi

  if [ ! -f "$MARKER" ]; then
    printf '%s\n' "🔒 review-gate: the mandatory review gate has NOT run for this $ACTION ($BRANCH @ ${HEAD:0:8}).
$RUN_HINT"
    return
  fi

  MARKER_INFO="$(python_cmd -c '
import json, sys
try:
    m = json.load(open(sys.argv[1]))
    print("|".join([str(m.get("mode","push")), m.get("head","") or "", m.get("tree","") or "",
                    "true" if m.get("ok") else "false", "readable"]))
except Exception:
    print("||||unreadable")
' "$MARKER" 2>/dev/null || echo "||||unreadable")"
  IFS="|" read -r M_MODE M_HEAD M_TREE M_OK M_STATE <<< "$MARKER_INFO"

  if [ "$M_STATE" = unreadable ]; then
    printf '%s\n' "🔒 review-gate: the marker is unreadable (corrupt/incomplete). Re-run the gate.
$RUN_HINT"; return
  fi
  if [ "$M_MODE" != "$GATE_MODE" ]; then
    printf '%s\n' "🔒 review-gate: the marker is for a different gate mode ($M_MODE) but this repo is '$GATE_MODE'. Re-run attest.
$RUN_HINT"; return
  fi

  if [ "$GATE_MODE" = commit ]; then
    if [ "$verdict" = COMMIT_ALL ] && ! git -C "$ROOT" diff --quiet 2>/dev/null; then
      printf '%s\n' "🔒 review-gate: 'git commit -a/-am' would commit UNSTAGED changes that were not reviewed. Stage everything (git add -A), re-run the review + attest, then commit.
$RUN_HINT"; return
    fi
    CUR_TREE="$(git -C "$ROOT" write-tree 2>/dev/null || echo "")"
    if [ -z "$CUR_TREE" ]; then
      printf '%s\n' "🔒 review-gate: could not compute the staged tree (unmerged paths?). Resolve + stage, then attest.
$RUN_HINT"; return
    fi
    if [ "$M_TREE" != "$CUR_TREE" ]; then
      printf '%s\n' "🔒 review-gate: the staged content changed after review (marker ${M_TREE:0:8} ≠ staged ${CUR_TREE:0:8}). Re-run the gate.
$RUN_HINT"; return
    fi
  else
    if [ "$M_HEAD" != "$HEAD" ]; then
      printf '%s\n' "🔒 review-gate: the code changed after review (marker ${M_HEAD:0:8} ≠ HEAD ${HEAD:0:8}). Re-run the gate on the latest commit.
$RUN_HINT"; return
    fi
    # A pre-push hook receives every ref update on stdin. Validate the actual
    # commit being pushed, not merely the checked-out HEAD — attesting HEAD must
    # NOT unlock pushing a different branch. Deletions carry an all-zero oid.
    if [ -n "${PUSH_UPDATES:-}" ]; then
      local LOCAL_REF LOCAL_OID REMOTE_REF REMOTE_OID PUSHED_COMMIT
      while read -r LOCAL_REF LOCAL_OID REMOTE_REF REMOTE_OID; do
        [ -n "$LOCAL_OID" ] || continue
        case "$LOCAL_OID" in 0000000000000000000000000000000000000000) continue ;; esac
        PUSHED_COMMIT="$(git -C "$ROOT" rev-parse --verify "${LOCAL_OID}^{commit}" 2>/dev/null || true)"
        if [ -z "$PUSHED_COMMIT" ]; then
          printf '%s\n' "🔒 review-gate: pushed ref '$LOCAL_REF' is not a commit. Review and attest a commit before pushing it.
$RUN_HINT"; return
        fi
        if [ "$PUSHED_COMMIT" != "$M_HEAD" ]; then
          printf '%s\n' "🔒 review-gate: pushed ref '$LOCAL_REF' points to ${PUSHED_COMMIT:0:8}, but the marker attests ${M_HEAD:0:8}. Check out that ref, review it, and re-run attest before pushing.
$RUN_HINT"; return
        fi
      done <<< "$PUSH_UPDATES"
    fi
  fi

  if [ "$M_OK" != true ]; then
    printf '%s\n' "🔒 review-gate: the last verify did NOT pass (typecheck/lint/test failed). Fix, then re-attest.
$RUN_HINT"; return
  fi
  # allowed → echo nothing
}

# ===========================================================================
# GIT HOOK ENTRYPOINTS — precommit / prepush
# ===========================================================================
if [ "$MODE" = "precommit" ] || [ "$MODE" = "prepush" ]; then
  PUSH_UPDATES=""
  [ "$MODE" = "prepush" ] && PUSH_UPDATES="$(cat 2>/dev/null || true)"   # capture pushed refs
  ROOT="$(repo_root)"; [ -z "$ROOT" ] && exit 0
  # This hook is being executed by review-gate.sh, so the repo IS gated. A MISSING
  # config is a misconfiguration, not "ungated" → fail closed (don't silently pass).
  if [ ! -f "$ROOT/$GATE_SUBDIR/gate.config.json" ]; then
    printf '\n🔒 review-gate: %s/gate.config.json is missing — failing closed. Restore it, or uninstall the gate (unset core.hooksPath / remove .githooks) to disable it.\n\n' "$GATE_SUBDIR" >&2
    exit 1
  fi
  if [ -z "${REVIEW_GATE_PYTHON:-}" ] && ! command -v python3 >/dev/null 2>&1 && ! command -v python >/dev/null 2>&1; then
    printf '\n🔒 review-gate: Python 3 is required (REVIEW_GATE_PYTHON, python3, or python) — failing closed. Install it.\n\n' >&2
    exit 1
  fi
  GATE_MODE="$(read_gate_mode "$ROOT/$GATE_SUBDIR/gate.config.json")"
  if [ "$GATE_MODE" = "invalid" ]; then
    printf '\n🔒 review-gate: %s/gate.config.json is present but invalid (bad JSON or unknown gateMode value) — failing closed. Fix it before committing/pushing.\n\n' "$GATE_SUBDIR" >&2
    exit 1
  fi

  # Each hook only acts in its matching mode (so both can be installed at once).
  if { [ "$MODE" = "precommit" ] && [ "$GATE_MODE" != "commit" ]; } ||
     { [ "$MODE" = "prepush" ]  && [ "$GATE_MODE" != "push" ]; }; then
    exit 0
  fi

  REASON="$(gate_block_reason "")"
  if [ -n "$REASON" ]; then
    printf '\n%s\n\n' "$REASON" >&2
    exit 1   # aborts the commit/push
  fi
  exit 0
fi

# ===========================================================================
# CLAUDE CODE PreToolUse ENTRYPOINT — check
# ===========================================================================
if [ "$MODE" = "check" ]; then
  INPUT="$(cat 2>/dev/null || true)"
  ROOT="$(repo_root)"; [ -z "$ROOT" ] && exit 0
  [ -f "$ROOT/$GATE_SUBDIR/review-gate.sh" ] || exit 0       # repo not gated
  CONFIG_MISSING=0
  if [ -f "$ROOT/$GATE_SUBDIR/gate.config.json" ]; then
    GATE_MODE="$(read_gate_mode "$ROOT/$GATE_SUBDIR/gate.config.json")"
  else
    GATE_MODE="invalid"; CONFIG_MISSING=1   # gated repo but missing config -> deny gated cmds
  fi

  VERDICT="$(printf '%s' "$INPUT" | GATE_MODE="$GATE_MODE" python_cmd -c '
import sys, json, re, shlex, os
mode = os.environ.get("GATE_MODE", "push")
try:
    cmd = json.load(sys.stdin).get("tool_input", {}).get("command", "")
except Exception:
    cmd = ""
segments = re.split(r"&&|\|\||[;&|\n]", cmd)
VALUE_OPTS = {"-C", "--git-dir"}
INSPECT = {"--dry-run", "--help", "-h"}
ALL_FLAGS = {"-a", "--all", "--include", "-i", "--interactive", "--patch", "-p"}
def classify(seg):
    try: toks = shlex.split(seg)
    except Exception: toks = seg.split()
    out = []
    for t in toks:
        if t.startswith("#"): break
        out.append(t)
    toks = out
    while toks and (re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", toks[0]) or toks[0] in ("command", "builtin")):
        toks.pop(0)
    if not toks: return "SKIP"
    head = toks[0].lstrip("\\").rsplit("/", 1)[-1]; rest = toks[1:]
    if head == "git":
        i = 0
        while i < len(rest) and rest[i].startswith("-"):
            opt = rest[i]; i += 1
            if opt in VALUE_OPTS and i < len(rest): i += 1
        if i >= len(rest): return "SKIP"
        sub = rest[i]; opts = []
        for t in rest[i+1:]:
            if t == "--": break
            opts.append(t)
        if sub == "push" and mode in ("push", "invalid"):
            return "SKIP" if any(o in INSPECT for o in opts) else "PUSH"
        if sub == "commit" and mode in ("commit", "invalid"):
            if any(o in INSPECT for o in opts): return "SKIP"
            allflag = any(o in ALL_FLAGS for o in opts) or any(re.match(r"^-[A-Za-z]*a[A-Za-z]*$", o) for o in opts)
            return "COMMIT_ALL" if allflag else "COMMIT"
        return "SKIP"
    if head == "gh" and mode in ("push", "invalid") and len(rest) >= 2 and rest[0] == "pr" and rest[1] == "create":
        opts = []
        for t in rest[2:]:
            if t == "--": break
            opts.append(t)
        return "SKIP" if any(o in ("--help", "-h") for o in opts) else "PUSH"
    return "SKIP"
results = [classify(s) for s in segments]
for v in ("COMMIT_ALL", "COMMIT", "PUSH"):
    if v in results:
        print(v); break
else:
    print("SKIP")
' 2>/dev/null || echo "SKIP")"

  [ "$VERDICT" = "SKIP" ] && exit 0
  if [ "$GATE_MODE" = "invalid" ]; then
    if [ "${CONFIG_MISSING:-0}" = "1" ]; then
      deny "🔒 review-gate: $GATE_SUBDIR/gate.config.json is missing — failing closed. Restore it, or uninstall the gate to disable it."
    else
      deny "🔒 review-gate: $GATE_SUBDIR/gate.config.json is invalid (bad JSON or unknown gateMode value) — fix it before committing/pushing."
    fi
  fi
  REASON="$(gate_block_reason "$VERDICT")"
  [ -n "$REASON" ] && deny "$REASON"
  exit 0
fi

# ===========================================================================
# ATTEST
# ===========================================================================
if [ "$MODE" = "attest" ]; then
  ROOT="$(repo_root)"
  if [ -z "$ROOT" ]; then echo "❌ attest: not inside a git repo." >&2; exit 1; fi
  cd "$ROOT" || exit 1

  RAN=""
  shift || true
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --ran=*) RAN="${1#--ran=}"; shift ;;
      --ran)   RAN="${2:-}"; shift 2 || shift ;;
      *)       shift ;;
    esac
  done

  HEAD="$(git rev-parse HEAD 2>/dev/null || echo "")"
  BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "?")"
  TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  GATE_DIR="$ROOT/$GATE_SUBDIR/.gate"
  MARKER="$GATE_DIR/attest.json"
  CONFIG_FILE="$ROOT/$GATE_SUBDIR/gate.config.json"
  mkdir -p "$GATE_DIR"
  if [ ! -f "$CONFIG_FILE" ]; then echo "❌ attest: $GATE_SUBDIR/gate.config.json is missing — create it (or reinstall review-gate)." >&2; exit 1; fi
  GATE_MODE="$(read_gate_mode "$CONFIG_FILE")"
  if [ "$GATE_MODE" = "invalid" ]; then echo "❌ attest: $GATE_SUBDIR/gate.config.json is invalid (bad JSON or unknown gateMode value) — fix it first." >&2; exit 1; fi

  echo "▶ review-gate attest [$GATE_MODE mode] — $BRANCH @ ${HEAD:0:8}"

  # P0: verify runs against the WORKING TREE, so it must match what the marker
  # binds to — otherwise verify could pass on good working-tree content while a
  # different (bad) staged tree / HEAD is what actually lands.
  # (a) untracked, non-ignored files are on disk during verify but are NOT in the
  # committed/pushed content — refuse so "verify == the change" holds.
  if [ -n "$(git ls-files --others --exclude-standard 2>/dev/null)" ]; then
    echo "❌ attest: untracked (non-ignored) files present. They're visible to verify but won't be committed — git add -A, remove, .gitignore, or stash them so verify matches the committed content." >&2
    exit 1
  fi
  # (b) modified-but-unstaged tracked files (see above).
  if [ "$GATE_MODE" = "commit" ]; then
    if ! git diff --quiet 2>/dev/null; then
      echo "❌ attest: unstaged changes to tracked files. verify runs on the working tree — stage everything first (git add -A) so the verified content IS the staged tree that gets committed." >&2
      exit 1
    fi
  else
    if ! git diff --quiet 2>/dev/null || ! git diff --cached --quiet 2>/dev/null; then
      echo "❌ attest: working tree / index is dirty. In push mode the marker binds to HEAD — commit or stash all changes first so verify matches what's pushed." >&2
      exit 1
    fi
  fi

  CFG_SH="$(emit_verify_config "$CONFIG_FILE")"
  eval "$CFG_SH"
  [ -f "$CONFIG_FILE" ] && echo "  • verify config: $GATE_SUBDIR/gate.config.json" || echo "  • verify config: none — Node defaults (tsc + eslint + vitest)"

  TREE=""
  if [ "$GATE_MODE" = "commit" ]; then
    if git rev-parse --verify -q HEAD >/dev/null 2>&1; then CBASE="HEAD"; else CBASE="$(git hash-object -t tree /dev/null 2>/dev/null)"; fi
    TREE="$(git write-tree 2>/dev/null || echo "")"
    if [ -z "$TREE" ]; then echo "❌ attest: cannot compute the staged tree (unmerged paths?). Resolve + stage, then re-run." >&2; exit 1; fi
    FULL_NAMES() { git diff --cached --name-only -z "$CBASE" 2>/dev/null; }
    ACMR_NAMES() { git diff --cached --name-only -z --diff-filter=ACMR "$CBASE" 2>/dev/null; }
    echo "  • binding: staged tree ${TREE:0:8}"
  else
    DEFAULT_REF="$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null)"
    # Time-box the fetch: an unreachable remote must not hang attest (the base is
    # only used to scope the diff; a stale base is safe — it just over-counts).
    if [ -n "$DEFAULT_REF" ]; then _tmo 15 git fetch origin "${DEFAULT_REF#origin/}" --quiet 2>/dev/null || true; else _tmo 15 git fetch origin --quiet 2>/dev/null || true; fi
    BASE=""
    for ref in "$DEFAULT_REF" origin/master origin/main master main; do
      [ -z "$ref" ] && continue
      REF_TIP="$(git rev-parse "$ref" 2>/dev/null || true)"
      # On a repo's first push, local main/master IS HEAD — not a meaningful review
      # base. Skip it so a first push diffs against the empty tree (ALL files).
      [ "$REF_TIP" = "$HEAD" ] && continue
      BASE="$(git merge-base HEAD "$ref" 2>/dev/null || true)"; [ -n "$BASE" ] && break
    done
    if [ -z "$BASE" ]; then BASE="$(git hash-object -t tree /dev/null 2>/dev/null)"; echo "  ⚠ no base branch — diffing against the empty tree (ALL files treated as touched)."; fi
    FULL_NAMES() { git diff --name-only -z "$BASE" HEAD 2>/dev/null; }
    ACMR_NAMES() { git diff --name-only -z --diff-filter=ACMR "$BASE" HEAD 2>/dev/null; }
    echo "  • binding: commit ${HEAD:0:8}"
  fi

  REQUIRED="$(FULL_NAMES | CODE_EXT="$CODE_EXT" python_cmd -c '
import sys, re, os
files = [f.decode("utf-8","surrogateescape") for f in sys.stdin.buffer.read().split(b"\x00") if f]
code_ext = [e for e in os.environ.get("CODE_EXT","").split("|") if e]
CODE = re.compile(r"\.(" + "|".join(re.escape(e) for e in code_ext) + r")$") if code_ext else None
def is_test(p):
    b = os.path.basename(p); path = "/" + p
    return ("/e2e/" in path or "/tests/" in path or "/__tests__/" in path or "/spec/" in path
            or ".test." in b or ".spec." in b or b.startswith("test_") or re.search(r"_test\.[A-Za-z0-9]+$", b) is not None)
req = ["review"] if files else []
nc = nt = nd = False
for f in files:
    if f.endswith(".md"): nd = True
    if is_test(f): nt = True
    elif CODE and CODE.search(f): nc = True
if nc: req.append("clean-code")
if nt: req.append("test")
if nd: req.append("docs")
print(",".join(req))
' 2>/dev/null || echo "review")"

  [ -z "$REQUIRED" ] && [ "$GATE_MODE" = "commit" ] && echo "  ⚠ nothing staged — did you forget 'git add'?"

  MISSING="$(python_cmd -c '
import sys
req = [x for x in sys.argv[1].split(",") if x]
ran = set(x.strip() for x in sys.argv[2].replace(" ", ",").split(",") if x.strip())
print(",".join([r for r in req if r not in ran]))
' "$REQUIRED" "$RAN" 2>/dev/null || echo "$REQUIRED")"

  if [ -n "$MISSING" ]; then
    echo "❌ attest: review/guard steps NOT acknowledged for this diff: $MISSING" >&2
    echo "   Required: ${REQUIRED:-none}    Acknowledged (--ran): ${RAN:-<none>}" >&2
    echo "   Run the review agents + the listed guard-skills, then re-run:" >&2
    echo "     bash $GATE_SUBDIR/review-gate.sh attest --ran ${REQUIRED}" >&2
    exit 1
  fi
  echo "  • gate steps acknowledged: ${RAN:-<none>} (required: ${REQUIRED:-none})"

  TOUCHED_Z="$(mktemp -t gate-touched.XXXXXX)"
  TC_LOG="$(mktemp -t gate-tc.XXXXXX)"; LINT_LOG="$(mktemp -t gate-lint.XXXXXX)"; TEST_LOG="$(mktemp -t gate-test.XXXXXX)"
  trap 'rm -f "$TOUCHED_Z" "$TC_LOG" "$LINT_LOG" "$TEST_LOG"' EXIT
  ACMR_NAMES | LINTABLE_EXT="$LINTABLE_EXT" python_cmd -c '
import sys, re, os
data = sys.stdin.buffer.read().split(b"\x00")
exts = [e for e in os.environ.get("LINTABLE_EXT","").split("|") if e]
pat = re.compile((r"\.(" + "|".join(re.escape(e) for e in exts) + r")$").encode()) if exts else None
out = [f for f in data if f and (pat is None or pat.search(f))]
sys.stdout.buffer.write(b"\x00".join(out))
' > "$TOUCHED_Z"
  NLINT="$(python_cmd -c 'import sys; d=open(sys.argv[1],"rb").read().split(b"\x00"); print(len([x for x in d if x]))' "$TOUCHED_Z" 2>/dev/null || echo 0)"

  WORKTREE_HINT=""
  if [ ! -d "$ROOT/node_modules" ] && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    if [ "$(git rev-parse --git-dir 2>/dev/null)" != "$(git rev-parse --git-common-dir 2>/dev/null)" ]; then
      WORKTREE_HINT=" (git worktree without its own node_modules — run from the main checkout or symlink deps)"
    fi
  fi

  TYPECHECK_RES="skip"; LINT_RES="skip"; TEST_RES="skip"; FAILED=0

  if [ "$TYPECHECK_ENABLED" != "1" ] || [ -z "$TYPECHECK_CMD" ]; then
    echo "  • typecheck: disabled — SKIP"
  else
    echo "  • typecheck: $TYPECHECK_CMD ..."
    if bash -c "$TYPECHECK_CMD" >"$TC_LOG" 2>&1; then TYPECHECK_RES="pass"; echo "    ✓ typecheck clean"
    else TYPECHECK_RES="fail"; FAILED=1; echo "    ✗ typecheck failed${WORKTREE_HINT}:"; tail -15 "$TC_LOG" | sed 's/^/      /'; fi
  fi

  if [ "$LINT_ENABLED" != "1" ] || [ -z "$LINT_CMD" ]; then
    echo "  • lint: disabled — SKIP"
  elif [ "$LINT_PERFILE" = "1" ] && [ "$NLINT" -eq 0 ]; then
    echo "  • lint: no touched lint-able files — SKIP"
  else
    echo "  • lint: $LINT_CMD ($([ "$LINT_PERFILE" = "1" ] && echo "$NLINT file(s)" || echo "whole project")) ..."
    OK_RUN=0
    if [ "$LINT_PERFILE" = "1" ]; then xargs -0 sh -c 'c="$1"; shift; exec sh -c "$c \"\$@\"" _ "$@"' _ "$LINT_CMD" < "$TOUCHED_Z" >"$LINT_LOG" 2>&1 && OK_RUN=1
    else bash -c "$LINT_CMD" >"$LINT_LOG" 2>&1 && OK_RUN=1; fi
    if [ "$OK_RUN" -eq 1 ]; then LINT_RES="pass"; echo "    ✓ lint clean"
    else LINT_RES="fail"; FAILED=1; echo "    ✗ lint findings${WORKTREE_HINT}:"; tail -20 "$LINT_LOG" | sed 's/^/      /'; fi
  fi

  if [ "$TEST_ENABLED" != "1" ] || [ -z "$TEST_CMD" ]; then
    echo "  • test: disabled — SKIP"
  elif [ "$TEST_PERFILE" = "1" ] && [ "$NLINT" -eq 0 ]; then
    echo "  • test: no touched testable files — SKIP"
  else
    echo "  • test: $TEST_CMD ($([ "$TEST_PERFILE" = "1" ] && echo "$NLINT file(s)" || echo "whole suite")) ..."
    OK_RUN=0
    if [ "$TEST_PERFILE" = "1" ]; then xargs -0 sh -c 'c="$1"; shift; exec sh -c "$c \"\$@\"" _ "$@"' _ "$TEST_CMD" < "$TOUCHED_Z" >"$TEST_LOG" 2>&1 && OK_RUN=1
    else bash -c "$TEST_CMD" >"$TEST_LOG" 2>&1 && OK_RUN=1; fi
    if [ "$OK_RUN" -eq 1 ]; then TEST_RES="pass"; echo "    ✓ test passed"
    else TEST_RES="fail"; FAILED=1; echo "    ✗ test failures${WORKTREE_HINT}:"; tail -25 "$TEST_LOG" | sed 's/^/      /'; fi
  fi

  OK="true"; [ "$FAILED" -eq 1 ] && OK="false"

  python_cmd -c "import json,sys
m={'mode':sys.argv[1],'head':sys.argv[2],'tree':sys.argv[3],'branch':sys.argv[4],'ts':sys.argv[5],
   'verify':{'typecheck':sys.argv[6],'lint':sys.argv[7],'test':sys.argv[8]},
   'gate':{'required':sys.argv[11],'ran':sys.argv[12]},'ok':sys.argv[9]=='true'}
open(sys.argv[10],'w').write(json.dumps(m,indent=2))" \
    "$GATE_MODE" "$HEAD" "$TREE" "$BRANCH" "$TS" "$TYPECHECK_RES" "$LINT_RES" "$TEST_RES" "$OK" "$MARKER" "$REQUIRED" "$RAN"

  if [ "$OK" = "true" ]; then
    if [ "$GATE_MODE" = "commit" ]; then
      echo "✅ attested for staged tree ${TREE:0:8}: typecheck=$TYPECHECK_RES lint=$LINT_RES test=$TEST_RES — commit unlocked (don't re-stage before committing)."
    else
      echo "✅ attested for ${HEAD:0:8}: typecheck=$TYPECHECK_RES lint=$LINT_RES test=$TEST_RES — push unlocked."
    fi
    exit 0
  else
    echo "❌ verify failed (typecheck=$TYPECHECK_RES lint=$LINT_RES test=$TEST_RES). Marker written NOT-ok; $GATE_MODE stays BLOCKED. Fix and re-run attest." >&2
    exit 1
  fi
fi

# ===========================================================================
# CI-VERIFY — re-run the gate's CONFIGURED verify in CI, where it can't be skipped
# with --no-verify. Same config + same Node defaults as attest (shared
# emit_verify_config), and it HONORS perFile: perFile commands run on the PR's
# changed files (diff vs the default branch), non-perFile run whole-project — so
# ci-verify MATCHES local attest instead of diverging. No marker / no --ran.
# Note: this enforces the VERIFY step, not that a human/agent actually reviewed.
# ===========================================================================
if [ "$MODE" = "ci-verify" ]; then
  ROOT="$(repo_root)"
  if [ -z "$ROOT" ]; then echo "❌ ci-verify: not inside a git repo." >&2; exit 1; fi
  cd "$ROOT" || exit 1
  CONFIG_FILE="$ROOT/$GATE_SUBDIR/gate.config.json"
  if [ ! -f "$CONFIG_FILE" ]; then echo "❌ ci-verify: $GATE_SUBDIR/gate.config.json is missing." >&2; exit 1; fi
  GATE_MODE="$(read_gate_mode "$CONFIG_FILE")"
  if [ "$GATE_MODE" = "invalid" ]; then echo "❌ ci-verify: $GATE_SUBDIR/gate.config.json is invalid (bad JSON or unknown gateMode value)." >&2; exit 1; fi
  CFG_SH="$(emit_verify_config "$CONFIG_FILE")"; eval "$CFG_SH"

  # Resolve the changed files vs the default branch so perFile commands run on the
  # SAME files local attest would — matching it, not diverging. Falls back to
  # whole-project when no base resolves (first commit / shallow checkout).
  DEFAULT_REF="$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null)"
  HEAD_OID="$(git rev-parse HEAD 2>/dev/null || echo "")"
  # Prefer an explicit base from the CI environment — the workflow sets it from the
  # GitHub event (github.event.before for push, pull_request.base.sha for a PR), so
  # a multi-commit push diffs from BEFORE the push, not just the last commit.
  CI_BASE=""
  if [ -n "${REVIEW_GATE_CI_BASE:-}" ]; then
    CI_BASE="$(git rev-parse --verify -q "${REVIEW_GATE_CI_BASE}^{commit}" 2>/dev/null || true)"
  fi
  if [ -z "$CI_BASE" ]; then
    for ref in "$DEFAULT_REF" origin/main origin/master main master; do
      [ -z "$ref" ] && continue
      RT="$(git rev-parse "$ref" 2>/dev/null || true)"; [ "$RT" = "$HEAD_OID" ] && continue
      CI_BASE="$(git merge-base HEAD "$ref" 2>/dev/null || true)"; [ -n "$CI_BASE" ] && break
    done
  fi
  # Still no base → diff against the EMPTY TREE (ALL tracked files), NOT HEAD^ (which
  # only covers the last commit and would MISS earlier commits in a multi-commit
  # push). Empty tree is the safe over-approximation: everything gets checked, and
  # perFile commands still receive a (full) file list.
  CI_NOBASE=0
  if [ -z "$CI_BASE" ]; then
    CI_BASE="$(git hash-object -t tree /dev/null 2>/dev/null)"; CI_NOBASE=1
  fi
  CI_TOUCHED="$(mktemp -t gate-ci.XXXXXX)"; trap 'rm -f "$CI_TOUCHED"' EXIT
  if [ -n "$CI_BASE" ]; then
    git diff --name-only -z --diff-filter=ACMR "$CI_BASE" HEAD 2>/dev/null | LINTABLE_EXT="$LINTABLE_EXT" python_cmd -c '
import sys, re, os
data = sys.stdin.buffer.read().split(b"\x00")
exts = [e for e in os.environ.get("LINTABLE_EXT","").split("|") if e]
pat = re.compile((r"\.(" + "|".join(re.escape(e) for e in exts) + r")$").encode()) if exts else None
out = [f for f in data if f and (pat is None or pat.search(f))]
sys.stdout.buffer.write(b"\x00".join(out))
' > "$CI_TOUCHED"
  fi
  CI_NLINT="$(python_cmd -c 'import sys; d=open(sys.argv[1],"rb").read().split(b"\x00"); print(len([x for x in d if x]))' "$CI_TOUCHED" 2>/dev/null || echo 0)"

  echo "▶ review-gate ci-verify ($([ "$CI_NOBASE" = 1 ] && echo "no base → all files (empty tree)" || echo "changed files vs ${CI_BASE:0:8}"))"
  CI_FAIL=0
  ci_run() {  # label cmd perFile enabled — honors perFile exactly like local attest
    local label="$1" cmd="$2" perfile="$3" enabled="$4"
    if [ "$enabled" != "1" ] || [ -z "$cmd" ]; then echo "• $label: disabled — skip"; return 0; fi
    if [ "$perfile" = "1" ] && [ -n "$CI_BASE" ]; then
      if [ "$CI_NLINT" -eq 0 ]; then echo "• $label: no changed lint-able files — skip"; return 0; fi
      echo "• $label ($CI_NLINT changed file(s)): $cmd"
      xargs -0 sh -c 'c="$1"; shift; exec sh -c "$c \"\$@\"" _ "$@"' _ "$cmd" < "$CI_TOUCHED" || { echo "✗ $label failed" >&2; CI_FAIL=1; }
    else
      echo "• $label (whole project): $cmd"
      bash -c "$cmd" || { echo "✗ $label failed" >&2; CI_FAIL=1; }
    fi
  }
  ci_run typecheck "$TYPECHECK_CMD" "$TYPECHECK_PERFILE" "$TYPECHECK_ENABLED"
  ci_run lint      "$LINT_CMD"      "$LINT_PERFILE"      "$LINT_ENABLED"
  ci_run test      "$TEST_CMD"      "$TEST_PERFILE"      "$TEST_ENABLED"
  if [ "$CI_FAIL" -eq 0 ]; then echo "✅ ci-verify passed"; exit 0; else echo "❌ ci-verify failed" >&2; exit 1; fi
fi

echo "usage: review-gate.sh precommit | prepush | check | attest --ran <review,clean-code,test,docs> | ci-verify" >&2
exit 2
