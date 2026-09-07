// MCP Apps for mikser-io — SEP-1865, not mcp-ui.
//
// The two are easy to conflate and the difference decides the wire shape.
// mcp-ui returns the UI *inside* the tool result as an embedded resource.
// MCP Apps predeclares it: the app is a RESOURCE at a `ui://` URI, a tool
// points at it through `_meta.ui.resourceUri`, and each call's data reaches
// the iframe as `structuredContent` via `ui/notifications/tool-result`.
// SEP-1865 considered the embedded shape and deferred it (see its Rationale),
// so this package implements the predeclared one and nothing else.
//
// What it does with mikser's own idea of content: an app is a LAYOUT. A
// layout that declares `mcpApp` frontmatter becomes eligible to render an
// entity into the shell, which is what makes the app per-entity rather than
// per-server — the same mechanism that renders a page, pointed at an iframe.
//
//   ---
//   match: "@/orders/*"
//   mcpApp:
//     mode: approve
//     description: Approve an order
//     actions: [approve, reject]
//     sandbox: [allow-scripts]
//     auth: [editors, admins]      # optional: groups that may use this app
//   ---
//   <button onclick="sendAction('approve', { id })">Approve</button>
//
// What an action MEANS lives beside the layout, in its sidecar — the same
// `<layout>.js` whose `load` the render already uses, with three more named
// exports this surface reads:
//
//   call({ action, payload, entity, layout, mode, principal, logger })
//        what the click does. Its return value is the tool result the app
//        sees. Absent, the action is relayed to the agent unchanged.
//   read({ uri, entity, layout, principal, logger })
//        answers the app's readServerResource() for this layout's own data.
//   list({ entity, layout, principal, logger })
//        what read() can be asked for, for the app's listServerResources().
//
// In-process, with the caller's principal, and no endpoint to mount: the
// webhook this replaced needed all three and could still lose a click.
//
// A layout is a BODY FRAGMENT. The shell (`ui://mikser/app-shell`) supplies
// the document, the protocol handshake and `sendAction` — so a layout never
// writes postMessage, and the protocol can change without touching content.
//
// This surface gets its OWN ROUTE — `/app` by default — mounted from
// mikser-io-mcp's substrate rather than added to `/mcp`. Two reasons. An app
// host connects to a route whose initialize declares the MCP Apps extension
// and whose tool list is the app surface and nothing else; and the action tool
// is app-callable by spec, so it must not appear on the agent's endpoint at
// all. Sessions, transport and the auth rule stay in mikser-io-mcp, which is
// why the registrations here carry `endpoints: [name]` and the route is asked
// for rather than hand-rolled.
//
// The host must negotiate the extension at initialize for any of this to
// render; mikser-io-mcp declares it from the ui:// resources actually bound,
// which is why this package needs ^11.1.0 of it and why registering here is
// enough to switch it on.
import path from 'node:path'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { useRenderer, matchEntity, useService } from 'mikser-io'
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
// The protocol's own vocabulary and registration helpers, from the SDK rather
// than from our reading of the spec. The negotiation bug that made every host
// show text instead of an app was exactly such a reading error.
import {
    registerAppTool, registerAppResource,
    EXTENSION_ID, RESOURCE_MIME_TYPE,
} from '@modelcontextprotocol/ext-apps/server'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// The app shell, read once at import. Built by `npm run build` (vite +
// vite-plugin-singlefile) into ONE self-contained document, because the iframe
// has no network of its own — the spec's CSP is `default-src 'none'`, so a
// second file would be a script that can never load. Committed and published,
// so installing this package needs no build.
// The shell as built, with its version placeholder still in it. Substituted
// below rather than baked in at build time: a version inside the artefact made
// every bump change the file, and `prepack` rebuilding it left the tree dirty
// exactly when the release tool was trying to decide what had moved.
const SHELL_VERSION_TOKEN = '__MIKSER_APP_SHELL_VERSION__'
const { version: PACKAGE_VERSION } = JSON.parse(
    readFileSync(path.join(__dirname, 'package.json'), 'utf8'))
