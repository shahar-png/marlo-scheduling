// Offline proof guard (AC-6). Importing this module replaces `globalThis.fetch`
// with one that throws on any non-localhost URL, so a proof run that reached
// Google, Gmail, or Neon fails loudly instead of silently going live.
//
// Localhost is allowed because the in-process handler transport builds
// `http://localhost/...` request objects (it never dispatches them over the
// network, but a test may still construct one).

export type FetchCall = { url: string; init?: RequestInit };

const NETWORK_BLOCKED = 'network access is blocked in proof runs';

const realFetch = globalThis.fetch;
let installed = false;
const blocked: string[] = [];

function urlOf(input: unknown): string {
  if (typeof input === 'string') {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  if (input instanceof Request) {
    return input.url;
  }
  return String(input);
}

function isLocal(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.hostname === 'localhost' ||
      parsed.hostname === '127.0.0.1' ||
      parsed.hostname === '::1'
    );
  } catch {
    // A relative path never leaves the process in these tests.
    return url.startsWith('/');
  }
}

export function armFetchGuard(): void {
  if (installed) {
    return;
  }
  installed = true;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = urlOf(input);
    if (!isLocal(url)) {
      blocked.push(url);
      throw new Error(`${NETWORK_BLOCKED}: ${url}`);
    }
    throw new Error(`${NETWORK_BLOCKED}: ${url}`);
  }) as typeof globalThis.fetch;
}

export function disarmFetchGuard(): void {
  installed = false;
  globalThis.fetch = realFetch;
}

export function blockedFetchUrls(): string[] {
  return [...blocked];
}

export const NETWORK_BLOCKED_MESSAGE = NETWORK_BLOCKED;

// Armed on import: every test file that imports it is offline by construction.
armFetchGuard();
