'use strict';

const { existsSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const root = path.join(__dirname, '..');

// Proof/CI has no Google secrets. Dummy names only — never used for live OAuth.
if (!process.env.AUTH_SECRET) {
  process.env.AUTH_SECRET = 'proof-only-auth-secret-not-for-production';
}
if (!process.env.AUTH_GOOGLE_ID) {
  process.env.AUTH_GOOGLE_ID = 'proof-only-google-id';
}
if (!process.env.AUTH_GOOGLE_SECRET) {
  process.env.AUTH_GOOGLE_SECRET = 'proof-only-google-secret';
}

function run(command, args) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    env: process.env,
    cwd: root,
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

// proof.yml runs `npm test` with no install step. Install from the lockfile
// when node_modules is missing so CI and a clean checkout both work.
if (!existsSync(path.join(root, 'node_modules', 'next', 'package.json'))) {
  run('npm', ['ci']);
}

run('npm', ['run', 'typecheck']);
run('npm', ['run', 'build']);
run('npm', ['run', 'test:unit']);
