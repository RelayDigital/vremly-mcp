/**
 * Loading, searching and describing the Vremly OpenAPI document.
 *
 * The document has ~854 paths. That number is why this server does NOT expose
 * one MCP tool per operation: a tool list that large is unusable — it would
 * cost more context to enumerate than most tasks cost to perform, and many
 * clients cap the tool count outright. Instead capability discovery and three tools (search, describe,
 * request) give complete coverage of every route at a fixed context cost.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

export type HttpMethod =
  | 'get'
  | 'put'
  | 'post'
  | 'delete'
  | 'patch'
  | 'head'
  | 'options';

const HTTP_METHODS: HttpMethod[] = [
  'get',
  'put',
  'post',
  'delete',
  'patch',
  'head',
  'options',
];

export interface Operation {
  method: HttpMethod;
  path: string;
  operationId?: string;
  summary?: string;
  description?: string;
  tags: string[];
  parameters: any[];
  requestBody?: any;
  responses?: Record<string, any>;
  security?: any[];
  requiredScopes?: string[];
}

export interface OpenApiDocument {
  openapi?: string;
  info?: { title?: string; version?: string; description?: string };
  paths: Record<string, any>;
  components?: {
    schemas?: Record<string, any>;
    securitySchemes?: Record<string, any>;
  };
}

/**
 * Where the document comes from, in order:
 *
 *   1. VREMLY_OPENAPI_PATH — an explicit local file.
 *   2. openapi.json beside the package (what `npm run sync:spec` writes, and
 *      what ships in the published tarball).
 *   3. apps/backend/openapi.public.json — the monorepo original, so a checkout that
 *      has not run sync:spec still works rather than failing confusingly.
 *
 * There is deliberately no network fetch. A stdio MCP server that blocks its
 * own startup on an HTTP call fails in a way the host surfaces badly, and the
 * published document is a build artifact of a specific backend commit — being
 * explicit about which copy is in play beats silently drifting to whatever is
 * deployed right now.
 */
