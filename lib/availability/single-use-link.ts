import { getEventType } from './event-type';
import { getOneOffMeeting } from './one-off';

export const LINK_UNUSED = 'unused' as const;
export const LINK_CONSUMED = 'consumed' as const;

export type SingleUseLinkStatus = typeof LINK_UNUSED | typeof LINK_CONSUMED;

export type SingleUseLink = {
  id: string;
  token: string;
  hostId: string;
  status: SingleUseLinkStatus;
  eventTypeId?: string;
  oneOffMeetingId?: string;
  bookingId?: string;
};

export type CreateSingleUseLinkInput = {
  hostId?: string;
  token?: string;
  eventTypeId?: string;
  oneOffMeetingId?: string;
};

const linksById = new Map<string, SingleUseLink>();
const linksByToken = new Map<string, string>();

export function resetSingleUseLinks(): void {
  linksById.clear();
  linksByToken.clear();
}

export function createSingleUseLink(
  input: CreateSingleUseLinkInput,
): SingleUseLink {
  const eventTypeId = input.eventTypeId?.trim() || undefined;
  const oneOffMeetingId = input.oneOffMeetingId?.trim() || undefined;

  if (Boolean(eventTypeId) === Boolean(oneOffMeetingId)) {
    throw new Error('exactly one of eventTypeId or oneOffMeetingId is required');
  }

  let hostId: string;
  if (eventTypeId) {
    const eventType = getEventType(eventTypeId);
    if (!eventType) {
      throw new Error('event type not found');
    }
    hostId = eventType.hostId;
  } else {
    const meeting = getOneOffMeeting(oneOffMeetingId!);
    if (!meeting) {
      throw new Error('one-off meeting not found');
    }
    hostId = meeting.hostId;
  }

  if (input.hostId !== undefined && input.hostId.trim() !== hostId) {
    throw new Error('hostId must match the link target');
  }

  const token = (input.token ?? crypto.randomUUID()).trim();
  if (!token) {
    throw new Error('token is required');
  }
  if (linksByToken.has(token)) {
    throw new Error('token must be unique');
  }

  const link: SingleUseLink = {
    id: crypto.randomUUID(),
    token,
    hostId,
    status: LINK_UNUSED,
    ...(eventTypeId ? { eventTypeId } : { oneOffMeetingId }),
  };
  linksById.set(link.id, link);
  linksByToken.set(token, link.id);
  return cloneLink(link);
}

export function getSingleUseLink(id: string): SingleUseLink | null {
  const found = linksById.get(id);
  return found ? cloneLink(found) : null;
}

export function getSingleUseLinkByToken(token: string): SingleUseLink | null {
  const id = linksByToken.get(token);
  return id ? getSingleUseLink(id) : null;
}

export function consumeSingleUseLink(
  token: string,
  bookingId: string,
): SingleUseLink {
  const id = linksByToken.get(token);
  const link = id ? linksById.get(id) : undefined;
  if (!link) {
    throw new Error('single-use link not found');
  }
  if (link.status === LINK_CONSUMED) {
    throw new Error('single-use link already consumed');
  }
  const trimmedBookingId = bookingId.trim();
  if (!trimmedBookingId) {
    throw new Error('bookingId is required');
  }
  link.status = LINK_CONSUMED;
  link.bookingId = trimmedBookingId;
  return cloneLink(link);
}

function cloneLink(link: SingleUseLink): SingleUseLink {
  const cloned: SingleUseLink = {
    id: link.id,
    token: link.token,
    hostId: link.hostId,
    status: link.status,
  };
  if (link.eventTypeId !== undefined) {
    cloned.eventTypeId = link.eventTypeId;
  }
  if (link.oneOffMeetingId !== undefined) {
    cloned.oneOffMeetingId = link.oneOffMeetingId;
  }
  if (link.bookingId !== undefined) {
    cloned.bookingId = link.bookingId;
  }
  return cloned;
}
