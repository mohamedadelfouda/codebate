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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const runtime = mkdtempSync(join(tmpdir(), "ar-git-test-runtime-"));
process.env.CODEBATE_RUNTIME_DIR = runtime;
process.on("exit", () => { try { rmSync(runtime, { recursive: true, force: true }); } catch {} });
