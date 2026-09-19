import { createHmac, timingSafeEqual } from 'node:crypto';

export const WEBHOOK_SIGNATURE_HEADER = 'Marlo-Webhook-Signature';

export function signWebhookPayload(body: string, secret: string): string {
  const key = secret.trim();
  if (!key) {
    throw new Error('secret is required');
  }
  const hex = createHmac('sha256', key).update(body, 'utf8').digest('hex');
  return `sha256=${hex}`;
}

export function verifyWebhookSignature(
  body: string,
  secret: string,
  header: string,
): boolean {
  if (!header) {
    return false;
  }
  const expected = signWebhookPayload(body, secret);
  const actual = Buffer.from(header);
  const wanted = Buffer.from(expected);
  if (actual.length !== wanted.length) {
    return false;
  }
  return timingSafeEqual(actual, wanted);
}
