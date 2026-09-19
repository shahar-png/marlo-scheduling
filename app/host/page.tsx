import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import { getUnauthenticatedHostRedirect } from '@/lib/auth/host-guard';

export default async function HostPage() {
  const session = await auth();
  const signInTo = getUnauthenticatedHostRedirect(session);
  if (signInTo) {
    redirect(signInTo);
  }

  return (
    <main>
      <h1>Host</h1>
      <p>Signed in. Calendar connection is recorded by the host service stub.</p>
    </main>
  );
}
