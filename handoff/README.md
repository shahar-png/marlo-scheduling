# Marlo Scheduling — Front-end Implementation Handoff

| | |
|---|---|
| **Version** | 1.0 · 2026-09-20 |
| **Owner** | Shahar (product, brand) |
| **Pairs with** | `marlo-scheduling-spec.md` v1.0 (product + backend spec; requirement IDs referenced below) |
| **Design source** | Design canvas "Marlo Scheduling UI" — https://claude.ai/artifact/DVEgkQX6k5KuCkVNbJtAPw (six approved artboards; ask Shahar for access) |
| **Status** | Approved for build against the existing backend |

## 0. What's in this package

```
handoff/
  README.md                      ← this document
  assets/logo/marlo-mark.svg     ← icon, currentColor, viewBox 0 0 1193 535
  assets/logo/marlo-wordmark.svg ← wordmark, currentColor, viewBox 0 0 2105 562
  tokens/marlo.css               ← design tokens + light/dark/surface theming (source of truth)
  tokens/tailwind.preset.js      ← same tokens for Tailwind
  copy/en.json                   ← every user-facing string, ICU MessageFormat
```

The logo SVGs are vector traces of the supplied brand PNGs, accurate to sub-pixel at every size used in the UI. If the brand team supplies master SVGs later, drop them in at the same paths; the API of the `<Logo>` component does not change.

## 1. Scope and assumptions

Front-end scope is everything a person sees: public booking pages, the host web app, the confirmation/reschedule/cancel pages, email templates, and the Chrome extension UI. The backend exists; this document assumes it implements the contract in spec Section 8 (`/api/v1/...` and `/public/...`). Where the built backend diverges, **adapt in one place** — the `lib/api/` client module described in Section 3 — and never in components. Log every divergence in `lib/api/DIVERGENCES.md` so the spec can be reconciled.

Brand rules are fixed and non-negotiable (Section 4). Typefaces are stand-ins (Section 4.3).

Phasing follows the spec: this handoff covers **v1 screens**. Round robin, routing forms, polls, contacts, and analytics screens (v2) reuse the same components; they are not designed yet.

## 2. Stack

Next.js 15 (App Router, React Server Components, TypeScript strict) on Vercel · Tailwind with `tokens/tailwind.preset.js` · Radix UI primitives for popover, select, dialog, tabs (unstyled; styled with tokens) · `@formatjs/intl` + `react-intl` for `copy/en.json` · `date-fns` + `@date-fns/tz` (never `Date` string parsing for wall-clock) · TanStack Query for client data · Zod schemas for every API response · MJML for emails (compiled at build, rendered server-side with the same tokens) · Vite + InboxSDK for the extension (spec `EXT-01`…`EXT-07`) · Playwright for E2E · Storybook for the component inventory · Sentry.

Route groups:

```
app/
  (public)/[slug]/page.tsx                 user or group landing         spec URL-01
  (public)/[slug]/[event]/page.tsx         booking page (step 1 + 2)     Main, Details artboards
  (public)/b/[token]/page.tsx              booking detail / confirmation Confirmation artboard
  (public)/b/[token]/reschedule/page.tsx
  (public)/b/[token]/cancel/page.tsx
  (public)/d/[token]  /o/[token]  /s/[token]   single-use, one-off, shared times → same booking components
  (app)/event-types/page.tsx               Dashboard artboard
  (app)/event-types/[id]/edit/page.tsx     editor (spec EVT-01…40; wireframe-level, no artboard)
  (app)/meetings, /availability, /workflows, /integrations, /settings, /admin
emails/                                    MJML templates                Email artboard
extension/                                 MV3 + InboxSDK                Gmail artboard
```

## 3. Architecture rules

