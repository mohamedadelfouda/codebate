<!-- review-gate:begin -->
## Review Gate (MANDATORY)

This project uses **review-gate**. Treat **`.review-gate/GATE.md`** as the only
authoritative protocol: review, fix, commit, attest the exact `HEAD`, then push.
It defines the required review agents, guard-skills, and verification commands.

The pre-push hook blocks an unattested push. Do not use `--no-verify`, and do not
duplicate a conflicting gate sequence in this file.
<!-- review-gate:end -->
