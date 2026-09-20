# Marlo Scheduling — Product & Technical Specification

| | |
|---|---|
| **Product** | Marlo Scheduling (working title — see Open Decisions D-01) |
| **Owner** | Shahar, Marlo |
| **Version** | 1.0 — Marlo-only branding; supersedes 0.9 |
| **Date** | 2026-09-20 |
| **Status** | Ready for estimation. Sections marked `{{PLACEHOLDER}}` need input from Marlo before build. |
| **Audience** | Engineering (full-stack, front-end, Chrome-extension), design, QA |
| **Placeholders** | `{{WORKSPACE_DOMAIN}}` = Marlo's Google Workspace domain; `{{BOOKING_DOMAIN}}` = public booking host (D-02) |

---

## 0. How to read this document

Sections 1–4 define what we are building and why. Section 5 is the functional spec, organized by product area, with Calendly's behavior reverse-engineered into explicit rules. Section 6 is brand and UX. Sections 7–9 are architecture, data model, API, and non-functional requirements. Section 10 is acceptance criteria; Section 11 is phasing; Section 12 lists decisions Marlo still owns.

Requirement IDs (`EVT-01`, `BOOK-07`, …) are stable and should be referenced in tickets, PRs, and test cases.

Priority language: **MUST** = required for the stated phase; **SHOULD** = expected unless there is a documented reason not to; **MAY** = optional.

---

## 1. Summary

Marlo needs an internal meeting-scheduling platform with full Calendly feature parity, running on Google Workspace (Gmail + Google Calendar), carrying the Marlo brand on every invitee-facing surface. Hosts are Marlo team members. Invitees are members, brand partners, investors, candidates, and vendors.

The system replaces Calendly for Marlo. It is single-tenant (one organization: Marlo) but built with an `organization` boundary in the data model so multi-tenant is a configuration change, not a rewrite.

### 1.1 Goals

1. Zero back-and-forth scheduling: hosts share a link or times; invitees self-book against live Google Calendar availability.
2. Calendly parity: every Calendly feature listed in the parity matrix (Section 3) exists, phased across v1–v3.
3. Gmail-native: schedule from inside Gmail compose (link, times, one-off meetings, polls); confirmations sent from the host's own Gmail address; calendar invites from the host's own Google Calendar.
4. Marlo-branded: booking pages, emails, and embeds read as Marlo ("Handled Right"), not as a generic scheduler.
5. Automatable: webhooks and a REST API so the Agentic OS and the Marlo agent can create, read, and react to bookings.

### 1.2 Non-goals (v1–v3)

- Selling the product to other companies (multi-tenant billing, self-serve signup, plan tiers).
- AI notetaker / meeting recording / meeting transcripts (Calendly Notetaker, Callie). Out of scope entirely.
- Native iOS/Android apps. A responsive PWA covers mobile for hosts; invitee booking is mobile-first web.
- Outlook / Exchange / iCloud calendar sync at v1 (v3 candidate; the calendar-provider layer is abstracted so it can be added).
- Salesforce / Marketo / Pardot routing (v3 candidate; HubSpot is v2).

### 1.3 Success metrics

| Metric | Target |
|---|---|
| Booking conversion (booking page view → confirmed) | ≥ 35% on 1:1 event types |
| Time-to-book (page load → confirmation) | median ≤ 60 s |
| Double-booking incidents | 0 |
| Notification delivery (confirmation, reminders) | ≥ 99.5% within 60 s of trigger |
| Host time saved vs. Calendly | qualitative; no regression in features used by the Marlo team |

---

## 2. Users, roles, permissions

### 2.1 Personas

| Persona | Description | Primary surfaces |
|---|---|---|
| **Host** | Marlo team member who owns event types and gets booked. | Dashboard, event-type editor, availability, Gmail extension |
| **Admin** | Marlo operator managing users, groups, managed events, branding, integrations. | Admin console |
| **Owner** | Shahar. Admin plus ownership transfer. | Admin console |
| **Invitee** | External person booking a time. Never has an account. | Public booking page, emails, reschedule/cancel pages |
| **System / Agent** | Agentic OS, the Marlo agent, Zapier. | REST API, webhooks |

### 2.2 Role matrix (`ROLE-01`)

| Capability | Owner | Admin | Host (User) |
|---|---|---|---|
| Manage own event types, availability, calendars | ✓ | ✓ | ✓ |
| View/manage own scheduled events | ✓ | ✓ | ✓ |
| Create team event types (round robin, collective) | ✓ | ✓ | ✓ if in the team |
| View all users' scheduled events | ✓ | ✓ | – |
| Invite/remove users, assign roles | ✓ | ✓ | – |
| Create groups (teams) | ✓ | ✓ | – |
| Create/lock managed events | ✓ | ✓ | – |
| Org branding, default templates | ✓ | ✓ | – |
| Org-scope webhooks, API tokens | ✓ | ✓ | – |
| Audit log, data deletion requests | ✓ | ✓ (read) | – |
| Transfer ownership | ✓ | – | – |

`ROLE-02` Per-event-type permissions: an event type has an owner (user) and optional editors (users). Admins can edit any event type. Managed events override this (Section 5.10.5).

---

## 3. Calendly parity matrix

The matrix is the scope contract. "Phase" is the release in which the feature MUST ship. Where Calendly gates a feature by plan, we do not; everything is available to every Marlo user.

| # | Calendly feature | Our behavior | Phase |
|---|---|---|---|
| 1 | Google sign-in, Google Calendar connect | Google OAuth only (Workspace domain `{{WORKSPACE_DOMAIN}}` restricted) | v1 |
| 2 | Multiple calendars for conflict check (Calendly: up to 6) | Unlimited Google calendars per user; one "add to" calendar | v1 |
| 3 | Availability schedules (weekly hours, multiple schedules, date overrides, time zone) | Same | v1 |
| 4 | Event-type-specific availability (custom hours) | Same | v1 |
| 5 | One-on-one event type | Same | v1 |
| 6 | Group event type (1 host, N invitees, capacity) | Same | v1 |
| 7 | Collective event type (all hosts must be free) | Same | v1 |
| 8 | Round robin (optimize for availability / equal distribution, priority, weighting) | Same + configurable counting window | v2 |
| 9 | Managed events (admin templates with locked sections) | Same | v2 |
| 10 | One-off meetings | Same | v1 |
| 11 | Single-use links | Same | v1 |
| 12 | Secret event types | Same | v1 |
| 13 | Meeting polls (≤ 40 slots, ≤ 40 participants) | Same | v2 |
| 14 | Date range (rolling days / fixed range / indefinite), min notice, buffers, start-time increments, daily/weekly/monthly limits, time-zone lock | Same | v1 |
| 15 | Locations: Google Meet, Zoom, Teams, Webex, phone (host calls / invitee calls), in-person, custom text, ask invitee | Google Meet, phone, in-person, custom, ask invitee (v1); Zoom, Teams (v2); Webex (v3) | v1/v2 |
| 16 | Invitee questions (text, textarea, radio, checkbox, dropdown, phone, required/optional, conditional on answer) | Same | v1 |
| 17 | Invitee can add guests | Same (max 10) | v1 |
| 18 | Notification mode: Calendar invitation vs Email confirmation | Same; email confirmations sent from host's Gmail via Gmail API | v1 |
| 19 | Custom email confirmation text, reminders, follow-ups, cancellation emails | Same via Workflows | v1 |
| 20 | SMS reminders (Calendly: 250 credits/user/mo on paid) | Twilio, no credit cap | v2 |
| 21 | Workflows (triggers, timing, email/SMS actions, variables, personalization) | Same | v1 email / v2 SMS |
| 22 | Confirmation page: default / redirect to external URL with pass-through params / custom message | Same | v1 |
| 23 | Reschedule and cancel (invitee + host), reason capture, cancellation policy text | Same | v1 |
| 24 | Mark no-show (invitee) | Same | v2 |
| 25 | Meetings dashboard: upcoming / past / date range / filters / export CSV | Same | v1 |
| 26 | Contacts (people you have met, meeting history) | Same | v2 |
| 27 | Booking page customization: logo, avatar, colors, welcome text, URL slug, hide branding | Marlo brand fixed; per-user avatar/bio; no per-user color overrides (Section 6) | v1 |
| 28 | Embeds: inline, popup widget, popup text; JS API; UTM & prefill params | Same | v1 |
| 29 | Chrome extension for Gmail: insert link, share available times, one-off, single-use link, poll, keyword detection | Same | v1 (link/times/one-off/single-use), v2 (poll, keyword detection, contact panel) |
| 30 | Google Workspace Add-on (Gmail sidebar, mobile Gmail) | Same | v3 |
| 31 | Routing forms (questions, rules, route to event type / URL / message, fallback, embed) | Same; HubSpot lookup v3 | v2 |
| 32 | Payments (Stripe, PayPal) before booking | Stripe only | v2 |
| 33 | Video: Zoom / Teams OAuth, per-booking unique links | v2 | v2 |
| 34 | CRM: HubSpot (create/update contact, log meeting) | v2 | v2 |
| 35 | Zapier / Make | Via webhooks + public API; official Zapier app v3 | v1 (webhooks) |
| 36 | Public API (users, event types, scheduled events, invitees, availability, scheduling links, routing submissions) | Same, plus `POST /bookings` (Calendly Scheduling API) | v2 |
| 37 | Webhooks (invitee.created, invitee.canceled, routing_form_submission.created) + signature | Same, plus `booking.rescheduled`, `invitee.no_show` | v1 |
| 38 | Admin: users, groups, permissions, domain claim, SSO/SCIM, audit log, data deletion API | Users/groups/permissions/branding (v1); audit log, data deletion, analytics (v2). SSO = Google; SCIM not needed | v1/v2 |
| 39 | Analytics (bookings by event type/host, popular days/times, cancellation rate) | Same | v2 |
| 40 | Multi-language booking pages | English only at v1; i18n scaffolding required | v1 (scaffold) |
| 41 | Mobile app | PWA | v2 |
| 42 | Host "request reschedule" (invitee picks new time) | Same | v1 |
| 43 | Booking-page tracking: Google Analytics 4 / GTM, Meta Pixel, LinkedIn Insight | Org-level tag IDs injected on public pages; embed events forwarded to parent | v2 |
| 44 | Slack notifications (new/canceled bookings to a channel) | Slack app, per-user or per-event-type channel | v3 |
| 45 | Notetaker / Callie AI | Not built | – |

---

## 4. Domain model and glossary

| Term | Definition |
|---|---|
| **Organization** | Marlo. Owns users, groups, branding, integrations, org-scope webhooks. |
| **User** | A Marlo team member with a Google Workspace login. Has a public scheduling page at `{{BOOKING_DOMAIN}}/{user_slug}`. |
| **Group** (Calendly: Team) | A named set of users with its own scheduling page `{{BOOKING_DOMAIN}}/{group_slug}` listing team event types. |
| **Calendar connection** | An OAuth grant to one Google account. Exposes N calendars. |
| **Conflict calendar** | A calendar checked for busy time. |
| **Destination calendar** | The single calendar where the host's booked events are written. |
| **Availability schedule** | Named weekly hours + date overrides + time zone. A user has ≥ 1; one is default. |
| **Event type** | A bookable meeting template. Kinds: `one_on_one`, `group`, `collective`, `round_robin`, `one_off`. |
| **Host** | A user assigned to an event type. |
| **Slot** | A candidate start time for an event type on a date, in the invitee's time zone. |
| **Booking** (Calendly: Scheduled event) | A confirmed instance: event type + start/end + host(s) + invitees. |
| **Invitee** | A person on a booking. Group bookings have many. Each invitee has its own reschedule/cancel token. |
| **Guest** | Extra email address an invitee adds. Receives the calendar invite; cannot reschedule. |
| **Workflow** | Trigger + timing + actions (email/SMS) attached to event types. |
| **Routing form** | Questions + rules that send a visitor to an event type, URL, or message. |
| **Single-use link** | A URL to an event type that becomes invalid after one booking. |
| **Meeting poll** | A host-proposed set of slots; participants vote; host finalizes into a booking. |
| **Managed event** | Admin-owned event-type template distributed to users, with lockable sections. |

