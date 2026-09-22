// Durable `OwnerStore` (C1 / C8). Every statement is parameterized; the whole
// file is provable offline against the recording fake.

import type { Database } from './db/index';
import {
  assertAssignableOwnerSlug,
  OwnerSlugTakenError,
  type HostToken,
  type Owner,
  type OwnerStore,
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
}

function mapOwner(raw: Record<string, unknown>): Owner {
  return {
    id: String(raw.id),
    slug: String(raw.slug),
    firstName: String(raw.first_name),
    email: String(raw.email),
    calendarId: String(raw.calendar_id ?? 'primary'),
  };
}
