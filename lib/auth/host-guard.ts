export const SIGN_IN_PATH = '/signin';
export const HOST_PATH = '/host';

export function isProtectedHostPath(pathname: string): boolean {
  return pathname === HOST_PATH || pathname.startsWith(`${HOST_PATH}/`);
}

export function getUnauthenticatedHostRedirect(
  session: { user?: unknown } | null | undefined,
): string | null {
  return session?.user ? null : SIGN_IN_PATH;
}

export function isAuthorizedForPath(
  session: { user?: unknown } | null | undefined,
  pathname: string,
): boolean {
  if (!isProtectedHostPath(pathname)) {
    return true;
  }
  return getUnauthenticatedHostRedirect(session) === null;
}