const APP_SHELL_HTML = readFileSync(path.join(__dirname, 'public', 'app-shell.html'), 'utf8')
    .replace(SHELL_VERSION_TOKEN, PACKAGE_VERSION)

export const APP_SHELL_URI = 'ui://mikser/app-shell'
// The SDK's constant, not a copy of it: `text/html;profile=mcp-app` is
// reserved for this and a conformant host ignores a ui:// resource that says
// anything else.
export const APP_SHELL_MIME = RESOURCE_MIME_TYPE
export { EXTENSION_ID }
export const MODES_URI = 'mikser://mcp-app/modes'
// Where a layout's own data lives, for an app that asks for more than the
// render gave it. Under mikser's existing scheme rather than a new one:
// `ui://` is the spec's, reserved for app documents, and a third scheme would
// be a vocabulary nobody else knows.
//
// The layout is ONE segment, percent-encoded, so a nested layout name
// (`blog/post`) cannot be mistaken for a longer path.
export const DATA_URI_TEMPLATE = 'mikser://app/{layout}/{+path}'
const dataUri = (layoutName, dataPath) => `mikser://app/${encodeURIComponent(layoutName)}/${dataPath}`
export const PREVIEW_TOOL = 'mikser_app_preview'
export const ACTION_TOOL = 'mikser_app_action'

// Who a client thinks it is talking to on this route.
//
// NOT mikser. This endpoint serves a site's apps to that site's visitors, so
// mikser's name and mark on it would brand someone else's form with the engine
// that happens to render it.
//
// The icon reuses what the engine already does rather than inventing a
// convention: mikser's server answers `/favicon.ico` with the site's own icon
// when the build emitted one, and with mikser's mark only as a fallback (the
// static output handler wins over that route — checked, not assumed). So the
// address is the site's answer to "what is this site's icon", and it is
// advertised only when the output actually holds one. When it does not, the
// answer is NO icon: that fallback is mikser's mark, and inheriting it here is
// the thing this exists to avoid.
const SITE_ICON = 'favicon.ico'

function siteIdentity({ runtime, title, icons, name }) {
    const url = runtime.options.url ?? null
    const host = url ? (() => { try { return new URL(url).host } catch { return null } })() : null
    const folder = path.basename(runtime.options.workingFolder ?? '') || null

    let own = []
    if (icons === undefined && url && runtime.options.outputFolder
        && existsSync(path.join(runtime.options.outputFolder, SITE_ICON))) {
        own = [{ src: `${url.replace(/\/$/, '')}/${SITE_ICON}`, mimeType: 'image/x-icon', sizes: ['any'] }]
    }

    return {
        // The programmatic identifier a host keys its config on: per site, so
        // two mikser sites in one client are two servers rather than one
        // shadowing the other.
        name: name ?? `${host ?? folder ?? 'mikser'}-app`,
        title: title ?? host ?? folder ?? 'Apps',
        icons: icons ?? own,
        websiteUrl: url ?? undefined,
    }
}

// Who may use a given app.
//
// A layout without `mcpApp.auth` is public — which is every app that existed
// before this, so an upgrade changes nothing. With it, the caller's GROUPS
// (the principal's `roles`, from groups.htgroup) must intersect the list.
//
// Groups rather than capabilities because a group is what a layout author can
// reason about and what the identity file already spells; capabilities are the
// engine's vocabulary for what a role may do to collections, which is a
// different question from "whose app is this".
function requiredGroups(layout) {
    const declared = layout?.meta?.mcpApp?.auth
    if (!declared) return null
    const groups = (Array.isArray(declared) ? declared : [declared])
        .map(group => String(group).trim())
        .filter(Boolean)
    return groups.length ? groups : null
}

