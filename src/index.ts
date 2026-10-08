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
  bodyValidationNote,
  UNKNOWN_BODY_FIELD_RULE,
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

const server = new Server(
  { name: 'vremly', version: '0.2.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: 'vremly_capabilities', description: 'Read the connected organization and granted business capabilities. Check before planning a workflow; no credential can bypass organization roles or project access.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
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
        'credential it accepts, and what it does with a body field it does not ' +
        'recognise. Call this before vremly_request so the body you send uses ' +
        `exactly the published field names. ${UNKNOWN_BODY_FIELD_RULE}`,
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
      case 'vremly_capabilities': {
        const result = await getClient().request({ method: 'GET', path: '/agent/capabilities' });
        return textResult(result, !result.ok);
      }
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
          requiredScopes: op.requiredScopes,
          note: bodyValidationNote(op),
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

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr, never stdout: stdout is the MCP transport, and anything written
  // there corrupts the protocol stream.
  process.stderr.write(
    `[vremly-mcp] ready — ${OPERATION_COUNT} operations from ${SPEC_PATH}\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`[vremly-mcp] failed to start: ${err?.message ?? err}\n`);
  process.exit(1);
});