Every user-facing time is stored as UTC instant + IANA zone for display. Availability rules are stored in the schedule's zone (wall-clock), never in UTC, so DST transitions behave as users expect.

---
## 5. Functional specification

### 5.1 Authentication and accounts

`AUTH-01` Sign-in is Google OAuth 2.0 only. Accepted accounts MUST belong to the `{{WORKSPACE_DOMAIN}}` Workspace domain (`hd` claim check + allowlist of additional domains configurable by Admin). The Google Cloud OAuth app is configured as **Internal** to the Marlo Workspace, which avoids Google's external-app verification for the sensitive `gmail.send` and `calendar` scopes.

`AUTH-02` Scopes requested at sign-in (incremental consent; calendar and Gmail scopes requested when the user connects a calendar or enables Gmail sending):
- `openid email profile`
- `https://www.googleapis.com/auth/calendar` (read free/busy on all calendars, write events to destination calendar)
- `https://www.googleapis.com/auth/gmail.send` (send confirmations as the host)

`AUTH-03` Refresh tokens are encrypted at rest (AES-256-GCM, key in the secrets manager). Token revocation or `invalid_grant` marks the connection `needs_reauth`, notifies the user (email + in-app banner), and disables their event types from accepting bookings until reconnected. Invitees hitting a disabled page see the "host is unavailable" state (Section 5.6.9).

`AUTH-04` First sign-in provisions the user: slug from Google first name (lowercase, collision → append number), default availability schedule (Mon–Fri 09:00–17:00 in browser-detected zone), one starter event type ("30 Minute Meeting", Google Meet). The onboarding flow then requests the calendar scope (incremental consent) and, once granted, connects the primary Google calendar as both conflict and destination; event types stay `off` until a destination calendar exists.

`AUTH-05` Session: HTTP-only secure cookie, 30-day sliding expiry, CSRF protection on mutations. Admin actions require a re-auth within the last 12 hours.

`AUTH-06` User deactivation (Admin): future bookings for that user are listed for the Admin to cancel or reassign (round-robin bookings reassign automatically to the next eligible host; 1:1 bookings require manual action). Their public pages return 404 with the org's "no longer available" message. Their webhooks and API tokens are revoked; org-scope ones survive.

### 5.2 Calendar connections

`CAL-01` A user MAY connect multiple Google accounts (e.g., personal + work). Each connection lists all calendars the account can read. Per calendar, the user toggles **Check for conflicts**. Exactly one calendar across all connections is the **Add-to calendar**.

`CAL-02` Conflict detection uses the Google Calendar `freebusy.query` endpoint over the requested window, batched per connection (up to 50 calendars/request). Results cached 60 s per (calendar, window). Events marked **Free** (transparency=`transparent`) do not block. All-day events block only if they are marked Busy. Declined invitations do not block. Tentative blocks (configurable per calendar via `block_tentative`; default block).

