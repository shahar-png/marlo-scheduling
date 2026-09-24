// Durable `OwnerStore` (C1 / C8). Every statement is parameterized; the whole
// file is provable offline against the recording fake.

import type { Database } from './db/index';
import {
  assertAssignableOwnerSlug,
  OwnerSlugTakenError,
  type EventTypeRecord,
  type HostToken,
  type Owner,
  type OwnerStore,
  type ScheduleRecord,
} from './owners';

export const UPSERT_OWNER_SQL = `INSERT INTO owners (id, slug, first_name, email, calendar_id)
  VALUES ($1, $2, $3, $4, $5)
  ON CONFLICT (id) DO UPDATE
    SET first_name = $3, email = $4, calendar_id = $5
  RETURNING id, slug, first_name, email, calendar_id`;

export const SELECT_OWNER_BY_SLUG_SQL =
  'SELECT id, slug, first_name, email, calendar_id FROM owners WHERE slug = $1';

export const SELECT_OWNER_BY_ID_SQL =
  'SELECT id, slug, first_name, email, calendar_id FROM owners WHERE id = $1';

export class PgOwnerStore implements OwnerStore {
  constructor(private readonly db: Database) {}

  async upsert(owner: Owner): Promise<Owner> {
    // Refused before any write for an application-owned root segment.
    const slug = assertAssignableOwnerSlug(owner.slug);
    const existing = await this.getBySlug(slug);
    if (existing !== null && existing.id !== owner.id) {
      throw new OwnerSlugTakenError(slug);
    }
    const result = await this.db.query(UPSERT_OWNER_SQL, [
      owner.id,
      slug,
      owner.firstName,
      owner.email,
      owner.calendarId,
    ]);
    return result.rows.length === 0
      ? { ...owner, slug }
      : mapOwner(result.rows[0]);
  }

  async getBySlug(slug: string): Promise<Owner | null> {
    const result = await this.db.query(SELECT_OWNER_BY_SLUG_SQL, [slug]);
    return result.rows.length === 0 ? null : mapOwner(result.rows[0]);
  }

  async getById(id: string): Promise<Owner | null> {
    const result = await this.db.query(SELECT_OWNER_BY_ID_SQL, [id]);
    return result.rows.length === 0 ? null : mapOwner(result.rows[0]);
  }

  async putHostToken(token: HostToken): Promise<void> {
    await this.db.query(
      `INSERT INTO host_tokens (owner_id, refresh_token_enc, updated_at)
         VALUES ($1, $2, $3)
       ON CONFLICT (owner_id) DO UPDATE
         SET refresh_token_enc = $2, updated_at = $3`,
      [token.ownerId, Buffer.from(token.refreshTokenEnc), token.updatedAt],
    );
  }

  async getHostToken(ownerId: string): Promise<HostToken | null> {
    const result = await this.db.query<{
      owner_id: unknown;
      refresh_token_enc: unknown;
      updated_at: unknown;
    }>(
      'SELECT owner_id, refresh_token_enc, updated_at FROM host_tokens WHERE owner_id = $1',
      [ownerId],
    );
    if (result.rows.length === 0) {
      return null;
    }
    const row = result.rows[0];
    const raw = row.refresh_token_enc;
    const bytes =
      raw instanceof Uint8Array
        ? new Uint8Array(raw)
        : new Uint8Array(Buffer.from(String(raw), 'base64'));
    return {
      ownerId: String(row.owner_id),
      refreshTokenEnc: bytes,
      updatedAt: String(row.updated_at),
    };
  }

  /**
   * C1 — the durable half of materialization. `pgCatalogSource` reads these two
   * tables, so a newly signed-in owner's `intro-30` resolves in a fresh isolate
   * only because sign-in wrote them here.
   */
  async upsertSchedule(schedule: ScheduleRecord): Promise<void> {
    await this.db.query(UPSERT_SCHEDULE_SQL, [
      schedule.id,
      schedule.ownerId,
      schedule.timezone,
      JSON.stringify(schedule.windows),
    ]);
  }

  async upsertEventType(eventType: EventTypeRecord): Promise<void> {
    // Product bar lock: only `one_on_one` is ever seeded or materialized (C6.9).
    await this.db.query(UPSERT_EVENT_TYPE_SQL, [
      eventType.id,
      eventType.ownerId,
      eventType.slug,
      eventType.durationMinutes,
      eventType.notificationMode,
      eventType.scheduleId,
      eventType.name,
    ]);
  }
}

export const UPSERT_SCHEDULE_SQL = `INSERT INTO availability_schedules (id, owner_id, timezone, rules)
  VALUES ($1, $2, $3, $4::jsonb)
  ON CONFLICT (id) DO UPDATE
    SET owner_id = $2, timezone = $3, rules = $4::jsonb`;

export const UPSERT_EVENT_TYPE_SQL = `INSERT INTO event_types
    (id, owner_id, slug, kind, duration_min, capacity, notification_mode, schedule_id, name)
  VALUES ($1, $2, $3, 'one_on_one', $4, NULL, $5, $6, $7)
  ON CONFLICT (id) DO UPDATE
    SET slug = $3, duration_min = $4, notification_mode = $5, schedule_id = $6, name = $7`;

function mapOwner(raw: Record<string, unknown>): Owner {
  return {
    id: String(raw.id),
    slug: String(raw.slug),
    firstName: String(raw.first_name),
    email: String(raw.email),
    calendarId: String(raw.calendar_id ?? 'primary'),
  };
}