1. **API client is the only place that knows the backend.** `lib/api/` exports typed functions (`getSlots`, `createBooking`, `rescheduleBooking`, …) validated with Zod. Components never call `fetch`.
2. **All times are instants + zone.** The API returns ISO 8601 UTC; the UI converts with the invitee's zone (`Intl.DateTimeFormat().resolvedOptions().timeZone`, overridable, persisted in `localStorage` key `marlo.tz`) at render time only. Tabular numerals on every time.
3. **No copy in components.** Every string comes from `copy/en.json` via `useIntl()`. Adding a string = adding a key.
4. **Theming by surface, not by class.** Tokens switch through `data-surface="dark|lime"` on a container and `data-theme` on `<html>`. Components use semantic tokens (`--ink`, `--surface`, `--cta`) and never raw brand hexes, except the `Logo` and the event-color chips.
5. **Server-render the public shell**; slot data streams in. No client bundle > 250 KB gz on public routes (spec `BOOK-14`).
6. **Accessibility is a build gate**: axe in Storybook and Playwright; keyboard paths in Section 9 must pass before a PR merges.

## 4. Brand rules (final)

### 4.1 Logo

- Two assets: the **mark** (icon) and the **wordmark**. Both render as inline SVG through `<Logo variant="mark|wordmark" />` so `currentColor` applies.
- **Color rule:** ink `#191918` on bright surfaces (cream, white, lime); cream `#f2eade` on dark surfaces (ink, slate). The `--logo` token already encodes this; the component just uses `color: var(--logo)`.
- **Never** place either asset on a tile, pill, circle, or any shape of its own. No backgrounds around the logo, ever — including favicon and app icon contexts inside our UI. (The app-icon tiles from the brand board are for OS home screens only.)
- Minimum sizes: mark 18 px tall, wordmark 16 px tall. Clear space = the mark's height on all sides.
- Sizes used in the approved screens: wordmark 92×25 (booking header), 84×22 (nav, email), 72×19 (mobile, extension panel); mark 200×90 (confirmation hero), 24×11 (footers), 22×10 (email footer, inserted block), 20–22 (extension toolbar button).

### 4.2 Color

| Token | Hex | Use |
|---|---|---|
| ink | `#191918` | Text, primary surfaces (app nav), primary CTA fill |
| slate | `#3e5259` | Secondary text (`#3e5258` variant for 4.5:1 on cream), avatars, active nav item, dark secondary panels |
| cream | `#f2eade` | Page ground (light), selected-slot echo, text on dark |
| lime | `#e5feb3` | Selection (available dates, chosen slots, pressed states), success/confirmation panels, CTA text on ink |
| white | `#fcfcfc` | Cards on cream |

Rules: lime is never a text color on light surfaces; lime backgrounds always carry ink text. Primary CTA = ink fill + lime text (`Lock it in`, `Next`, `Insert into email`, `Join Meet`). Secondary = 1 px `line-strong` border, ink text, transparent fill. Destructive actions are text links in slate; the red token is reserved for inline validation. Event-type color chips use only ink / slate / lime (the 12-chip palette in the spec collapses to these three plus their tints at v1).

### 4.3 Type

Stand-in pairing until the brand guide names faces: **Outfit** (display: headlines, event names, times in hero contexts) and **Manrope** (everything else). Load from Google Fonts with `display=swap`; self-host at launch. When the real faces arrive, change two tokens (`--font-display`, `--font-text`) and re-check the display sizes in `tokens/marlo.css`.

Scale: hero 112 px (confirmation "Handled." only), xl 56 px (email headline), lg 34 px (booking headline), md 30 px (mobile headline), sm 20 px (section titles); UI text 14/15 px; captions 12/13 px; caps labels 11–13 px at `0.08em` tracking. Headline tracking `-0.02em`, hero `-0.04em`.

### 4.4 Voice

"Handled Right" — warm and loud. Headlines ≤ 5 words, buttons are verbs, times are always spelled out. All approved strings are in `copy/en.json`; do not paraphrase them in code, and route new strings through Shahar.

## 5. Component inventory

Build these in Storybook first (one story per state); screens compose them.

