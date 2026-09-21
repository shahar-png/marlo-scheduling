// Safe public path construction (BOOK-FE-19). Pure: no fetch, no client
// directive, no imports from lib/booking — the Server booking page, the
// confirmation adapter, and the client helpers all import it, and it is the
// **only** place a slug is joined into a path.
//
// `createEventType` accepts any non-empty trimmed slug (`intro#follow-up`,
// `intro?x=1`, `a/b`, …). Interpolating such a slug into `/demo/${slug}`
// yields a URL whose path is `/demo/intro` — a different or missing event.
// Representable segments are percent-encoded; the delimiters every layer
// between a `Location` header, the browser, Vercel's router and Next's param
// decoder is free to split on or decode once are rejected outright, so a slug
// that needs them simply has no public URL this slice.

const CONTROL = /[\u0000-\u001f\u007f]/;
const RESERVED = /[/\\?#]/;

export function encodePathSegment(segment: string): string | null {
  if (segment === '' || segment === '.' || segment === '..') {
    return null;
  }
  if (RESERVED.test(segment) || CONTROL.test(segment)) {
    return null;
  }
  try {
    const encoded = encodeURIComponent(segment);
    if (decodeURIComponent(encoded) !== segment) {
      return null;
    }
    return encoded;
  } catch {
    // Lone surrogates throw a URIError — not representable.
    return null;
  }
}

export function publicBookingPath(hostSlug: string, eventSlug: string): string | null {
  const host = encodePathSegment(hostSlug);
  const event = encodePathSegment(eventSlug);
  if (host === null || event === null) {
    return null;
  }
  return `/${host}/${event}`;
}
