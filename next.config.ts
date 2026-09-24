import type { NextConfig } from 'next';

import { DRIVER_CANDIDATES } from './lib/db/driver';

// The Postgres driver is loaded through a **computed** `createRequire` specifier
// (`lib/db/driver.ts`), which is deliberately invisible to the bundler so that a
// deployment without a driver fails with one clear `store_driver_unavailable`
// rather than a build error. The cost of that is that Next's file tracing cannot
// see the dependency either, so it would ship a serverless function whose
// `node_modules` has no driver in it. Both settings below close that gap:
//
//   * `serverExternalPackages` keeps the driver out of the bundle (it is a
//     native/CJS package that must be `require`d at runtime, not inlined);
//   * `outputFileTracingIncludes` forces the package's files into every route's
//     trace, which is what actually puts it on disk next to the function.
//
// The globs are inert when a candidate is not installed, so the offline proof
// (`npm test`, no driver present) builds exactly as before.
const nextConfig: NextConfig = {
  serverExternalPackages: [...DRIVER_CANDIDATES],
  outputFileTracingIncludes: {
    '/**/*': DRIVER_CANDIDATES.map((name) => `./node_modules/${name}/**/*`),
  },
};

export default nextConfig;