| Component | Props (essential) | Spec / behavior |
|---|---|---|
| `Logo` | `variant: mark\|wordmark`, `height` | Section 4.1. Inline SVG, `aria-label="Marlo"`, decorative instances `aria-hidden`. |
| `Button` | `variant: primary\|secondary\|ghost\|link`, `size: md(48)\|sm(36)\|xs(34)`, `asChild` | Radius 12 (md), 10 (sm), 8 (xs). Primary: ink/lime. Focus ring: 2 px ink offset 2 px (cream ring on dark). Min tap 44 px on mobile (pad hit area, not visual). |
| `IconButton` | `label` (required) | 36–44 px circle, ghost. |
| `Field` | `label`, `hint`, `error`, `required`, wraps `input\|textarea\|select` | Height 48, radius 12, border `line-strong`; focus border 1.5 px ink; error border danger + message below in 12 px. Label 13 px/600 above. |
| `MonthGrid` | `month`, `availableDates: Set<ISODate>`, `selected`, `min`, `max`, `onSelect`, `weekStart` | 7-col grid, 48 px cells (40 on mobile), day labels 11 px caps. Available = lime circle; selected = ink circle/cream text; today = 1.5 px ink outline; out-of-range = `muted`. ARIA `grid` with roving tabindex; arrow keys move, PageUp/Down change month, Enter selects; month change announced via live region. |
| `SlotList` | `date`, `slots: {start, spotsLeft?}[]`, `selected`, `onSelect`, `onConfirm`, `hourFormat` | Column of 48 px buttons, radius 12, border `line-strong`, 15 px/600 tabular. Selected slot splits into two: a cream disabled-look time + an ink/lime "Next" button (Calendly interaction, keep). Group types show `spotsLeft` caption right-aligned inside the button. |
| `TimezoneSelect` | `value`, `onChange` | Searchable Radix combobox of IANA zones with city labels; globe icon; persists to `localStorage`. |
| `HourFormatToggle` | `value: 12\|24` | Pill segmented control, 34 px. |
| `SelectedTimeChip` | `eventName`, `duration`, `start`, `tz`, `onChange` | Cream rounded 16 panel with "Change" link (Details artboard top). |
| `Badge` | `tone: neutral\|secret\|off\|managed` | 10 px caps, pill, cream fill / slate text. |
| `EventTypeCard` | `eventType`, `stats`, actions | White card radius 20, 6 px top border in the event color, name 18 px display, meta 13 px slate, primary "Copy link" (sm) + secondary "Share times"/"Single-use link"; `off` state at 60 % opacity with "Turn on". Kebab `IconButton` top-right. |
| `NavRail` | `items`, `active`, `user` | 232 px ink rail (`data-surface="dark"`): wordmark 84 px, lime "Create" button 44 px, items 40 px radius 10 (active = slate fill), user card at bottom on `ink-2`. Collapses to a bottom tab bar < 1024 px. |
| `TodayRail` | `bookings`, `weekStats` | 320 px aside; next meeting on lime with "Join Meet" ink button; others on white; slate stat card at bottom. Hidden < 1280 px (moves under the grid). |
| `Panel` / `Sheet` | | Desktop popover panel radius 20 + `shadow-panel`; mobile bottom sheet. Used by extension and share dialogs. |
| `Tabs` | | 13 px/600, 2 px ink underline on active (extension panel). |
| `SlotMiniGrid` | `days[5]`, `slotsByDay`, `selected: Set`, `max=20` | Extension picker: 5 columns, 34 px buttons radius 8; selected = lime fill/700; unavailable rows = cream blank. |
| `InsertedTimesBlock` | `slots`, `eventUrl`, `tz` | Email-safe HTML (tables, inline CSS, no `<style>`): cream box radius 12, mark + "PICK A TIME THAT WORKS" caps, date rows with underlined time links, "Or pick any time" line. Rendered server-side by `POST /share_pages` (spec `OFF-03`) and by the extension. |
| `EmptyState` / `ErrorState` | `title`, `body`, `action` | Uses `states.*` strings. |
| `Toast` | | Bottom-center, ink fill, cream text, 160 ms. "Copied". |

