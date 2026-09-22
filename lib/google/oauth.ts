// Refresh-token exchange (AC-14) over an injected `fetch`, plus AES-256-GCM
// encryption of the refresh token at rest under `OAUTH_TOKEN_KEY`.
//
// A missing or rejected refresh token is `HostNotConnectedError`, which C6.0
// classifies as a **definite** failure — the request never went out — so the
// lifecycle records `delivery.calendar: failed` / `delivery.email: failed`
// with code `host_not_connected` and never crashes.

import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { HostNotConnectedError } from './errors';
import type { FetchLike } from './live-calendar';

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** C7 / REV1-04: the exact consent scope set, including a free/busy scope. */
export const GOOGLE_SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/calendar.freebusy',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/gmail.send',
] as const;

export const GOOGLE_AUTH_PARAMS = {
  access_type: 'offline',
  prompt: 'consent',
} as const;

export type ExchangeRefreshTokenInput = {
  fetch: FetchLike;
  refreshToken: string;
  clientId: string | null;
  clientSecret: string | null;
};

export type AccessToken = {
  accessToken: string;
  expiresInSeconds: number;
};

export async function exchangeRefreshToken(
  input: ExchangeRefreshTokenInput,
): Promise<AccessToken> {
  if (!input.refreshToken || !input.clientId || !input.clientSecret) {
    throw new HostNotConnectedError();
  }
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: input.refreshToken,
    client_id: input.clientId,
    client_secret: input.clientSecret,
  }).toString();

  const response = await input.fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  let parsed: unknown = null;
  try {
    parsed = await response.json();
  } catch {
    parsed = null;
  }
  const record = isRecord(parsed) ? parsed : {};
  if (record.error === 'invalid_grant' || record.error === 'unauthorized_client') {
    // The host revoked consent: a definite refusal, not an outage.
    throw new HostNotConnectedError(String(record.error));
  }
  const accessToken = typeof record.access_token === 'string' ? record.access_token : '';
  if (!accessToken) {
    throw new HostNotConnectedError('no access_token in token response');
  }
  return {
    accessToken,
    expiresInSeconds:
      typeof record.expires_in === 'number' ? record.expires_in : 3600,
  };
}

// ---- token at rest -------------------------------------------------------

function keyOf(rawKey: string): Buffer {
  // Accepts any key material; normalised to 32 bytes by SHA-256 so a hex,
  // base64, or passphrase value all work without a separate format rule.
  return createHash('sha256').update(rawKey, 'utf8').digest();
}

export function encryptRefreshToken(token: string, rawKey: string): Uint8Array {
  if (!rawKey) {
    throw new Error('OAUTH_TOKEN_KEY is required to store a refresh token');
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, keyOf(rawKey), iv);
  const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return new Uint8Array(Buffer.concat([iv, cipher.getAuthTag(), encrypted]));
}

export function decryptRefreshToken(payload: Uint8Array, rawKey: string): string {
  if (!rawKey) {
    throw new HostNotConnectedError('OAUTH_TOKEN_KEY is not set');
  }
  const buffer = Buffer.from(payload);
  if (buffer.length <= IV_BYTES + TAG_BYTES) {
    throw new HostNotConnectedError('stored refresh token is truncated');
  }
  const iv = buffer.subarray(0, IV_BYTES);
  const tag = buffer.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const body = buffer.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv(ALGORITHM, keyOf(rawKey), iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  } catch {
    throw new HostNotConnectedError('stored refresh token could not be decrypted');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
