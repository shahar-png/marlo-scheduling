// Edge runtime. It re-exports an Auth.js instance built from the **Edge-safe**
// config, so the booking runtime — and the `node:crypto` the OAuth token
// encryption needs (AC-14) — never reaches this bundle.
export { auth as middleware } from '@/lib/auth/edge';

export const config = {
  matcher: ['/host', '/host/:path*'],
};