`CAL-03` Booking writes one event to the destination calendar of the assigned host (for collective types: one event on the primary owner's calendar with co-hosts as attendees, so it appears on every host's calendar as a single shared Google event) via `events.insert` with:
- `summary` = event-type "calendar title" template (default `{{event_name}} with {{invitee_name}}`; Calendly's default is `{{invitee_name}} and {{host_name}}` — ours is configurable per event type),
- `description` = event description + invitee answers + reschedule/cancel links,
- `attendees` = invitees + guests (+ co-hosts for collective), with `sendUpdates` = `all` in Calendar-invitation mode, `none` in Email-confirmation mode (Section 5.8),
- `conferenceData` created via `conferenceDataVersion=1` when location is Google Meet,
- `extendedProperties.private.booking_id` for idempotent reconciliation,
- `guestsCanModify=false`, `guestsCanInviteOthers=false`, `guestsCanSeeOtherGuests` true only for group events if the host allows (default false).

`CAL-04` Reschedule updates the same Google event (`events.patch`). Cancel deletes it (or keeps it prefixed, per `keep_canceled_calendar_event`). Host edits inside Google Calendar do not propagate back to the booking, except: if the host deletes the Google event, a watch notification (`events.watch` push channel, renewed every 7 days) sets the booking to `canceled` with `canceled_by=system` (reason "deleted from calendar") and triggers cancellation notifications. This matches Calendly's behavior of treating the calendar as authoritative for deletions. Per-event-type setting `keep_canceled_calendar_event` controls whether our own cancellations delete the Google event (default) or keep it with a `[CANCELED]` prefix.

`CAL-05` Manual "Sync now" button per connection; background full re-check nightly for events in the next 90 days to catch missed watch notifications.

### 5.3 Availability

`AVL-01` Availability schedule fields: `name`, `timezone` (IANA), `is_default`, `weekly_rules[]` (day-of-week, start, end in `HH:MM`, multiple intervals per day allowed, must not overlap), `date_overrides[]` (a specific date → list of intervals or "unavailable all day").

`AVL-02` Each user has ≥ 1 schedule. Deleting the default is blocked until another is set default. Deleting a schedule used by event types reassigns them to the default with a confirmation dialog.

`AVL-03` An event type uses either a named schedule ("Use an existing schedule") or **custom hours** stored inline on the event type (same structure as a schedule, not shared). Team event types (collective, round robin) use each host's own schedule or custom hours per host; an Admin MAY force a specific team schedule for all hosts.

`AVL-04` Time-zone rule: weekly rules and overrides are wall-clock in the schedule's zone. A slot at "09:00" on a DST switch day means 09:00 local. Cross-zone display converts each concrete interval to UTC before presenting to the invitee.

`AVL-05` Availability editor UX: weekly grid (Mon–Sun) with per-day interval rows, copy-to-days action, date-override calendar picker, time-zone selector with search, "Troubleshoot availability" view that shows, for a chosen date, why each hour is unavailable (outside hours, calendar conflict with calendar name, buffer, notice, limit reached). This diagnostics view is the single largest driver of Calendly support tickets and MUST ship in v1.

### 5.4 Event types

#### 5.4.1 Kinds

| Kind | Hosts | Invitees per slot | Slot logic | Phase |
|---|---|---|---|---|
| `one_on_one` | 1 | 1 | Host's free slots | v1 |
| `group` | 1 | up to `max_invitees` | Host's free slots; slot stays open until capacity reached; existing group bookings do not count as conflicts for the same slot | v1 |
| `collective` | 2–20 | 1 | Intersection of all hosts' free slots | v1 |
| `round_robin` | 2–100 | 1 | Union of hosts' free slots; host assigned at booking (Section 5.10.1) | v2 |
| `one_off` | 1 | 1 | Host's free slots restricted to selected days/times; auto-expires when booked or past | v1 |

#### 5.4.2 Editor sections and fields (`EVT-01` … `EVT-40`)

**Event details**
- `EVT-01` `name` (≤ 80 chars, required); `slug` (auto from name, editable, unique per user or per group, `[a-z0-9-]`); `description` (rich text: bold, italic, links, lists; ≤ 5,000 chars); `color` (choice of 12 palette tokens, Section 6); `internal_note` (host-only, shown on event-type card).
- `EVT-02` `duration_minutes` (5–720; presets 15/30/45/60; custom); `duration_options[]` (optional: offer invitee a choice of durations, e.g. 15/30/60 — Calendly parity).
- `EVT-03` `kind` (immutable after creation, except `one_on_one` → `round_robin`/`collective` conversion allowed while no future bookings exist).

**Location** (`EVT-10`) One or more location options; if more than one, invitee chooses at booking.

| Location type | Behavior |
|---|---|
| `google_meet` | Meet link generated per booking via Calendar `conferenceData`; requires host's Google connection |
| `zoom` | Unique meeting per booking via Zoom OAuth (v2); fallback to host's Personal Meeting ID if configured |
| `ms_teams` | Unique meeting per booking via Microsoft Graph (v2) |
| `phone_host_calls` | Invitee provides number (required phone field auto-added) |
| `phone_invitee_calls` | Host's number shown after booking |
| `in_person` | Address text; optional Google Maps link; time-zone lock recommended |
| `webex` | Unique meeting per booking via Webex OAuth (v3) |
| `custom` | Free text shown after booking (e.g., "Marlo will text you a link") |
| `ask_invitee` | Invitee types a location at booking |
| `none` | No location shown |

Per-host location overrides on team event types (each host sets their own phone/Zoom).

**Scheduling settings**
- `EVT-20` `date_range`: `rolling` (N calendar days or N business days into the future, 1–365, default 60 calendar days) | `fixed` (start date, end date) | `indefinite`.
- `EVT-21` `availability_source`: `schedule_id` | `custom_hours`.
- `EVT-22` `buffer_before_minutes`, `buffer_after_minutes` (0–240; presets 0/5/10/15/30/45/60/90/120).
- `EVT-23` `min_notice`: value + unit (minutes/hours/days), 0–30 days, default 4 hours. Applied against booking time (not page-load time).
- `EVT-24` `start_time_increment_minutes`: 5/10/15/20/30/45/60/90/120 or "match duration" (default). Slots are generated from the start of each availability interval in the schedule's zone.
- `EVT-25` Limits: `max_per_day`, `max_per_week`, `max_per_month` (per event type, per host); plus user-level "max events per day across all event types" (Calendly has this at event-type level; we add user-level as a SHOULD).
- `EVT-26` `timezone_display`: `invitee_local` (default) | `locked` (fixed zone; used for in-person).
- `EVT-27` `secret` boolean: hidden from the user's/group's public landing page; reachable by direct URL; excluded from sitemaps and search-engine indexing (`noindex`).
- `EVT-28` `invitee_can_add_guests` boolean; `max_guests` (default 10).
- `EVT-29` `max_invitees` (group only, 2–1000); `show_remaining_spots` boolean (group).
- `EVT-30` `allow_reschedule` / `allow_cancel` by invitee (default both true); `cancellation_policy_text` shown on the cancel page; `min_cancel_notice` (optional: block invitee cancel/reschedule within X hours; host always can); `show_host_email_when_blocked` (default true).
- `EVT-31` `booking_calendar_title_template` (Section 5.2 `CAL-03`).
- `EVT-32` `language` (v1: `en` only; enum reserved).
- `EVT-33` `status`: `active` | `off` (Calendly "On/Off" toggle; off = page shows "not accepting bookings").

**Invitee questions** (`EVT-35`)
- Built-in, always present: `name` (required; optionally split first/last), `email` (required). Guests field appears when `EVT-28` is on.
- Custom questions: types `text` (single line), `textarea`, `radio` (single choice), `checkboxes` (multi), `dropdown`, `phone` (E.164 with country selector), `number`. Each: `label`, `required`, `position`, `options[]` for choice types, `visible_when` (optional conditional: show when question X has answer Y — single condition).
- Max 30 questions. Phone-based locations auto-inject a required phone question.
- Answers are stored per invitee, included in the calendar event description, emails, webhooks, and CSV export.

**Notifications and workflows** (`EVT-36`) See Section 5.8/5.9. Event-type level choice: `notification_mode` = `calendar_invitation` (default) | `email_confirmation`. Event-type editor shows the workflows attached and lets the host add reminders/follow-ups inline.

**Confirmation page** (`EVT-37`)
- `confirmation_type`: `default` (Marlo confirmation page with add-to-calendar buttons) | `redirect` (external URL; `pass_event_details_as_query` boolean appends `invitee_name`, `invitee_email`, `event_type_name`, `event_start_time`, `event_end_time`, `answer_1..n`, `utm_*`) | `custom_message` (rich text shown on the default page).
- `EVT-38` "Add to calendar" buttons on the default page: Google, Outlook.com, Office 365, Yahoo, ICS download.

**Payments** (`EVT-39`, v2) `payment_required` boolean; `amount` (minor units), `currency`; `terms_text`; provider Stripe Checkout in payment intent mode; booking is held for 10 minutes while the invitee pays; unpaid holds are released.

**Permissions** (`EVT-40`) `owner_user_id`; `editor_user_ids[]`; for team types: `group_id` (owner group). Admins can transfer ownership.

#### 5.4.3 Event-type list page

- Cards grouped by user (and by group for team types) with: color bar, name, duration, kind badge, location icon, `secret` badge, `managed` badge, `off` state.
- Actions: copy link, share (Section 5.12), edit, clone, delete (blocked if future bookings exist — offer "turn off" instead), turn on/off, single-use link, add internal note.
- Filters: mine / all users (admin) / by group / kind / status. Search by name.

### 5.5 Slot computation (the core algorithm) (`SLOT-01` … `SLOT-12`)

Inputs: event type `E`, invitee time zone `TZi`, requested month (or date), current time `now`.

1. `SLOT-01` **Window.** Compute `[W_start, W_end)` from `E.date_range` in the *host schedule's* zone. For rolling business days, count Mon–Fri only. Min notice is applied to candidate starts in `SLOT-03`, not by clipping intervals, so increments stay anchored to the schedule.
2. `SLOT-02` **Host availability intervals.** For each host `h`: expand weekly rules for each date in the window into concrete UTC intervals; replace any date that has an override with the override's intervals (empty = unavailable). Merge adjacent intervals.
3. `SLOT-03` **Candidate starts.** For each availability interval `[a, b)`, generate starts `a, a+inc, a+2·inc, …` while `start + duration ≤ b`. `inc = E.start_time_increment` (or duration). Do not re-anchor to the top of the hour; Calendly anchors to the interval start, and so do we. Drop any start `< now + min_notice`. All intervals in this section are half-open `[start, end)`; two intervals overlap iff `s1 < e2 && s2 < e1` (a slot ending exactly when a busy block begins is allowed).
4. `SLOT-04` **Busy subtraction.** Fetch busy intervals for `h` from all conflict calendars in `[W_start − buffer_before − 24h, W_end + buffer_after + 24h)`. Because `freebusy.query` returns opaque blocks, the destination calendar (which is normally also a conflict calendar) is read with `events.list` instead, so events carrying our `extendedProperties.private.booking_id` can be recognized: those are replaced by this system's own booking records (which know capacity and status), and the booking currently being rescheduled is excluded entirely. A candidate `[s, s+d)` is rejected if `[s − buffer_before, s + d + buffer_after)` overlaps any busy interval. Buffers are properties of the event type being booked; they are checked against *all* busy time, not only against other bookings.
5. `SLOT-05` **Limits.** Reject candidates on a day/week/month where `h` already has ≥ `max_per_*` bookings of `E` (counted in the host schedule zone, week starting Monday), or ≥ user-level daily max across event types.
6. `SLOT-06` **Group capacity.** For `group` types, existing sessions of `E` at the same start with `invitee_count < max_invitees` are *not* busy (their own calendar event is recognized per `SLOT-04` and ignored); they are offered as the same slot with remaining spots. Sessions of `E` at overlapping but different starts, and full sessions, block.
7. `SLOT-07` **Combine hosts.** `one_on_one`/`group`/`one_off`: the single host's set. `collective`: intersection across hosts (same start instant). `round_robin`: union across eligible hosts, tagged with the set of available hosts per slot (used at assignment time).
8. `SLOT-08` **One-off restriction.** Intersect with the specific intervals the host picked when creating the one-off.
9. `SLOT-09` **Presentation.** Convert to `TZi`; group by local date; a month view marks dates with ≥ 1 slot; day view lists slots in `h:mm a` (12/24h toggle). A slot that starts on one local date but was generated on another host-zone date belongs to the invitee's local date.
10. `SLOT-10` **Freshness.** Slot lists are computed on request (not precomputed) with the 60 s free/busy cache. At booking time the chosen slot is recomputed with the cache bypassed (`SLOT-12`).
11. `SLOT-11` **Performance.** p95 ≤ 600 ms for a month of a 1:1 event type with 6 conflict calendars; p95 ≤ 1.5 s for a 10-host round robin. Free/busy calls run in parallel per host.
12. `SLOT-12` **Booking-time validation.** Inside a DB transaction with a per-host advisory lock (`pg_advisory_xact_lock(hash(host_id))`): recompute eligibility for the exact `(E, start, host)` with fresh free/busy; if it fails, return `409 slot_unavailable` and the UI shows "That one just went — pick another" with the refreshed list.

### 5.6 Public booking pages and booking flow

#### 5.6.1 URL structure (`URL-01`)

| Path | Content |
|---|---|
| `/{user_slug}` | User landing page: avatar, name, bio, list of non-secret active event types |
| `/{user_slug}/{event_slug}` | Event-type booking page |
| `/{group_slug}` | Group landing page (team event types) |
| `/{group_slug}/{event_slug}` | Team event-type booking page |
| `/d/{single_use_token}` | Single-use link |
| `/o/{one_off_token}` | One-off meeting |
| `/p/{poll_token}` | Meeting poll |
| `/r/{routing_form_slug}` | Routing form |
| `/s/{share_token}` | Shared available-times page (`OFF-03`) |
| `/b/{booking_token}` | Booking detail (confirmation page revisit) |
| `/b/{booking_token}/reschedule` | Reschedule |
| `/b/{booking_token}/cancel` | Cancel |

Domain: `{{BOOKING_DOMAIN}}` (Decision D-02; proposed `book.marlo.{{tld}}`). User and group slugs share one namespace: enforced by an org-wide unique `slugs(organization_id, slug)` table that both `users` and `groups` write to. Reserved (cannot be slugs): `d, o, p, r, b, s, api, app, admin, embed, public, static, assets`.

`URL-02` Supported query parameters on booking pages: `month=YYYY-MM`, `date=YYYY-MM-DD`, `slot=ISO8601` (deep link to a specific slot; opens the form directly if still available), `name`, `email`, `first_name`, `last_name`, `guests` (comma-separated), `a1..aN` (prefill answers by question position), `location` (preselect), `duration` (if duration options), `timezone` (IANA), `hide_event_type_details=1`, `hide_gdpr_banner=1`, `text_color`/`primary_color` (ignored — brand is fixed; kept for embed compatibility), `utm_source/medium/campaign/term/content`, `salesforce_uuid`, `host` (round robin: pin a specific host by slug if eligible), `embed_domain`, `embed_type`.

#### 5.6.2 Flow (`BOOK-01` … `BOOK-14`)

1. `BOOK-01` **Step 1 — pick a time.** Left panel: Marlo mark, host avatar(s)/name, event name, duration, location icon(s), description, cancellation policy summary. Right panel: month calendar → day list. Time-zone selector (auto-detected via `Intl.DateTimeFormat().resolvedOptions().timeZone`, searchable, remembered in `localStorage`). 12h/24h toggle. Group types show "N spots left" on each slot when `show_remaining_spots`. Navigation limited to the date range. Loading skeletons; no slot list flashes.
2. `BOOK-02` **Step 2 — details.** Selected time shown at top with "change" link. Fields: name, email, guests (progressive disclosure: "Add guests" link → email chips), custom questions, location choice (if > 1), duration choice (if options), consent checkbox if `{{LEGAL_CONSENT_REQUIRED}}`. Submit button label configurable (default "Schedule it").
3. `BOOK-03` **Validation.** Client-side inline; server-side authoritative. Email RFC 5322 + MX check (soft: warn, don't block). Phone E.164. Required questions enforced. Guest emails deduplicated, max `max_guests`.
4. `BOOK-04` **Hold and confirm.** Server runs `SLOT-12`; creates booking (status `confirmed`), writes calendar event(s), enqueues notifications, fires webhooks, all within one request (calendar write may be retried asynchronously if Google returns 5xx; the booking is still confirmed and the UI does not wait for Google beyond 5 s).
5. `BOOK-05` **Confirmation page.** Per `EVT-37`. Shows: "Handled." headline (Section 6), event name, host, date/time in invitee zone + host zone if different, location (Meet link if available; "link will be in your invite" if pending), add-to-calendar buttons, reschedule/cancel links, custom message. Group events do not reveal other invitees.
6. `BOOK-06` **Duplicate booking guard.** Same email booking the same event type at the same start → return the existing booking (idempotent), not a second one. Same email booking a second future slot of the same event type → allowed but the confirmation page notes the other booking.
7. `BOOK-07` **Reschedule (invitee).** Token link → same picker with current time highlighted and "You're rescheduling {event} from {old time}" banner → optional reason (shown to host) → confirm. Reschedule keeps the booking ID and calendar event; sets `rescheduled_from` audit; for round robin, keeps the host by default (event-type setting `reschedule_reassigns_host` for parity with Calendly's "reassign on reschedule" option). Blocked inside `min_cancel_notice` with a message directing the invitee to contact the host (host email shown per `EVT-30`).
8. `BOOK-08` **Cancel (invitee).** Token link → reason (optional/required per event type) → confirm → status `canceled`, calendar event deleted, cancellation notifications sent, slot released. Cancel page shows `cancellation_policy_text`. "Book a new time" link on the cancel confirmation.
9. `BOOK-09` **Host actions** on a booking: reschedule (opens picker as host, bypasses min notice and limits, invitee gets a "rescheduled by host" email), **request reschedule** (Calendly parity: releases the current time and emails the invitee a link to pick a new one, with an optional message; the booking sits in `pending_reschedule` for 7 days, then auto-cancels), cancel (with message to invitee), mark no-show (v2), edit invitee answers, add guests, resend confirmation, copy Meet link, open in Google Calendar.
10. `BOOK-10` **Time-zone mismatch guard.** If the invitee's detected zone differs from the zone stored in `localStorage`/selected, show a non-blocking "Times shown in {zone}" chip with a change affordance. Confirmation page always shows both zones when they differ.
11. `BOOK-11` **Group event edge:** last spot taken between step 1 and submit → `409` with "That session just filled up" and list of other sessions.
12. `BOOK-12` **Turned-off / deleted / unauthorized page states:** `off` → "Not booking right now" page with host contact hint; deleted/unknown → 404 branded page; host `needs_reauth` → "Host's calendar is disconnected" (host notified).
13. `BOOK-13` **Accessibility:** WCAG 2.2 AA. Full keyboard operation of calendar and slot list; ARIA grid for the month; visible focus; color contrast ≥ 4.5:1; reduced-motion respected; screen-reader announcements on month change and slot selection.
14. `BOOK-14` **Performance:** LCP ≤ 1.5 s on 4G for the booking page; slot list fetch is a single JSON call per month; SSR the shell; no client-side bundle > 250 KB gz for the public page.

#### 5.6.3 GDPR/consent banner
`BOOK-15` Optional consent line above submit (`{{LEGAL_CONSENT_TEXT}}`), with link to `{{PRIVACY_URL}}`. Off by default for internal use; embeddable pages can pass `hide_gdpr_banner`.

### 5.7 Booking lifecycle and dashboard

`LIFE-01` Booking statuses: `confirmed` → (`rescheduled` is an event, not a status) → `canceled` (`canceled_by` = invitee / host / system) | `completed` (auto, after end time) | `no_show` (host-marked, v2) | `pending_reschedule` (host requested a new time, `BOOK-09`). Payment-pending holds (v2) are `pending_payment` with a 10-minute TTL.

`LIFE-02` **Meetings dashboard** (host): tabs Upcoming / Pending (polls, unpaid) / Past / Date range. Each row: date/time (host zone), event name, invitee name(s) + email, location, host(s) for team events, status chips. Row expand: answers, guests, reschedule history, cancel reason, links (Meet, Google Calendar), actions per `BOOK-09`. Filters: event type, host (admin/group), status, invitee email search. Export CSV of the filtered view (all fields + answers flattened to columns). Bulk: cancel selected (with message).

`LIFE-03` Admin view of all users' meetings with the same filters plus user selector.

`LIFE-04` Booking detail page (`/app/bookings/{id}`) with full timeline: created, notifications sent (with delivery status), rescheduled, canceled, webhook deliveries.

### 5.8 Notifications (system-level)

`NOTIF-01` Two mutually exclusive modes per event type:

| Mode | What happens on booking |
|---|---|
| `calendar_invitation` (default) | Host's Google Calendar event is created with invitees as attendees and `sendUpdates=all`. Google emails the invitation from the host's account. The system sends **no** separate confirmation email (unless a Workflow adds one). |
| `email_confirmation` | Calendar event created with `sendUpdates=none` and invitees not attached as attendees (they are listed in the description). The system sends a Marlo-branded confirmation email **from the host's Gmail address via the Gmail API** with an `.ics` (METHOD:REQUEST) attached and add-to-calendar links. |

Rationale (matches Calendly): calendar-invitation mode gives invitees a native RSVP experience; email-confirmation mode gives full brand control and avoids "invitation from a stranger" spam filtering.

`NOTIF-02` Sending infrastructure:
- Primary: Gmail API `users.messages.send` as the host (`From: Host Name <host@{{WORKSPACE_DOMAIN}}>`, `Reply-To` host). Emails therefore appear in the host's Sent folder and replies thread naturally.
- Fallback (host lacks `gmail.send` grant, quota exceeded, or API error after 3 retries): transactional provider (Postmark or Resend) from `{{SYSTEM_SENDER}}` (e.g., `hello@{{WORKSPACE_DOMAIN}}`) with `Reply-To` host. SPF/DKIM/DMARC for the sending domain are a launch prerequisite.
- Per-host daily cap guard: 1,500 messages/day (Workspace limit is 2,000).
- Every send is logged (`notification_log`) with provider message ID and delivery state (sent / bounced / failed). Bounces from the fallback provider are ingested via webhook; Gmail sends surface bounces as inbound messages to the host (not tracked).

`NOTIF-03` System emails (always sent regardless of Workflows, unless the event-type mode suppresses the confirmation):

| Email | To | Trigger |
|---|---|---|
| Booking confirmation | invitee (+ guests) | booking created (email_confirmation mode) |
| New booking notice | host(s) | booking created (always; can be muted per user) |
| Rescheduled | invitee, host(s) | reschedule |
| Canceled | invitee, host(s) | cancel |
| Reassigned | old host, new host | round-robin reassignment |
| Calendar disconnected | user | `needs_reauth` |
| Poll finalized | participants | poll → booking |

`NOTIF-04` `.ics` generation: `UID` = booking UUID, `SEQUENCE` increments on reschedule, `METHOD:REQUEST` on create/reschedule, `METHOD:CANCEL` on cancel, `ORGANIZER` = host, `ATTENDEE` = invitee(s), `X-GOOGLE-CONFERENCE` / `LOCATION` set to the Meet URL, `DTSTART/DTEND` in UTC (`Z`), `TZID` VTIMEZONE block included for Outlook.

`NOTIF-05` Template engine: MJML → HTML, plain-text alternative, Marlo brand (Section 6.4). Variables per Section 5.9.4. All templates have org-level defaults editable by Admin; event-type-level overrides via Workflows.

### 5.9 Workflows (automations)

`WF-01` A workflow = `name`, `trigger`, `timing`, `actions[]`, `event_type_ids[]` (or "all my event types" / "all org event types" for admin), `enabled`, `owner`.

`WF-02` Triggers (Calendly parity):

| Trigger | Timing options |
|---|---|
| `booking.created` | immediately |
| `booking.starts` | N minutes/hours/days **before** start (multiple timings allowed → multiple steps) |
| `booking.ends` | N minutes/hours/days **after** end |
| `booking.canceled` | immediately |
| `booking.rescheduled` | immediately |
| `booking.no_show` (v2) | immediately |

`WF-03` Actions: `send_email` (to invitee / to host / to both / to custom addresses; subject, rich body with variables; optional "include .ics"), `send_sms` (v2; to invitee if phone collected / to host; ≤ 320 chars; Twilio; opt-out keyword handling; invitee phone consent line on booking form when SMS workflows are attached), `webhook_call` (POST JSON to URL — our addition, SHOULD in v2).

`WF-04` Execution: a scheduler enqueues jobs at booking create/reschedule/cancel time (recomputing "before start" jobs on reschedule; canceling pending jobs on cancel). Jobs are idempotent by `(workflow_step_id, booking_id, invitee_id)`. Jobs due in the past at creation (e.g., 24h reminder for a meeting in 2h) are skipped, not sent late. Time-based jobs fire within 60 s of due time.

`WF-05` Defaults created for each new user (editable/deletable): "Reminder — 24 hours before (email to invitee)", "Reminder — 1 hour before (email to invitee)", "Follow-up — 1 hour after (email to invitee)" (off by default).

`WF-06` Variables available in email/SMS bodies and subjects (Calendly parity, with our naming; Calendly names accepted as aliases for copy-paste compatibility):

| Variable | Description |
|---|---|
| `{{event_name}}` | Event type name |
| `{{event_description}}` | |
| `{{event_date}}`, `{{event_time}}`, `{{event_end_time}}` | In the *recipient's* zone (invitee zone for invitee emails, host zone for host emails) |
| `{{event_timezone}}` | Recipient's zone label |
| `{{event_duration}}` | e.g. "30 min" |
| `{{location}}` | Rendered location (Meet URL, address, phone) |
| `{{invitee_name}}`, `{{invitee_first_name}}`, `{{invitee_last_name}}`, `{{invitee_email}}`, `{{invitee_phone}}` | |
| `{{host_name}}`, `{{host_first_name}}`, `{{host_email}}`, `{{host_phone}}` | Assigned host (round robin) or owner |
| `{{all_hosts}}` | Collective: comma-separated |
| `{{answer_1}}` … `{{answer_N}}`, `{{answers}}` | Individual / all Q&A block |
| `{{reschedule_url}}`, `{{cancel_url}}`, `{{booking_url}}` | Tokenized links |
| `{{meeting_link}}` | Meet/Zoom URL if any |
| `{{cancellation_reason}}`, `{{canceled_by}}` | On cancel triggers |
| `{{guests}}` | Comma-separated guest emails |
| `{{utm_source}}` … | UTM captured at booking |

`WF-07` Preview with sample data; "Send test to me". Rich-text editor with variable picker.

`WF-08` Managed-event workflows (v2): admins attach workflows to managed events; locked from user edits (Section 5.10.5).
### 5.10 Team scheduling

#### 5.10.1 Round robin (`RR-01` … `RR-10`, v2)

`RR-01` Event type fields: `hosts[]` each with `priority` (`high` = 3, `medium` = 2, `low` = 1, default medium) and `weight` (1–10, default 1), `distribution_mode`, `counting_window` (`rolling_30d` default | `rolling_7d` | `all_future` | `calendar_month`), `reschedule_reassigns_host` (default false), `allow_host_pin_param` (default true).

`RR-02` Distribution modes:

| Mode | Slots shown | Host chosen at booking |
|---|---|---|
| `optimize_availability` (default) | Union of all hosts' slots | Among hosts available at that slot: highest `priority`; ties → lowest `bookings_in_window / weight`; ties → least-recently-assigned |
| `optimize_equal_distribution` | Slots of the **next-in-line** host(s) only: compute each host's `load = bookings_in_window / weight`; show the union of slots of all hosts whose load equals the minimum (within the same top priority tier). If that set has zero slots in the requested month, fall back to the next-lowest load tier. | The host whose slot was shown; ties as above |

Calendly documents these as "Optimize for availability" and "Optimize for equal distribution" and warns the latter reduces shown availability; we replicate that trade-off and surface the same warning in the editor.

`RR-03` `bookings_in_window` counts confirmed bookings of *this event type* assigned to the host, excluding canceled and excluding bookings that were created by `host` pin or by host-side manual assignment (they still count toward calendar busy time). Admin toggle: count across all round-robin event types in the group instead.

`RR-04` Host pinning: `?host={slug}` shows only that host's slots and assigns them (if the host is on the event type). Used for "book with the person you spoke to" links and Gmail inserts.

`RR-05` Reassignment: host cancels or is deactivated → system attempts to reassign to another eligible host free at that time (same selection rule); if none, the booking is canceled and the invitee gets a cancellation with a "rebook" link. Admin can manually reassign from the booking page. Both old and new hosts are notified.

`RR-06` Per-host location and per-host custom hours apply.

`RR-07` A host can be temporarily removed from rotation (`active=false`) without deleting them from the event type (e.g., PTO). Existing bookings remain.

`RR-08` Assignment is recorded with the reason (`priority`, `load`, `pin`, `manual`, `reassign`) for audit and analytics.

`RR-09` Fairness test: with 3 equal hosts, equal availability, and 30 sequential bookings, the max/min assignment difference MUST be ≤ 1 in `optimize_equal_distribution` and ≤ 3 in `optimize_availability`.

`RR-10` Editor shows a live "distribution preview" table: host, priority, weight, bookings in window, active.

#### 5.10.2 Collective (`COL-01`)
All hosts required. Slots = intersection (`SLOT-07`). One Google event is created on the primary owner's destination calendar with co-hosts as attendees (`sendUpdates=all`), so every host sees the same shared event — matching Calendly's behavior. Conflict checks still run against each host's own conflict calendars. Cancel by any host cancels for all (with confirmation).

#### 5.10.3 Group (`GRP-01`)
See `SLOT-06`, `EVT-29`, `BOOK-11`. One calendar event per session; invitees appended as attendees as they book (in calendar-invitation mode) or listed in the description (email-confirmation mode). Host can set `guestsCanSeeOtherGuests`. Session roster visible on the booking detail page; per-invitee cancel tokens; host can cancel the whole session (notifies all) or remove one invitee.

#### 5.10.4 Groups (Calendly "Teams") (`TEAM-01`)
Admin creates a group: `name`, `slug`, `members[]`, `managers[]` (can edit team event types). Group landing page lists team event types (collective/round robin) plus a "book with a specific person" section listing members' user pages (toggle). Users can belong to many groups.

#### 5.10.5 Managed events (`MGD-01` … `MGD-05`, v2)

`MGD-01` Admin creates a managed event template (all event-type fields) and assigns it to users and/or groups. Each assignee receives a linked copy under their own scheduling page.

`MGD-02` Each editor section has a lock: `locked` sections are read-only for the user and stay in sync with the template; `unlocked` sections are user-editable and do not sync. **Location is always unlocked** (Calendly rule). Re-locking a section overwrites user edits on the next template save (warn the admin).

`MGD-03` Sections that can be locked: event details, scheduling settings, invitee questions, notifications/workflows, confirmation page, payments.

`MGD-04` Managed events show an "Admin managed" badge on cards and cannot be deleted by users (they can be turned off only if the admin allows it).

`MGD-05` Unassigning a user deletes their copy after cancel/reassign handling of future bookings.

### 5.11 Routing forms (`RF-01` … `RF-08`, v2)

`RF-01` Form: `name`, `slug`, `headline`, `description`, `submit_label`, `questions[]`, `routes[]`, `fallback`, `status`.

`RF-02` Question types: `text`, `textarea`, `email`, `phone`, `radio`, `checkboxes`, `dropdown`, `number`. Required flag. Email question is special-cased: if present, it is passed as `email` prefill to the destination.

`RF-03` Routes evaluated top to bottom; first match wins. Rule = one or more conditions joined by `AND`/`OR` (single level). Condition = `(question, operator, value)`; operators: `equals`, `not_equals`, `contains`, `not_contains`, `is_one_of`, `greater_than`, `less_than`, `is_empty`, `is_not_empty`; for email: `domain_equals`, `domain_in_list`.

`RF-04` Destinations: `event_type` (opens the booking page inline in the same flow, with answers prefilled into matching questions by label and `name/email` prefilled), `external_url` (redirect, optional pass-through of answers as query params), `custom_message` (rich text; typical "we're not a fit" screen).

`RF-05` Fallback: required; default `custom_message`.

`RF-06` Every submission is stored (`routing_submissions`) with answers, matched route, resulting booking ID if any, UTM, referrer. Webhook `routing_form_submission.created` fires on submit (before booking).

`RF-07` Embeddable exactly like booking pages (Section 5.14). Preview/test mode does not store submissions.

`RF-08` HubSpot lookup routing (route by CRM owner/property) — v3.

### 5.12 One-off meetings, single-use links, sharing, meeting polls

`OFF-01` **One-off meeting** (v1): host picks event name, duration, location, and specific time windows (click-drag on their own calendar view showing busy time), and gets a link `/o/{token}`. Booking page shows only those windows minus conflicts. Expires when booked (single booking) or when the last window passes. Created from the app or the Gmail extension.

`OFF-02` **Single-use link** (v1): `/d/{token}` for any event type; valid for one booking; optional expiry (default 30 days). After use, the page shows "This link has been used" with a link to the host's public page if the event type isn't secret. Listing of active single-use links per event type with revoke.

`OFF-03` **Share dialog** (v1) on any event type: copy link; **Share available times** — pick a date range (default next 7 days) and up to 20 specific slots from the live availability, choose format ("times list" or "week grid"), generate: (a) an HTML block for email (each time is a link to `/{user}/{event}?slot=…`), (b) plain text, (c) a shareable web page `/s/{token}` showing just those times. Slots are not held; if taken, the link falls through to the normal picker with a notice. Also: "Copy embed code" (Section 5.14), QR code.

`POLL-01` **Meeting polls** (v2): host sets name, duration, location, up to 40 candidate slots, up to 40 participants (email or open link), optional deadline. Participants vote available / if-need-be / no per slot without an account; host sees a tally grid; "Finalize" converts the winning slot to a booking (creates calendar event, notifies all participants, and sends non-selected participants a "this time was chosen" notice). Participants' votes update live (SSE). Poll closes on finalize or deadline.

### 5.13 Gmail and Chrome extension

The Gmail integration has three layers. Layer 1 (backend) is covered in 5.1/5.2/5.8. Layers 2 and 3 below.

#### 5.13.1 Chrome extension (`EXT-01` … `EXT-12`)

`EXT-01` Manifest V3 extension, published on the Chrome Web Store as unlisted (internal), also installable via Workspace admin force-install. Auth: the extension opens the web app's OAuth sign-in in a popup; a short-lived extension token (JWT, 1 h, refreshed silently via a background service worker using a refresh cookie on the app origin) authenticates API calls. No Google tokens are stored in the extension.

`EXT-02` Gmail compose integration via a content script on `mail.google.com` (InboxSDK or an equivalent maintained compose-API library — Decision D-05). A Marlo icon appears in the compose toolbar (all compose windows: new, reply, inline reply).

`EXT-03` Clicking the icon opens a panel with tabs: **Event types** (search; each row: name, duration, kind; actions "Insert link" / "Share times"), **One-off**, **Single-use link**, **Poll** (v2).

`EXT-04` **Insert link:** if text is selected in the compose body, wrap it as a hyperlink to the event type; otherwise insert a link with the event name as anchor text (`Book time: {{event_name}}`). UTM `utm_source=gmail` appended.

`EXT-05` **Share times:** mini-picker inside the panel (next 7 days default, navigable; shows live availability; multi-select up to 20 slots; time zone selector defaulting to the host's zone). Inserts an HTML block matching Section 5.12 `OFF-03` format (a) — styled with inline CSS that survives Gmail's sanitizer (no `<style>` blocks, no external CSS, table-based layout, images limited to the Marlo mark hosted at `{{ASSET_CDN}}`), followed by a plain "Or pick any time: {link}" line. The block is editable text once inserted.

`EXT-06` **One-off:** inline form (name, duration, location, windows chosen on a mini week grid with busy shading) → creates the one-off → inserts its link.

`EXT-07` **Single-use link:** choose event type → generate → insert.

`EXT-08` **Keyword detection** (v2): local regex over the compose body (never sent to a server) for phrases like "find a time", "when are you free", "schedule a call", "grab 30 minutes", "let's meet", "what times work" → shows a subtle inline chip near the compose toolbar ("Share times?") that opens `EXT-05`. Per-user toggle; off by default for reply windows if the thread already contains a Marlo link.

`EXT-09` **Contact panel** (v2): when reading a thread, a side panel (Gmail add-on slot or InboxSDK sidebar) shows for each external participant: upcoming/past bookings with Marlo, last meeting date, quick actions (insert link, share times, book on their behalf).

`EXT-10` **Google Calendar page** (v2): on `calendar.google.com`, add a "Marlo" button in the event creation popover offering "Create one-off meeting from this time" and a sidebar showing today's Marlo bookings.

`EXT-11` **Toolbar popup** (anywhere in Chrome): event types list with copy-link, share-times, one-off, single-use; upcoming meetings today with join links; link to the app.

`EXT-12` Resilience: Gmail DOM changes must degrade gracefully (feature hidden, error reported to Sentry, no broken compose). Extension version check: app can flag a minimum version and prompt update.

#### 5.13.2 Google Workspace Add-on (`ADDON-01`, v3)
Card-based Gmail add-on (Apps Script or hosted HTTP endpoint) providing insert-link and share-times in the Gmail sidebar on web and mobile Gmail, for users who cannot install the Chrome extension. Same backend endpoints.

#### 5.13.3 Gmail-side behaviors the backend guarantees
- Confirmations from the host's own address (`NOTIF-02`).
- The host's Sent folder contains every confirmation/reminder sent on their behalf (Gmail API inserts into Sent automatically).
- Thread hygiene: reminders and follow-ups sent via Gmail API set `In-Reply-To`/`References` to the original confirmation's `Message-ID` so the invitee sees one thread per booking.
- Invitee replies land in the host's inbox (Reply-To). No inbound parsing at v1–v3.

### 5.14 Embeds (`EMB-01` … `EMB-06`)

`EMB-01` Three embed types, code generated from the Share dialog:

| Type | Behavior |
|---|---|
| Inline | `<div class="marlo-inline-widget" data-url="…"></div><script src="{{BOOKING_DOMAIN}}/embed/widget.js" async></script>` — iframe injected, auto-height via `postMessage` |
| Popup widget | Floating button (bottom-right, text configurable, Marlo styling) opens a modal iframe |
| Popup text | `Marlo.initPopupWidget({url})` bound to any link/button on the host page |

`EMB-02` JS API: `Marlo.initInlineWidget({url, parentElement, prefill:{name,email,guests,customAnswers:{a1:…}}, utm:{…}})`, `Marlo.initPopupWidget`, `Marlo.showPopupWidget(url)`, `Marlo.closePopupWidget()`, `Marlo.initBadgeWidget({url,text})`.

`EMB-03` Events posted to the parent window (`postMessage`, origin-checked): `marlo.profile_page_viewed`, `marlo.event_type_viewed`, `marlo.date_and_time_selected`, `marlo.event_scheduled` (payload: booking URI, invitee URI). Mirrors Calendly's four embed events for drop-in analytics compatibility.

`EMB-04` `hide_event_type_details`, `hide_gdpr_banner`, `background_color` (accepted, ignored), `embed_domain` recorded on bookings for analytics.

`EMB-05` `Content-Security-Policy: frame-ancestors` set to `*` for public pages (or an allowlist if Admin configures one). `X-Frame-Options` not set on public pages; set to `DENY` on app/admin.

`EMB-06` Routing forms embed identically.

### 5.15 Integrations (`INT-01` … `INT-14`)

| ID | Integration | Scope | Phase |
|---|---|---|---|
| `INT-01` | Google Calendar | Section 5.2 | v1 |
| `INT-02` | Google Meet | Auto-generated per booking | v1 |
| `INT-03` | Gmail API sending | Section 5.8 | v1 |
| `INT-04` | Webhooks | Section 8.4 | v1 |
| `INT-05` | Zoom | OAuth per user; `POST /users/me/meetings` per booking; delete on cancel; update on reschedule; PMI fallback | v2 |
| `INT-06` | Microsoft Teams | Graph `onlineMeetings` per booking (host needs a Microsoft account) | v2 |
| `INT-07` | Stripe | Checkout session before confirmation; webhook `checkout.session.completed` confirms the held booking; refunds manual | v2 |
| `INT-08` | HubSpot | On booking: upsert contact by email, create Meeting engagement associated to contact, set `marlo_last_booking_at`; on cancel: update meeting outcome | v2 |
| `INT-09` | Twilio SMS | Workflows `send_sms`; STOP/START handling; per-country sender config | v2 |
| `INT-10` | Zapier (official app) | Triggers: booking created/canceled/rescheduled, routing submission; Actions: create single-use link | v3 |
| `INT-11` | Salesforce | Lead/contact/event sync + lookup routing | v3 |
| `INT-13` | Slack | Booking created/canceled/rescheduled posts to a channel; per user or per event type | v3 |
| `INT-14` | Webex | Unique meeting per booking via Webex OAuth | v3 |
| `INT-12` | Marlo agent hook | The Marlo agent (text channel) can call `POST /v1/scheduling_links` and `POST /v1/bookings` to book a founder call for a member from a conversation; `booking.*` webhooks notify Marlo to text the member confirmations | v3 |

### 5.16 Admin console (`ADM-01` … `ADM-09`; ADM-01…06 v1, ADM-07…09 v2)

`ADM-01` **Users:** list (name, email, role, groups, event-type count, calendar status, last active), invite by email (must be Workspace domain), change role, deactivate (Section `AUTH-06`), impersonate (view-only, logged).
`ADM-02` **Groups:** CRUD, members, managers, group page settings.
`ADM-03` **Managed events:** Section 5.10.5.
`ADM-04` **Branding:** logo/mark upload (SVG/PNG), org display name, default host bio template, footer text, privacy/terms URLs, system sender address, custom domain (`{{BOOKING_DOMAIN}}`) with DNS verification (CNAME) and managed TLS.
`ADM-05` **Integrations:** org-level Stripe, HubSpot, Twilio, Zoom app credentials; org-scope webhooks; API tokens (org scope).
`ADM-06` **Defaults:** default notification mode, default reminders workflow, default event-type settings for new users, allowed embed domains, consent text, tracking tag IDs (GA4/GTM, Meta Pixel, LinkedIn — v2).
`ADM-07` **Audit log** (v2): actor, action, target, before/after diff (for settings), IP, timestamp; filterable; exportable; retained 2 years. Events: sign-in, role change, event-type create/update/delete, managed-event push, booking cancel by host, webhook/API token create/revoke, branding changes, data deletion.
`ADM-08` **Data deletion** (v2): by invitee email → deletes/anonymizes invitee records across bookings, answers, routing submissions, contacts, notification logs (keeps aggregate counts); logged; also exposed as API (`DELETE /v1/data_compliance/invitees`).
`ADM-09` **Analytics** (v2): bookings created/canceled/no-show per period; by event type, host, group; conversion (page views → bookings) via first-party page-view events; popular days/hours; lead time distribution; reschedule rate; round-robin distribution chart; routing form funnel. Export CSV.

### 5.17 Contacts (`CON-01`, v2)
Auto-created from invitees (email as key). Fields: name, email, phone, company (from email domain), last meeting, meeting count, tags (manual), notes (manual), source (booking / routing form / import). List with search and filters; contact page shows meeting history; "Book on their behalf" (host picks a slot on the invitee's behalf and the invitee receives the confirmation); CSV import/export. Gmail contact panel (`EXT-09`) reads from this.

### 5.18 Host web app — information architecture (`APP-01`)

Left nav: **Event types**, **Meetings**, **Availability**, **Contacts** (v2), **Workflows**, **Routing** (v2), **Polls** (v2), **Integrations**, **Admin** (role-gated). Top: search (event types, bookings by invitee), "Create +" (event type / one-off / single-use / poll), user menu (share my link, settings, sign out). Settings: profile (name, slug, avatar, bio, phone, zone, 12/24h, week start), calendars, notifications (mute host notices), Gmail sending (grant/revoke), extension status, API tokens (user scope), webhooks (user scope).

Responsive: the host app works on mobile (PWA, v2) for Meetings, share link, and one-off creation; editors are desktop-first but usable on tablet.
## 6. Brand and UX (Marlo)

Every invitee-facing surface (booking pages, confirmation, reschedule/cancel, emails, SMS, embeds, Gmail inserts, polls, routing forms) is Marlo. The host app is Marlo too, but utilitarian.

### 6.1 Voice principles (locked essence: "Handled Right" — warm and loud)

1. **Handled.** Every state tells the invitee what is already taken care of. Confirmation copy leads with the outcome, not the mechanics.
2. **Warm.** Second person, contractions, no corporate hedging. Never "Your request has been submitted."
3. **Loud.** Short declaratives. One idea per line. Headlines ≤ 5 words. Buttons are verbs.
4. **Specific.** Times, names, and places are always spelled out. "Tuesday, Oct 6 · 10:00 AM ET" not "your selected time".
5. **Calm under error.** Errors say what happened and what to do next, in one breath. No exclamation marks in errors.
6. **No filler.** No "please", "kindly", "feel free". No emoji in system copy.

Copy below is a starting draft in this register. `{{VOICE_REVIEW}}`: final copy to be reviewed against the Marlo brand guide before launch.

### 6.2 Microcopy (`COPY-01`)

| Surface | Draft copy |
|---|---|
| Booking page headline | "Grab time with {host_first_name}" |
| Slot list empty (no times this month) | "Nothing open this month. Try the next one." |
| Step 2 headline | "Almost there." |
| Submit button | "Lock it in" |
| Confirmation headline | "Handled." |
| Confirmation subhead | "You're on {host_first_name}'s calendar. Invite's on its way to {invitee_email}." |
| Slot taken (409) | "That one just went. Pick another." |
| Group session full | "That session just filled up. Here's what's still open." |
| Reschedule banner | "Moving your {event_name} from {old_time}." |
| Reschedule done | "Moved. New time: {new_time}." |
| Cancel headline | "Cancel this one?" |
| Cancel done | "Canceled. {host_first_name} knows." |
| Cancel blocked (min notice) | "Too close to change online. Email {host_first_name} and we'll sort it." |
| Event off | "{host_first_name} isn't taking bookings right now." |
| Single-use link used | "This link's been used. Want another time? {host page link}" |
| Calendar disconnected | "{host_first_name}'s calendar is disconnected. We've let them know." |
| 404 | "Nothing here. Check the link." |
| Email: confirmation subject | "Handled: {event_name} with {host_first_name} — {event_date}" |
| Email: reminder subject | "Tomorrow: {event_name} with {host_first_name}" / "In an hour: {event_name}" |
| Email: canceled subject | "Canceled: {event_name} on {event_date}" |
| Email: rescheduled subject | "Moved: {event_name} → {event_date} {event_time}" |
| Email footer | "Scheduled with Marlo" + reschedule/cancel links |
| SMS reminder (v2) | "Marlo: {event_name} with {host_first_name} tomorrow at {event_time} {event_timezone}. Change it: {short_url}" |
| Gmail insert lead-in | "Pick a time that works:" |
| Popup embed button | "Grab time" |

### 6.3 Visual identity tokens (`{{BRAND_TOKENS}}` — to be supplied from the Marlo brand guide)

Engineering wires the token layer; the values below were supplied on 2026-09-20 (see the front-end handoff, `tokens/marlo.css`). Until supplied, use a neutral placeholder theme (near-black on warm white, one accent) clearly labeled "placeholder" in the UI.

```css
:root {
  /* Color */
  --marlo-bg:            {{COLOR_BG}};          /* page background */
  --marlo-surface:       {{COLOR_SURFACE}};     /* cards, panels */
  --marlo-ink:           {{COLOR_INK}};         /* primary text */
  --marlo-ink-muted:     {{COLOR_INK_MUTED}};
  --marlo-accent:        {{COLOR_ACCENT}};      /* primary action, selected slot */
  --marlo-accent-ink:    {{COLOR_ACCENT_INK}};  /* text on accent */
  --marlo-line:          {{COLOR_LINE}};        /* hairlines */
  --marlo-success:       {{COLOR_SUCCESS}};
  --marlo-danger:        {{COLOR_DANGER}};
  /* Event colors (12) used only as small chips in the host app */
  --marlo-chip-1 … --marlo-chip-12: {{CHIP_PALETTE}};
  /* Type */
  --marlo-font-display:  {{FONT_DISPLAY}};      /* headlines */
  --marlo-font-text:     {{FONT_TEXT}};         /* body, UI */
  --marlo-font-mono:     {{FONT_MONO}};         /* times, codes (optional) */
  --marlo-scale:         {{TYPE_SCALE}};        /* e.g. 1.25 major third */
  /* Shape & motion */
  --marlo-radius-sm/md/lg: {{RADII}};
  --marlo-shadow:        {{SHADOW}};
  --marlo-ease:          {{EASING}};
  --marlo-dur:           {{DURATION_MS}};
}
```

Requirements that hold regardless of values:
- `BRAND-01` Light and dark themes; booking page follows `prefers-color-scheme`, host app has a manual toggle. Tokens redefined per theme.
- `BRAND-02` Contrast ≥ 4.5:1 for text, ≥ 3:1 for UI components in both themes; validated in CI with a token lint.
- `BRAND-03` Marlo mark (SVG) top-left of every public page and email header; "Scheduled with Marlo" footer is not removable (internal tool; no white-label).
- `BRAND-04` Host avatar (from Google profile, overridable) and name are the only per-user visual variables. No per-user colors or logos.
- `BRAND-05` Email templates use the same tokens compiled to inline CSS; web fonts fall back to system stack in email.
- `BRAND-06` Typography discipline: headlines in display face at 2 sizes max per page; body at one size; times rendered in tabular numerals (`font-variant-numeric: tabular-nums`).

### 6.4 Booking page layout (`LAYOUT-01`)

Desktop (≥ 1024px): two-column card centered on the page, max width 1040px. Left column (36%): Marlo mark, host avatar 56px, host name, event name (display face), duration + location rows with icons, description, cancellation policy line. Right column (64%): month grid (7 columns, 44px cells, today outlined, available dates in accent tint, selected in solid accent), then slot list appears to the right of the grid (three-column layout on ≥ 1280px) or below (1024–1279px). Time-zone selector and 12/24h toggle below the grid, left-aligned.

Mobile (< 768px): single column; sticky header with mark + event name; month grid full-width with 40px cells; slot list below as full-width buttons; step 2 is a new screen with a back affordance; confirmation screen full-bleed.

Slot button: 48px tall, hairline border, time in tabular numerals; hover/focus lifts to surface with accent border; selected slot splits into two buttons "10:00 AM" (disabled look) and "Next" (accent) — this is Calendly's interaction and it tests well; keep it.

Confirmation page: "Handled." as the largest text on the page; details as a definition list; add-to-calendar as a row of secondary buttons; reschedule/cancel as text links at the bottom.

### 6.5 Emails (`EMAIL-01`)
Single-column, 560px, mark top-left, headline in display face, details table (When / Where / Who / Notes), primary button (Join / Reschedule), footer. Plain-text alternative always generated. Dark-mode safe (no pure white blocks on transparent backgrounds).

### 6.6 Accessibility and i18n
`A11Y-01` WCAG 2.2 AA across public pages and emails (semantic tables, alt text). `I18N-01` All strings in a message catalog (ICU MessageFormat); dates via `Intl`; RTL-safe layout; English only shipped at v1.

---

## 7. Architecture

### 7.1 Recommended stack (Decision D-04; recommendation, not mandate)

| Layer | Choice | Why |
|---|---|---|
| Web app + public pages + API | Next.js (App Router, TypeScript) on Vercel | Marlo already runs Vercel; SSR for fast public pages; edge caching for slot JSON |
| Database | Postgres (Neon or Supabase) with Prisma or Drizzle | Transactions + advisory locks for booking; JSONB for answers |
| Queue / scheduled jobs | Inngest or Trigger.dev (durable functions) | Reminder jobs at exact times, retries, idempotency keys; no self-hosted workers |
| Cache | Upstash Redis | Free/busy cache, rate limits, single-use token checks |
| Email | Gmail API (primary), Postmark (fallback) | Section 5.8 |
| SMS | Twilio | v2 |
| Payments | Stripe Checkout | v2 |
| Auth | Auth.js (NextAuth) with Google provider, DB sessions | Incremental scopes |
| Extension | MV3, TypeScript, Vite, InboxSDK | Section 5.13 |
| Observability | Sentry (app + extension), Axiom/Datadog logs, Vercel analytics, OpenTelemetry traces | |
| Infra as code | Vercel project config + Neon branches; GitHub Actions CI | |

### 7.2 Services (logical)

- **Availability service** — implements Section 5.5; pure function over (event type, hosts, schedules, busy intervals, bookings); unit-tested with fixtures across DST boundaries.
- **Calendar provider adapter** — interface `CalendarProvider { listCalendars, freeBusy, createEvent, patchEvent, deleteEvent, watch }`; Google implementation at v1; Microsoft later.
- **Booking service** — transactional create/reschedule/cancel; emits domain events.
- **Notification service** — consumes domain events; renders templates; sends via provider adapter (`Gmail`, `Postmark`, `Twilio`).
- **Workflow scheduler** — materializes jobs from workflows × bookings; reconciles on reschedule/cancel.
- **Webhook dispatcher** — signs and delivers; retries with backoff; dead-letter after 24 h.
- **Public API** — REST, Section 8.

Domain events: `booking.created`, `booking.rescheduled`, `booking.canceled`, `booking.completed`, `booking.no_show`, `booking.reassigned`, `invitee.added` (group), `routing_form.submitted`, `poll.finalized`, `calendar.disconnected`, `payment.completed`.

### 7.3 Time handling rules (`TIME-01`)
All instants in Postgres `timestamptz`. All wall-clock rules as `time` + IANA zone. Use a tz-correct library (`@date-fns/tz` or Temporal polyfill); never construct dates from local strings on the server. DST test cases in CI: spring-forward gap (02:30 does not exist), fall-back overlap (01:30 occurs twice), host in `America/New_York` with invitee in `Asia/Kolkata` (+30 min offset), `Pacific/Chatham` (+45 min), zones without DST.

### 7.4 Security and privacy (`SEC-01` … `SEC-08`)
- `SEC-01` Google tokens encrypted (AES-256-GCM), keys in Vercel/Neon secret store or AWS KMS; rotation supported.
- `SEC-02` Invitee tokens (`/b/{token}`, `/d/`, `/o/`, `/p/`): 128-bit random, base62, single purpose, revocable; reschedule/cancel tokens never expire while the booking is upcoming; expire 30 days after the event ends.
- `SEC-03` Rate limits: public booking POST 10/min/IP and 3/min/email; slot GET 120/min/IP; API 600 req/min per token (Calendly's is similar); extension 300/min/user.
- `SEC-04` Abuse: hCaptcha on booking when risk score high (many bookings from one IP, disposable email domains); email verification link optional per event type ("verify email before confirming") — off by default.
- `SEC-05` PII minimization: invitee data retained 3 years after last meeting then anonymized (configurable); notification logs 1 year; free/busy cache never persisted; Gmail content never read (send-only scope).
- `SEC-06` Webhook signatures (Section 8.4); API tokens hashed (SHA-256) at rest, shown once.
- `SEC-07` Admin actions and impersonation logged; CSP on app; dependency scanning; annual pen test line item.
- `SEC-08` Google API Services User Data Policy compliance statement in the privacy policy (`{{PRIVACY_URL}}`) even though the app is Internal.

---

## 8. Data model and API

### 8.1 Data model (Postgres) (`DATA-01`)

All tables: `id uuid pk`, `organization_id`, `created_at`, `updated_at`; soft-delete via `deleted_at` where noted. Field types abbreviated.

**organizations** — `name`, `slug`, `booking_domain`, `branding jsonb`, `defaults jsonb`, `allowed_embed_domains text[]`, `consent_text`, `system_sender_email`.

**users** — `email` (unique), `name`, `first_name`, `last_name`, `slug` (unique/org), `avatar_url`, `bio`, `phone`, `timezone`, `time_format` (12/24), `week_start`, `role` (owner/admin/user), `status` (active/deactivated), `google_sub`, `gmail_send_enabled bool`, `max_bookings_per_day int null` (EVT-25 user-level), `notification_prefs jsonb`, `last_active_at`.

**groups** — `name`, `slug` (unique/org), `description`, `page_settings jsonb`. **group_members** — `group_id`, `user_id`, `is_manager`.

**calendar_connections** — `user_id`, `provider` (google), `account_email`, `access_token_enc`, `refresh_token_enc`, `token_expires_at`, `scopes text[]`, `status` (ok/needs_reauth), `watch_channel_id`, `watch_expires_at`. **calendars** — `connection_id`, `external_id`, `name`, `color`, `check_conflicts bool`, `is_destination bool` (unique true per user), `block_tentative bool`.

**availability_schedules** — `user_id` (null for org/team schedules), `name`, `timezone`, `is_default`. **schedule_rules** — `schedule_id`, `weekday` (0–6), `start_time time`, `end_time time`. **schedule_overrides** — `schedule_id`, `date`, `start_time null`, `end_time null` (null pair = unavailable all day; multiple rows per date allowed).

**event_types** — `owner_user_id null`, `group_id null`, `kind`, `name`, `slug`, `description`, `color`, `internal_note`, `duration_minutes`, `duration_options int[]`, `locations jsonb[]`, `date_range jsonb` `{type, days, business_days, start, end}`, `schedule_id null`, `custom_hours jsonb null`, `buffer_before`, `buffer_after`, `min_notice_minutes`, `start_increment_minutes null`, `max_per_day/week/month int null`, `timezone_mode`, `locked_timezone`, `secret bool`, `allow_guests bool`, `max_guests`, `max_invitees` (group), `show_remaining_spots`, `allow_reschedule`, `allow_cancel`, `min_cancel_notice_minutes`, `show_host_email_when_blocked bool`, `cancellation_policy`, `cancel_reason_required bool`, `keep_canceled_calendar_event bool`, `submit_label`, `notification_mode`, `calendar_title_template`, `confirmation jsonb` `{type, url, pass_params, message}`, `payment jsonb null`, `status` (active/off), `managed_template_id null`, `managed_locks jsonb`, `rr_settings jsonb` `{mode, counting_window, count_across_group, reschedule_reassigns, allow_host_pin}`, `one_off jsonb null` `{windows:[…], expires_at}`, `language`, `deleted_at`.

**event_type_hosts** — `event_type_id`, `user_id`, `priority`, `weight`, `active`, `location_override jsonb`, `custom_hours jsonb null`, `schedule_id null`. **event_type_editors** — `event_type_id`, `user_id`.

**event_type_questions** — `event_type_id`, `position`, `type`, `label`, `required`, `options jsonb`, `visible_when jsonb null`, `system_key null` (name/email/phone/guests).

**managed_event_templates** — all event-type fields + `locks jsonb` + `assignments jsonb` `{user_ids, group_ids}`.

**bookings** — `event_type_id`, `event_type_snapshot jsonb` (name, duration, location at booking time), `start_at`, `end_at`, `timezone_invitee`, `status`, `location_resolved jsonb` `{type, value, meeting_url}`, `calendar_events jsonb[]` `{host_user_id, calendar_id, external_event_id}`, `rescheduled_from_start_at null`, `reschedule_count`, `canceled_at`, `canceled_by` (invitee/host/system), `cancel_reason`, `no_show_at`, `payment_id null`, `source` (web/embed/api/extension/poll/routing/one_off/single_use), `embed_domain`, `utm jsonb`, `single_use_link_id null`, `routing_submission_id null`, `poll_id null`, `booking_token` (unique), `idempotency_key`.

**booking_hosts** — `booking_id`, `user_id`, `role` (host/cohost), `assignment_reason`, `assigned_at`. **invitees** — `booking_id`, `name`, `first_name`, `last_name`, `email`, `phone`, `timezone`, `status` (active/canceled), `token` (unique; reschedule/cancel), `contact_id null`, `no_show bool`. **invitee_answers** — `invitee_id`, `question_id`, `label_snapshot`, `value jsonb`. **booking_guests** — `booking_id`, `invitee_id`, `email`.

**workflows** — `owner_user_id null`, `name`, `trigger`, `scope` (event_types/all_mine/all_org), `enabled`, `managed bool`. **workflow_steps** — `workflow_id`, `position`, `anchor` (`start`|`end`|`trigger`), `offset_minutes` (negative = before anchor, positive = after), `action`, `recipient`, `subject`, `body_html`, `body_text`, `include_ics`, `extra_emails text[]`, `webhook_url null`. **workflow_event_types** — `workflow_id`, `event_type_id`. **workflow_jobs** — `step_id`, `booking_id`, `invitee_id null`, `due_at`, `status` (scheduled/sent/skipped/failed/canceled), `attempts`, `last_error`, unique `(step_id, booking_id, invitee_id)`.

**notification_log** — `booking_id null`, `invitee_id null`, `user_id null`, `channel` (email/sms), `provider` (gmail/postmark/twilio), `template`, `to`, `provider_message_id`, `status`, `error`, `sent_at`.

**routing_forms** — `owner_user_id`, `name`, `slug`, `headline`, `description`, `submit_label`, `status`. **routing_questions** — `form_id`, `position`, `type`, `label`, `required`, `options jsonb`. **routing_routes** — `form_id`, `position`, `name`, `conditions jsonb`, `destination jsonb`. **routing_submissions** — `form_id`, `answers jsonb`, `matched_route_id null`, `destination_snapshot jsonb`, `booking_id null`, `utm jsonb`, `referrer`, `ip_hash`.

**single_use_links** — `event_type_id`, `created_by`, `token`, `expires_at`, `used_booking_id null`, `revoked_at`. **share_pages** — `event_type_id`, `token`, `slots timestamptz[]`, `format`, `expires_at`.

**polls** — `owner_user_id`, `name`, `duration_minutes`, `location jsonb`, `token`, `deadline_at`, `status` (open/finalized/closed), `booking_id null`. **poll_options** — `poll_id`, `start_at`. **poll_participants** — `poll_id`, `name`, `email`, `token`. **poll_votes** — `participant_id`, `option_id`, `value` (yes/if_need_be/no).

**payments** — `booking_id`, `provider`, `session_id`, `amount`, `currency`, `status`, `paid_at`, `refunded_at`.

**contacts** — `email` (unique/org), `name`, `phone`, `company`, `tags text[]`, `notes`, `first_seen_at`, `last_meeting_at`, `meeting_count`, `source`.

**webhook_subscriptions** — `scope` (user/org), `owner_user_id null`, `url`, `events text[]`, `signing_key_enc`, `status`, `created_by`. **webhook_deliveries** — `subscription_id`, `event`, `payload jsonb`, `attempts`, `status`, `last_status_code`, `next_retry_at`, `delivered_at`.

**api_tokens** — `scope` (user/org), `user_id null`, `name`, `token_hash`, `last_used_at`, `revoked_at`, `permissions text[]`.

**audit_log** — `actor_user_id`, `action`, `target_type`, `target_id`, `diff jsonb`, `ip`, `user_agent`.

**page_views** — `event_type_id null`, `user_slug`, `path`, `step` (profile/event/slot_selected/booked), `session_hash`, `embed_domain`, `utm jsonb`, `occurred_at` (partitioned monthly; used for analytics/conversion).

Indexes of note: `bookings(start_at)`, `bookings(event_type_id, start_at)`, `booking_hosts(user_id, booking_id)`, partial index on `bookings(status) where status='confirmed'`, `invitees(email)`, `workflow_jobs(due_at) where status='scheduled'`, unique `event_types(owner_user_id, slug)` and `event_types(group_id, slug)`.

### 8.2 REST API (`API-01` … `API-06`)

Base `https://{{BOOKING_DOMAIN}}/api/v1`.

- `API-01` Auth: `Authorization: Bearer <token>` (user or org scope; permissions list per token). OAuth 2.0 client credentials for third parties is v3.
- `API-02` JSON request/response; ISO 8601 UTC timestamps; IANA zones as strings; money in minor units.
- `API-03` Errors as RFC 7807 problem details with a stable `code` (`slot_unavailable`, `validation_error`, `rate_limited`, …).
- `API-04` Cursor pagination (`?cursor=&limit=`, limit ≤ 100); every resource carries both `id` and `uri` (Calendly returns URIs; we return both to ease migration of Zapier-style integrations).

| Method | Path | Notes |
|---|---|---|
| GET | `/users/me` | |
| GET | `/users`, `/users/{id}` | org scope |
| POST | `/users/invite` · PATCH `/users/{id}` · POST `/users/{id}/deactivate` | admin: invite by Workspace email, change role, deactivate (`AUTH-06`) |
| GET | `/organizations/current` | membership counts, settings |
| GET/POST | `/groups`, `/groups/{id}`, `/groups/{id}/members` | admin |
| GET/POST/PATCH/DELETE | `/event_types`, `/event_types/{id}` | filters `user`, `group`, `kind`, `active`; PATCH supports every editor field |
| GET | `/event_types/{id}/available_times?start=&end=&timezone=` | max 7-day window per call (Calendly's limit); returns `[{start, hosts?[], spots_remaining?}]` |
| GET | `/event_types/{id}/busy_times?…` | host busy intervals (user scope, own only) |
| POST | `/scheduling_links` | `{event_type_id, max_uses:1, expires_at}` → single-use URL |
| POST | `/share_pages` | slots → shareable page + HTML/text blocks |
| POST | `/one_off_meetings` | |
| GET/POST/PATCH/DELETE | `/availability_schedules`, `/availability_schedules/{id}` | rules and overrides inline |
| GET | `/bookings`, `/bookings/{id}` | filters `user`, `group`, `event_type`, `status`, `invitee_email`, `min_start`, `max_start`, `sort` |
| POST | `/bookings` | **Scheduling API**: `{event_type_id, start, timezone, invitee:{name,email,phone}, guests[], answers{}, location?, host_id?, source:"api", idempotency_key}` → booking; returns 409 on conflict |
| POST | `/bookings/{id}/reschedule` | `{start, reason?, notify:true}` |
| POST | `/bookings/{id}/cancel` | `{reason?, notify:true}` |
| POST | `/bookings/{id}/invitees/{iid}/no_show` · DELETE | v2 |
| GET | `/bookings/{id}/invitees`, `/invitees/{id}` | answers, tokens (redacted for org scope unless permitted) |
| GET/POST/PATCH/DELETE | `/workflows` | |
| GET/POST/PATCH/DELETE | `/routing_forms`, `/routing_forms/{id}/submissions` | |
| GET/POST/PATCH | `/polls`, `/polls/{id}/finalize` | |
| GET | `/contacts`, `/contacts/{id}` | v2 |
| GET/POST/DELETE | `/webhook_subscriptions` | |
| GET | `/webhook_deliveries?subscription=` · POST `/webhook_deliveries/{id}/retry` | |
| DELETE | `/data_compliance/invitees` | `{emails[]}` → async job id; v2 |
| GET | `/audit_log` | admin; v2 |
| GET | `/analytics/bookings?group_by=&from=&to=` | v2 |

`API-05` Idempotency: `Idempotency-Key` header on all POSTs, 24 h retention. `API-06` OpenAPI 3.1 document generated from code and published at `/api/docs`; a TypeScript SDK generated from it for the Marlo agent and the Agentic OS.

### 8.3 Public (unauthenticated) endpoints used by the booking page
`GET /public/pages/{user_or_group_slug}`, `GET /public/event_types/{slug}?owner=`, `GET /public/event_types/{id}/slots?month=&timezone=`, `POST /public/bookings` (same schema as `POST /bookings` minus host selection, plus captcha token), `GET/POST /public/bookings/{token}` (detail/reschedule/cancel), `GET/POST /public/routing_forms/{slug}`, `GET/POST /public/polls/{token}`. All rate-limited per `SEC-03`, cached where safe (`Cache-Control: private, max-age=30` on slots).

### 8.4 Webhooks (`WH-01` … `WH-06`)

`WH-01` Events: `booking.created` (alias `invitee.created`), `booking.canceled` (alias `invitee.canceled`), `booking.rescheduled`, `booking.no_show` (`invitee_no_show.created`/`deleted`), `booking.reassigned`, `routing_form_submission.created`, `poll.finalized`. Aliases exist so Calendly-shaped consumers (Zapier, n8n templates) work with minimal changes.

`WH-02` Payload envelope:
```json
{
  "id": "evt_01J…",
  "event": "booking.created",
  "created_at": "2026-09-18T14:03:11Z",
  "created_by": "user:… | system",
  "payload": {
    "booking": { "id", "uri", "event_type": {"id","name","kind","slug"}, "start_at", "end_at",
                 "status", "location": {"type","value","meeting_url"}, "hosts":[{"id","name","email"}],
                 "source", "utm": {}, "reschedule_url_host": "…" },
    "invitee": { "id", "name", "first_name", "last_name", "email", "phone", "timezone",
                 "answers":[{"question","answer","position"}], "guests":["…"],
                 "reschedule_url", "cancel_url", "tracking": {"utm_source":…} },
    "old_booking": { "start_at","end_at" }  // rescheduled only
  }
}
```
`WH-03` Signature: header `Marlo-Webhook-Signature: t=<unix>,v1=<hex HMAC-SHA256(signing_key, t + "." + raw_body)>`; consumers reject if `|now − t| > 5 min`. Signing key shown once on creation.

`WH-04` Delivery: POST, 10 s timeout, expect 2xx; on failure retry after 1 m, 5 m, 30 m, 2 h, 6 h, 12 h (7 attempts total, ≈ 20.5 h); then dead-letter with admin notification; manual retry from UI/API. Deliveries are ordered per subscription (a failing event does not block later events; consumers must use `id` for idempotency).

`WH-05` Scopes: user (own bookings) or org (all). Org-scope webhooks survive user deactivation; user-scope are disabled with the user.

`WH-06` Test delivery button sends a `ping` event.

---

## 9. Non-functional requirements

| Area | Requirement |
|---|---|
| Availability | 99.9% monthly for public booking pages and API; scheduled maintenance outside 06:00–22:00 ET |
| Performance | Section 5.5 `SLOT-11`, 5.6 `BOOK-14`; API p95 < 400 ms excluding Google calls |
| Scale (design point) | 50 hosts, 5,000 bookings/month, 100k page views/month; schema and jobs must handle 20× without redesign |
| Reliability | Bookings never lost: booking commit precedes calendar write; calendar write retried by durable job; reconciliation job fixes drift nightly |
| Observability | Traces per booking request; dashboards: slot latency, booking success rate, notification delivery, webhook success, Google API error rate and quota; alerts on booking failures > 1%/15 min, quota > 80%, `needs_reauth` spikes |
| Backups | Point-in-time recovery 7 days; daily snapshots retained 30 days; restore drill quarterly |
| Environments | `dev` (Neon branch per PR), `staging` (Google OAuth test users, sandbox Stripe/Twilio), `prod` |
| Testing | Unit (availability algorithm ≥ 95% branch coverage, DST fixtures), integration (Google APIs via recorded fixtures + a live nightly suite against a test Workspace), E2E (Playwright: booking, reschedule, cancel, group fill, round robin, extension insert), load test (k6: 200 concurrent bookings on one round-robin type — zero double bookings) |
| Browser support | Last 2 versions of Chrome, Safari, Firefox, Edge; iOS Safari 16+; Android Chrome |
| Compliance | Google API user-data policy; CAN-SPAM footers on marketing-like follow-ups; TCPA consent for SMS; data deletion within 30 days of request |

---

## 10. Acceptance criteria (representative; full suite lives in the test plan)

| ID | Scenario | Expected |
|---|---|---|
| AC-01 | Host has 09:00–17:00 ET Mon–Fri, a 10:00–10:30 Google event, event type with 15-min before/after buffers, 30-min duration, 30-min increments | Slots on that day: 09:00, 11:00, 11:30 … 16:30. 09:30 rejected because its after-buffer (10:00–10:15) hits the event; 10:00 rejected (direct overlap); 10:30 rejected because its before-buffer (10:15–10:30) hits the event |
| AC-02 | Min notice 4 h, 30-min increments anchored at 09:00, hours 09:00–17:00, now = 13:15 ET | Earliest eligible start ≥ 17:15; candidates are 17:30, 18:00 … which fall outside hours, so the first offered slot is 09:00 next working day (never 17:15) |
| AC-03 | Invitee in `Asia/Kolkata` views a host in `America/New_York` on a US DST switch day | All slots displayed at the correct +9:30/+10:30 offset; no missing/duplicated slot |
| AC-04 | Two invitees submit the same 1:1 slot within 200 ms | Exactly one booking; the other gets 409 and refreshed slots |
| AC-05 | Group event, capacity 5, 4 booked; two invitees submit simultaneously | One succeeds (5/5), other gets "session full" |
| AC-06 | Collective with hosts A and B, 30-min event, 0 buffers; A busy 14:00–15:00 | 13:30 offered (ends 14:00, no overlap); 14:00 and 14:30 not offered; 15:00 offered |
| AC-07 | Round robin equal distribution, `counting_window=all_future`, hosts A/B/C, A weight 2 | After 40 bookings, A ≈ 20, B ≈ 10, C ≈ 10 (±1) |
| AC-08 | Invitee reschedules a booking that has a 24 h reminder scheduled | Old job canceled; new job created at new start − 24 h; calendar event patched (same ID); invitee and host receive "Moved" emails |
| AC-09 | Host deletes the Google Calendar event | Booking becomes `canceled` (`canceled_by=system`) within 2 min; invitee receives cancellation |
| AC-10 | Email-confirmation mode; host granted `gmail.send` | Invitee receives the email from `host@{{WORKSPACE_DOMAIN}}`, with `.ics`; the email appears in the host's Sent |
| AC-11 | Host revoked Gmail access | Confirmation sent via fallback provider from system sender with Reply-To host; host banner shown |
| AC-12 | Single-use link booked once | Second visit shows "used" state; API returns 410 |
| AC-13 | Gmail extension "Share times" with 6 slots, invitee clicks the third | Booking page opens with that slot preselected and the form shown; if taken, picker opens with a notice |
| AC-14 | Routing form: email domain in enterprise list → event type "Partner intro"; else → message | Correct destination; submission stored; webhook fired once |
| AC-15 | Webhook endpoint returns 500 for 3 attempts then 200 | Delivered on 4th attempt; delivery log shows attempts; no duplicate event IDs |
| AC-16 | Invitee opens booking page with keyboard only | Can select month, date, slot, fill form, submit; focus order logical; screen reader announces slot count |
| AC-17 | Managed event with locked "scheduling settings"; admin changes buffer to 10 min | All assignees' copies update; a user's unlocked description edits remain |
| AC-18 | Booking page on iPhone 13 Safari over simulated 4G | LCP ≤ 1.5 s; no horizontal scroll; slot buttons ≥ 44 px tall |

---

## 11. Phasing and estimates

Estimates assume 2 senior full-stack engineers + 1 front-end/extension engineer + 0.5 designer, working from this spec. Weeks are calendar weeks.

| Phase | Scope (requirement groups) | Weeks |
|---|---|---|
| **v1 — Replace Calendly for 1:1 and simple team use** | AUTH, CAL, AVL, EVT (all kinds except round robin), SLOT, BOOK, LIFE, NOTIF (both modes, Gmail sending), WF (email), COL, GRP, TEAM, OFF (one-off, single-use, share), EXT-01…07, 11, 12, EMB, WH, brand tokens + v1 copy, admin basics (users, groups, branding), analytics events capture | 8–10 |
| **v2 — Full team parity** | RR, MGD, RF, POLL, WF SMS, Stripe, Zoom/Teams, HubSpot, Contacts, EXT-08…10, PWA, audit log, data deletion, analytics UI, API tokens + public API | 8–10 |
| **v3 — Ecosystem** | Workspace add-on, Zapier app, Salesforce, HubSpot lookup routing, Webex, Outlook/iCloud calendars, Marlo text-booking hook, i18n languages | 6–8 |

Milestone gates: v1 exit = the Marlo team has moved every Calendly link to Marlo Scheduling and Calendly is canceled. v2 exit = round-robin investor/partner intake live with routing form on the website.

Launch prerequisites (owned by Marlo, can run in parallel with build): decide `{{BOOKING_DOMAIN}}` and set DNS; create the Google Cloud project under the `{{WORKSPACE_DOMAIN}}` Workspace and mark the OAuth app Internal; SPF/DKIM/DMARC for the sending domain; Postmark/Resend account; Sentry, Neon, Upstash, Inngest accounts; Chrome Web Store developer account; deliver brand tokens and final copy review.

---

## 12. Open decisions for Marlo

| ID | Decision | Options / recommendation |
|---|---|---|
| D-01 | Product name | "Marlo Scheduling" (internal) with invitee-facing surfaces simply saying "Marlo". Marlo is the only visible brand; no sub-brand, no parent-company mention. |
| D-02 | Booking domain | `book.marlo.{{tld}}` on the same domain the agent uses. Slugs and tokens are domain-independent, so this can change later without migration. |
| D-03 | Default notification mode | Recommend `calendar_invitation` for internal/partner meetings (native RSVP), `email_confirmation` for member-facing event types (brand control). Settable per event type either way. |
| D-04 | Stack | Section 7.1 recommendation; confirm Vercel + Neon + Inngest. |
| D-05 | Gmail compose integration library | InboxSDK (mature, maintained, free with registered app ID) vs hand-rolled DOM integration (fragile). Recommend InboxSDK. |
| D-06 | Round-robin counting window default | `rolling_30d` recommended. |
| D-07 | Invitee data retention | 3 years recommended. |
| D-08 | Whether investor/partner intake uses a routing form on the public site at v2 | Recommend yes; it is the main reason to build round robin at all. |
| D-09 | Brand tokens and copy | Colors and logo delivered 2026-09-20 (front-end handoff). Still open: brand typefaces; review of Section 6.2 copy. |
| D-10 | Marlo text-booking hook (INT-12) timing | v3 as specced, or pull into v2 if member calls become part of onboarding/escalation flows. |

---

## Appendix A — Calendly behaviors verified during reverse-engineering

The following Calendly behaviors were confirmed from Calendly's own help center and developer documentation and are replicated above: event-type kinds (one-on-one, group, collective, round robin) and their host/slot rules; round-robin "optimize for availability" vs "optimize for equal distribution" and the reduced-availability trade-off of the latter; date range options (rolling days, fixed range, indefinite); start-time increments; minimum notice; daily/weekly/monthly limits; before/after buffers; time-zone lock for in-person; secret event types; invitee questions and add-guests; two notification modes (calendar invitation vs email confirmation); email/SMS reminders and follow-ups via Workflows; confirmation page redirect with event details as query params; one-off meetings and single-use links; meeting polls (40 slots / 40 participants); managed events with per-section locks where location is always editable and locked sections re-sync on template save; routing forms with question/qualifier/answer conditions joined by and/or, destinations of event type / external URL / custom message, and a mandatory fallback; the Chrome extension for Gmail (insert link, share available time slots inline, one-off meetings, meeting polls, local keyword detection); webhooks for invitee created / canceled and routing form submissions with signature validation and event-ID deduplication; embed types inline / popup widget / popup text; plan-level capabilities (Free: 1 event type, 1 calendar; Standard: unlimited event types, 6 calendars, group/collective, Stripe/PayPal, HubSpot; Teams: round robin, routing, Salesforce, admin tools; Enterprise: SSO/SCIM, domain claiming, audit log, data deletion API).

Sources: [Calendly plan comparison](https://calendly.com/help/choose-the-right-calendly-plan-for-your-team), [Multi-person scheduling options](https://calendly.com/help/multi-person-scheduling-options-for-your-organization), [Event types overview](https://calendly.com/help/event-types-overview), [How to customize your event types](https://help.calendly.com/hc/en-us/articles/14073251046807-How-to-customize-your-event-types), [Fine-tune availability settings](https://calendly.com/help/how-to-fine-tune-your-availability-settings), [Scheduling FAQ](https://calendly.com/help/scheduling-faq), [Managed events overview](https://calendly.com/help/managed-events-overview), [How to create a routing form](https://help.calendly.com/hc/en-us/articles/4418606043927-How-to-create-a-Routing-Form), [Calendly extension for Gmail](https://calendly.com/help/how-to-use-the-calendly-extension-for-gmail), [Calendly for Chrome](https://calendly.com/help/how-to-install-and-use-calendly-for-chrome), [Webhooks overview](https://calendly.com/help/webhooks-overview), [Developer getting started](https://developer.calendly.com/getting-started), [Event types explained (third-party guide)](https://calendlyconsulting.com/calendly-event-types-explained-guide/), [Calendly features (third-party guide)](https://calendlyconsulting.com/calendly-features/).

## Appendix B — Requirement ID index

ROLE 01–02 · AUTH 01–06 · CAL 01–05 · AVL 01–05 · EVT 01–03, 10, 20–33, 35–40 · SLOT 01–12 · URL 01–02 · BOOK 01–15 · LIFE 01–04 · NOTIF 01–05 · WF 01–08 · RR 01–10 · COL 01 · GRP 01 · TEAM 01 · MGD 01–05 · RF 01–08 · OFF 01–03 · POLL 01 · EXT 01–12 · ADDON 01 · EMB 01–06 · INT 01–14 · ADM 01–09 · CON 01 · APP 01 · COPY 01 · BRAND 01–06 · LAYOUT 01 · EMAIL 01 · A11Y 01 · I18N 01 · TIME 01 · SEC 01–08 · DATA 01 · API 01–06 · WH 01–06 · AC 01–18 · D 01–10
