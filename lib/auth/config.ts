import Google from 'next-auth/providers/google';
import type { NextAuthConfig } from 'next-auth';
import {
  ALLOWED_GOOGLE_HOSTED_DOMAIN,
  isAllowedGoogleWorkspaceIdentity,
} from './workspace';
import { isAuthorizedForPath } from './host-guard';

export const googleProvider = Google({
  clientId: process.env.AUTH_GOOGLE_ID,
  clientSecret: process.env.AUTH_GOOGLE_SECRET,
  authorization: {
    params: {
      hd: ALLOWED_GOOGLE_HOSTED_DOMAIN,
      prompt: 'select_account',
      scope: [
        'openid',
        'email',
        'profile',
        'https://www.googleapis.com/auth/calendar.freebusy',
        'https://www.googleapis.com/auth/calendar.events',
      ].join(' '),
    },
  },
});

function hostedDomainFromProfile(profile: unknown): string | null {
  if (!profile || typeof profile !== 'object') {
    return null;
  }
  const hd = (profile as { hd?: unknown }).hd;
  return typeof hd === 'string' ? hd : null;
}

export const authConfig = {
  providers: [googleProvider],
  pages: {
    signIn: '/signin',
  },
  trustHost: true,
  callbacks: {
    authorized({ auth, request }) {
      return isAuthorizedForPath(auth, request.nextUrl.pathname);
    },
    signIn({ profile }) {
      return isAllowedGoogleWorkspaceIdentity({
        email: profile?.email,
        hd: hostedDomainFromProfile(profile),
      });
    },
  },
} satisfies NextAuthConfig;
