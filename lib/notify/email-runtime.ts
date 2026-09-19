import {
  getDefaultMockEmailProvider,
  type EmailProvider,
} from './email';

let injectedProvider: EmailProvider | null = null;

export function setBookingEmailProvider(provider: EmailProvider | null): void {
  injectedProvider = provider;
}

export function getBookingEmailProvider(): EmailProvider {
  return injectedProvider ?? getDefaultMockEmailProvider();
}
