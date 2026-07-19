#!/usr/bin/env node
// `codebate` (and `npx codebate`): start the local Codebate server. It serves the web UI on
// 127.0.0.1 and opens the browser — the CLI is a launcher for that local app, not a terminal UI.
//
// Two things differ from a `git clone` + `node server/index.js` run, both handled here so a global
// install "just works":
//   1. Node floor — fail fast with a clear message on an unsupported runtime instead of a cryptic
//      syntax error deep in the server (mirrors scripts/source-preflight.mjs).
//   2. Data directory — a globally-installed package lives in a read-only, reinstall-wiped location, so
//      default the runtime dir to the user's home. An explicit CODEBATE_RUNTIME_DIR always wins.
import os from "node:os";
import path from "node:path";

const major = Number(process.versions.node.split(".")[0]);
if (!Number.isInteger(major) || major < 22) {
  console.error(`Codebate needs Node.js 22 or newer — you have ${process.versions.node}. Install Node 22+ and re-run.`);
  process.exit(1);
}

if (!process.env.CODEBATE_RUNTIME_DIR) {
  process.env.CODEBATE_RUNTIME_DIR = path.join(os.homedir(), ".codebate");
}

try {
  const { serverReady } = await import(new URL("../server/index.js", import.meta.url).href);
  // Launched via the bin, server/index.js's directEntry startup guard is NOT installed (process.argv[1]
  // is this launcher, not server/index.js), so a post-evaluation startup failure (port already in use,
  // runtime lock held) would otherwise surface as an unhandledRejection and still exit 0 — a false
  // "started". Await the server's readiness so such a failure exits non-zero here.
  await serverReady;
} catch (error) {
  console.error(`Codebate failed to start: ${error?.message || error}`);
  process.exit(1);
}
