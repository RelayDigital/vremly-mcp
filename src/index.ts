#!/usr/bin/env node
/**
 * Vremly MCP server.
 *
 * Exposes the Vremly REST API to an AI agent over the Model Context Protocol,
 * on stdio.
 *
 * ── WHY THREE TOOLS AND NOT 854 ─────────────────────────────────────────────
 *
 * The obvious design is one tool per operation, generated from the OpenAPI
 * document. The document has 854 paths. Enumerating them costs more context
 * than most tasks are worth, and many hosts cap the tool count anyway.
 *
 * So instead: search to find the endpoint, describe to learn its shape, and
 * request to call it. Three tools, complete coverage, fixed context cost — and
 * no generated tool list to fall out of date, because the search reads the
 * document directly.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import {
  loadSpec,
  resolveSpecPath,
  searchOperations,
  findOperation,
  resolveSchema,
  listOperations,
  type OpenApiDocument,
} from './spec';
import { VremlyClient } from './http';

const SPEC_PATH = resolveSpecPath();
const doc: OpenApiDocument = loadSpec(SPEC_PATH);
const OPERATION_COUNT = listOperations(doc).length;

/**
 * The client is constructed lazily. Building it eagerly would throw on a
 * missing VREMLY_API_KEY before the transport is connected, and a stdio server
 * that dies during handshake shows up in the host as "server failed to start"
 * with no reason — the actionable message would be lost. This way the error
 * arrives as a tool result the user can actually read.
 */
let client: VremlyClient | null = null;
let clientError: string | null = null;

function getClient(): VremlyClient {
  if (client) return client;
  if (clientError) throw new Error(clientError);
  try {
    client = new VremlyClient();
    return client;
  } catch (err: any) {
    clientError = err?.message ?? String(err);
    throw err;
  }
}

/** Single source for the version the host handshakes with and the banner prints. */
const VERSION = '0.1.0';

const server = new Server(
  { name: 'vremly', version: VERSION },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'vremly_search_endpoints',
      description:
        `Search the Vremly API for endpoints by keyword. The API has ${OPERATION_COUNT} ` +
        'operations covering projects (shoots), customers, media and delivery, ' +
        'invoicing, scheduling, the marketplace and webhooks. Start here when ' +
        'you do not already know the exact path. Returns method, path, summary ' +
        'and tags — pass a result to vremly_describe_endpoint for its full shape.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description:
              'Keywords, e.g. "create project", "webhook subscription", "invoice pdf". All terms must match.',
          },
          method: {
            type: 'string',
            description: 'Optional HTTP method filter, e.g. "POST".',
            enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
          },
          limit: {
            type: 'number',
            description: 'Maximum results (default 20).',
          },
        },
        required: ['query'],
      },
    },
    {
      name: 'vremly_describe_endpoint',
      description:
        'Describe one Vremly endpoint in full: path and query parameters, the ' +
        'request body schema with required fields, response schemas, and which ' +
        'credential it accepts. Call this before vremly_request so the body you ' +
        'send matches what the server validates — unknown fields are stripped ' +
        'silently rather than rejected, so a misspelled key fails invisibly.',
      inputSchema: {
        type: 'object',
        properties: {
          method: {
            type: 'string',
            description: 'HTTP method, e.g. "POST".',
          },
          path: {
            type: 'string',
            description:
              'Path template exactly as returned by search, placeholders included, e.g. "/projects/{id}".',
          },
        },
        required: ['method', 'path'],
      },
    },
    {
      name: 'vremly_request',
      description:
        'Call a Vremly API endpoint and return its status and body. ' +
        'Authenticates with the configured organization API key; the ' +
        'organization is derived from that key, so it can only ever reach that ' +
        "organization's data, and the key's scopes decide what it may do (a " +
        'READ key cannot write). Substitute real ids into the path — do not ' +
        'send {placeholders}.',
      inputSchema: {
        type: 'object',
        properties: {
          method: {
            type: 'string',
            description: 'HTTP method, e.g. "GET" or "POST".',
          },
          path: {
            type: 'string',
            description:
              'Path with real values substituted, e.g. "/projects/proj_123".',
          },
          query: {
            type: 'object',
            description: 'Optional query string parameters.',
            additionalProperties: true,
          },
          body: {
            type: 'object',
            description:
              'Optional JSON request body. Ignored for GET/HEAD/OPTIONS.',
            additionalProperties: true,
          },
        },
        required: ['method', 'path'],
      },
    },
  ],
}));

