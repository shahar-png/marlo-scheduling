export type WebhookHttpResult = {
  status: number;
};

export interface WebhookHttp {
  post(
    url: string,
    body: string,
    headers: Record<string, string>,
  ): Promise<WebhookHttpResult>;
}

export type MockWebhookPost = {
  url: string;
  body: string;
  headers: Record<string, string>;
};

export type MockWebhookHttp = WebhookHttp & {
  posts: MockWebhookPost[];
};

export type MockWebhookHttpOptions = {
  statusFor?: (
    post: MockWebhookPost,
    callIndex: number,
  ) => number | Promise<number>;
};

export function createMockWebhookHttp(
  options: MockWebhookHttpOptions = {},
): MockWebhookHttp {
  const posts: MockWebhookPost[] = [];
  return {
    posts,
    async post(url, body, headers) {
      const recorded: MockWebhookPost = {
        url,
        body,
        headers: { ...headers },
      };
      posts.push(recorded);
      const status = options.statusFor
        ? await options.statusFor(recorded, posts.length)
        : 200;
      return { status };
    },
  };
}

const defaultMock = createMockWebhookHttp();

let injectedHttp: WebhookHttp | null = null;

export function setWebhookHttp(http: WebhookHttp | null): void {
  injectedHttp = http;
}

export function getWebhookHttp(): WebhookHttp {
  return injectedHttp ?? defaultMock;
}

export function resetWebhookHttp(): void {
  injectedHttp = null;
  defaultMock.posts.length = 0;
}

export function listWebhookPosts(): MockWebhookPost[] {
  return defaultMock.posts.map((row) => ({
    url: row.url,
    body: row.body,
    headers: { ...row.headers },
  }));
}
