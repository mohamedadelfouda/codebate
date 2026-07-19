import test from "node:test";
import assert from "node:assert/strict";
import { preflightRoute, routeRequest } from "../../server/capability-router.js";

test("routes explicit state-changing requests away from discussion", () => {
  for (const [request, intent] of [
    ["run the tests", "execute"],
    ["نفذ التعديلات في المشروع", "execute"],
    ["commit the changes", "execute"],
    ["run npm test", "execute"],
    ["review this repo", "project_read"],
    ["open a PR", "publish"],
    ["Can you explain the issue, then commit the changes", "execute"],
    ["How do pull requests work; then open a PR", "publish"],
    ["Can you explain the issue? Fix the code.", "execute"],
    ["Can you explain and fix the code", "execute"],
    ["What is wrong?\nPlease run the tests", "execute"],
    ["ازاي المشكلة دي حصلت؟ اصلح الكود", "execute"],
    ["كيف يعمل؟ ثم ارفع PR", "publish"],
    ["How do I open a PR? Then run the tests", "execute"],
  ]) {
    assert.equal(routeRequest(request).intent, intent, request);
  }
  const blocked = preflightRoute("run the tests", { projectTrusted: true });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.reasonCode, "state_change_requires_execution");
});

test("allows grounded review only after project trust", () => {
  const blocked = preflightRoute("راجع المشروع", { projectTrusted: false });
  assert.equal(blocked.intent, "project_read");
  assert.equal(blocked.action, "attach_project");
  assert.equal(blocked.reasonCode, "project_trust_required");
  const allowed = preflightRoute("راجع المشروع", { projectTrusted: true });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.reasonCode, null);
});

test("does not over-route ordinary discussion", () => {
  assert.deepEqual(routeRequest("What makes a useful code review?"), {
    intent: "discussion",
    requiredCapability: "discussion",
    confidence: "default",
  });
  assert.equal(routeRequest("How do I run the tests?").intent, "discussion");
  assert.equal(routeRequest("ازاي أشغل الاختبارات؟").intent, "discussion");
});
