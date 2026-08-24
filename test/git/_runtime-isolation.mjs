// Redirect the app runtime dir to a throwaway location BEFORE any server module (store.js) is imported
// and freezes RUNTIME_ROOT. The git tests create real disposable clones and session files via the real
// code paths; without this they land under the repo's own runtime root (RUNTIME_ROOT defaults to the
// repo when CODEBATE_RUNTIME_DIR is unset) and — because the out-of-project clone is no longer inside
// the temp project dir the tests delete — leak into the checkout on every run. Import this FIRST (before
// node:test and before any ../../server import) in every git test file that exercises execution clones.
//
// node --test isolates each test file in its own process, so this runs once per file. Always redirect to a
// fresh throwaway dir — never reuse an inherited CODEBATE_RUNTIME_DIR: these tests create real disposable
// clones + session files through the app's own paths, so a stray/real value would be polluted, and parallel
// test processes would collide on one shared runtime.
//
// Canonicalize the fresh directory before store.js sees it. macOS commonly exposes os.tmpdir() through
// `/var` while realpath resolves to `/private/var`; Windows runners can likewise expose a temp directory
// through a filesystem alias. The production execution-root guard intentionally rejects a runtime path
// whose canonical location differs, so the test harness must hand it the canonical throwaway root rather
// than weakening that security check just to accommodate CI aliases.
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const runtime = realpathSync(mkdtempSync(join(tmpdir(), "ar-git-test-runtime-")));
process.env.CODEBATE_RUNTIME_DIR = runtime;
process.on("exit", () => { try { rmSync(runtime, { recursive: true, force: true }); } catch {} });
