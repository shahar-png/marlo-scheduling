# marlo-scheduling

Built by the OLI Agent OS loop with no human merge: `PLAN.md` → plan review → build → `PROOF_CMD` → inspect → judge → PR → CI (`proof`) → auto-merge → deploy.

- Work orders: copy `docs/PLAN-TEMPLATE.md` to `PLAN.md`, review with the VP of Product, then `agent-os dispatch PLAN.md`.
- `PROOF_CMD` for this repo: `npm test`
- Kill switch: label a PR `hold`.
- Rules for every seat: `AGENTS.md`.
