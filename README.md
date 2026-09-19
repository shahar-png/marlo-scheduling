# marlo-scheduling

Built by the OLI Agent OS loop with no human merge: `PLAN.md` → plan review → build → `PROOF_CMD` → inspect → judge → PR → CI (`proof`) → auto-merge → deploy.

## Local development

```bash
npm ci
npm test
npm run dev
```

- `npm ci` — install dependencies from the lockfile on a clean checkout
- `npm test` — PROOF_CMD: typecheck, `next build`, and automated tests
- `npm run dev` — start the Next.js App Router app locally

`GET /` serves the Marlo Scheduling placeholder. `GET /api/health` returns `{ "ok": true }`.

- Work orders: copy `docs/PLAN-TEMPLATE.md` to `PLAN.md`, review with the VP of Product, then `agent-os dispatch PLAN.md`.
- `PROOF_CMD` for this repo: `npm test`
- Kill switch: label a PR `hold`.
- Rules for every seat: `AGENTS.md`.
