export const ALLOWED_GOOGLE_HOSTED_DOMAIN = 'myoli.co';

export function isAllowedGoogleWorkspaceIdentity(identity: {
  email?: string | null;
  hd?: string | null;
}): boolean {
  const email = identity.email?.trim().toLowerCase() ?? '';
  const hd = identity.hd?.trim().toLowerCase() ?? '';
  const domain = ALLOWED_GOOGLE_HOSTED_DOMAIN.toLowerCase();
  return hd === domain && email.endsWith(`@${domain}`);
}
