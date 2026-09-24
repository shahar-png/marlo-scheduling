'use strict';

// PROOF_CMD harness (AC-6 / REV1-12). Two separable phases, in this order:
//
//   1. provisionDependencies() — the only step allowed to touch the network,
//      and only on a clean checkout (`.github/` is off-limits to the builder,
//      so the harness stays self-bootstrapping). It logs the network step and
//      refuses under MARLO_OFFLINE=1.
//   2. runProof() — typecheck, `next build`, unit tests, each spawned with an
//      explicit disabled child env so `next build` re-reading `.env.local`
//      cannot switch a proof run onto a live path.
//
// Both are exported for the unit test, which injects a fake `spawnSync`.

const { existsSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const root = path.join(__dirname, '..');

const PROOF_STEPS = [
  ['npm', ['run', 'typecheck']],
  ['npm', ['run', 'build']],
  ['npm', ['run', 'test:unit']],
];

const PROVISION_LOG = 'proof: provisioning dependencies via npm ci (network)';
const OFFLINE_REFUSAL = 'proof: dependencies missing and MARLO_OFFLINE=1';

// Explicit disabled env for every proof child (AC-6). `MARLO_PROOF=1` is the
// hard override in lib/env.ts; the three others are belt-and-braces so a
// value inherited from the shell or re-read from `.env.local` cannot win.
function proofChildEnv(env) {
  return {
    ...env,
    MARLO_PROOF: '1',
    LIVE_CALENDAR: '0',
    LIVE_EMAIL: '0',
    DATABASE_URL: '',
    // Proof/CI has no Google secrets. Dummy names only — never live OAuth.
    AUTH_SECRET: env.AUTH_SECRET || 'proof-only-auth-secret-not-for-production',
    AUTH_GOOGLE_ID: env.AUTH_GOOGLE_ID || 'proof-only-google-id',
    AUTH_GOOGLE_SECRET: env.AUTH_GOOGLE_SECRET || 'proof-only-google-secret',
  };
}

function dependenciesPresent(exists) {
  return exists(path.join(root, 'node_modules', 'next', 'package.json'));
}

function provisionDependencies(options = {}) {
  const exists = options.exists || existsSync;
  const spawn = options.spawn || spawnSync;
  const env = options.env || process.env;
  const log = options.log || console.log;
  const error = options.error || console.error;

  if (dependenciesPresent(exists)) {
    return { provisioned: false, status: 0 };
  }
  if (env.MARLO_OFFLINE === '1' || env.MARLO_OFFLINE === 'true') {
    error(OFFLINE_REFUSAL);
    return { provisioned: false, status: 2 };
  }
  log(PROVISION_LOG);
  const result = spawn('npm', ['ci'], {
    stdio: 'inherit',
    env,
    cwd: root,
  });
  return { provisioned: true, status: result.status === 0 ? 0 : result.status || 1 };
}

function runProof(options = {}) {
  const spawn = options.spawn || spawnSync;
  const env = proofChildEnv(options.env || process.env);

  for (const [command, args] of PROOF_STEPS) {
    const result = spawn(command, args, {
      stdio: 'inherit',
      env,
      cwd: root,
    });
    if (result.status !== 0) {
      return { status: result.status === 0 ? 0 : result.status || 1 };
    }
  }
  return { status: 0 };
}

function main(options = {}) {
  const exit = options.exit || ((code) => process.exit(code));
  const provision = provisionDependencies(options);
  if (provision.status !== 0) {
    return exit(provision.status);
  }
  const proof = runProof(options);
  if (proof.status !== 0) {
    return exit(proof.status);
  }
  return exit(0);
}

module.exports = {
  main,
  provisionDependencies,
  runProof,
  proofChildEnv,
  PROOF_STEPS,
  PROVISION_LOG,
  OFFLINE_REFUSAL,
};

if (require.main === module) {
  main();
}