// The refusal, in the shape mikser-io-mcp's per-call hook expects.
//
// 401 when nobody is named, 403 when someone is: the difference is the whole
// point. A 401 carries the challenge that tells a host where to sign in, so
// "required when the server asks" works; a 403 says signing in again will not
// help, which stops a client looping on a refresh it cannot fix.
function refusalFor(layout, principal) {
    const groups = requiredGroups(layout)
    if (!groups) return null

    const held = principal?.roles ?? []
    if (held.some(group => groups.includes(group))) return null

    const anonymous = !principal?.subject || principal.subject === 'anonymous'
    return anonymous
        ? { status: 401, error: `${layout.id} requires sign-in (one of: ${groups.join(', ')})` }
        : { status: 403, error: `${layout.id} is restricted to [${groups.join(', ')}] and ${principal.subject} is in [${held.join(', ') || 'no groups'}]` }
}

export function mcpApp(options = {}) {
    // `name` is the endpoint's name AND what the registrations below scope
    // themselves to, so the two cannot drift apart. `path` defaults to
    // /<name>, which is what makes `apps` the whole configuration in the
    // common case.
    const {
        // Singular, like every other route mikser mounts — /mcp, /live,
        // /drive, /api. This is one surface, not a directory of them.
        name = 'app',
        path: routePath = `/${name}`,
        auth, token, allowRemote,
        // What this route exposes. The default is THIS surface and nothing
        // else: a host connects here to run an app, and has no use for
        // mikser_delete_entity — while every write tool on a second route is
        // a second way to reach it. The agent's endpoint stays /mcp.
        //
        // `[]` excludes rather than allows: matchesAny() treats an empty list
        // as "nothing matches" and only `null` as "everything".
        tools     = [PREVIEW_TOOL, ACTION_TOOL],
        resources = [APP_SHELL_URI, MODES_URI, DATA_URI_TEMPLATE],
        prompts   = [],
        // Identity shown for this route. Defaults come from the site — see
        // siteIdentity above; `icons: []` is how you say "no icon" and is
        // also what an iconless site gets.
        title, icons, serverName,
    } = options

    return (core) => {
        const { runtime, onLoaded, useLogger, findEntity, findEntities } = core
        // Every registration below is bound ONLY on this route. Requires
        // mikser-io-mcp >= 11.2.0, which is where endpoint scoping and the
        // mountEndpoint seam live; on anything older the tools would land on
        // /mcp instead, which is the thing this avoids.
        const scope = { endpoints: [name] }

        onLoaded(() => {
            const logger = useLogger()
            // Asked for from a hook so every factory has run — including
            // mcp()'s, which provides this.
            const mcp = useService('mcp')
            if (!mcp) {
                // Out loud, not silently. A config with mcpApp() and no mcp()
                // — or with mcp() behind a flag this one is not behind — has
                // an app surface that never appears, and the only symptom
                // otherwise is a host that shows no app.
                logger.warn('mcpApp: no mcp service — add mcp() to the plugins array (before this one, and behind the same flag). No app surface registered.')
                return
            }

            const { render: previewRender } = useRenderer(runtime, {
                defaultTimeout: options.renderTimeout
                    ?? runtime.config.preview?.renderTimeout
                    ?? 30_000,
            })

            // A layout's sidecar export, or undefined.
            //
            // Reached through the `layouts` SERVICE, never an import: this
            // package depends on the contract — something provides `layouts`
            // with a `sidecar(layout)` — and not on the package that happens
            // to satisfy it. There is no dependency on mikser-io-layouts in
            // this manifest, and none in this code; absent the service, the
            // app surface still renders and still relays, it just reaches no
            // handlers, and says so once.
            //
            // A service rather than a copy because the digest stamping that
            // keeps an edited sidecar from answering out of cache lives with
            // the loader, and a second copy of it would drift.
            const sidecarExport = async (layout, name) => {
                const layoutsService = useService('layouts')
                if (typeof layoutsService?.sidecar !== 'function') {
                    // Said once, not per click: without it a project's
                    // handlers are simply never reached, and silence would
                    // look like a handler that does nothing.
                    if (!sidecarExport.warned) {
                        sidecarExport.warned = true
                        logger.warn('mcpApp: no `layouts` service with sidecar loading (mikser-io-layouts >= 11.2.0 provides one) — layout handlers (call/read/list) will not be reached.')
                    }
                    return undefined
                }
                try {
                    const sidecar = await layoutsService.sidecar(layout)
                    const handler = sidecar?.[name]
                    return typeof handler === 'function' ? handler : undefined
                } catch (err) {
                    // A sidecar that will not even load is the project's
                    // problem to see, and it is not this call's fault.
                    logger.error('mcpApp: sidecar for %s failed to load: %s', layout?.id, err.message)
                    return undefined
                }
            }

            const appLayouts = async (mode) => {
                const all = await findEntities()
                return all.filter(layout =>
                    layout.collection === 'layouts'
                    && layout.meta?.mcpApp
                    && (mode === undefined || (layout.meta.mcpApp.mode ?? 'preview') === mode))
            }

            // Discovery. Read before calling the preview tool to learn which
            // modes this project actually has and what each one matches —
            // derived live from the catalog, so a layout added while the
            // engine runs shows up with no restart.
            mcp.registerResource(
                'mikser-mcp-app-modes',
                MODES_URI,
                {
                    ...scope,
                    title: 'MCP Apps modes available in this project',
                    description: `Live list of mcpApp modes and their candidate layouts, derived from layout frontmatter. Read this to discover what ${PREVIEW_TOOL} can render before calling it.`,
                    mimeType: 'application/json',
                },
                async (uri) => {
                    const layouts = await appLayouts()
                    const modes = {}
                    for (const layout of layouts) {
                        // A listing that names restricted apps hands an
                        // anonymous caller their descriptions and action
                        // names — that covers the door and leaves the sign on
                        // it.
                        if (refusalFor(layout, mcp.principal?.() ?? null)) continue
                        const declared = layout.meta.mcpApp
                        const mode = declared.mode ?? 'preview'
                        if (!modes[mode]) modes[mode] = []
                        modes[mode].push({
                            layoutId:    layout.id,
                            match:       layout.meta.match ?? null,
                            description: declared.description ?? null,
                            actions:     declared.actions     ?? [],
                            sandbox:     declared.sandbox     ?? ['allow-scripts'],
                        })
                    }
                    return {
                        contents: [{
                            uri: uri.href,
                            mimeType: 'application/json',
                            text: JSON.stringify({
                                modes,
                                totalLayouts: layouts.length,
                                notes: [
                                    "Modes come from layout.meta.mcpApp.mode, defaulting to 'preview' when omitted.",
                                    `Each candidate carries a \`match\` pattern; ${PREVIEW_TOOL} matches your entityId against those for the mode you ask for.`,
                                    'Layouts without `mcpApp` frontmatter are not listed and are not eligible.',
                                ],
                            }, null, 2),
                        }],
                    }
                },
            )

            // The app itself, predeclared. A host fetches this once via
            // resources/read, loads it in a sandboxed iframe, then delivers
            // each call's structuredContent into it. Static across calls,
            // which is the point of the predeclared model — it can be
            // reviewed and cached before any tool runs.
            //
            // The MIME type is not decorative: SEP-1865 reserves
            // `text/html;profile=mcp-app` for this, and a conformant host
            // ignores a ui:// resource that says anything else.
            // registerAppResource, not registerResource: the SDK defaults and
            // normalises what a ui:// resource must declare, so the shape
            // tracks the spec rather than our copy of it.
            registerAppResource(
                mcp,
                'mikser-app-shell',
                APP_SHELL_URI,
                {
                    ...scope,
                    title: 'MCP Apps shell for mikser layouts',
                    description: 'The document mikser layouts render into. The MCP Apps protocol inside it is the official SDK, bundled — so a layout is content-only HTML.',
                },
                async (uri) => ({
                    contents: [{ uri: uri.href, mimeType: APP_SHELL_MIME, text: APP_SHELL_HTML }],
                }),
            )

            // A layout's own data, answered by its sidecar. A TEMPLATE
            // because what exists is the project's business, not ours: `list`
            // is what the sidecars say they have, and `read` routes one URI
            // back to the layout that owns it.
            mcp.registerResource(
                'mikser-app-data',
                new ResourceTemplate(DATA_URI_TEMPLATE, {
                    list: async () => {
                        const resources = []
                        for (const layout of await appLayouts()) {
                            if (refusalFor(layout, mcp.principal?.() ?? null)) continue
                            const lister = await sidecarExport(layout, 'list')
                            if (!lister) continue
                            try {
                                const entries = await lister({
                                    layout,
                                    principal: mcp.principal?.() ?? null,
                                    logger,
                                })
                                for (const entry of entries ?? []) {
                                    // The sidecar names a path; mikser owns
                                    // the URI space, so mikser builds the URI.
                                    if (!entry?.path) continue
                                    resources.push({
                                        uri: dataUri(layout.name, entry.path),
                                        name: entry.name ?? entry.path,
                                        description: entry.description ?? undefined,
                                        mimeType: entry.mimeType ?? undefined,
                                    })
                                }
                            } catch (err) {
                                // One project's broken lister must not empty
                                // the listing for every other app on the route.
                                logger.error('mcpApp: list in %s.js threw: %s', layout.name, err.message)
                            }
                        }
                        return { resources }
                    },
                }),
                {
                    ...scope,
                    title: 'Data an app layout offers',
                    description: "Whatever a layout's sidecar exposes through its `list` and `read` exports, for an app that needs more than the render handed it.",
                },
                async (uri, variables) => {
                    const layoutName = decodeURIComponent(
                        Array.isArray(variables?.layout) ? variables.layout[0] : variables?.layout ?? '')
                    const dataPath = Array.isArray(variables?.path)
                        ? variables.path.join('/')
                        : variables?.path ?? ''
                    const layout = (await appLayouts()).find(candidate => candidate.name === layoutName)
                    if (!layout) throw new Error(`No mcpApp layout named "${layoutName}"`)

                    const reader = await sidecarExport(layout, 'read')
                    if (!reader) throw new Error(`${layoutName}.js exports no \`read\`, so it offers no data`)

                    const answer = await reader({
                        uri: uri.href,
                        path: dataPath,
                        layout,
                        principal: mcp.principal?.() ?? null,
                        logger,
                    })
                    // What a sidecar may answer with, in order, so that the
                    // easy case is one line and the full case is still reachable:
                    //
                    //   a string           → text/plain
                    //   { contents: [...] } → passed through untouched
                    //   { text | blob, mimeType? } → an envelope it composed
                    //   anything else      → the object IS the data, as JSON
                    //
                    // The last two are told apart by `text`/`blob` and nothing
                    // else. Consuming a `mimeType` key off a data object would
                    // mean an answer of `{ path, mimeType }` silently loses
                    // half of itself — which is exactly what it did before
                    // this rule was written down.
                    if (typeof answer === 'string') {
                        return { contents: [{ uri: uri.href, mimeType: 'text/plain', text: answer }] }
                    }
                    if (answer && Array.isArray(answer.contents)) return answer
                    if (answer && (typeof answer.text === 'string' || typeof answer.blob === 'string')) {
                        const { text, blob, mimeType } = answer
                        return {
                            contents: [{
                                uri: uri.href,
                                mimeType: mimeType ?? (blob ? 'application/octet-stream' : 'text/plain'),
                                ...(blob ? { blob } : { text }),
                            }],
                        }
                    }
                    return {
                        contents: [{
                            uri: uri.href,
                            mimeType: 'application/json',
                            text: JSON.stringify(answer ?? null, null, 2),
                        }],
                    }
                },
            )

            // registerAppTool for the same reason: the tool→app link is
            // `_meta.ui.resourceUri` today and the helper is what keeps up if
            // the spec moves the key (it already carries a deprecated
            // alternative for the older spelling).
            registerAppTool(
                mcp,
                PREVIEW_TOOL,
                {
                    ...scope,
                    description: `Render an entity through a layout that declares \`mcpApp\` frontmatter and return it as an app. Picks the layout by matching \`entityId\` against \`layout.meta.match\` and filtering on \`mode\`. **Read \`${MODES_URI}\` first** to discover which modes and entity patterns this project supports. Layouts without \`mcpApp\` frontmatter are not eligible. Hosts that negotiate the MCP Apps extension render the result inside an iframe loaded from \`${APP_SHELL_URI}\`; other hosts display the rendered HTML as text.`,
                    inputSchema: {
                        entityId: z.string().describe('Entity to render, e.g. "/articles/2026-launch".'),
                        mode:     z.string().optional().describe('Which mode to render. Defaults to "preview". Available modes are whatever your layouts declare as `mcpApp.mode`.'),
                    },
                    _meta: {
                        ui: {
                            // Spec-required: names the app this tool renders into.
                            resourceUri: APP_SHELL_URI,
                            // Both, stated rather than left to a host default:
                            // the model calls this tool, the app renders what
                            // comes back.
                            visibility: ['model', 'app'],
                        },
                    },
                },
                async ({ entityId, mode = 'preview' }) => {
                    const logger = useLogger()
                    const fail = (msg) => ({ isError: true, content: [{ type: 'text', text: msg }] })

                    try {
                        const candidates = await appLayouts(mode)
                        if (candidates.length === 0) {
                            return fail(`No layouts found with mcpApp.mode="${mode}". Author a layout with YAML frontmatter at the top: \`---\\nmatch: "@/articles/*"\\nmcpApp:\\n  mode: ${mode}\\n  description: "..."\\n  actions: [...]\\n---\``)
                        }

                        const entity = await findEntity({ id: entityId })
                        if (!entity) return fail(`Entity not found: ${entityId}`)

                        const matched = candidates.find(layout =>
                            layout.meta?.match && matchEntity(entity, layout.meta.match))
                        if (!matched) {
                            const patterns = candidates
                                .map(layout => `  ${layout.id}: match=${JSON.stringify(layout.meta?.match ?? null)}`)
                                .join('\n')
                            return fail(`No mcpApp layout matched ${entityId} in mode=${mode}.\nCandidates for this mode:\n${patterns}`)
                        }

                        // Force the chosen layout. Both `layout` and
                        // `meta.layout` have to be set: the layouts plugin
                        // re-resolves `entity.layout` from `entity.meta.layout`
                        // every cycle and this render goes through the full
                        // lifecycle, so setting only the former lets the
                        // production layout silently win.
                        const renderEntity = {
                            ...entity,
                            layout: matched,
                            meta: { ...(entity.meta || {}), layout: matched.name },
                        }
                        // `save: false` only — NOT `catalog: false`. That flag
                        // prunes the catalog row after the render, which is
                        // right for an entity the caller synthesised and
                        // catastrophic here: the entity being rendered came
                        // out of the catalog, so every preview deleted the
                        // very thing it rendered. The symptom was a form that
                        // worked once and then answered "Entity not found",
                        // with the file still on disk, no change set, and the
                        // removal logged only at debug.
                        const { output } = await previewRender(renderEntity, { save: false })
                        const result = output?.result
                        if (result == null) {
                            return fail(`Render produced no output for ${entityId} via ${matched.id}. Check that the layout's template engine has a matching renderer plugin loaded.`)
                        }

                        const html = typeof result === 'string'
                            ? result
                            : Buffer.isBuffer(result) ? result.toString('utf8') : String(result)

                        const declared = matched.meta?.mcpApp ?? {}
                        logger.debug('%s rendered %s via %s (mode=%s, %d chars)',
                            PREVIEW_TOOL, entityId, matched.id, mode, html.length)

                        // What the iframe receives through
                        // ui/notifications/tool-result. The shell reads `html`
                        // and injects it; entityId and layoutId are what
                        // sendAction sends back.
                        const structuredContent = {
                            entityId,
                            layoutId: matched.id,
                            mode,
                            html,
                            mcpApp: {
                                layoutId:    matched.id,
                                mode,
                                description: declared.description ?? null,
                                actions:     declared.actions     ?? [],
                                sandbox:     declared.sandbox     ?? ['allow-scripts'],
                                actionTool:  ACTION_TOOL,
                            },
                        }
                        return {
                            // The fallback for a host that does not negotiate
                            // the extension: it shows this text, so the user
                            // sees the rendered content even with no iframe.
                            // No mimeType on it — TextContent has no such
                            // field and the SDK drops it; the type lives on
                            // the ui:// resource and in the negotiation.
                            content: [{ type: 'text', text: html }],
                            structuredContent,
                        }
                    } catch (err) {
                        logger.error('%s error: %s', PREVIEW_TOOL, err.message)
                        return fail(err.message)
                    }
                },
            )

            // The click path. App-callable only: `visibility: ['app']` means a
            // host MUST keep it out of the model's tool list and MUST let an
            // iframe it opened invoke it. The iframe's only route here is the
            // host's own authenticated MCP transport, so there is no callId,
            // no signed URL and nothing else to forge — the authorisation
            // that matters is that the action appears in the layout's
            // declared `actions` list.
            mcp.registerTool(
                ACTION_TOOL,
                {
                    ...scope,
                    description: `Deliver a user action emitted from an mcpApp iframe. App-callable only — invisible to the agent, invoked exclusively by iframes opened via ${PREVIEW_TOOL}. Validates the action against the layout's declared \`mcpApp.actions\` list and returns { entityId, action, payload }.`,
                    inputSchema: {
                        entityId: z.string().describe('Entity the action targets (the same id the iframe was rendered for).'),
                        layoutId: z.string().describe('Layout that rendered the iframe — used to look up the allowed-actions list.'),
                        action:   z.string().describe("Action name. Must appear in the layout's mcpApp.actions list."),
                        payload:  z.record(z.any()).optional().describe('Structured payload — form fields, a chosen status, whatever the layout sends. Schema is layout-defined; mikser passes it through.'),
                    },
                    _meta: { ui: { visibility: ['app'] } },
                },
                async ({ entityId, layoutId, action, payload = {} }) => {
                    const logger = useLogger()
                    const fail = (msg) => ({ isError: true, content: [{ type: 'text', text: msg }] })
                    const ok = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] })

                    try {
                        const layout = await findEntity({ id: layoutId })
                        if (!layout || layout.collection !== 'layouts') {
                            return fail(`Layout not found or not a layout: ${layoutId}`)
                        }
                        const declared = layout.meta?.mcpApp
                        if (!declared) {
                            return fail(`Layout ${layoutId} does not declare mcpApp frontmatter — not eligible as an action source.`)
                        }
                        const allowed = declared.actions ?? []
                        if (!allowed.includes(action)) {
                            return fail(`Action "${action}" not in allowed list for ${layoutId}. Declared: [${allowed.join(', ')}]`)
                        }

                        const handler = await sidecarExport(layout, 'call')
                        if (!handler) {
                            // No sidecar, or one that does not handle actions:
                            // the click goes to the agent, which is a complete
                            // answer and the only one before this existed.
                            logger.debug('%s %s/%s relayed', ACTION_TOOL, entityId, action)
                            return ok({ entityId, action, payload })
                        }

                        const entity = await findEntity({ id: entityId })
                        try {
                            const outcome = await handler({
                                action,
                                payload,
                                entity,
                                layout,
                                mode: declared.mode ?? 'preview',
                                // Who clicked, when the route is gated. Null on
                                // a public route — which is most of them, and
                                // is why a sidecar validates rather than trusts.
                                principal: mcp.principal?.() ?? null,
                                logger,
                            })
                            logger.debug('%s %s/%s handled by the sidecar', ACTION_TOOL, entityId, action)
                            // A handler that returns nothing still handled the
                            // action; saying so beats an empty result the app
                            // cannot tell from a failure.
                            return ok(outcome ?? { entityId, action, handled: true })
                        } catch (err) {
                            // The click is not lost: the app is told which of
                            // "not handled" and "handler threw" happened, and
                            // the engine's log carries the stack.
                            logger.error('%s %s/%s sidecar threw: %s', ACTION_TOOL, entityId, action, err.stack ?? err.message)
                            return fail(`Action "${action}" failed in ${layout.name}.js: ${err.message}`)
                        }
                    } catch (err) {
                        logger.error('%s error: %s', ACTION_TOOL, err.message)
                        return fail(err.message)
                    }
                },
            )

            // After the registrations, so the endpoint's first session binds a
            // complete surface rather than an empty one.
            if (typeof mcp.mountEndpoint !== 'function') {
                // Named rather than guessed at: on an older mikser-io-mcp
                // there is no seam and no scoping, so the tools would silently
                // serve from /mcp — an app surface on the agent's endpoint,
                // which is the one arrangement the spec rules out.
                logger.error('mcpApp: mikser-io-mcp is too old — needs >= 11.2.0 for endpoint scoping and mountEndpoint. Not mounting %s.', routePath)
                return
            }
            // Every door into a restricted layout, refused before dispatch.
            //
            // Three of them, because gating one leaves the others open and a
            // gate with a hole is worse than no gate: someone reads the code,
            // sees `auth`, and stops looking.
            //
            //   mikser_app_preview      — the app itself
            //   mikser_app_action       — the click, reachable without ever
            //                             rendering the app
            //   resources/read on
            //   mikser://app/<layout>/… — the data BEHIND the app
            const authorizeCall = async ({ call, principal }) => {
                const method = call?.method
                const params = call?.params ?? {}

                if (method === 'tools/call' && params.name === PREVIEW_TOOL) {
                    const entityId = params.arguments?.entityId
                    const mode = params.arguments?.mode ?? 'preview'
                    const entity = entityId ? await findEntity({ id: entityId }) : null
                    if (!entity) return null   // "not found" is the tool's answer to give
                    const layout = (await appLayouts(mode)).find(candidate =>
                        candidate.meta?.match && matchEntity(entity, candidate.meta.match))
                    return layout ? refusalFor(layout, principal) : null
                }

                if (method === 'tools/call' && params.name === ACTION_TOOL) {
                    const layout = await findEntity({ id: params.arguments?.layoutId })
                    return layout?.collection === 'layouts' ? refusalFor(layout, principal) : null
                }

                if (method === 'resources/read') {
                    const uri = params.uri ?? ''
                    if (!uri.startsWith('mikser://app/')) return null
                    const layoutName = decodeURIComponent(uri.slice('mikser://app/'.length).split('/')[0] ?? '')
                    const layout = (await appLayouts()).find(candidate => candidate.name === layoutName)
                    return layout ? refusalFor(layout, principal) : null
                }

                return null
            }

            const serverInfo = siteIdentity({ runtime, title, icons, name: serverName })
            const mounted = mcp.mountEndpoint({
                name, path: routePath, auth, token, allowRemote,
                tools, resources, prompts, serverInfo, authorizeCall,
            })
            logger.info('MCP Apps mounted: %s%s (%s, %s)',
                runtime.options.url ?? `http://localhost:${runtime.options.port ?? 3000}`,
                mounted.path, PREVIEW_TOOL, ACTION_TOOL)
            logger.debug('MCP Apps surface on %s: %s + %s + %s + %s',
                mounted.path, PREVIEW_TOOL, ACTION_TOOL, MODES_URI, APP_SHELL_URI)
        })

        // Names this package to the runtime's loaded-plugin record, so ping
        // reports it as running rather than as undetectable.
        return { module: import.meta.url }
    }
}

export default mcpApp
