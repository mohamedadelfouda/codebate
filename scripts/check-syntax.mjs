// Syntax-check every runtime JS file under server/, public/, and desktop/.
// Runs `node --check` on each file; exits non-zero if any fails.
// Uses a manual recursive walk to keep the check independent of package dependencies.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // directory may not exist
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}

const files = [...walk("server"), ...walk("public"), ...walk("desktop"), "forge.config.cjs"].sort();

let failed = 0;
for (const file of files) {
  try {
    execFileSync(process.execPath, ["--check", file], { stdio: ["ignore", "ignore", "pipe"] });
  } catch (err) {
    failed += 1;
    console.error(`✗ syntax error: ${file}`);
    if (err.stderr) console.error(String(err.stderr).trim());
  }
}

if (failed) {
  console.error(`\n${failed} file(s) failed syntax check`);
  process.exit(1);
}
console.log(`✓ syntax ok: ${files.length} file(s)`);
