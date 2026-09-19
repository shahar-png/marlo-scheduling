export const BOOKING_CONFIRMATION = 'booking_confirmation' as const;
export const BOOKING_RESCHEDULED = 'booking_rescheduled' as const;
export const BOOKING_CANCELLED = 'booking_cancelled' as const;

export type EmailTemplate =
  | typeof BOOKING_CONFIRMATION
  | typeof BOOKING_RESCHEDULED
  | typeof BOOKING_CANCELLED;

export type EmailMessage = {
  to: string;
  subject: string;
  template: EmailTemplate;
  bookingId: string;
};

export type SentEmail = EmailMessage & { id: string };

export type EmailSendResult = {
  id: string;
};

export interface EmailProvider {
  send(message: EmailMessage): Promise<EmailSendResult>;
}

export type MockEmailProvider = EmailProvider & {
  sent: SentEmail[];
};

export const EMAIL_SUBJECTS: Record<EmailTemplate, string> = {
  [BOOKING_CONFIRMATION]: 'Booking confirmed',
  [BOOKING_RESCHEDULED]: 'Booking rescheduled',
  [BOOKING_CANCELLED]: 'Booking cancelled',
};

export function createMockEmailProvider(): MockEmailProvider {
  const sent: SentEmail[] = [];
  return {
    sent,
    async send(message: EmailMessage): Promise<EmailSendResult> {
      const to = message.to.trim();
      const subject = message.subject.trim();
      const bookingId = message.bookingId.trim();
      if (!to || !to.includes('@')) {
        throw new Error('email to is required');
      }
      if (!subject) {
        throw new Error('email subject is required');
      }
      if (!bookingId) {
        throw new Error('email bookingId is required');
      }
      const recorded: SentEmail = {
        to,
        subject,
        template: message.template,
        bookingId,
        id: `mock-email-${sent.length + 1}`,
      };
      sent.push(recorded);
      return { id: recorded.id };
    },
  };
}

const defaultMock = createMockEmailProvider();

export function getDefaultMockEmailProvider(): MockEmailProvider {
  return defaultMock;
}

export function resetEmailMessages(): void {
  defaultMock.sent.length = 0;
}

export function listSentEmails(): SentEmail[] {
  return defaultMock.sent.map((row) => ({ ...row }));
}
