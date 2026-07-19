<div align="right">
  <a href="README.ar.md">🇪🇬 اقرأ بالعربية</a>
</div>

# Codebate

**Coding agents that challenge, review, and converge — while you stay in control.**

Codebate is a local workspace where Claude Code, Codex, and Cursor can work on the same task, inspect the same bounded project context, challenge each other's proposals, and produce a clear result you can review.

It is not another chat interface with several agents sitting side by side.
Codebate records what each agent proposed, where they agreed, what remains unresolved, and why a session stopped. When code changes are involved, execution happens inside a disposable copy of your repository and nothing reaches the real project until you explicitly approve it.

<!-- Add the launch demo GIF here:
![Codebate demo](docs/assets/codebate-demo.gif)
-->

## Why I built Codebate

My workflow used to look like this:

1. Ask Claude to create a plan.
2. Copy the plan into Codex for review.
3. Take Codex's objections back to Claude.
4. Repeat the process several times.
5. Try to remember which version was current and what both agents had actually agreed on.

The agents were useful, but I was acting as the communication layer between them.
Codebate turns that manual relay into a structured local workflow.
The agents receive the same evidence, respond to each other directly, and leave behind a reviewable record of proposals, disagreements, decisions, and next steps.

## What Codebate does

### Shared project evidence

Every participating agent works from the same bounded context instead of receiving unrelated prompts copied between different tools.
Project files are unavailable until you explicitly trust the project.

### Three conversation modes

**Chat**
Ask several agents the same question and compare their independent responses.

**Collaboration**
Agents work through the task in rounds, improve each other's proposals, and converge on a shared outcome.

**Debate**
Two agents take opposing positions, challenge assumptions, and make the remaining disagreements visible.

### Deterministic convergence

Codebate does not treat a confident final paragraph as proof that the agents agreed.
It separately tracks:

* proposed work items;
* accepted open items;
* resolved or merged items;
* unresolved decisions;
* required user actions;
* the reason a session completed or stopped.

The final summary explains the result. It does not silently rewrite the official session state.

### Execute → Review → Decide

For code-changing tasks:

1. An executor works inside a disposable clone of the repository.
2. Codebate captures the exact resulting tree and bounded diff.
3. A separate agent reviews the captured result without modifying it.
4. You inspect the proposal, the implementation, and the review.
5. Only your approval allows the reviewed result to reach the real repository.

Rejected work stays outside the project.

### Human approval for side effects

External actions such as creating a pull request, sending an email, or changing connected data remain proposals until you approve them.
Codebate is designed to assist with decisions, not silently make them for you.

## Provider roles

Codebate uses the CLI tools and subscriptions already installed on your computer.

| Provider    | Chat | Collaboration | Debate | Review | Isolated execution |
| ----------- | :--: | :-----------: | :----: | :----: | :----------------: |
| Claude Code |   ✓  |       ✓       |    ✓   |    ✓   |          —         |
| Codex CLI   |   ✓  |       ✓       |    ✓   |    ✓   |          ✓         |
| Cursor CLI  |   ✓  |       ✓       |    ✓   |    ✓   |          —         |

Execution is exposed only when Codebate can enforce the required local boundary. A provider is not advertised as an executor merely because it can edit files.

## Quick start

### Requirements

* Node.js 22 or newer
* Git
* At least two supported coding-agent CLIs installed and signed in:
  * Claude Code
  * Codex CLI
  * Cursor CLI
* GitHub CLI (`gh`) only when using GitHub-related actions

### Run with npm

```bash
npx codebate
```

Codebate starts a local loopback server and opens the workspace in your browser.
Your prompts, agent outputs, sessions, and decisions remain stored locally. Codebate does not proxy your model usage through its own cloud backend.

### Run from source

```bash
git clone https://github.com/mohamedadelfouda/codebate.git
cd codebate
corepack enable
pnpm install --prod --frozen-lockfile --ignore-scripts
pnpm start
```

By default, Codebate opens at:

```text
http://127.0.0.1:3210
```

## Safety model

Codebate is built around explicit boundaries rather than trust in prompt instructions alone.

* Project files are not shared until the project is trusted.
* Trusted provider executables are fingerprinted.
* Planning and review calls are read-only.
* Agent environments use an allowlist and do not inherit arbitrary secrets.
* Agent output, call duration, file evidence, and stored session data are bounded.
* Executions happen in disposable clones with independent Git objects and configuration.
* The exact reviewed tree is validated again before acceptance.
* Secret scanning runs before accepted work reaches the project.
* No unrestricted executor or pre-approved publishing mode exists.
* Connector credentials remain on the host and are not inserted into prompts.
* External writes require an explicit user decision.

A disposable Git clone is not a complete operating-system sandbox. Read the full threat model in [SECURITY.md](SECURITY.md).

## Local by design

Codebate does not replace Claude Code, Codex, or Cursor.
It coordinates the tools you already use.
Prompts and bounded project evidence are sent through the selected providers' official local CLIs. There is no Codebate account, hosted agent runtime, or additional model subscription.

## Current scope

Codebate is focused on one problem:

> Helping developers get more reliable work from multiple coding agents without losing visibility or control.

It is not trying to become an autonomous software company, an invisible background agent, or a general-purpose workflow platform.
The priority is making collaboration, review, execution, and approval understandable and trustworthy.

## Validate

```bash
corepack enable
pnpm install --frozen-lockfile --ignore-scripts
pnpm check
pnpm lint
pnpm test
pnpm test:coverage
pnpm test:integration
pnpm test:smoke
pnpm test:browser
```

## Documentation

* [Product principles](PRODUCT.md)
* [Architecture](docs/ARCHITECTURE.md)
* [Provider integration](docs/PROVIDERS.md)
* [Connector approval contract](docs/CONNECTORS.md)
* [Execute → Review → Decide](EXECUTION.md)
* [Security policy](SECURITY.md)
* [Contributing](CONTRIBUTING.md)
* [Code of Conduct](CODE_OF_CONDUCT.md)

## Contributing

Codebate is open source and early contributions are welcome.
Good starting areas include:

* provider adapters;
* cross-platform CLI discovery;
* safety-boundary testing;
* accessibility;
* Arabic and English UX;
* evaluation and benchmarking;
* documentation and real-world examples.

Please read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

## License

MIT © Mohamed Adel Fouda