export function resolveSpecPath(): string {
  const explicit = process.env.VREMLY_OPENAPI_PATH;
  if (explicit) {
    const p = resolve(explicit);
    if (!existsSync(p)) {
      throw new Error(
        `VREMLY_OPENAPI_PATH points at ${p}, which does not exist.`,
      );
    }
    return p;
  }

  const candidates = [
    join(__dirname, '..', 'openapi.json'),
    join(__dirname, '..', '..', 'backend', 'openapi.public.json'),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  throw new Error(
    'No OpenAPI document found. Run `npm run sync:spec`, or set ' +
      'VREMLY_OPENAPI_PATH to a copy of the Vremly OpenAPI document.',
  );
}

export function loadSpec(path = resolveSpecPath()): OpenApiDocument {
  const raw = readFileSync(path, 'utf8');
  const doc = JSON.parse(raw) as OpenApiDocument;
  if (!doc.paths || typeof doc.paths !== 'object') {
    throw new Error(`${path} is not an OpenAPI document — it has no "paths".`);
  }
  return doc;
}

/** Flatten paths × methods into a single list, resolving path-level parameters. */
export function listOperations(doc: OpenApiDocument): Operation[] {
  const operations: Operation[] = [];

  for (const [path, pathItem] of Object.entries(doc.paths)) {
    if (!pathItem || typeof pathItem !== 'object') continue;

    // Parameters may be declared once for the whole path and inherited by each
    // operation. Dropping them is how a path parameter goes missing from a
    // generated call.
    const shared: any[] = Array.isArray((pathItem as any).parameters)
      ? (pathItem as any).parameters
      : [];

    for (const method of HTTP_METHODS) {
      const op = (pathItem as any)[method];
      if (!op || typeof op !== 'object') continue;

      operations.push({
        method,
        path,
        operationId: op.operationId,
        summary: op.summary,
        description: op.description,
        tags: Array.isArray(op.tags) ? op.tags : [],
        parameters: [
          ...shared,
          ...(Array.isArray(op.parameters) ? op.parameters : []),
        ],
        requestBody: op.requestBody,
        responses: op.responses,
        security: op.security,
        requiredScopes: op['x-vremly-required-scopes'],
      });
    }
  }

  return operations;
}

/**
 * Score an operation against a query.
 *
 * Deliberately simple and explainable rather than fuzzy: an agent searching
 * "create a project" should get POST /projects at the top, and it should be
 * obvious why. Path segments are weighted above prose because that is what
 * callers actually search by, and an exact segment match ("projects") beats a
 * substring hit inside an unrelated word ("project-templates").
 */
function scoreOperation(op: Operation, terms: string[]): number {
  if (terms.length === 0) return 1;

  const pathSegments = op.path
    .toLowerCase()
    .split(/[/{}\-_]+/)
    .filter(Boolean);
  const pathText = op.path.toLowerCase();
  const summary = (op.summary ?? '').toLowerCase();
  const description = (op.description ?? '').toLowerCase();
  const tags = op.tags.join(' ').toLowerCase();
  const operationId = (op.operationId ?? '').toLowerCase();

  let score = 0;
  let matchedTerms = 0;

  for (const term of terms) {
    let termScore = 0;

    if (pathSegments.includes(term)) termScore += 10;
    else if (pathText.includes(term)) termScore += 5;

    if (tags.includes(term)) termScore += 4;
    if (operationId.includes(term)) termScore += 3;
    if (summary.includes(term)) termScore += 3;
    if (description.includes(term)) termScore += 1;

    if (termScore > 0) matchedTerms += 1;
    score += termScore;
  }

  // Every term has to land somewhere. Without this a two-word query returns
  // everything matching only its most common word, which for this API means
  // "project" returns most of the surface.
  if (matchedTerms < terms.length) return 0;

  // Shorter paths are the more general, more likely-intended endpoint:
  // /projects before /projects/{id}/media/{mediaId}/variants.
  score += Math.max(0, 6 - pathSegments.length);

  return score;
}

export interface SearchResult {
  method: string;
  path: string;
  summary?: string;
  tags: string[];
  operationId?: string;
}

export function searchOperations(
  doc: OpenApiDocument,
  query: string,
  opts: { method?: string; limit?: number } = {},
): SearchResult[] {
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);

  const wantedMethod = opts.method?.toLowerCase();
  const limit = opts.limit ?? 20;

  return listOperations(doc)
    .filter((op) => !wantedMethod || op.method === wantedMethod)
    .map((op) => ({ op, score: scoreOperation(op, terms) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.op.path.length - b.op.path.length)
    .slice(0, limit)
    .map(({ op }) => ({
      method: op.method.toUpperCase(),
      path: op.path,
      summary: op.summary,
      tags: op.tags,
      operationId: op.operationId,
    }));
}

export function findOperation(
  doc: OpenApiDocument,
  method: string,
  path: string,
): Operation | undefined {
  const m = method.toLowerCase();
  return listOperations(doc).find((op) => op.method === m && op.path === path);
}

/**
 * What the API does with a body field it does not recognise. It has two
 * answers, and saying one of them for every endpoint is how an assistant ends
 * up either retrying a 400 it was told cannot happen or trusting a 2xx that
 * ignored half its request.
 */
export const UNKNOWN_BODY_FIELD_RULE =
  'An unknown or misspelled body field is handled one of two ways: where the ' +
  'body is validated it is rejected with 400 and nothing changes; where it is ' +
  'not, it is ignored and the call can still return 2xx.';

/**
 * Which half of `UNKNOWN_BODY_FIELD_RULE` applies to one operation.
 *
 * The API's global ValidationPipe runs `whitelist` WITH `forbidNonWhitelisted`,
 * so a body typed as a DTO class rejects an unknown key with a 400 naming it.
 * The document shows which bodies those are: the Swagger plugin emits a `$ref`
 * to a component schema only for a class-typed body, and cannot describe an
 * inline type literal or a single `@Body('key')` at all — those operations
 * publish no requestBody, and the pipe skips them. An inline schema in between
 * is reported as unverified rather than guessed either way.
 *
 * Mirrors `bodyValidationNote` in apps/backend/src/mcp/mcp-tools.service.ts
 * (the hosted server). Two copies only because this package is published
 * standalone and cannot import the backend; the backend's
 * mcp-tools.service.spec.ts fails if their wording differs.
 */
export function bodyValidationNote(op: Operation): string {
  if (op.method === 'get' || op.method === 'head') {
    return (
      'A GET carries no body. Send only the query parameters listed above: ' +
      'depending on the route, an unlisted one is either rejected with 400 or ignored.'
    );
  }
  if (!op.requestBody || typeof op.requestBody !== 'object') {
    return (
      'No request body is published for this operation. Either it takes none, ' +
      'or it reads body fields the API does not validate — there an unknown or ' +
      'misspelled field is ignored and the call can still return 2xx. Take field ' +
      'names from the description above; never guess one.'
    );
  }
  const content: Record<string, any> = op.requestBody.content ?? {};
  const schema = (content['application/json'] ?? Object.values(content)[0])
    ?.schema;
  if (typeof schema?.$ref === 'string') {
    return (
      'This body is validated against the schema above. An unknown or ' +
      'misspelled field is rejected with 400 ("property <name> should not ' +
      'exist") and nothing is changed; a missing required field or a wrong type ' +
      'is refused the same way. A property typed as a free-form object is not ' +
      'checked inside.'
    );
  }
  return (
    'This body may not be validated, so an unknown or misspelled field is not ' +
    'guaranteed to be rejected — it can be ignored while the call still ' +
    'returns 2xx. Send exactly the field names above.'
  );
}

/**
 * Inline $ref-ed schemas so a caller sees field names without a second lookup.
 *
 * Bounded by depth, and cycles are cut with a marker rather than followed —
 * this API has self-referential schemas (a folder containing folders), and an
 * unbounded expansion of those does not terminate.
 */
export function resolveSchema(
  doc: OpenApiDocument,
  schema: any,
  depth = 0,
  seen: Set<string> = new Set(),
): any {
  if (!schema || typeof schema !== 'object') return schema;
  if (depth > 6) return { $comment: 'depth limit reached; expand separately' };

  if (typeof schema.$ref === 'string') {
    const name = schema.$ref.replace('#/components/schemas/', '');
    if (seen.has(name)) return { $ref: schema.$ref, $comment: 'circular' };
    const target = doc.components?.schemas?.[name];
    if (!target) return schema;
    const nextSeen = new Set(seen);
    nextSeen.add(name);
    return {
      ...resolveSchema(doc, target, depth + 1, nextSeen),
      $schemaName: name,
    };
  }

  if (Array.isArray(schema)) {
    return schema.map((item) => resolveSchema(doc, item, depth + 1, seen));
  }

  const out: Record<string, any> = {};
  for (const [key, value] of Object.entries(schema)) {
    out[key] =
      value && typeof value === 'object'
        ? resolveSchema(doc, value, depth + 1, seen)
        : value;
  }
  return out;
}
