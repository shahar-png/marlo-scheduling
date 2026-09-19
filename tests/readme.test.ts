import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const REQUIRED_ENV_NAMES = [
  'AUTH_SECRET',
  'AUTH_GOOGLE_ID',
  'AUTH_GOOGLE_SECRET',
  'GMAIL_CLIENT_ID',
  'GMAIL_CLIENT_SECRET',
  'GMAIL_REFRESH_TOKEN',
  'GMAIL_FROM',
];

const CREDENTIAL_SHAPED = [
  /AUTH_SECRET\s*=\s*\S+/,
  /AUTH_GOOGLE_ID\s*=\s*\S+/,
  /AUTH_GOOGLE_SECRET\s*=\s*\S+/,
  /GOCSPX-[A-Za-z0-9_-]+/,
  /\d{12,}-[a-z0-9]+\.apps\.googleusercontent\.com/i,
];

describe('AC-5 README environment names', () => {
  it('documents required Auth.js env names and no secret values', () => {
    const readme = readFileSync(path.join(process.cwd(), 'README.md'), 'utf8');

    assert.match(readme, /npm ci/);
    assert.match(readme, /npm test/);
    assert.match(readme, /npm run dev/);

    for (const name of REQUIRED_ENV_NAMES) {
      assert.match(readme, new RegExp(`\\b${name}\\b`));
    }

    for (const pattern of CREDENTIAL_SHAPED) {
      assert.equal(
        pattern.test(readme),
        false,
        `README must not contain credential-shaped value matching ${pattern}`,
      );
    }
  });
});
