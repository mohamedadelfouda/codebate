import test from "node:test";
import assert from "node:assert/strict";
import {
  validateTrustedLaunchDescriptor,
  deriveCursorQualification,
  REQUIRED_REVIEW_LAYERS,
  REQUIRED_EXECUTE_LAYERS,
} from "../../server/providers/cursor-qualification.js";

// Descriptors are per-platform, so fixtures pin their platform and are validated FOR that platform — the
// validator uses that platform's path semantics, making these assertions deterministic on the
// Ubuntu/Windows/macOS CI matrix regardless of the host OS.
const TRUSTED_ROOT = "C:\\Users\\me\\.cursor\\versions\\2026.07.09-a3815c0";
const NODE = `${TRUSTED_ROOT}\\node.exe`;
const ENTRY = `${TRUSTED_ROOT}\\index.js`;

function descriptor(overrides = {}) {
  return {
    schemaVersion: 1,
    providerId: "cursor",
    executable: NODE,
    executableFingerprint: "sha256:node",
    entryPoint: ENTRY,
    entryPointFingerprint: "sha256:index",
    fixedPrefixArgs: [ENTRY],
    version: "2026.07.09-a3815c0",
    platform: "win32",
    arch: "x64",
    ...overrides,
  };
}

// Validate the win32 fixture FOR win32 explicitly, so the check is deterministic on any CI host.
const WIN = { trustedRoot: TRUSTED_ROOT, platform: "win32", arch: "x64" };

const POSIX_ROOT = "/home/me/.local/share/cursor-agent/versions/2026.07.09-a3815c0";
function posixDescriptor(overrides = {}) {
  const entry = `${POSIX_ROOT}/index.js`;
  return {
    schemaVersion: 1, providerId: "cursor",
    executable: `${POSIX_ROOT}/node`, executableFingerprint: "sha256:node",
    entryPoint: entry, entryPointFingerprint: "sha256:index",
    fixedPrefixArgs: [entry], version: "2026.07.09-a3815c0",
    platform: "linux", arch: "x64", ...overrides,
  };
}

test("a well-formed Cursor trusted-launch descriptor validates", () => {
  assert.deepEqual(
    validateTrustedLaunchDescriptor(descriptor(), WIN),
    { valid: true, violations: [] },
  );
});

test("a Node flag before the entry point is rejected — code would run before Cursor starts", () => {
  const result = validateTrustedLaunchDescriptor(
    descriptor({ fixedPrefixArgs: ["--require", "C:\\evil.js", ENTRY] }),
    WIN,
  );
  assert.equal(result.valid, false);
  assert.ok(result.violations.some((v) => /no Node flags may precede/.test(v)));
  assert.ok(result.violations.some((v) => /entryPoint must be the first/.test(v)));
});

test("each descriptor invariant fails closed on its own", () => {
  const cases = [
    [{ schemaVersion: 2 }, /schemaVersion must be 1/],
    [{ providerId: "claude" }, /provider-bound/],
    [{ executable: "relative\\node.exe" }, /executable must be an absolute path/],
    [{ entryPoint: "relative\\index.js", fixedPrefixArgs: ["relative\\index.js"] }, /entryPoint must be an absolute path/],
    [{ executableFingerprint: "" }, /executableFingerprint is required/],
    [{ entryPointFingerprint: "" }, /entryPointFingerprint is required/],
    [{ fixedPrefixArgs: [] }, /non-empty array/],
    [{ fixedPrefixArgs: [NODE, ENTRY] }, /entryPoint must be the first/],
    [{ fixedPrefixArgs: [ENTRY, "--force"] }, /exactly \[entryPoint\]/], // trailing arg baked into the trusted prefix
  ];
  for (const [override, pattern] of cases) {
    const result = validateTrustedLaunchDescriptor(descriptor(override), WIN);
    assert.equal(result.valid, false, `${JSON.stringify(override)} should be invalid`);
    assert.ok(result.violations.some((v) => pattern.test(v)), `${JSON.stringify(override)} → ${pattern}`);
  }
});

test("an entryPoint outside the trusted version directory is rejected", () => {
  const outside = "C:\\Users\\me\\.cursor\\versions\\other\\index.js";
  const result = validateTrustedLaunchDescriptor(
    descriptor({ entryPoint: outside, fixedPrefixArgs: [outside] }),
    WIN,
  );
  assert.equal(result.valid, false);
  assert.ok(result.violations.some((v) => /within the trusted Cursor version directory/.test(v)));
});

test("a missing or non-object descriptor fails closed", () => {
  assert.equal(validateTrustedLaunchDescriptor(null).valid, false);
  assert.equal(validateTrustedLaunchDescriptor("nope").valid, false);
  assert.equal(validateTrustedLaunchDescriptor(undefined).valid, false);
});

test("a descriptor validated without a trustedRoot fails closed — containment cannot be skipped", () => {
  const result = validateTrustedLaunchDescriptor(descriptor(), { platform: "win32", arch: "x64" }); // no trustedRoot
  assert.equal(result.valid, false);
  assert.ok(result.violations.some((v) => /trustedRoot must be supplied/.test(v)));
});

