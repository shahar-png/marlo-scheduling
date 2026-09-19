import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import SignInPage from '../app/signin/page';
import {
  getUnauthenticatedHostRedirect,
  isAuthorizedForPath,
} from '../lib/auth/host-guard';

describe('AC-2 protected host route and sign-in', () => {
  it('redirects unauthenticated host access to the sign-in route', () => {
    assert.equal(getUnauthenticatedHostRedirect(null), '/signin');
    assert.equal(getUnauthenticatedHostRedirect({}), '/signin');
    assert.equal(isAuthorizedForPath(null, '/host'), false);
    assert.equal(isAuthorizedForPath(undefined, '/host/calendars'), false);
  });

  it('allows an authenticated session on the host route', () => {
    const session = { user: { email: 'shahar@myoli.co' } };
    assert.equal(getUnauthenticatedHostRedirect(session), null);
    assert.equal(isAuthorizedForPath(session, '/host'), true);
  });

  it('leaves public routes open without a session', () => {
    assert.equal(isAuthorizedForPath(null, '/'), true);
    assert.equal(isAuthorizedForPath(null, '/api/health'), true);
    assert.equal(isAuthorizedForPath(null, '/signin'), true);
    assert.equal(
      isAuthorizedForPath(null, '/api/event-types/intro-30/available-times'),
      true,
    );
    assert.equal(
      isAuthorizedForPath(null, '/api/event-types/intro-30/bookings'),
      true,
    );
  });

  it('renders a Google sign-in control on the sign-in route', () => {
    const html = renderToStaticMarkup(<SignInPage />);
    assert.match(html, /Sign in with Google/);
    assert.match(html, /\/api\/auth\/signin\/google/);
  });

  it('wires the host page to redirect unauthenticated visitors', () => {
    const source = readFileSync(
      path.join(process.cwd(), 'app/host/page.tsx'),
      'utf8',
    );
    assert.match(source, /getUnauthenticatedHostRedirect/);
    assert.match(source, /redirect\(/);
  });
});
