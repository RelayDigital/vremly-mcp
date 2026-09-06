/**
 * The HTTP client the `vremly_request` tool calls through.
 *
 * ── WHAT ENFORCES SAFETY HERE ───────────────────────────────────────────────
 *
 * Not this file. The boundary is the API key: the server derives the
 * organization from it (so no key can reach another org's data, however this
 * client is called) and checks the key's scopes on every route. A READ key
 * physically cannot write, whatever an agent asks for.
 *
 * That is the guarantee worth relying on, because it holds even if this
 * process is compromised or an agent is prompt-injected. VREMLY_MCP_READ_ONLY
 * below is a convenience for people who want a second belt while using a
 * broader key — it is not the security boundary and must not be described as
 * one.
 */

const DEFAULT_BASE_URL = 'https://api.vremly.com';

/** Responses can be large (a project list with media). Truncate rather than
 *  flood the model's context, and say so explicitly when it happens. */
const MAX_BODY_CHARS = 100_000;

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface RequestOptions {
  method: string;
  path: string;
  query?: Record<string, string | number | boolean | null | undefined>;
  body?: unknown;
}

export interface RequestResult {
  status: number;
  ok: boolean;
  url: string;
  body: unknown;
  truncated?: boolean;
  rateLimit?: Record<string, string>;
}

export class VremlyClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly readOnly: boolean;
  private readonly timeoutMs: number;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    const apiKey = env.VREMLY_API_KEY?.trim();
    if (!apiKey) {
      throw new Error(
        'VREMLY_API_KEY is not set. Create a key in the Vremly app under ' +
          'Settings → API Keys and set it in this server’s environment.',
      );
    }
    this.apiKey = apiKey;
    this.baseUrl = (env.VREMLY_API_URL?.trim() || DEFAULT_BASE_URL).replace(
      /\/+$/,
      '',
    );
    this.readOnly = env.VREMLY_MCP_READ_ONLY === '1';
    this.timeoutMs = Number(env.VREMLY_MCP_TIMEOUT_MS ?? 30_000);
  }

  get isReadOnly(): boolean {
    return this.readOnly;
  }

  get base(): string {
    return this.baseUrl;
  }

  async request(opts: RequestOptions): Promise<RequestResult> {
    const method = opts.method.toUpperCase();

    if (this.readOnly && !SAFE_METHODS.has(method)) {
      throw new Error(
        `This server is running with VREMLY_MCP_READ_ONLY=1, so ${method} is ` +
          'refused. Unset it to allow writes.',
      );
    }

    // Reject a path that still contains an unsubstituted {placeholder}: sending
    // it produces a confusing 404 from the server, when the real problem is a
    // caller that forgot to fill in an id.
    const unfilled = opts.path.match(/\{([^}]+)\}/);
    if (unfilled) {
      throw new Error(
        `The path still contains the placeholder {${unfilled[1]}}. Substitute ` +
          'the real value before calling — this tool does not guess ids.',
      );
    }

    const url = new URL(
      opts.path.startsWith('/') ? opts.path : `/${opts.path}`,
      this.baseUrl,
    );

    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value === undefined || value === null) continue;
      url.searchParams.set(key, String(value));
    }

    const headers: Record<string, string> = {
      'x-api-key': this.apiKey,
      accept: 'application/json',
      // Lets the backend attribute traffic, the same way the web and iOS
      // clients identify themselves.
      'x-client': 'mcp',
    };

    let payload: string | undefined;
    if (opts.body !== undefined && !SAFE_METHODS.has(method)) {
      payload = JSON.stringify(opts.body);
      headers['content-type'] = 'application/json';
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: payload,
        signal: controller.signal,
      });
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        throw new Error(
          `Request to ${method} ${url.pathname} timed out after ${this.timeoutMs}ms.`,
        );
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    const truncated = text.length > MAX_BODY_CHARS;
    const kept = truncated ? text.slice(0, MAX_BODY_CHARS) : text;

    let body: unknown;
    try {
      // A truncated payload is no longer valid JSON, so do not pretend.
      body = truncated ? kept : kept ? JSON.parse(kept) : null;
    } catch {
      body = kept;
    }

    // Surfaced because 429 is the failure an automation hits most, and the
    // reset time is the one thing that makes it actionable.
    const rateLimit: Record<string, string> = {};
    for (const header of [
      'x-ratelimit-limit',
      'x-ratelimit-remaining',
      'x-ratelimit-reset',
      'retry-after',
    ]) {
      const value = response.headers.get(header);
      if (value !== null) rateLimit[header] = value;
    }

    return {
      status: response.status,
      ok: response.ok,
      url: url.toString(),
      body,
      ...(truncated ? { truncated: true } : {}),
      ...(Object.keys(rateLimit).length ? { rateLimit } : {}),
    };
  }
}
