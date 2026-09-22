// AC-5 — strict single-mailbox validation, applied at the API boundary before
// any store or Google call.
//
// Exactly one `addr-spec`: no display name, no comma/semicolon list, no CR/LF,
// ≤ 254 characters. Anything that could inject a header is rejected with 400.

const MAX_LENGTH = 254;
const CONTROL = /[\u0000-\u001f\u007f]/;
const HEADER_PREFIX = /^\s*(to|cc|bcc|subject|from|reply-to)\s*:/i;
const LOCAL = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const DOMAIN_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;

export class EmailAddressError extends Error {
  readonly status = 400;
  constructor(message = 'invitee email is invalid') {
    super(message);
    this.name = 'EmailAddressError';
  }
}

export function isSingleMailbox(value: string): boolean {
  if (value.length === 0 || value.length > MAX_LENGTH) {
    return false;
  }
  if (CONTROL.test(value)) {
    return false;
  }
  if (HEADER_PREFIX.test(value)) {
    return false;
  }
  // A list, a display name, or an angle-addr is not a single addr-spec.
  if (/[,;<>"()[\]\\]/.test(value)) {
    return false;
  }
  if (/\s/.test(value)) {
    return false;
  }
  const at = value.lastIndexOf('@');
  if (at <= 0 || at === value.length - 1) {
    return false;
  }
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (!LOCAL.test(local)) {
    return false;
  }
  const labels = domain.split('.');
  if (labels.length < 2) {
    return false;
  }
  return labels.every((label) => DOMAIN_LABEL.test(label));
}

export function assertSingleMailbox(value: string, what = 'email'): string {
  const trimmed = value.trim();
  if (!isSingleMailbox(trimmed)) {
    throw new EmailAddressError(`${what} must be a single valid mailbox`);
  }
  return trimmed;
}

/** Display names and subjects are folded through MIME, never interpolated raw. */
export function assertNoHeaderInjection(value: string, what = 'value'): string {
  if (CONTROL.test(value)) {
    throw new EmailAddressError(`${what} must not contain control characters`);
  }
  return value;
}
