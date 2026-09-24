// The single reader of `process.env` (AC-15 grep test). Every other module
// asks `resolveEnv()` — or takes the value as an argument — so a live code
// path can never be entered by a stray `process.env` read.
//
// `MARLO_PROOF=1` is a **hard override** (AC-6 / LIVE-03): it forces the
// in-memory store and the mock calendar/email adapters even when `LIVE_*=1`
// and `DATABASE_URL` are present in the environment. `next build` re-reads
// `.env.local`, so the proof harness passes the override explicitly to every
// child and nothing in the tree can opt back into a live path.
//
// The only sanctioned exception is `app/api/health/route.ts`, which may read
// the deploy SHA env names directly (AC-15 exception list).

export type StoreMode = 'memory' | 'pg';
export type AdapterMode = 'mock' | 'live';

export type ResolvedEnv = {
  /** `pg` iff a non-empty `DATABASE_URL` is set and proof mode is off. */
  store: StoreMode;
  calendar: AdapterMode;
  email: AdapterMode;
  /** Present only in `pg` mode; never logged. */
  databaseUrl: string | null;
  /** Raw AES-256-GCM key material for `host_tokens` (AC-14). */
  oauthTokenKey: string | null;
  googleClientId: string | null;
  googleClientSecret: string | null;
  /** True when `MARLO_PROOF=1` forced mocks. */
  proof: boolean;
  /** True when `MARLO_OFFLINE=1` forbids the `npm ci` bootstrap (AC-6). */
  offline: boolean;
};

export type EnvSource = Record<string, string | undefined>;

let override: EnvSource | null = null;

/** Test seam: pins the source `resolveEnv()` reads until reset with `null`. */
export function setEnvOverride(next: EnvSource | null): void {
  override = next;
}

export function resolveEnv(overrides?: EnvSource): ResolvedEnv {
  const source: EnvSource = overrides ?? override ?? process.env;
  const proof = isOn(source.MARLO_PROOF);
  const offline = isOn(source.MARLO_OFFLINE);

  if (proof) {
    // Hard override: no store, calendar, or email value from the environment
    // is consulted, so a proof run cannot reach Neon, Google, or Gmail.
    return {
      store: 'memory',
      calendar: 'mock',
      email: 'mock',
      databaseUrl: null,
      oauthTokenKey: null,
      googleClientId: null,
      googleClientSecret: null,
      proof: true,
      offline,
    };
  }

  const databaseUrl = nonEmpty(source.DATABASE_URL);
  return {
    store: databaseUrl === null ? 'memory' : 'pg',
    calendar: isOn(source.LIVE_CALENDAR) ? 'live' : 'mock',
    email: isOn(source.LIVE_EMAIL) ? 'live' : 'mock',
    databaseUrl,
    oauthTokenKey: nonEmpty(source.OAUTH_TOKEN_KEY),
    googleClientId: nonEmpty(source.GOOGLE_CLIENT_ID),
    googleClientSecret: nonEmpty(source.GOOGLE_CLIENT_SECRET),
    proof: false,
    offline,
  };
}

function isOn(value: string | undefined): boolean {
  return value === '1' || value === 'true';
}

function nonEmpty(value: string | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}
