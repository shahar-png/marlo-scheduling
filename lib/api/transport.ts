// The transport is the only thing that talks HTTP. Client helpers use
// fetchTransport against the existing /api/... routes; tests (and server
// code) substitute a stub or the route handlers (see handler-transport.ts).

export type ApiRequest = {
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
};

export type ApiResponse = {
  status: number;
  body: unknown;
};

export type Transport = (request: ApiRequest) => Promise<ApiResponse>;

export const fetchTransport: Transport = async (request) => {
  const response = await fetch(request.path, {
    method: request.method,
    headers:
      request.body === undefined
        ? { accept: 'application/json' }
        : { accept: 'application/json', 'content-type': 'application/json' },
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