## 6. Screens (v1)

Each screen lists: artboard, route, data, layout, states, interactions, and acceptance references from the spec.

### 6.1 Booking page — step 1 (artboard `Main`, 1280×860)

Route `/{slug}/{event}` (also `/d/`, `/o/`, `/s/` variants). Data: `GET /public/event_types/{slug}?owner=` (server) and `GET /public/event_types/{id}/slots?month=&timezone=` (client, TanStack, `staleTime` 30 s, refetch on window focus).

Layout: cream page; header row 1040 px wide with wordmark left and "Times shown in {tz} · Change" right; white card 1040×720 radius 28 with `shadow-card`. Left column 360 px: avatar 48 (initial on slate, or Google photo), host name 14/600 + role 12 slate, headline 34 display "Grab time with {first}", event name 15/600, meta rows (clock, video, globe icons 18 px) 14 px slate, description 14 px, policy line pinned to bottom 12 px slate. Right area: `MonthGrid` 392 px + `SlotList` beside it (≥ 1280); below the grid: `TimezoneSelect` + `HourFormatToggle` separated by a hairline. Footer: mark 24 px + "Scheduled with Marlo" 12 px slate, centered.

States: loading (skeleton cells, no layout shift), empty month (`booking.emptyMonth` + Next month affordance), event off (`states.eventOff`), calendar disconnected (`states.calendarDisconnected`), 404 (`states.notFound`), link used (`states.linkUsed`), slot taken on confirm → refresh list + `details.errors.slotTaken` toast (spec `SLOT-12`, `AC-04`).

Interactions: deep-link params `month`, `date`, `slot`, `timezone`, prefill (`URL-02`); selecting a date scrolls the slot list into view on mobile; selecting a slot updates the URL (`?date&slot`) so refresh/back preserve state; "Next" navigates to step 2 without a page load.

Responsive: < 1280 slot list drops below the grid; < 768 single column, sticky header with wordmark, month grid full-width 40 px cells, slot buttons full-width; step 2 becomes its own screen (6.2).

### 6.2 Booking page — step 2 (artboard `Details`, 390×844)

Same route, `?step=details` (mobile is a new screen, desktop replaces the right area). `SelectedTimeChip` at top, headline 30 display "Almost there.", `Field`s: Name, Email (email field shows the 1.5 px ink focus border in the artboard), "Add guests" progressive disclosure → email chips (max `max_guests`), custom questions in order (types per spec `EVT-35`; conditional visibility), optional consent line, sticky bottom bar with primary CTA 52 px "Lock it in" and footnote 11 px.

Submit: `POST /public/bookings` with `idempotency_key` (UUID generated when the step opens; reused on retry). Success → replace to `/b/{token}` (6.3). 409 `slot_unavailable` → back to step 1 with toast; 409 `session_full` → `details.errors.sessionFull` + other sessions; 422 → field errors from the problem-details `errors[]` map.

Validation: client-side inline on blur; server authoritative. E.164 phone with country selector when a phone question or phone location exists.

### 6.3 Confirmation (artboard `Confirmation`, 1280×720)

Route `/b/{token}`. Data: `GET /public/bookings/{token}`. Layout: left 560 px lime panel (`data-surface="lime"`): wordmark 100 px top, mark 200 px, hero "Handled." 112 display, subhead 18 px (`confirmation.subhead`), "Scheduled with Marlo" 12 px slate bottom. Right: caps label event name 13 px, date and time range in 36 display tabular on two lines, zone line 14 px slate (`bothSameZone` / `differentZones`), `<dl>` With / Where / You said (120 px label column), "Add to calendar" pills 44 px (Google / Outlook / Office 365 / .ics — hrefs generated server-side, `.ics` from `NOTIF-04`), hairline, Reschedule (ink) + Cancel (slate) text links.

