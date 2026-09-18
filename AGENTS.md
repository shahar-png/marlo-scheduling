# How this repository is developed

This repo is built by the OLI Agent OS loop. If you are an AI seat (builder, inspector, judge) reading this, these rules bind you.

- The work order is `PLAN.md` at the repo root. Its `## Acceptance criteria` (AC-1..n) are the contract; `## Non-goals` fence the scope; `PROOF_CMD` is the only proof that counts.
- **Builder:** edit the working tree only. Never `git commit`, `git push`, create branches, or touch `.github/`, `PLAN.md`, or `PLAN-REVIEW-LOG.md`. Run `PROOF_CMD` yourself before reporting. Report files changed, proof output, and any denied action.
- **Inspector:** read-only. Report findings as `{id, severity, path, evidence, fix}`; zero findings is valid.
- **Judge:** grade against the acceptance criteria and the proof output; one disposition per finding.
- Humans do not merge. `main` is protected; the `proof` GitHub Actions check is the gate; auto-merge does the rest. A PR labelled `hold` will not merge.
- Deploys: pushes to `main` deploy automatically (Vercel, when linked). A failed post-deploy health check triggers an automatic revert PR.

Tooling: https://github.com/shaharc11/agent-os-loop (`agent-os dispatch`, `docs/DISPATCH.md`, `docs/GROK-BOT-BRIEFING.md`).