test("containment rejects sibling-prefix, .. escape, cross-drive, and UNC paths", () => {
  const outside = [
    `${TRUSTED_ROOT}EVIL\\index.js`,        // sibling whose name is a prefix of the root
    `${TRUSTED_ROOT}\\..\\other\\index.js`, // .. escape back out of the version dir
    "D:\\2026.07.09-a3815c0\\index.js",     // different drive
    "\\\\server\\share\\index.js",          // UNC
  ];
  for (const entryPoint of outside) {
    const result = validateTrustedLaunchDescriptor(
      descriptor({ entryPoint, fixedPrefixArgs: [entryPoint] }),
      WIN,
    );
    assert.equal(result.valid, false, `${entryPoint} must not be contained`);
    assert.ok(result.violations.some((v) => /within the trusted Cursor version directory/.test(v)), entryPoint);
  }
  // A path genuinely nested inside the version directory is contained (no containment violation).
  const nested = `${TRUSTED_ROOT}\\node_modules\\cursor\\index.js`;
  const contained = validateTrustedLaunchDescriptor(
    descriptor({ entryPoint: nested, fixedPrefixArgs: [nested] }),
    WIN,
  );
  assert.deepEqual(contained.violations.filter((v) => /within the trusted/.test(v)), []);
});

test("a descriptor validates cross-platform for the platform it was built for (linux)", () => {
  assert.deepEqual(
    validateTrustedLaunchDescriptor(posixDescriptor(), { trustedRoot: POSIX_ROOT, platform: "linux", arch: "x64" }),
    { valid: true, violations: [] },
  );
});

test("a descriptor is rejected when validated for a platform it was not built for", () => {
  const result = validateTrustedLaunchDescriptor(descriptor(), { trustedRoot: TRUSTED_ROOT, platform: "linux", arch: "x64" });
  assert.equal(result.valid, false);
  assert.ok(result.violations.some((v) => /does not match the target platform/.test(v)));
});

test("an unsupported platform or arch is rejected", () => {
  const badPlatform = validateTrustedLaunchDescriptor(
    posixDescriptor({ platform: "sunos" }), { trustedRoot: POSIX_ROOT, platform: "sunos", arch: "x64" });
  assert.ok(badPlatform.violations.some((v) => /platform must be one of/.test(v)));
  const badArch = validateTrustedLaunchDescriptor(
    posixDescriptor({ arch: "mips" }), { trustedRoot: POSIX_ROOT, platform: "linux", arch: "mips" });
  assert.ok(badArch.violations.some((v) => /arch must be one of/.test(v)));
});

const allTrue = (layers) => Object.fromEntries(layers.map((layer) => [layer, true]));

test("Cursor qualifies as a reviewer only when every reviewer layer is proven", () => {
  const q = deriveCursorQualification({
    version: "2026.07.09-a3815c0", platform: "win32", arch: "x64",
    tests: allTrue(REQUIRED_REVIEW_LAYERS),
  });
  assert.equal(q.reviewQualified, true);
  assert.equal(q.executeQualified, false); // no executor layers supplied
  assert.equal(q.reasons.length, REQUIRED_EXECUTE_LAYERS.length);
  assert.equal(q.version, "2026.07.09-a3815c0");
});

test("Cursor qualifies as an executor only with the full reviewer floor plus every executor layer", () => {
  const q = deriveCursorQualification({ tests: allTrue([...REQUIRED_REVIEW_LAYERS, ...REQUIRED_EXECUTE_LAYERS]) });
  assert.equal(q.reviewQualified, true);
  assert.equal(q.executeQualified, true);
  assert.deepEqual(q.reasons, []);
});

test("a single unproven reviewer layer fails closed (network not proven denied)", () => {
  const tests = allTrue(REQUIRED_REVIEW_LAYERS);
  delete tests.networkDenied;
  const q = deriveCursorQualification({ tests });
  assert.equal(q.reviewQualified, false);
  assert.equal(q.executeQualified, false);
  assert.ok(q.reasons.some((r) => /networkDenied/.test(r)));
  assert.equal(q.tests.review.networkDenied, false);
});

test("execution fails closed when the sandbox is not proven fail-closed, even if all else passes", () => {
  const tests = allTrue([...REQUIRED_REVIEW_LAYERS, ...REQUIRED_EXECUTE_LAYERS]);
  tests.sandboxFailClosed = false;
  const q = deriveCursorQualification({ tests });
  assert.equal(q.reviewQualified, true);
  assert.equal(q.executeQualified, false);
  assert.ok(q.reasons.some((r) => /sandboxFailClosed/.test(r)));
});

test("execution cannot qualify while the reviewer floor fails, even if every executor layer passes", () => {
  const q = deriveCursorQualification({ tests: allTrue(REQUIRED_EXECUTE_LAYERS) });
  assert.equal(q.reviewQualified, false);
  assert.equal(q.executeQualified, false);
  assert.ok(q.reasons.some((r) => /reviewer layer must pass before execution/.test(r)));
});

test("empty or malformed evidence qualifies nothing, and a truthy-but-not-true layer is rejected", () => {
  for (const evidence of [undefined, {}, { tests: null }, { tests: { descriptorValid: "yes" } }]) {
    const q = deriveCursorQualification(evidence);
    assert.equal(q.reviewQualified, false);
    assert.equal(q.executeQualified, false);
  }
  // "yes" is truthy but not strictly true — fail-closed means it does not count as met.
  assert.equal(deriveCursorQualification({ tests: { descriptorValid: "yes" } }).tests.review.descriptorValid, false);
});
