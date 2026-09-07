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
//   ---
//   <button onclick="sendAction('approve', { id })">Approve</button>
//
// A layout is a BODY FRAGMENT. The shell (`ui://mikser/app-shell`) supplies
// the document, the protocol handshake and `sendAction` — so a layout never
// writes postMessage, and the protocol can change without touching content.
//
// This surface gets its OWN ROUTE — `/apps` by default — mounted from
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
const APP_SHELL_HTML = readFileSync(path.join(__dirname, 'public', 'app-shell.html'), 'utf8')

export const APP_SHELL_URI = 'ui://mikser/app-shell'
// The SDK's constant, not a copy of it: `text/html;profile=mcp-app` is
// reserved for this and a conformant host ignores a ui:// resource that says
// anything else.
export const APP_SHELL_MIME = RESOURCE_MIME_TYPE
export { EXTENSION_ID }
export const MODES_URI = 'mikser://mcp-app/modes'
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
        name: name ?? `${host ?? folder ?? 'mikser'}-apps`,
        title: title ?? host ?? folder ?? 'Apps',
        icons: icons ?? own,
        websiteUrl: url ?? undefined,
    }
}

export function mcpApp(options = {}) {
    // `name` is the endpoint's name AND what the registrations below scope
    // themselves to, so the two cannot drift apart. `path` defaults to
    // /<name>, which is what makes `apps` the whole configuration in the
    // common case.
    const {
        name = 'apps',
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
        resources = [APP_SHELL_URI, MODES_URI],
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
                        const { output } = await previewRender(renderEntity, { save: false, catalog: false })
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

                        // Relay, and only relay. A layout used to be able to
                        // name an HTTP `handler.url` that mikser POSTed the
                        // action to, HMAC-signed — an entire webhook protocol
                        // to reach code that already lives in the project. It
                        // bought a loopback endpoint to mount, a signature to
                        // verify, a timeout, and a failure mode where a click
                        // is neither relayed nor handled. The successor is a
                        // handler beside the layout, in-process, where the
                        // action's meaning belongs.
                        logger.debug('%s %s/%s relayed', ACTION_TOOL, entityId, action)
                        return ok({ entityId, action, payload })
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
            const serverInfo = siteIdentity({ runtime, title, icons, name: serverName })
            const mounted = mcp.mountEndpoint({
                name, path: routePath, auth, token, allowRemote,
                tools, resources, prompts, serverInfo,
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
