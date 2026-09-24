// AC-5 — minimal `.ics` with RFC 5545 escaping of every text value
// (`\\`, `;`, `,`, and newlines) and 75-octet line folding.

export type IcsEvent = {
  uid: string;
  start: string;
  end: string;
  summary: string;
  description?: string;
  organizerEmail: string;
  attendeeEmail: string;
  /** `CANCELLED` for a cancel email so the invitee's client removes it. */
  status: 'CONFIRMED' | 'CANCELLED';
  sequence: number;
  stamp: string;
};

export function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n/g, '\\n')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\n');
}

export function icsInstant(iso: string): string {
  return new Date(Date.parse(iso)).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

export function buildIcs(event: IcsEvent): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Marlo//Scheduling//EN',
    'CALSCALE:GREGORIAN',
    event.status === 'CANCELLED' ? 'METHOD:CANCEL' : 'METHOD:REQUEST',
    'BEGIN:VEVENT',
    `UID:${escapeIcsText(event.uid)}`,
    `DTSTAMP:${icsInstant(event.stamp)}`,
    `DTSTART:${icsInstant(event.start)}`,
    `DTEND:${icsInstant(event.end)}`,
    `SUMMARY:${escapeIcsText(event.summary)}`,
    ...(event.description === undefined
      ? []
      : [`DESCRIPTION:${escapeIcsText(event.description)}`]),
    `ORGANIZER:mailto:${escapeIcsText(event.organizerEmail)}`,
    `ATTENDEE;RSVP=FALSE:mailto:${escapeIcsText(event.attendeeEmail)}`,
    `STATUS:${event.status}`,
    `SEQUENCE:${event.sequence}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return lines.map(foldLine).join('\r\n');
}

/** RFC 5545 line folding at 75 octets. */
function foldLine(line: string): string {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) {
    return line;
  }
  const chunks: string[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const size = offset === 0 ? 75 : 74;
    chunks.push(bytes.subarray(offset, offset + size).toString('utf8'));
    offset += size;
  }
  return chunks.join('\r\n ');
}
