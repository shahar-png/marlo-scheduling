-- C8 — complete initial schema for an EMPTY database.
-- Applied by `npm run db:migrate` (scripts/migrate.cjs) inside one
-- transaction, recorded in `schema_migrations`, and idempotent on re-run.
--
-- Identifiers are the deterministic C1 ids (`own_{ownerSlug}`,
-- `evt_{ownerSlug}__{eventSlug}`, `sch_{ownerSlug}__{scheduleKey}`), so a
-- fresh serverless isolate that re-seeds fixtures reproduces them and a
-- persisted booking's `event_type_id` / `schedule_id` always resolves.

CREATE TABLE IF NOT EXISTS schema_migrations (
  version    integer     PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS owners (
  id          text        PRIMARY KEY,
  slug        text        NOT NULL UNIQUE,
  first_name  text        NOT NULL,
  email       text        NOT NULL UNIQUE,
  calendar_id text        NOT NULL DEFAULT 'primary',
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Refresh token at rest is AES-256-GCM ciphertext under OAUTH_TOKEN_KEY (AC-14).
CREATE TABLE IF NOT EXISTS host_tokens (
  owner_id          text        PRIMARY KEY REFERENCES owners (id) ON DELETE CASCADE,
  refresh_token_enc bytea       NOT NULL,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS availability_schedules (
  id       text  PRIMARY KEY,
  owner_id text  NOT NULL REFERENCES owners (id) ON DELETE CASCADE,
  timezone text  NOT NULL,
  rules    jsonb NOT NULL DEFAULT '[]'::jsonb
);

-- `kind` and `capacity` are catalog data only. The seed and sign-in
-- materialization write `kind='one_on_one'` exclusively (Product bar lock,
-- C6.9): no pg code path implements capacity sharing or host assignment.
CREATE TABLE IF NOT EXISTS event_types (
  id                text    PRIMARY KEY,
  owner_id          text    NOT NULL REFERENCES owners (id) ON DELETE CASCADE,
  slug              text    NOT NULL,
  kind              text    NOT NULL DEFAULT 'one_on_one',
  duration_min      integer NOT NULL CHECK (duration_min > 0),
  capacity          integer,
  notification_mode text    NOT NULL DEFAULT 'email_confirmation'
                            CHECK (notification_mode IN ('calendar_invitation', 'email_confirmation')),
  schedule_id       text    NOT NULL REFERENCES availability_schedules (id) ON DELETE RESTRICT,
  name              text    NOT NULL DEFAULT '',
  UNIQUE (owner_id, slug)
);

CREATE TABLE IF NOT EXISTS bookings (
  id                 text        PRIMARY KEY,
  token              text        NOT NULL UNIQUE,
  idempotency_key    text        NOT NULL,
  create_fingerprint text        NOT NULL,
  owner_id           text        NOT NULL REFERENCES owners (id) ON DELETE CASCADE,
  event_type_id      text        NOT NULL REFERENCES event_types (id) ON DELETE RESTRICT,
  host_id            text        NOT NULL,
  "start"            timestamptz NOT NULL,
  "end"              timestamptz NOT NULL,
  status             text        NOT NULL DEFAULT 'confirmed'
                                 CHECK (status IN ('confirmed', 'cancelled')),
  revision           integer     NOT NULL DEFAULT 1,
  -- NULL exactly while the booking's creation is unfinalized (C6.4a CF-1).
  latest_action      text        CHECK (latest_action IN ('confirm', 'reschedule', 'cancel')),
  google_event_id    text,
  google_event_etag  text,
  calendar_state     text        NOT NULL DEFAULT 'pending'
                                 CHECK (calendar_state IN ('pending', 'created', 'failed', 'deleted')),
  rescheduled_from   timestamptz,
  -- Durable destination reservation written by reschedule T1 (C6.1).
  reserved_start     timestamptz,
  reserved_end       timestamptz,
  pending_op         jsonb,
  -- The create a non-create op inherited but did not complete (C6.4a).
  unfinished_create  jsonb,
  -- One entry per insert attempt whose outcome this app never observed (C6.3a).
  unresolved_inserts jsonb       NOT NULL DEFAULT '[]'::jsonb,
  -- Monotonic per-row reap cursor: every `inspectSeq` is drawn from it under
  -- the host lock, so the traversal never depends on the clock (REV13-01).
  reap_cursor        bigint      NOT NULL DEFAULT 0,
  invitee_name       text        NOT NULL,
  invitee_email      text        NOT NULL,
  notes              text,
  metadata           jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, idempotency_key),
  CHECK (id <> token)
);

CREATE INDEX IF NOT EXISTS bookings_host_start_idx ON bookings (host_id, "start");
CREATE INDEX IF NOT EXISTS bookings_host_reserved_idx ON bookings (host_id, reserved_start)
  WHERE reserved_start IS NOT NULL;
CREATE INDEX IF NOT EXISTS bookings_event_type_start_idx ON bookings (event_type_id, "start")
  WHERE status = 'confirmed';
CREATE INDEX IF NOT EXISTS bookings_token_idx ON bookings (token);

-- C6.4 terminal-rejection fence (REV8-01). Rows are never expired, exactly
-- like idempotency keys. `session_full` is kept in the CHECK for wire
-- compatibility although pg mode never writes it (C6.9).
CREATE TABLE IF NOT EXISTS create_rejections (
  owner_id           text        NOT NULL REFERENCES owners (id) ON DELETE CASCADE,
  idempotency_key    text        NOT NULL,
  create_fingerprint text        NOT NULL,
  reason             text        NOT NULL CHECK (reason IN ('slot_unavailable', 'session_full')),
  rejected_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, idempotency_key, create_fingerprint)
);

-- C5 delivery ledger. `attempts` doubles as the claim generation.
CREATE TABLE IF NOT EXISTS notification_deliveries (
  booking_id text        NOT NULL REFERENCES bookings (id) ON DELETE CASCADE,
  revision   integer     NOT NULL,
  action     text        NOT NULL CHECK (action IN ('confirm', 'reschedule', 'cancel')),
  recipient  text        NOT NULL CHECK (recipient IN ('invitee', 'owner')),
  state      text        NOT NULL CHECK (state IN ('claimed', 'sent', 'failed')),
  claimed_at timestamptz NOT NULL DEFAULT now(),
  attempts   integer     NOT NULL DEFAULT 1,
  PRIMARY KEY (booking_id, revision, action, recipient)
);

-- Demo owner + its event type and schedule under the C1 ids.
INSERT INTO owners (id, slug, first_name, email, calendar_id)
VALUES ('own_demo', 'demo', 'Marlo', 'demo@example.com', 'primary')
ON CONFLICT (id) DO NOTHING;

INSERT INTO availability_schedules (id, owner_id, timezone, rules)
VALUES (
  'sch_demo__default',
  'own_demo',
  'UTC',
  '[{"weekday":1,"start":"09:00","end":"20:00"},
    {"weekday":2,"start":"09:00","end":"20:00"},
    {"weekday":3,"start":"09:00","end":"20:00"},
    {"weekday":4,"start":"09:00","end":"20:00"},
    {"weekday":5,"start":"09:00","end":"20:00"}]'::jsonb
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO event_types (id, owner_id, slug, kind, duration_min, notification_mode, schedule_id, name)
VALUES (
  'evt_demo__intro-30',
  'own_demo',
  'intro-30',
  'one_on_one',
  30,
  'email_confirmation',
  'sch_demo__default',
  'Intro call'
)
ON CONFLICT (id) DO NOTHING;
