import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { authConfig, googleProvider } from '../lib/auth/config';
import { isAllowedGoogleWorkspaceIdentity } from '../lib/auth/workspace';

describe('AC-1 Auth.js Google provider', () => {
  it('exports a Google provider with id and name (no network I/O)', () => {
    assert.equal(googleProvider.id, 'google');
    assert.equal(googleProvider.name, 'Google');
  });

  it('includes Google in the Auth.js providers list', () => {
    const providers = authConfig.providers;
    assert.ok(providers.length > 0);
    const google = providers.find((provider) => {
      if (!provider || typeof provider === 'function') {
        return false;
      }
      return provider.id === 'google';
    });
    assert.ok(google);
    assert.equal(google.name, 'Google');
  });

  it('is imported by the App Router Auth.js route', () => {
    const route = readFileSync(
      path.join(process.cwd(), 'app/api/auth/[...nextauth]/route.ts'),
      'utf8',
    );
    assert.match(route, /from ['"]@\/auth['"]/);
    assert.match(route, /handlers/);
  });

  it('allowlists the myoli.co Workspace hosted domain', () => {
    assert.equal(
      isAllowedGoogleWorkspaceIdentity({
        email: 'shahar@myoli.co',
        hd: 'myoli.co',
      }),
      true,
    );
    assert.equal(
      isAllowedGoogleWorkspaceIdentity({
        email: 'someone@gmail.com',
        hd: 'gmail.com',
      }),
      false,
    );
  });
});
