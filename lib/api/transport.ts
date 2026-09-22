// The transport is the only thing that talks HTTP. Client helpers use
// fetchTransport against the existing /api/... routes; tests (and server
// code) substitute a stub or the route handlers (see handler-transport.ts).

export type ApiRequest = {
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
  /**
   * Extra request headers. Two exist in this slice: the C9 `Idempotency-Key` on
   * create, and the C11 `Authorization: Bearer {token}` on every
   * `/api/bookings/{id}/*` call. The token is never sent in the query string or
   * the JSON body.
   */
  headers?: Record<string, string>;
};

export type ApiResponse = {
  status: number;
  body: unknown;
};

export type Transport = (request: ApiRequest) => Promise<ApiResponse>;

export const fetchTransport: Transport = async (request) => {
  const response = await fetch(request.path, {
    method: request.method,
    headers: {
      accept: 'application/json',
      ...(request.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(request.headers ?? {}),
    },
    body: request.body === undefined ? undefined : JSON.stringify(request.body),
    cache: 'no-store',
  });
  return { status: response.status, body: await readJson(response) };
};

export async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}