Mobile: lime panel becomes the top block (mark 120 px, hero 64 px), details stack below. `confirmation_type = redirect` → server redirect with pass-through params (`EVT-37`); `custom_message` → rendered rich text under the `<dl>`.

### 6.4 Reschedule and cancel

`/b/{token}/reschedule`: step-1 layout with a cream banner (`reschedule.banner`) above the grid, current slot highlighted with an outline, optional reason textarea at step 2, CTA "Move it", done state `reschedule.done`. `/b/{token}/cancel`: single card, headline "Cancel this one?", policy text from the event type, optional/required reason, secondary "Keep it" + primary "Cancel meeting", done state with "Book a new time". Blocked-by-notice state per `BOOK-07`.

### 6.5 Host app — Event types (artboard `Dashboard`, 1440×900)

Route `/event-types`. Data: `GET /event_types?user=me` (+ `?group=` for team tabs), `GET /bookings?min_start=today&max_start=tomorrow`, weekly stats from `GET /analytics/bookings` if present, else computed client-side from `/bookings`. Layout: `NavRail` 232 · main (padding 32/40): title 32 display + summary 14 slate, right-aligned search (240 px) + secondary "Copy my link"; filter pills row (`Mine`, group names, `All users` for admins); 3-column card grid gap 16 (2 columns < 1280, 1 < 768); `TodayRail` 320.

Card actions: "Copy link" writes the public URL and shows the "Copied" toast; "Share times" opens the share `Panel` (date range, `SlotMiniGrid`, format toggle, copy HTML/text, embed code, QR — spec `OFF-03`); "Single-use link" → `POST /scheduling_links` then copy; kebab → edit, clone, turn on/off, delete (blocked with future bookings, offer turn off), internal note.

### 6.6 Event-type editor (no artboard; build from spec `EVT-01…40`)

Two-pane: left sticky section nav (Event details, Location, Scheduling, Questions, Notifications, Confirmation, Permissions), right form. Use `Field` throughout; live URL preview under the slug; buffers/notice/limits as select + number; date-range radio with inline inputs; questions as a sortable list with a type select; location as a checklist with per-type inline fields. Save = `PATCH /event_types/{id}`; unsaved-changes guard. Managed-event locks (v2) render as a lock icon + disabled section.

### 6.7 Availability, Meetings, Workflows, Integrations, Settings, Admin (no artboards)

Build straight from the spec (`AVL-05` diagnostics view is required in v1; `LIFE-02` dashboard; `WF-07` editor; `ADM-01…06`). Use the same rail, page header, card, and field patterns; no new visual language. Get a review from Shahar on each before polish.

### 6.8 Confirmation email (artboard `Email`, 640×820)

MJML template `emails/booking-confirmation.mjml`: 560 px column, radius 20 card on cream; lime header block (wordmark 84 px, "Handled." 56 display, intro 15 px); body table What / When / Where / Who with 88 px label column and hairlines; primary button 48 px ink/lime "Join Google Meet" (or "Add to calendar" when no video link); "You said:" italic line; text links Reschedule / Cancel / Add to calendar; footer with mark 22 px + "Scheduled with Marlo" and "Reply to reach {host} directly". Web fonts fall back to system sans in email. Plain-text alternative generated from the same data. Reminder, canceled, moved variants reuse the shell with the subjects in `copy/en.json → email.*`.

### 6.9 Gmail extension — Share times (artboard `Gmail`, 1000×660)

Panel 380×600, radius 20, `shadow-panel`, anchored to the compose window: header (wordmark 72 px + close), `Tabs` (Share times / Insert link / One-off / Single-use), event-type selector (bordered row with name + meta + chevron), week header with prev/next, `SlotMiniGrid`, footer with selected count + primary "Insert into email". Toolbar icon = mark 22 px in ink on a **transparent** 36 px button (no tile). Inserted content = `InsertedTimesBlock` (email-safe HTML) followed by the "Talk soon" text the host had. Data: extension token (`EXT-01`) → `GET /event_types?user=me`, `GET /event_types/{id}/available_times?start&end&timezone`, `POST /share_pages`.

