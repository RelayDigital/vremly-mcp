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
| `VREMLY_MCP_READ_ONLY` | unset | `1` refuses anything but `GET`/`HEAD`/`OPTIONS`. |
| `VREMLY_MCP_TIMEOUT_MS` | `30000` | Per-request timeout. |
| `VREMLY_OPENAPI_PATH` | bundled | Point at a different OpenAPI document. |

## Tools

Three, not one per endpoint:

| Tool | Purpose |
|---|---|
| `vremly_search_endpoints` | Find endpoints by keyword. |
| `vremly_describe_endpoint` | Parameters, required body fields, responses. |
| `vremly_request` | Call it, and return the status and body. |

The API has over a thousand operations. A tool per operation would cost more
context to enumerate than most tasks cost to perform, and many hosts cap the
tool count outright. Search → describe → request reaches all of them at a fixed
cost, and because search reads the OpenAPI document directly there is no
generated tool list to fall out of date.

Describing before calling is not ceremony: the API validates with
`whitelist: true`, so a body field it does not recognise is **silently
dropped** rather than rejected. A request built from a guessed field name
returns `201` having ignored the field.

## Permissions

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
