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

The route carries **this surface and nothing else** — two tools and two resources. A host connects here to run an app and has no use for `mikser_delete_entity`, and every write tool on a second route is another way to reach it. The agent's tools stay on `/mcp`:

| | `/mcp` | `/apps` |
|---|---|---|
| tools | 21 (the whole mikser surface) | 2 — `mikser_app_preview`, `mikser_app_action` |
| resources | 7 `mikser://…` | 2 — the shell and the modes list |
| extension declared | no | yes |

Sessions, transport, the auth rule and the protected-resource metadata stay in `mikser-io-mcp`; this package asks for a route rather than hand-rolling one.

| Option | Default | |
|---|---|---|
| `name` | `'apps'` | endpoint name, and what registrations scope themselves to |
| `path` | `/<name>` | where it mounts |
| `auth` | — | a verifier (`mikser-io-auth`'s `oauth()` / `jwt()`, or any `{ verify }`) |
| `token` | — | static-secret shorthand; keeps mikser's loopback-trust model |
| `allowRemote` | `false` | serve to non-loopback callers with no credential |
| `renderTimeout` | `30000` | ms for one app render |
| `tools` | the two app tools | what of the tool surface this route exposes; `[]` exposes none, `null` exposes everything |
| `resources` | the shell and the modes list | same, for resources |
| `prompts` | `[]` | same, for prompts |

## The surface

| | |
|---|---|
| `ui://mikser/app-shell` | the app, `text/html;profile=mcp-app`. Predeclared, static, reviewable before any tool runs |
| `mikser://mcp-app/modes` | live discovery — which modes exist and what each matches, from layout frontmatter |
| `mikser_app_preview` | render an entity through its `mcpApp` layout into the shell |
| `mikser_app_action` | deliver a click; app-callable only |

## What happens on a click

`sendAction(action, payload?)` → `tools/call mikser_app_action` over the host's bridge → the action is checked against the layout's declared `actions` list → `{ entityId, action, payload }` comes back as the tool result, and the agent decides what it means.

The allow-list is the auth boundary; there is no callId, signed URL or token on this channel, because the iframe's only route here is the host's already-authenticated MCP transport.

## What an action means: the layout's sidecar

`<layout>.js` — the same sidecar file whose `load` export the render already uses — answers for the app through three more named exports:

```js
// layouts/order.js
export async function call({ action, payload, entity, layout, mode, principal, logger }) {
    if (action === 'approve') return { ok: true, id: entity.meta.id }
}
export async function list({ layout, principal, logger }) {
    return [{ path: 'rows', name: 'Order rows', mimeType: 'application/json' }]
}
export async function read({ path, uri, layout, principal, logger }) {
    if (path === 'rows') return { rows: [/* … */] }
}
```

- **`call`** receives a *declared* action — the `actions` list is checked first, so project code never sees an action the layout didn't offer. Its return value is the tool result the app sees; returning nothing still counts as handled. Throwing reports the failure naming the file, rather than losing the click.
- **`list`** and **`read`** back the app's `listServerResources()` and `readServerResource()`. The sidecar names a `path`; mikser builds the URI under `mikser://apps/<layout>/<path>`, so a project never constructs mikser's URI space. `read` may answer with a string, a `{ text | blob, mimeType }` envelope, a full `{ contents: [...] }`, or any object (serialised as JSON — a `mimeType` key in a data object stays data).
- **`principal`** is who called, when the route is gated; on a public route it's `anonymous` — a name, not a person, which is why a sidecar validates rather than trusts.

Sidecars load through `mikser-io-layouts`'s own loader, so an edited handler takes effect under `--watch` by the same digest rule the render uses. Without `mikser-io-layouts` ≥ 11.2.0 there is no loader, and `mcpApp` says so once rather than leaving handlers quietly unreached.

An earlier version let a layout name an HTTP `handler.url` that mikser POSTed each action to, HMAC-signed. It is **gone**: an entire webhook protocol — an endpoint to mount, a signature to verify, a timeout, and a state where a click was neither relayed nor handled — to reach code already sitting in the project. A layout that still declares the block gets a plain relay; nothing is POSTed. Its successor is a handler beside the layout, in-process, which is where an action's meaning belongs.

## The shell is built, not hand-written

The protocol inside the iframe is the official SDK — [`@modelcontextprotocol/ext-apps`](https://github.com/modelcontextprotocol/ext-apps) — bundled into one self-contained document by `vite` + `vite-plugin-singlefile`, which is what the SDK's own `add-app-to-server` skill prescribes. The iframe has no network (the spec's CSP is `default-src 'none'`), so a build that emitted separate assets would produce a page whose scripts can never load.

```bash
npm run build      # src/app/{index.html,main.js} -> public/app-shell.html
```

The built file is committed and published, and `prepack` rebuilds it, so installing needs no build and a stale artefact cannot ship. What lives in `src/app/main.js` is only the part that is mikser's: take the rendered layout out of `structuredContent`, put it in the page, and give the layout `sendAction`. Handlers are registered before `connect()`, per the SDK's guidance — a result arriving during the handshake is otherwise dropped and the app renders empty.

Because the runtime is the SDK's, layouts also get its behaviour for free: host theme and fonts (`applyDocumentTheme`, `applyHostStyleVariables`), safe-area insets, iframe size notifications, and `_meta["ui/resourceUri"]` emitted alongside the modern key so hosts on the older spelling still resolve the app.

## If nothing renders

A conformant host renders an app only for a server that declared the extension at `initialize`:

```json
"capabilities": { "extensions": { "io.modelcontextprotocol/ui": { "mimeTypes": ["text/html;profile=mcp-app"] } } }
```

`mikser-io-mcp` derives that from the `ui://` resources actually bound on the route, so registering here switches it on — under the SDK's own `EXTENSION_ID`, pinned by a test so the two cannot drift. If a host still shows text, it does not implement the extension: that is the correct fallback, and `content[0].text` carries the rendered HTML so the user sees something either way.

When something does break, the shell shows one line — a failed handshake, a call that threw — and nothing on the happy path. These routes serve a site's visitors, so a protocol log under a customer's form is a leak, not a diagnostic; the detail goes to the host through the SDK's `sendLog`.

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
