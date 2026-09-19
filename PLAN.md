# PLAN — Scaffold Next.js app + green PROOF_CMD

Spec owner: Shahar + VP of Product · Product review: Shahar + Grok · Status: APPROVED (Founder go + VP Product, 19 Sep 2026 ET)

## Goal

`marlo-scheduling` becomes a runnable Next.js (App Router, TypeScript) app on Vercel/Neon-ready scaffolding so `npm test` is green on CI and a minimal public health/home route exists. This unblocks the agent-os builder→proof→inspect→judge loop for later v1 Scheduling slices (auth, calendar, booking).

## Non-goals

- Google OAuth / Calendar / Gmail scopes
- Booking pages, slot engine, event types, or data model tables beyond what Next/Prisma scaffold stubs need
- Chrome extension, embeds, webhooks, Inngest workflows
- Round robin, routing forms, SMS, Stripe, Zoom/Teams (v2+)
- Custom booking domain DNS (`book.myoli.co`) or brand token polish
- Multi-tenant sell / notetaker / native apps
- Changing `.github/`, branch protection, or `PROOF_CMD` name (`npm test` stays)

## Acceptance criteria

| ID | Criterion | How it is observed |
|---|---|---|
| AC-1 | Root `package.json` exists with Node scripts; `npm test` exits 0 on a clean checkout after `npm ci` | CI `proof` job and local `npm ci && npm test` |
| AC-2 | App is Next.js App Router + TypeScript; `npm run build` succeeds (add script; may be invoked from test harness or documented as part of proof if folded into `npm test`) | `npm test` green implies typecheck/build or dedicated scripts that `npm test` runs |
| AC-3 | Authenticated-unneeded public route `GET /` returns HTTP 200 with Marlo Scheduling placeholder copy (not a Vercel 404) | curl or Playwright against `next start` / preview URL |
| AC-4 | `GET /api/health` returns HTTP 200 JSON `{ "ok": true }` | curl / unit or integration test |
| AC-5 | README documents how to run locally (`npm ci`, `npm test`, `npm run dev`) without referencing secrets | file review |

## Builder

BUILDER: claude — greenfield Next scaffold + test harness fits Claude implement lane. Inspector: codex (separate). Judge: Grok via agent-os.

## Approach

1. Scaffold Next.js App Router TypeScript app at repo root (keep existing `AGENTS.md`, `docs/`, `.github/workflows`).
2. Add a minimal Vitest or Node test runner wired to `npm test` so the existing `proof.yml` gate passes.
3. Add `app/page.tsx` (or `src/app`) placeholder and `app/api/health/route.ts`.
4. Do not commit `.env*` or secrets; leave Neon/Auth wiring for a later PLAN.
5. If Prisma is added, only an empty/minimal schema with no production credentials required for `npm test`.

## Assumptions and risks

- Phase 0 v1 packet APPROVED 19 Sep 2026 (VP Product + Shahar go): stack Next/Vercel/Neon/Inngest; domain `book.myoli.co` later; InboxSDK later.
- Risk: `npm test` currently has nothing to run (no `package.json`) — this PLAN exists to fix that.
- Risk: Vercel Git App may still lack repo access — deploy can wait; CI proof on GitHub must pass first.
- MacBook Pro must be awake for `agent-os dispatch`; Mac-mini already has the clone at `~/Developer/marlo-scheduling`.

## Verification

```text
PROOF_CMD: npm test
```

Expected result: exit code 0; at least one passing test covering health and/or smoke of the app module. Manual: after merge+deploy (when Git linked), `/` and `/api/health` 200 on the Vercel URL.

## Round budget

MAX_JUDGE_ROUNDS: 3 · MAX_FIX_ROUNDS (proof retries per round): 2 · Escalate to Shahar on exhaustion.
