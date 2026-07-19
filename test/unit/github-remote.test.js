import test from "node:test";
import assert from "node:assert/strict";
import { githubRepository, isGitHubRemote } from "../../server/github-remote.js";

test("canonical GitHub HTTPS, SSH URL, and SCP remotes are accepted", () => {
  assert.equal(githubRepository("https://github.com/openai/codex.git"), "openai/codex");
  assert.equal(githubRepository("ssh://git@github.com/openai/codex.git"), "openai/codex");
  assert.equal(githubRepository("git@github.com:openai/codex.git"), "openai/codex");
});

test("non-GitHub and credential-bearing or non-canonical remotes are rejected", () => {
  for (const remote of [
    "https://gitlab.com/openai/codex.git",
    "https://token@github.com/openai/codex.git",
    "https://github.com/openai/codex/issues",
    "https://github.com/openai/codex.git?ref=main",
    "ssh://github.com/openai/codex.git",
    "ssh://root@github.com/openai/codex.git",
  ]) {
    assert.equal(isGitHubRemote(remote), false, remote);
    assert.throws(() => githubRepository(remote), /canonical GitHub/);
  }
});