## 7. Data contracts the front-end consumes

From spec Section 8.3, with the response shapes the UI expects (Zod schemas in `lib/api/schemas.ts`):

```ts
// GET /public/event_types/{id}/slots?month=YYYY-MM&timezone=IANA
{ month: "2026-09", timezone: "America/New_York",
  days: { "2026-09-22": [ { start: "2026-09-22T14:00:00Z", spots_remaining?: number, hosts?: string[] } ] } }

// POST /public/bookings
{ event_type_id, start, timezone, invitee: { name, email, phone? }, guests?: string[], answers?: Record<string,string|string[]>,
  location?: string, duration?: number, host?: string, utm?: {}, embed_domain?: string, idempotency_key, captcha_token? }
→ 201 { booking: { token, start_at, end_at, status, location: {type, value, meeting_url?}, event_type: {name, duration_minutes, confirmation}, hosts: [{first_name, name, timezone}] },
        invitee: { name, email, timezone, answers[] }, calendar_links: { google, outlook, office365, ics } }
→ 409 { type, code: "slot_unavailable" | "session_full", detail }
→ 422 { type, code: "validation_error", errors: [{ field, message }] }

// GET /public/bookings/{token} → same as 201 body plus can_reschedule, can_cancel, min_cancel_notice_minutes, policy_text
// POST /public/bookings/{token}/reschedule { start, reason? }   POST /public/bookings/{token}/cancel { reason? }
```

If the built backend names fields differently, map them in `lib/api/adapters.ts`; keep the schemas above as the UI-facing types.

## 8. Analytics events (first-party, spec `ADM-09`, `EMB-03`)

`page_view` (`{slug, event_type_id?, step}`), `slot_selected`, `booking_created`, `booking_rescheduled`, `booking_canceled`, `copy_link`, `share_times_inserted`. Post to `POST /public/events` (batch, `sendBeacon`), and forward the four embed events to the parent window with `postMessage` when `embed_type` is set.

## 9. Quality gates (definition of done per screen)

1. Storybook stories for every state listed in Section 6, reviewed against the artboard at 100 % zoom.
2. Keyboard-only path: booking page (month → date → slot → Next → fields → Lock it in) completes without a mouse; focus order matches visual order; screen reader announces month changes and slot counts (`BOOK-13`, `AC-16`).
3. axe: zero serious/critical issues. Contrast: all text ≥ 4.5:1 in light and dark (slate-text `#3e5258` on cream passes; slate on lime passes; never lime text on cream).
4. Lighthouse mobile on the booking page: Performance ≥ 90, LCP ≤ 1.5 s on simulated 4G (`BOOK-14`, `AC-18`); public bundle ≤ 250 KB gz.
5. DST fixtures from spec `TIME-01` rendered correctly in the UI (`AC-03`).
6. Playwright E2E: book, reschedule, cancel, slot-taken race (mocked 409), group full, single-use link reuse, extension insert (`AC-04`, `AC-05`, `AC-12`, `AC-13`).
7. No hard-coded strings; `copy/en.json` diff reviewed by Shahar.
8. Logo audit: grep for `marlo-mark`/`marlo-wordmark` usages; every instance uses `<Logo>` with `--logo` color and no background.

## 10. Open items

| # | Item | Owner |
|---|---|---|
| 1 | Brand typefaces (replace Outfit/Manrope) | Shahar / brand |
| 2 | `{{BOOKING_DOMAIN}}` and `{{WORKSPACE_DOMAIN}}` values (spec D-02); mockups show `book.marlo.co` as a placeholder | Shahar |
| 3 | Confirm backend endpoint names/shapes against Section 7; record divergences | Backend lead |
| 4 | Favicon / app icon: use the mark alone on transparent; the OS home-screen tiles come from the brand board | Front-end |
| 5 | Editor and settings screens (6.6, 6.7) get a design review before polish | Shahar |