function textResult(value: unknown, isError = false) {
  return {
    content: [
      {
        type: 'text' as const,
        text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
      },
    ],
    ...(isError ? { isError: true } : {}),
  };
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name } = request.params;
  const args = (request.params.arguments ?? {}) as Record<string, any>;

  try {
    switch (name) {
      case 'vremly_search_endpoints': {
        if (typeof args.query !== 'string' || !args.query.trim()) {
          return textResult(
            'query is required and must be a non-empty string.',
            true,
          );
        }
        const results = searchOperations(doc, args.query, {
          method: typeof args.method === 'string' ? args.method : undefined,
          limit: typeof args.limit === 'number' ? args.limit : undefined,
        });
        if (results.length === 0) {
          return textResult(
            `No endpoint matched "${args.query}". Every term must match, so try ` +
              'fewer or more general words — "webhook" rather than "webhook subscription secret".',
          );
        }
        return textResult({ count: results.length, results });
      }

      case 'vremly_describe_endpoint': {
        const { method, path } = args;
        if (typeof method !== 'string' || typeof path !== 'string') {
          return textResult('method and path are both required strings.', true);
        }
        const op = findOperation(doc, method, path);
        if (!op) {
          return textResult(
            `No such operation: ${method.toUpperCase()} ${path}. Paths must be the ` +
              'template form returned by vremly_search_endpoints, with {placeholders} intact.',
            true,
          );
        }

        const bodySchema = op.requestBody?.content?.['application/json']?.schema;

        return textResult({
          method: op.method.toUpperCase(),
          path: op.path,
          summary: op.summary,
          description: op.description,
          tags: op.tags,
          parameters: op.parameters.map((p: any) => ({
            name: p.name,
            in: p.in,
            required: p.required ?? false,
            description: p.description,
            schema: resolveSchema(doc, p.schema),
          })),
          requestBody: bodySchema
            ? {
                required: op.requestBody?.required ?? false,
                schema: resolveSchema(doc, bodySchema),
              }
            : undefined,
          responses: Object.fromEntries(
            Object.entries(op.responses ?? {}).map(([status, value]: any) => [
              status,
              {
                description: value?.description,
                schema: resolveSchema(
                  doc,
                  value?.content?.['application/json']?.schema,
                ),
              },
            ]),
          ),
          security: op.security,
        });
      }

      case 'vremly_request': {
        const { method, path } = args;
        if (typeof method !== 'string' || typeof path !== 'string') {
          return textResult('method and path are both required strings.', true);
        }
        const result = await getClient().request({
          method,
          path,
          query: args.query,
          body: args.body,
        });
        // A non-2xx is reported as an error result so the agent does not read a
        // 403 body as success, but the body is still returned — the server's
        // 403 names the scope that was missing, which is the fix.
        return textResult(result, !result.ok);
      }

      default:
        return textResult(`Unknown tool: ${name}`, true);
    }
  } catch (err: any) {
    return textResult(err?.message ?? String(err), true);
  }
});

/**
 * Startup banner.
 *
 * EVERY BYTE HERE GOES TO stderr. stdout is the MCP transport; one stray
 * character on it desynchronises the JSON-RPC stream and the host drops the
 * connection without a useful error.
 *
 * Colour is capability-gated rather than assumed. When a host captures stderr
 * into a log file `isTTY` is false, and raw escapes would land in that log as
 * `[36m` litter — so they are omitted. NO_COLOR is honoured by convention
 * (no-color.org).
 */
const useColor = Boolean(process.stderr.isTTY) && !process.env.NO_COLOR;
const paint = (code: string, s: string) =>
  useColor ? `[${code}m${s}[0m` : s;
const dim = (s: string) => paint('2', s);
const cyan = (s: string) => paint('36', s);
const green = (s: string) => paint('32', s);
const yellow = (s: string) => paint('33', s);
const bold = (s: string) => paint('1', s);

const WORDMARK = [
  '  ██╗   ██╗██████╗ ███████╗███╗   ███╗██╗  ██╗   ██╗',
  '  ██║   ██║██╔══██╗██╔════╝████╗ ████║██║  ╚██╗ ██╔╝',
  '  ██║   ██║██████╔╝█████╗  ██╔████╔██║██║   ╚████╔╝ ',
  '  ╚██╗ ██╔╝██╔══██╗██╔══╝  ██║╚██╔╝██║██║    ╚██╔╝  ',
  '   ╚████╔╝ ██║  ██║███████╗██║ ╚═╝ ██║███████╗██║   ',
  '    ╚═══╝  ╚═╝  ╚═╝╚══════╝╚═╝     ╚═╝╚══════╝╚═╝   ',
];

/**
 * The point of this is not decoration — it is that "started" and "usable" are
 * different states. A server with no API key still connects happily and then
 * fails on the first tool call, which reads to the user as the assistant being
 * broken. Printing what was actually resolved makes that visible up front.
 */
function banner(): string {
  const hasKey = Boolean(process.env.VREMLY_API_KEY);
  const baseUrl = process.env.VREMLY_API_URL ?? 'https://api.vremly.com';
  const readOnly = process.env.VREMLY_MCP_READ_ONLY === '1';

  const ok = green('✔');
  const warn = yellow('!');
  const row = (mark: string, label: string, value: string) =>
    `  ${mark} ${dim(label.padEnd(12))}${value}`;

  return [
    '',
    ...WORDMARK.map(cyan),
    '',
    `  ${bold('Model Context Protocol server')}  ${dim(`v${VERSION}`)}`,
    '',
    row(ok, 'endpoints', `${OPERATION_COUNT} operations`),
    row(ok, 'api', baseUrl),
    // Presence only. The key is never echoed, not even truncated — stderr ends
    // up in host log files that outlive the session.
    hasKey
      ? row(ok, 'api key', 'VREMLY_API_KEY detected')
      : row(warn, 'api key', yellow('VREMLY_API_KEY not set — calls will fail')),
    row(
      ok,
      'mode',
      readOnly ? 'read-only (GET, HEAD, OPTIONS)' : 'read + write, limited by key scopes',
    ),
    row(ok, 'transport', 'stdio'),
    '',
    hasKey
      ? `  ${green('Ready.')} ${dim('Ask your assistant to search the Vremly API.')}`
      : `  ${yellow('Ready, but unauthenticated.')} ${dim('Set VREMLY_API_KEY and restart.')}`,
    '',
    '',
  ].join('\n');
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr, never stdout: stdout is the MCP transport, and anything written
  // there corrupts the protocol stream.
  process.stderr.write(banner());
}

main().catch((err) => {
  process.stderr.write(
    `\n  ${paint('31', '✖')} ${bold('vremly-mcp failed to start')}\n` +
      `    ${err?.message ?? err}\n` +
      `    ${dim(`spec: ${SPEC_PATH}`)}\n\n`,
  );
  process.exit(1);
});
