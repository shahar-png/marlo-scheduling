// AC-5 — MIME assembly. Subjects and display names are RFC 2047 encoded,
// bodies are quoted-printable, the `.ics` part is base64, and no value reaches
// a header raw: a name or subject containing CR/LF cannot inject a header
// because the encoder never emits a bare CRLF inside an encoded word.

const CRLF = '\r\n';
const MAX_ENCODED_WORD = 63;

export function encodeHeaderValue(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value) && !/[\r\n]/.test(value)) {
    return value;
  }
  // RFC 2047 encoded word, base64, chunked so no line exceeds the limit.
  const bytes = Buffer.from(value, 'utf8');
  const chunks: string[] = [];
  const perChunk = Math.floor((MAX_ENCODED_WORD / 4) * 3);
  for (let offset = 0; offset < bytes.length; offset += perChunk) {
    chunks.push(`=?UTF-8?B?${bytes.subarray(offset, offset + perChunk).toString('base64')}?=`);
  }
  return chunks.join(`${CRLF} `);
}

export function encodeQuotedPrintable(body: string): string {
  const bytes = Buffer.from(body.replace(/\r\n/g, '\n'), 'utf8');
  let line = '';
  const lines: string[] = [];

  const flush = (soft: boolean): void => {
    lines.push(soft ? `${line}=` : line);
    line = '';
  };

  for (const byte of bytes) {
    let encoded: string;
    if (byte === 0x0a) {
      lines.push(line);
      line = '';
      continue;
    }
    if (byte === 0x3d || byte < 0x20 || byte > 0x7e) {
      encoded = `=${byte.toString(16).toUpperCase().padStart(2, '0')}`;
    } else {
      encoded = String.fromCharCode(byte);
    }
    if (line.length + encoded.length > 75) {
      flush(true);
    }
    line += encoded;
  }
  if (line.length > 0) {
    lines.push(line);
  }
  return lines.join(CRLF);
}

export type MimeMessage = {
  from: string;
  to: string;
  toDisplayName?: string;
  subject: string;
  body: string;
  ics?: { filename: string; content: string };
};

export function buildMimeMessage(message: MimeMessage): string {
  const boundary = `marlo-${Buffer.from(message.subject).toString('hex').slice(0, 16)}-b`;
  const toHeader =
    message.toDisplayName === undefined || message.toDisplayName === ''
      ? message.to
      : `${encodeHeaderValue(message.toDisplayName)} <${message.to}>`;

  const headers = [
    `From: ${message.from}`,
    `To: ${toHeader}`,
    `Subject: ${encodeHeaderValue(message.subject)}`,
    'MIME-Version: 1.0',
  ];

  if (message.ics === undefined) {
    headers.push('Content-Type: text/plain; charset="UTF-8"');
    headers.push('Content-Transfer-Encoding: quoted-printable');
    return `${headers.join(CRLF)}${CRLF}${CRLF}${encodeQuotedPrintable(message.body)}${CRLF}`;
  }

  headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
  const parts = [
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    encodeQuotedPrintable(message.body),
    `--${boundary}`,
    `Content-Type: text/calendar; charset="UTF-8"; method=REQUEST; name="${message.ics.filename}"`,
    'Content-Transfer-Encoding: base64',
    `Content-Disposition: attachment; filename="${message.ics.filename}"`,
    '',
    chunk64(Buffer.from(message.ics.content, 'utf8').toString('base64')),
    `--${boundary}--`,
    '',
  ];
  return `${headers.join(CRLF)}${CRLF}${CRLF}${parts.join(CRLF)}`;
}

/** Gmail's `messages.send` takes the raw message base64url-encoded. */
export function toGmailRaw(mime: string): string {
  return Buffer.from(mime, 'utf8').toString('base64url');
}

function chunk64(value: string): string {
  const lines: string[] = [];
  for (let offset = 0; offset < value.length; offset += 76) {
    lines.push(value.slice(offset, offset + 76));
  }
  return lines.join(CRLF);
}
