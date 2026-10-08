# Vremly MCP server

Gives an AI assistant access to the [Vremly](https://vremly.com) API over the
[Model Context Protocol](https://modelcontextprotocol.io) — so it can look up
your shoots, customers, media and invoices, and change them if you let it.

Full documentation: **[docs.vremly.com/guides/mcp](https://docs.vremly.com/guides/mcp)**

## Install

Create an API key in the Vremly app under **Settings → API Keys**, then add
this to your MCP host's config:

```json
{
  "mcpServers": {
    "vremly": {
      "command": "npx",
      "args": ["-y", "github:RelayDigital/vremly-mcp"],
      "env": {
        "VREMLY_API_KEY": "your-api-key"
      }
    }
  }
}
```

For **Claude Code**, that goes in `.mcp.json` in your project, or run:

```bash
claude mcp add vremly --env VREMLY_API_KEY=your-api-key \
  -- npx -y github:RelayDigital/vremly-mcp
```

There is nothing to clone or build — `npx` fetches the repo and compiles it on
first run.

### Configuration

| Variable | Default | Purpose |
|---|---|---|
| `VREMLY_API_KEY` | *(required)* | Your organization API key. |
| `VREMLY_API_URL` | `https://api.vremly.com` | API base URL. |
| `VREMLY_MCP_READ_ONLY` | unset | `1` permits GET/HEAD/OPTIONS and explicitly reviewed preparation/preview POST operations only. |
| `VREMLY_MCP_TIMEOUT_MS` | `30000` | Per-request timeout. |
| `VREMLY_OPENAPI_PATH` | bundled | Point at a different OpenAPI document. |

### Read-only sessions

`VREMLY_MCP_READ_ONLY=1` also permits these reviewed POST operations, which need a request body to calculate a preview:

- `/orders/prepare`
- `/agent-actions/booking/preview`
- `/agent-actions/rebook/{projectId}/preview`
- `/agent-actions/delivery/{projectId}/preview`
- `/agent-actions/followup/{projectId}/preview`
- `/agent-migrations/{migrationId}/reconciliation-preview`
- `/agent-actions/{booking|delivery|followup}/receipts/{receiptId}/reconciliation-preview`

Other POST operations and all PUT/PATCH/DELETE operations are refused in this mode. These previews do not confirm bookings, charge payments, deliver media, send follow-up or commit migration changes. API-key scopes and organization/project authorization still apply to every permitted request.

## Tools

Four tools expose the reviewed public integration surface:

| Tool | Purpose |
|---|---|
| `vremly_capabilities` | Inspect the connected organization and granted business permissions. |
| `vremly_search_endpoints` | Find endpoints by keyword. |
| `vremly_describe_endpoint` | Parameters, required body fields, responses and permissions. |
| `vremly_request` | Call an endpoint and return its status and body. |

Use capabilities → search → describe → request. Describing before calling avoids guessing request fields. Validated request bodies reject unknown fields with HTTP 400; endpoints without a published body schema may ignore unknown fields. The endpoint description identifies which behavior applies.

## Permissions

Version 0.2.0 adds explicit read/write grants for evaluations, team, dispatch,
reports, project conversations, scheduling, training, inventory, permitted
settings, payroll, workflow catalogs and saved views. For example,
`EVALUATIONS_WRITE` allows reviewed evaluation reads and writes while retaining
all organization role and project authorization checks. It grants no other
domain. Existing `READ`/`WRITE` credentials do not gain these capabilities.
Create a new key with the needed grants; updating the local package grants
nothing. Hosted connections require explicit reauthorization to add grants.



**What the assistant may do is decided by the key and enforced server-side on
every request** — not by this process.

| Scope | Grants |
|---|---|
| `READ` | `GET`, `HEAD`, `OPTIONS` |
| `WRITE` | Everything `READ` allows, plus `POST`, `PUT`, `PATCH`, `DELETE` |
| `ADMIN` | Everything |
| `BULK_IMPORT` | The bulk import endpoints only |
| `WEBHOOKS` | Managing webhook subscriptions |

A key belongs to one organization and the server derives the organization from
it, so the assistant can never reach another organization's data.

> **Give it a `READ` key unless it needs to write.** That guarantee holds even
> if the assistant is prompt-injected by something it reads. `VREMLY_MCP_READ_ONLY=1`
> is a convenience, **not** a security boundary — anything able to set that
> variable could also unset it.

Requests are rate limited per key: 3/second, 20/10 seconds, 100/minute.

## Development

```bash
npm install
npm run build
npm run typecheck
```

`prepare` runs `build`, which is what lets `npx` install this straight from
GitHub — `dist/` is deliberately not committed.

This repository is a **published mirror**. The source of truth is
`apps/mcp-server` in the Vremly monorepo, and `openapi.json` is generated from
the backend rather than written by hand. Send changes there; edits made
directly here will be overwritten by the next sync.
