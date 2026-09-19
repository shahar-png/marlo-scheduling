> Supersedes the completed scaffold PLAN (shipped @ `7696cff`). That slice is done: Next.js App Router + TypeScript, `npm test` green, `/` and `/api/health` in place. This work order is the next v1 slice only.

# PLAN — Google OAuth + Calendar connect (v1)

Spec owner: Shahar + VP of Product · Product review: Shahar + Grok · Status: APPROVED (Founder go continuous + VP Product, 19 Sep 2026 ET) — Founder said keep going after slice 1.

## Goal

Hosts on `marlo-scheduling` can sign in with Google (Google Workspace **Internal** app for `myoli.co`) and connect Google Calendar so the product can later read free/busy and write to a chosen destination calendar. After this ships, Auth.js has a Google provider, a sign-in path exists, a calendar-connection stub records destination calendar + connection status, and a `freeBusy` adapter interface is proven against a mock Google fixture — unlocking later booking slices without implementing booking yet.

## Non-goals

- Booking UI, public booking pages, event types, or a slot/availability engine
- Sending mail via Gmail (or any outbound email)
- Chrome extension, InboxSDK, embeds, or webhooks
- Round robin, routing forms, or multi-host assignment
- Multi-tenant sell / notetaker / native apps
- Outlook / Microsoft 365 calendar
- Custom booking domain DNS (`book.myoli.co` stays later)
- Changing `.github/`, branch protection, or the `PROOF_CMD` name (`npm test` stays)

## Acceptance criteria

Every criterion is observed **only** via `PROOF_CMD` (`npm test`). The existing proof harness already folds typecheck + `next build` + unit tests into `npm test` (`scripts/proof.cjs`); keep that. No manual, curl-only, preview-URL, or live-Google observation.

| ID | Criterion | How it is observed |
|---|---|---|
| AC-1 | Auth.js is wired with a Google provider (config module exists and is imported by the app; Google is in the providers list). Tests must not call live Google. | Solely `PROOF_CMD` (`npm test`) — unit test asserts the auth config exports a Google provider (id/name) without network I/O |
| AC-2 | Unauthenticated access to a protected host route is redirected to a sign-in route; the sign-in route renders a Google sign-in control. No live OAuth dance. | Solely `PROOF_CMD` (`npm test`) — render/redirect unit tests (no live server required) |
| AC-3 | A calendar-connection model + service stub exists: a host can record connected status and a destination calendar id. No production DB credentials or live Google required. | Solely `PROOF_CMD` (`npm test`) — unit tests for stub create/read (in-memory or module-level is fine) |
| AC-4 | A `freeBusy` adapter interface exists; given a checked-in mock Google freeBusy fixture, it returns a typed list of busy windows (start/end). No live Google Calendar API. | Solely `PROOF_CMD` (`npm test`) — fixture unit test against the adapter |
| AC-5 | README documents required env **names** (at least `AUTH_SECRET`, `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`) and does not contain secret values. Existing `npm ci` / `npm test` / `npm run dev` docs remain. | Solely `PROOF_CMD` (`npm test`) — a test reads README and asserts those names are present and no credential-shaped secret values are committed |

## Builder

BUILDER: claude — Auth.js + Next App Router wiring and stub/adapter tests fit the Claude implement lane. Inspector: codex (separate). Judge: Grok via agent-os.

## Approach

1. Add Auth.js (`next-auth` / Auth.js) with the Google provider. Keep secrets out of git; tests use dummy env or import the config module directly.
2. Add a sign-in route and one protected host route (middleware or server-side session check). Existing `/` placeholder and `/api/health` stay public so post-deploy health is unchanged.
3. Add a calendar-connection type + service stub (destination calendar id, connected flag). Do not require Neon/Prisma credentials for `npm test`; a real table can wait.
4. Add a `freeBusy` port (interface) plus an adapter that maps a mock Google freeBusy JSON fixture into typed busy windows. Production Google client is out of scope if it cannot run without secrets.
5. Extend README with env **names only**. Extend `tests/` (same Node test runner) so AC-1..5 are covered by `npm run test:unit`. Do not change `PROOF_CMD`; do not edit `.github/`.
6. If an AC cannot be observed without live Google or a real OAuth redirect, report it as impossible rather than adding a manual AC.

## Assumptions and risks

- Phase 0 locks **D-01..D-05** (v1 packet APPROVED 19 Sep 2026, VP Product + Shahar go). Stack remains Next/Vercel/Neon/Inngest; booking domain `book.myoli.co` is later; this slice does not reopen those decisions.
- Google OAuth app is **Internal** to the `myoli.co` Workspace. External/unverified OAuth and multi-workspace tenancy are out of scope.
- Founder go continuous after slice 1 (19 Sep 2026 ET): this PLAN is the next dispatched work order, not a product-reopen.
- Risk: Auth.js needs `AUTH_SECRET` / Google client ids at runtime — `npm test` must stay green on CI without those secrets (dummy values or mocked config).
- Risk: live Google Calendar / OAuth cannot run in `proof` — adapters and routes must be testable via fixtures and redirects only.
- Risk: adding a real DB in this slice would fail `npm test` without credentials — stubs first.

## Verification

```text
PROOF_CMD: npm test
```

`PROOF_CMD` remains exactly `npm test`. Green (exit code 0) means typecheck + `next build` + unit tests all pass, including AC-1..5 and the existing scaffold checks (home placeholder, `/api/health`, README install/dev commands). No manual or visual checks for this slice.

## Round budget

MAX_JUDGE_ROUNDS: 3 · MAX_FIX_ROUNDS (proof retries per round): 2 · Escalate to Shahar on exhaustion.
