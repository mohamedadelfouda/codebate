# Execute → Review → Decide

Codebate permits one writer per execution. The executor and reviewer must be different enabled providers.

## Lifecycle

1. The user attaches and explicitly trusts a Git project.
2. Codebate captures the target branch, base SHA, Git identity, remote fingerprint, and publication-related Git configuration.
3. Codebate creates a disposable local clone with separate Git objects, refs, and configuration. The executor changes that clone and is instructed not to commit; any executor commits are collapsed back to the captured base before acceptance.
4. Codebate captures an immutable Git tree, builds a bounded diff, and scans that exact tree for secrets.
5. The reviewer receives bounded read-only access to the execution clone and may inspect complete files. Claude uses Codebate's host-brokered project tools; providers with a native sandbox use their read-only project mode.
6. The UI shows the executor output, diff, review, scan findings, and Accept/Reject controls.
7. On acceptance, Codebate revalidates the project and clone, scans the previously reviewed tree again, creates a commit from that exact tree with the captured project-owner identity, and imports it under a private accepted ref in the project repository.
8. Local acceptance uses compare-and-swap ref updates plus a locked index/working-tree refresh, so a moved branch or user edit fails closed. Pull-request publication is offered only for a canonical GitHub origin, pushes the exact accepted ref, and opens or finds the matching GitHub PR.

Rejection deletes the disposable clone. A blocking secret deletes the same clone, including loose or packed secret objects, without writing them into the project repository.

## Permission modes

| Mode | Local file edits | Local commands | Network publication |
| --- | --- | --- | --- |
| Reviewer/planning | No | Read-only commands when enforced by the provider sandbox; otherwise bounded broker reads only | No |
| `run` | Yes | Yes, in the provider's isolated workspace mode | No |

The provider registry controls which execution modes a provider may expose. Codex currently exposes one honest `run` boundary because its workspace sandbox permits both edits and local commands; Codebate does not present prompt-only "edit without commands" as a security mode. Claude currently exposes no execution mode and remains available for collaboration and read-only review. There is no `full` mode. Merge and PR actions are acceptance actions owned by Codebate, not executor permissions.

## Acceptance failures and retries

If a merge or pull-request side effect fails after the accepted commit is stored, the execution enters `accepted_pending_merge` or `accepted_pending_pr`. Retrying reuses the same accepted commit; it does not re-run the executor or create a different change.

Acceptance is rejected when the base branch, HEAD, Git author identity, remote, hooks/signing configuration, or main working-tree cleanliness has drifted. Run the execution again from the new base instead of silently merging stale work.
