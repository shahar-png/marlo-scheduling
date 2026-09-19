export { auth as middleware } from '@/auth';

export const config = {
  matcher: ['/host', '/host/:path*'],
};
