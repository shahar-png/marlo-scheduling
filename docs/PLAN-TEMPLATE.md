# PLAN — <feature name>

Spec owner: Shahar + Claude · Product review: Shahar + Grok · Status: DRAFT | APPROVED (sha256: …)

## Goal

One paragraph. What exists after this ships that does not exist now, and for whom.

## Non-goals

What this work order explicitly does not touch. The judge treats work outside this list as a defect, not a bonus.

## Acceptance criteria

Every criterion has a stable ID. The inspector checks them, the judge cites them by ID in `unmet_criteria`. Observable behaviour only; no "code is clean".

| ID | Criterion | How it is observed |
|---|---|---|
| AC-1 | … | test name / command / manual step |
| AC-2 | … | … |
| AC-3 | … | … |

## Builder

BUILDER: claude | codex — chosen per work order by `claudex-route` (task fit, not a fixed ranking). One line why. Inspector is the other; judge is Grok.

## Approach

Files to add or change, in order. Key decisions and the trade-off behind each. Anything an impossible requirement should be reported against rather than silently redesigned.

## Assumptions and risks

Confirmed assumptions with their source (path or link). Remaining risks and what would make them real.

## Verification

```text
PROOF_CMD: <exact command, e.g. npm test && npm run lint && npm run typecheck>
```

Expected result: what green looks like (test count, exit code). Manual or visual checks, if any, with who performs them.

## Round budget

MAX_JUDGE_ROUNDS: 3 · MAX_FIX_ROUNDS (proof retries per round): 2 · Escalate to Shahar on exhaustion.
