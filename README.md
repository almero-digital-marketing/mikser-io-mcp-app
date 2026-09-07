# mikser-io-mcp-app

MCP Apps for [mikser-io](https://github.com/almero-digital-marketing/mikser-io) — interactive UI over MCP, served on its own route, with a layout as the app.

Implements [SEP-1865](https://modelcontextprotocol.io/seps/1865-mcp-apps-interactive-user-interfaces-for-mcp), the accepted MCP Apps extension. **Not mcp-ui.** The two are easy to conflate and the difference decides the wire shape: mcp-ui returns the UI inside the tool result as an embedded resource, while MCP Apps predeclares it — the app is a resource at a `ui://` URI, a tool points at it through `_meta.ui.resourceUri`, and each call's data reaches the iframe as `structuredContent`. SEP-1865 considered the embedded shape and deferred it, so this package implements the predeclared one and nothing else.

## An app is a layout

```yaml
---
match: "@/orders/*"
mcpApp:
  mode: approve
  description: Approve an order
  actions: [approve, reject]
  sandbox: [allow-scripts]
  handler:
    url: http://127.0.0.1:3000/internal/orders
---
```
```html
<button onclick="sendAction('approve', { note: 'looks right' })">Approve</button>
```

That is the whole authoring surface. The layout is a **body fragment** — no doctype, no protocol code. The shell supplies the document, the handshake and `sendAction`, so the protocol can change without touching content.

Because an app is a layout matched against an entity, it is per-entity rather than per-server: the mechanism that renders a page, pointed at an iframe.

## Install

```bash
npm install mikser-io-mcp-app
```

```js
import { mcp } from 'mikser-io-mcp'
import { mcpApp } from 'mikser-io-mcp-app'

export default async ({ options }) => ({
    plugins: [
        ...pipeline(),
        // mcp() first: it provides the substrate this mounts on.
        options.server && mcp({ base: '' }),
        options.server && mcpApp(),
    ],
})
```

Both behind `--server` — there is no route without an HTTP server, and a plugin whose surface silently never appears is worse than one that refuses.

## Its own route

`mcpApp()` mounts at **`/apps`**, separate from `/mcp`, and every tool and resource it registers is scoped to that endpoint. Two reasons:

- an app host connects to a route whose `initialize` declares the extension and whose tool list is the app surface and nothing else;
- `mikser_app_action` is **app-callable** (`_meta.ui.visibility: ['app']`) — the spec says a host must keep it out of the model's tool list, so it has no business on the agent's endpoint.

Sessions, transport, the auth rule and the protected-resource metadata stay in `mikser-io-mcp`; this package asks for a route rather than hand-rolling one.

| Option | Default | |
|---|---|---|
| `name` | `'apps'` | endpoint name, and what registrations scope themselves to |
| `path` | `/<name>` | where it mounts |
| `auth` | — | a verifier (`mikser-io-auth`'s `oauth()` / `jwt()`, or any `{ verify }`) |
| `token` | — | static-secret shorthand; keeps mikser's loopback-trust model |
| `allowRemote` | `false` | serve to non-loopback callers with no credential |
| `renderTimeout` | `30000` | ms for one app render |

## The surface

| | |
|---|---|
| `ui://mikser/app-shell` | the app, `text/html;profile=mcp-app`. Predeclared, static, reviewable before any tool runs |
| `mikser://mcp-app/modes` | live discovery — which modes exist and what each matches, from layout frontmatter |
| `mikser_app_preview` | render an entity through its `mcpApp` layout into the shell |
| `mikser_app_action` | deliver a click; app-callable only |

## What happens on a click

`sendAction(action, payload?)` → `tools/call mikser_app_action` over the host's bridge → the action is checked against the layout's declared `actions` list → then either returned to the agent as `{ entityId, action, payload }`, or POSTed to `handler.url` when the layout declares one, with the handler's JSON becoming the result the iframe sees.

The allow-list is the auth boundary; there is no callId, signed URL or token on this channel, because the iframe's only route here is the host's already-authenticated MCP transport. A handler that fails does not lose the click — the relay payload comes back with `handlerError` set, so the agent knows which of the two happened. `handler.secret` adds an HMAC (`x-mikser-signature: sha256=…`) the receiver must verify.

## If nothing renders

A conformant host renders an app only for a server that declared the extension at `initialize`:

```json
"capabilities": { "extensions": { "io.modelcontextprotocol/ui": { "mimeTypes": ["text/html;profile=mcp-app"] } } }
```

`mikser-io-mcp` (≥ 11.1.0) derives that from the `ui://` resources actually bound on the route, so registering here switches it on. If a host still shows text, it does not implement the extension — that is the correct fallback, and `content[0].text` carries the rendered HTML so the user sees something either way. The shell also prints every protocol event in an in-iframe panel, which is how you tell "host has no AppBridge" from "layout threw".

## Migrating from `mcpUi`

This feature lived in `mikser-io-mcp` under the mcp-ui vocabulary. Renamed on the way out, with no aliases — a layout still on `mcpUi` is not eligible, deliberately and under test:

| was | is |
|---|---|
| `mcpUi:` frontmatter | `mcpApp:` |
| `mikser_preview_ui` | `mikser_app_preview` |
| `mikser_ui_action` | `mikser_app_action` |
| `ui://mikser/preview-ui-shell` | `ui://mikser/app-shell` |
| `mikser://mcp-ui/modes` | `mikser://mcp-app/modes` |
| served on `/mcp` | served on `/apps` |

## Decisions

[ADR-0001](documentation/decisions/0001-app-action-delivery.md) — the predeclared shell, `tools/call` delivery, and the optional webhook, including the alternatives ruled out.

## License

MIT
