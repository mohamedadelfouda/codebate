<!-- review-gate:begin -->
## Review Gate — mandatory before every push

This project uses **review-gate**. The only authoritative sequence is
**`.review-gate/GATE.md`**: review the branch diff, fix real findings, commit,
attest that exact `HEAD`, then push. The gate file decides which reviewers,
guard-skills, and verification commands the change requires.

The pre-push hook blocks an unattested push. Do not bypass it with
`--no-verify`, and do not duplicate a different gate sequence here.
<!-- review-gate:end -->
