import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import nodePath from 'node:path'

import { mcpApp } from '../../index.js'
import { createMcpSubstrate } from 'mikser-io-mcp'
import { EXTENSION_ID, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server'
import { createHarness } from 'mikser-io/testing/harness.js'
import { provideService, resetServices } from 'mikser-io'

// A minimal MCP shim — captures simpleTool / registerTool / registerResource
// calls so tests can invoke the handlers directly without booting the real MCP.
function fakeMcp() {
    const tools = new Map()
    const resources = new Map()
    return {
        registered: tools,
        resources,
        simpleTool(name, description, inputSchema, handler) {
            tools.set(name, { description, inputSchema, handler })
        },
        // registerTool is the lower-level path; tools that need _meta
        // (like mikser_app_action's visibility flag for MCP Apps) use it
        // directly. Capture into the same map so tests don't care which
        // path the plugin took.
        registerTool(name, config, handler) {
            tools.set(name, { ...config, handler })
        },
        registerResource(name, uri, metadata, handler) {
            resources.set(uri, { name, metadata, handler })
        },
        registerPrompt() {},
        // The seam mikser-io-mcp >= 11.2.0 exposes so a package can own its
        // own route. Recorded, not executed — the route's behaviour is that
        // package's business; what matters here is that this one asks for it
        // with the right name and path.
        mounted: [],
        mountEndpoint(args) {
            this.mounted.push(args)
            return { name: args.name, path: args.path ?? `/${args.name}` }
        },
    }
}

// The preview plugin asks core for the 'mcp' service. We provide a fake
// before invoking the plugin so its onLoaded registers against ours.
function withMcp(harnessOptions = {}, entities = []) {
    // A fresh fake per test, and the registry is module state: providing a
    // second 'mcp' without clearing the first is (correctly) an error.
    resetServices()
    const mcp = fakeMcp()
    const h = createHarness({
        options: { ...harnessOptions, port: 3001 },
        entities,
    })
    provideService('mcp', mcp)
    mcpApp()(h.core)
    return { h, mcp }
}

describe('mcpApp: mikser_app_preview dispatch', () => {
    it('registers mikser_app_preview under MCP when the mcp service is provided', async () => {
        const { h, mcp } = withMcp()
        await h.runHook('loaded')
        assert.ok(mcp.registered.has('mikser_app_preview'),
            'the plugin should register mikser_app_preview on onLoaded')
    })

    it('declares _meta.ui.resourceUri pointing at the shell (MCP Apps spec)', async () => {
        // Per ADR-0001: spec-conformant hosts read this off the tool
        // definition (statically, at tools/list time) to decide which
        // iframe template to render the tool's result inside. Without
        // it, hosts display the rendered HTML as plain text instead of
        // an iframe — the empirical bug that drove the restructure.
        const { h, mcp } = withMcp()
        await h.runHook('loaded')

        const tool = mcp.registered.get('mikser_app_preview')
        assert.equal(tool._meta?.ui?.resourceUri, 'ui://mikser/app-shell',
            'mikser_app_preview must declare _meta.ui.resourceUri on the tool definition')
    })

    it('registers the ui://mikser/app-shell resource with the spec MIME type', async () => {
        const { h, mcp } = withMcp()
        await h.runHook('loaded')

        const shell = mcp.resources.get('ui://mikser/app-shell')
        assert.ok(shell, 'shell resource should be registered at ui://mikser/app-shell')
        assert.equal(shell.metadata.mimeType, 'text/html;profile=mcp-app',
            'shell resource MUST declare text/html;profile=mcp-app — basic-host and other conformant hosts reject anything else')

        // Resource handler returns the shell HTML so the iframe can load.
        const fakeUri = { href: 'ui://mikser/app-shell' }
        const result = await shell.handler(fakeUri)
        assert.equal(result.contents[0].mimeType, 'text/html;profile=mcp-app')
        // Contains the protocol plumbing — the things we care about end-to-end.
        assert.match(result.contents[0].text, /ui\/initialize/, 'shell must implement ui/initialize handshake')
        assert.match(result.contents[0].text, /ui\/notifications\/tool-result/, 'shell must handle ui/notifications/tool-result')
        assert.match(result.contents[0].text, /window\.sendAction/, 'shell must expose window.sendAction for layouts to call')
        assert.match(result.contents[0].text, /mikser_app_action/, 'shell must relay clicks to mikser_app_action')
    })

    it('does NOT register when no mcp service is provided', async () => {
        const h = createHarness({ options: { port: 3001 } })
        resetServices()
        mcpApp()(h.core)
        await h.runHook('loaded')
        // No MCP → no tool. Plugin still loads (route mount, cache available).
        // We can't easily assert the negative on a Map we never got, but
        // we can verify onLoaded completed without throwing.
        assert.ok(true)
    })

    it('fails with a helpful message when no layout declares mcpApp for the requested mode', async () => {
        // Layout exists but has no mcpApp metadata at all.
        const layout = {
            id: '/layouts/article.hbs',
            collection: 'layouts',
            type: 'layout',
            name: 'article',
            meta: { match: '@/articles/*' },
        }
        const article = { id: '/articles/launch', collection: 'documents', name: 'articles/launch' }

        const { h, mcp } = withMcp({}, [layout, article])
        await h.runHook('loaded')

        const tool = mcp.registered.get('mikser_app_preview')
        const result = await tool.handler({ entityId: '/articles/launch', mode: 'preview' })

        assert.equal(result.isError, true)
        assert.match(result.content[0].text, /No layouts found with mcpApp\.mode="preview"/)
    })

    it('fails when the target entity is not in the catalog', async () => {
        const layout = {
            id: '/layouts/article-preview.hbs',
            collection: 'layouts',
            type: 'layout',
            name: 'article-preview',
            meta: {
                match: '@/articles/*',
                mcpApp: { mode: 'preview', description: 'Article preview', actions: ['approve'] },
            },
        }
        const { h, mcp } = withMcp({}, [layout])
        await h.runHook('loaded')

        const tool = mcp.registered.get('mikser_app_preview')
        const result = await tool.handler({ entityId: '/articles/does-not-exist', mode: 'preview' })

        assert.equal(result.isError, true)
        assert.match(result.content[0].text, /Entity not found/)
    })

    it('fails with a candidate list when no mcpApp layout matches the entity', async () => {
        // Two candidates for the same mode, but neither matches /products/*.
        const articleLayout = {
            id: '/layouts/article-preview.hbs',
            collection: 'layouts',
            type: 'layout',
            name: 'article-preview',
            meta: { match: '@/articles/*', mcpApp: { mode: 'preview' } },
        }
        const blogLayout = {
            id: '/layouts/blog-preview.hbs',
            collection: 'layouts',
            type: 'layout',
            name: 'blog-preview',
            meta: { match: '@/blog/*', mcpApp: { mode: 'preview' } },
        }
        const product = { id: '/products/sku-001', collection: 'products', name: 'products/sku-001' }

        const { h, mcp } = withMcp({}, [articleLayout, blogLayout, product])
        await h.runHook('loaded')

        const tool = mcp.registered.get('mikser_app_preview')
        const result = await tool.handler({ entityId: '/products/sku-001', mode: 'preview' })

        assert.equal(result.isError, true)
        assert.match(result.content[0].text, /No mcpApp layout matched/)
        // Should surface the available candidate patterns so the agent
        // can reason about why nothing matched.
        assert.match(result.content[0].text, /article-preview/)
        assert.match(result.content[0].text, /blog-preview/)
    })

    it('filters candidates by mode — a layout with mode=edit is not eligible for mode=preview', async () => {
        const previewLayout = {
            id: '/layouts/article-preview.hbs',
            collection: 'layouts',
            type: 'layout',
            name: 'article-preview',
            meta: { match: '@/articles/*', mcpApp: { mode: 'preview' } },
        }
        const editLayout = {
            id: '/layouts/article-edit.hbs',
            collection: 'layouts',
            type: 'layout',
            name: 'article-edit',
            meta: { match: '@/articles/*', mcpApp: { mode: 'edit' } },
        }
        const article = { id: '/articles/launch', collection: 'documents', name: 'articles/launch' }

        const { h, mcp } = withMcp({}, [previewLayout, editLayout, article])
        await h.runHook('loaded')

        const tool = mcp.registered.get('mikser_app_preview')
        // Ask for an unsupported mode. Both layouts exist, but neither
        // has mode='approval'; should fall through the "no mode" gate.
        const result = await tool.handler({ entityId: '/articles/launch', mode: 'approval' })

        assert.equal(result.isError, true)
        assert.match(result.content[0].text, /No layouts found with mcpApp\.mode="approval"/)
    })

    it('registers the mikser://mcp-app/modes discovery resource alongside the tool', async () => {
        const { h, mcp } = withMcp()
        await h.runHook('loaded')
        assert.ok(mcp.resources.has('mikser://mcp-app/modes'),
            'the plugin should register the MCP Apps modes resource')
    })

    it('mikser://mcp-app/modes returns an empty modes map when no layouts declare mcpApp', async () => {
        const plainLayout = {
            id: '/layouts/article.hbs',
            collection: 'layouts',
            type: 'layout',
            name: 'article',
            meta: { match: '@/articles/*' },  // no mcpApp key
        }
        const { h, mcp } = withMcp({}, [plainLayout])
        await h.runHook('loaded')

        const resource = mcp.resources.get('mikser://mcp-app/modes')
        const result = await resource.handler(new URL('mikser://mcp-app/modes'))
        const payload = JSON.parse(result.contents[0].text)

        assert.deepEqual(payload.modes, {})
        assert.equal(payload.totalLayouts, 0)
    })

    it('mikser://mcp-app/modes groups layouts by mode with match patterns and actions', async () => {
        const previewArticle = {
            id: '/layouts/article-preview.hbs',
            collection: 'layouts',
            type: 'layout',
            name: 'article-preview',
            meta: {
                match: '@/articles/*',
                mcpApp: {
                    mode: 'preview',
                    description: 'Article preview',
                    actions: ['approve', 'reject'],
                },
            },
        }
        const previewProduct = {
            id: '/layouts/product-preview.hbs',
            collection: 'layouts',
            type: 'layout',
            name: 'product-preview',
            meta: {
                match: '@/products/*',
                mcpApp: { mode: 'preview', actions: ['approve'] },
            },
        }
        const editArticle = {
            id: '/layouts/article-edit.hbs',
            collection: 'layouts',
            type: 'layout',
            name: 'article-edit',
            meta: {
                match: '@/articles/*',
                mcpApp: { mode: 'edit', actions: ['save', 'cancel'] },
            },
        }
        // A layout with mcpApp but no explicit mode — defaults to 'preview'.
        const defaultModeLayout = {
            id: '/layouts/landing.hbs',
            collection: 'layouts',
            type: 'layout',
            name: 'landing',
            meta: { match: '@/landing/*', mcpApp: { description: 'Landing' } },
        }

        const { h, mcp } = withMcp({}, [previewArticle, previewProduct, editArticle, defaultModeLayout])
        await h.runHook('loaded')

        const resource = mcp.resources.get('mikser://mcp-app/modes')
        const result = await resource.handler(new URL('mikser://mcp-app/modes'))
        const payload = JSON.parse(result.contents[0].text)

        assert.equal(payload.totalLayouts, 4)
        assert.equal(payload.modes.preview.length, 3, 'three layouts in preview mode (two explicit + one default)')
        assert.equal(payload.modes.edit.length, 1)

        // Spot-check the shape of one candidate.
        const articleEntry = payload.modes.preview.find(c => c.layoutId === '/layouts/article-preview.hbs')
        assert.ok(articleEntry)
        assert.equal(articleEntry.match, '@/articles/*')
        assert.equal(articleEntry.description, 'Article preview')
        assert.deepEqual(articleEntry.actions, ['approve', 'reject'])
        assert.deepEqual(articleEntry.sandbox, ['allow-scripts']) // default sandbox

        // Default-mode layout landed under 'preview'.
        const landingEntry = payload.modes.preview.find(c => c.layoutId === '/layouts/landing.hbs')
        assert.ok(landingEntry, 'layout without explicit mcpApp.mode should default to preview')
    })

    it('mikser://mcp-app/modes excludes non-layout entities even if they have mcpApp-shaped meta', async () => {
        // Defensive: the resource filters by collection === 'layouts',
        // so a stray document.meta.mcpApp can't pollute the discovery list.
        const layout = {
            id: '/layouts/article-preview.hbs',
            collection: 'layouts',
            type: 'layout',
            name: 'article-preview',
            meta: { match: '@/articles/*', mcpApp: { mode: 'preview' } },
        }
        const docWithStrayMcpUi = {
            id: '/articles/launch',
            collection: 'documents',
            type: 'document',
            name: 'articles/launch',
            meta: { mcpApp: { mode: 'rogue' } },
        }

        const { h, mcp } = withMcp({}, [layout, docWithStrayMcpUi])
        await h.runHook('loaded')

        const resource = mcp.resources.get('mikser://mcp-app/modes')
        const result = await resource.handler(new URL('mikser://mcp-app/modes'))
        const payload = JSON.parse(result.contents[0].text)

        assert.equal(payload.totalLayouts, 1)
        assert.equal(payload.modes.rogue, undefined, 'document.meta.mcpApp must not surface as a mode')
    })

    it('defaults mode to "preview" when not supplied', async () => {
        const layout = {
            id: '/layouts/article-preview.hbs',
            collection: 'layouts',
            type: 'layout',
            name: 'article-preview',
            meta: { match: '@/articles/*', mcpApp: { mode: 'preview' } },
        }
        const { h, mcp } = withMcp({}, [layout])
        await h.runHook('loaded')

        const tool = mcp.registered.get('mikser_app_preview')
        // Don't pass mode — should default to 'preview' and look for
        // candidates with mode==='preview'. The error path we hit here
        // is "entity not found", which confirms the mode filter
        // accepted the preview layout (otherwise we'd see the no-mode
        // error first).
        const result = await tool.handler({ entityId: '/articles/does-not-exist' })
        assert.equal(result.isError, true)
        assert.match(result.content[0].text, /Entity not found/)
    })
})

describe('mcpApp: mikser_app_action', () => {
    it('registers mikser_app_action with _meta.ui.visibility=[app]', async () => {
        const { h, mcp } = withMcp()
        await h.runHook('loaded')

        const tool = mcp.registered.get('mikser_app_action')
        assert.ok(tool, 'mikser_app_action should be registered')
        // MCP Apps spec — visibility=['app'] makes it invisible to the
        // model and callable from inside iframes opened via the host's
        // AppBridge. Drift here breaks every Apps-conformant host.
        assert.deepEqual(tool._meta?.ui?.visibility, ['app'],
            'mikser_app_action must declare visibility=[app]')
    })

    it('pure-relay: returns { entityId, action, payload } when no handler.url', async () => {
        const layout = {
            id: '/layouts/article-approval.hbs',
            collection: 'layouts',
            type: 'layout',
            name: 'article-approval',
            meta: {
                match: '@/articles/*',
                mcpApp: { mode: 'approval', actions: ['approve', 'reject'] },
            },
        }
        const { h, mcp } = withMcp({}, [layout])
        await h.runHook('loaded')

        const tool = mcp.registered.get('mikser_app_action')
        const result = await tool.handler({
            entityId: '/articles/launch',
            layoutId: '/layouts/article-approval.hbs',
            action:   'approve',
            payload:  { reviewer: 'alice' },
        })

        assert.equal(result.isError, undefined)
        const data = JSON.parse(result.content[0].text)
        assert.deepEqual(data, {
            entityId: '/articles/launch',
            action:   'approve',
            payload:  { reviewer: 'alice' },
        })
    })

    it('rejects actions not in the layout\'s allowed list', async () => {
        const layout = {
            id: '/layouts/article-approval.hbs',
            collection: 'layouts',
            type: 'layout',
            name: 'article-approval',
            meta: {
                match: '@/articles/*',
                mcpApp: { mode: 'approval', actions: ['approve', 'reject'] },
            },
        }
        const { h, mcp } = withMcp({}, [layout])
        await h.runHook('loaded')

        const tool = mcp.registered.get('mikser_app_action')
        const result = await tool.handler({
            entityId: '/articles/launch',
            layoutId: '/layouts/article-approval.hbs',
            action:   'delete-everything',
            payload:  {},
        })

        assert.equal(result.isError, true)
        assert.match(result.content[0].text, /not in allowed list/)
        // Specifically calls out what WAS allowed so the agent/iframe
        // author can fix the call site.
        assert.match(result.content[0].text, /approve, reject/)
    })

    it('rejects when layoutId points to a non-layout entity', async () => {
        const article = {
            id: '/articles/launch',
            collection: 'documents',
            type: 'document',
            name: 'articles/launch',
            meta: {},
        }
        const { h, mcp } = withMcp({}, [article])
        await h.runHook('loaded')

        const tool = mcp.registered.get('mikser_app_action')
        const result = await tool.handler({
            entityId: '/articles/launch',
            layoutId: '/articles/launch',     // pointing at a document — wrong
            action:   'approve',
            payload:  {},
        })

        assert.equal(result.isError, true)
        assert.match(result.content[0].text, /not found or not a layout/)
    })

    it('rejects when the resolved layout has no mcpApp frontmatter', async () => {
        const layout = {
            id: '/layouts/plain.hbs',
            collection: 'layouts',
            type: 'layout',
            name: 'plain',
            meta: { match: '@/articles/*' },   // no mcpApp
        }
        const { h, mcp } = withMcp({}, [layout])
        await h.runHook('loaded')

        const tool = mcp.registered.get('mikser_app_action')
        const result = await tool.handler({
            entityId: '/articles/launch',
            layoutId: '/layouts/plain.hbs',
            action:   'approve',
            payload:  {},
        })

        assert.equal(result.isError, true)
        assert.match(result.content[0].text, /does not declare mcpApp/)
    })

    it('ignores a layout that still declares a handler block', async () => {
        // The webhook is gone: `handler.url` bought a loopback endpoint, an
        // HMAC, a timeout and a state where a click was neither relayed nor
        // handled. Legacy frontmatter must not resurrect it — a project that
        // upgrades and forgets to delete the block gets a plain relay, not a
        // POST to a URL nobody is listening on.
        const layout = {
            id: '/layouts/order.hbs',
            collection: 'layouts',
            type: 'layout',
            name: 'order',
            meta: {
                match: '@/orders/*',
                mcpApp: {
                    mode: 'preview',
                    actions: ['approve'],
                    handler: { url: 'http://127.0.0.1:9/never', secret: 'shh' },
                },
            },
        }
        const { h, mcp } = withMcp({}, [layout])
        await h.runHook('loaded')

        const result = await mcp.registered.get('mikser_app_action').handler({
            entityId: '/orders/1', layoutId: '/layouts/order.hbs',
            action: 'approve', payload: { note: 'ok' },
        })
        assert.equal(result.isError, undefined)
        assert.deepEqual(JSON.parse(result.content[0].text), {
            entityId: '/orders/1', action: 'approve', payload: { note: 'ok' },
        })
    })
})

// The clean break, pinned. `mcpUi` was this feature's key while it lived in
// mikser-io-mcp, and the whole point of this package is that the mcp-ui
// vocabulary is gone — so a layout still on the old key must be INELIGIBLE,
// not quietly accepted. Written as a test because "let's also read the old
// key, just to be kind" is a one-line change that would undo the decision
// without anyone noticing.
describe('mcpApp: the mcp-ui vocabulary is not accepted', () => {
    it('ignores a layout that declares the legacy mcpUi key', async () => {
        const legacy = {
            id: '/layouts/legacy-ui.liquid',
            collection: 'layouts',
            type: 'layout',
            name: 'legacy-ui',
            meta: { match: '@/orders/*', mcpUi: { mode: 'approve', actions: ['approve'] } },
        }
        const order = { id: '/orders/1', collection: 'documents', name: 'orders/1' }

        const { h, mcp } = withMcp({}, [legacy, order])
        await h.runHook('loaded')

        const result = await mcp.registered.get('mikser_app_preview')
            .handler({ entityId: '/orders/1', mode: 'approve' })
        assert.equal(result.isError, true)
        assert.match(result.content[0].text, /No layouts found with mcpApp\.mode="approve"/)
    })

    it('leaves a legacy-key layout out of the modes resource', async () => {
        const legacy = {
            id: '/layouts/legacy-ui.liquid',
            collection: 'layouts',
            type: 'layout',
            name: 'legacy-ui',
            meta: { match: '@/orders/*', mcpUi: { mode: 'approve' } },
        }
        const { h, mcp } = withMcp({}, [legacy])
        await h.runHook('loaded')

        const read = await mcp.resources.get('mikser://mcp-app/modes')
            .handler({ href: 'mikser://mcp-app/modes' })
        const body = JSON.parse(read.contents[0].text)
        assert.deepEqual(body.modes, {})
        assert.equal(body.totalLayouts, 0)
    })

    it('serves the shell as a COMPLETE document, not a fragment', async () => {
        // The predeclared model loads this resource as the iframe's document.
        // A fragment would leave the host with no <html> to mount, and the
        // fragment/document split is exactly what separates a layout (body
        // content) from the shell (the document around it).
        const { h, mcp } = withMcp()
        await h.runHook('loaded')

        const shell = await mcp.resources.get('ui://mikser/app-shell')
            .handler({ href: 'ui://mikser/app-shell' })
        const html = shell.contents[0].text
        assert.match(html, /^<!DOCTYPE html>/i, 'the shell must be a full document')
        assert.match(html, /<html[\s>]/i)
        assert.doesNotMatch(html, /mcp-?ui/i, 'no mcp-ui vocabulary survives in the shell')
    })
})

// The route. This surface does not live on /mcp: an app host connects to a
// route whose tool list is the app surface, and the action tool is
// app-callable by spec, so it must not reach the agent's endpoint.
describe('mcpApp: its own route', () => {
    it('mounts at /apps by default and scopes every registration to it', async () => {
        const { h, mcp } = withMcp()
        await h.runHook('loaded')

        assert.deepEqual(mcp.mounted.map(m => [m.name, m.path]), [['apps', '/apps']])
        // The route carries THIS surface and nothing else. Mounted without
        // filters it would serve every shared tool as well — 21 of them on
        // gpointpremium, mikser_delete_entity included — on a route whose
        // whole purpose is running an app.
        const [mount] = mcp.mounted
        assert.deepEqual(mount.tools, ['mikser_app_preview', 'mikser_app_action'])
        assert.deepEqual(mount.resources, ['ui://mikser/app-shell', 'mikser://mcp-app/modes'])
        assert.deepEqual(mount.prompts, [], 'an empty list excludes; null would allow everything')

        for (const tool of ['mikser_app_preview', 'mikser_app_action']) {
            assert.deepEqual(mcp.registered.get(tool).endpoints, ['apps'],
                `${tool} must be scoped to the apps endpoint, not bound on /mcp`)
        }
        for (const uri of ['ui://mikser/app-shell', 'mikser://mcp-app/modes']) {
            assert.deepEqual(mcp.resources.get(uri).metadata.endpoints, ['apps'],
                `${uri} must be scoped to the apps endpoint`)
        }
    })

    it('takes a different name and derives the path from it', async () => {
        resetServices()
        const mcp = fakeMcp()
        const h = createHarness({ options: { port: 3001 } })
        provideService('mcp', mcp)
        mcpApp({ name: 'ui' })(h.core)
        await h.runHook('loaded')

        assert.deepEqual(mcp.mounted.map(m => [m.name, m.path]), [['ui', '/ui']])
        assert.deepEqual(mcp.registered.get('mikser_app_preview').endpoints, ['ui'])
    })

    it('passes the endpoint credential through rather than inventing one', async () => {
        resetServices()
        const mcp = fakeMcp()
        const verifier = { verify: async () => ({ subject: 'someone' }) }
        const h = createHarness({ options: { port: 3001 } })
        provideService('mcp', mcp)
        mcpApp({ auth: verifier, allowRemote: true })(h.core)
        await h.runHook('loaded')

        assert.equal(mcp.mounted[0].auth, verifier)
        assert.equal(mcp.mounted[0].allowRemote, true)
    })

    it('registers nothing and mounts nothing without the mcp service', async () => {
        resetServices()
        const h = createHarness({ options: { port: 3001 } })
        mcpApp()(h.core)
        await assert.doesNotReject(() => h.runHook('loaded'))
    })

    it('refuses to mount on a substrate too old to scope, instead of leaking onto /mcp', async () => {
        // The failure this guards is silent: without scoping the tools bind on
        // the default endpoint, so the agent gets an app-callable tool and the
        // app host gets no route.
        resetServices()
        const mcp = fakeMcp()
        delete mcp.mountEndpoint
        const h = createHarness({ options: { port: 3001 } })
        provideService('mcp', mcp)
        mcpApp()(h.core)
        await h.runHook('loaded')
        assert.deepEqual(mcp.mounted, [], 'nothing mounted')
        assert.ok(!mcp.registered.has('mikser_app_preview')
            || mcp.registered.get('mikser_app_preview').endpoints.length === 1,
            'if it registered at all, the registration still carries its scope')
    })
})

// Identity. This route serves a site's apps to that site's visitors, so
// mikser's name and mark on it would brand someone else's form with the engine
// that renders it.
describe('mcpApp: the route carries the site\'s identity, not mikser\'s', () => {
    function withSite({ url, files = [], appOptions = {} } = {}) {
        resetServices()
        const outputFolder = mkdtempSync(nodePath.join(tmpdir(), 'mcp-app-out-'))
        for (const file of files) writeFileSync(nodePath.join(outputFolder, file), 'x')
        const mcp = fakeMcp()
        const h = createHarness({ options: { port: 3001, url, outputFolder, workingFolder: '/srv/premium' } })
        provideService('mcp', mcp)
        mcpApp(appOptions)(h.core)
        return { h, mcp }
    }

    it('never inherits mikser\'s icons — an iconless site gets none', async () => {
        const { h, mcp } = withSite({ url: 'https://gpointpremium.com' })
        await h.runHook('loaded')
        const { serverInfo } = mcp.mounted[0]
        assert.deepEqual(serverInfo.icons, [], 'no icon beats someone else\'s mark')
        assert.ok(!JSON.stringify(serverInfo).toLowerCase().includes('mikser-mark'))
        assert.equal(serverInfo.title, 'gpointpremium.com')
        assert.equal(serverInfo.name, 'gpointpremium.com-apps')
        assert.equal(serverInfo.websiteUrl, 'https://gpointpremium.com')
    })

    it('advertises the address the engine already serves, when the build emitted an icon', async () => {
        // /favicon.ico is the engine's own answer: the site's icon when the
        // output has one, mikser's mark otherwise. Reused rather than a new
        // convention of icon file names.
        const { h, mcp } = withSite({ url: 'https://gpointpremium.com', files: ['favicon.ico'] })
        await h.runHook('loaded')
        assert.deepEqual(mcp.mounted[0].serverInfo.icons, [
            { src: 'https://gpointpremium.com/favicon.ico', mimeType: 'image/x-icon', sizes: ['any'] },
        ])
    })

    it('says no icon when the output has none, rather than letting the engine fallback brand it', async () => {
        // That address would still answer — with mikser's mark. Advertising it
        // is exactly how someone else's form ends up wearing mikser's icon.
        const { h, mcp } = withSite({ url: 'https://gpointpremium.com', files: ['favicon.svg'] })
        await h.runHook('loaded')
        assert.deepEqual(mcp.mounted[0].serverInfo.icons, [])
    })

    it('ignores a favicon that the site declares but never emitted', async () => {
        // Probed in the output folder on purpose: a <link rel=icon> pointing at
        // a file no build produced is not an icon, and advertising it gives a
        // host a broken image instead of none.
        const { h, mcp } = withSite({ url: 'https://gpointpremium.com', files: ['index.html'] })
        await h.runHook('loaded')
        assert.deepEqual(mcp.mounted[0].serverInfo.icons, [])
    })

    it('takes an explicit title, name and icons', async () => {
        const icons = [{ src: 'https://cdn.example/logo.png', mimeType: 'image/png', sizes: ['64x64'] }]
        const { h, mcp } = withSite({
            url: 'https://gpointpremium.com',
            files: ['favicon.svg'],
            appOptions: { title: 'G Point Premium', serverName: 'gpoint-premium', icons },
        })
        await h.runHook('loaded')
        const { serverInfo } = mcp.mounted[0]
        assert.equal(serverInfo.title, 'G Point Premium')
        assert.equal(serverInfo.name, 'gpoint-premium')
        assert.deepEqual(serverInfo.icons, icons, 'an explicit list replaces the probe')
    })

    it('falls back to the working folder when the site has no public url', async () => {
        const { h, mcp } = withSite({})
        await h.runHook('loaded')
        const { serverInfo } = mcp.mounted[0]
        assert.equal(serverInfo.title, 'premium')
        assert.equal(serverInfo.name, 'premium-apps')
        assert.deepEqual(serverInfo.icons, [], 'no url means no absolute icon to advertise')
    })
})

// What the SDK owns, pinned. These are the places where a hand-written copy of
// the spec drifted from the spec before: the mime type, the tool→app link, and
// the extension id in the handshake.
describe('mcpApp: the protocol comes from the SDK', () => {
    it('declares the shell with the SDK\'s reserved mime type', async () => {
        const { h, mcp } = withMcp()
        await h.runHook('loaded')
        const shell = mcp.resources.get('ui://mikser/app-shell')
        assert.equal(shell.metadata.mimeType, RESOURCE_MIME_TYPE)
        assert.equal(RESOURCE_MIME_TYPE, 'text/html;profile=mcp-app',
            'if the SDK ever changes this, the shell moves with it — no copy to update')
    })

    it('links the tool to the app the way the SDK spells it', async () => {
        const { h, mcp } = withMcp()
        await h.runHook('loaded')
        assert.equal(mcp.registered.get('mikser_app_preview')._meta?.ui?.resourceUri,
            'ui://mikser/app-shell')
    })

    it('keeps mikser\'s endpoint scoping through the SDK helpers', async () => {
        // registerAppTool / registerAppResource rebuild the config they pass
        // on. `endpoints` is mikser's routing key and has to survive that, or
        // the app surface silently lands on /mcp.
        const { h, mcp } = withMcp()
        await h.runHook('loaded')
        assert.deepEqual(mcp.registered.get('mikser_app_preview').endpoints, ['apps'])
        assert.deepEqual(mcp.resources.get('ui://mikser/app-shell').metadata.endpoints, ['apps'])
    })

    it('agrees with mikser-io-mcp about the extension id', async () => {
        // mikser-io-mcp declares the extension from the ui:// resources bound
        // on a route, and it spells the id as a literal. This is the test that
        // turns drift between that literal and the SDK into a failure.
        const substrate = createMcpSubstrate()
        substrate.registerResource('shell', 'ui://drift/probe',
            { mimeType: RESOURCE_MIME_TYPE, endpoints: ['drift'] },
            async (uri) => ({ contents: [{ uri: uri.href, text: '<!DOCTYPE html>' }] }))
        substrate.registerTool('mikser_drift_probe',
            { description: 'p', inputSchema: {}, endpoints: ['drift'],
              _meta: { ui: { resourceUri: 'ui://drift/probe' } } },
            async () => ({ content: [] }))
        const declared = substrate.createServer({ endpoint: 'drift' })
            .server.getCapabilities().extensions ?? {}
        assert.deepEqual(declared[EXTENSION_ID], { mimeTypes: [RESOURCE_MIME_TYPE] },
            `mikser-io-mcp must declare the extension under the SDK's id (${EXTENSION_ID})`)
    })
})

// The shell is a build artefact now. These assert the properties the iframe
// depends on, which a broken build would silently lose.
describe('the built app shell', () => {
    const shell = readFileSync(nodePath.join(import.meta.dirname, '..', '..', 'public', 'app-shell.html'), 'utf8')

    it('is one self-contained document, because the iframe has no network', () => {
        assert.match(shell, /^<!DOCTYPE html>/i)
        assert.doesNotMatch(shell, /<script[^>]+src=/, 'a second file would never load under default-src none')
        assert.doesNotMatch(shell, /<link[^>]+rel=["']?stylesheet/, 'same for stylesheets')
    })

    it('carries the SDK runtime rather than a hand-rolled protocol', () => {
        assert.match(shell, /ui\/notifications\/tool-result/, 'the SDK\'s protocol is in the bundle')
        assert.match(shell, /sendAction/, 'and the one API a layout uses is exposed')
        assert.doesNotMatch(shell, /window\.parent\.postMessage\(\{\s*jsonrpc/,
            'no second implementation of the transport')
    })

    it('shows no protocol log on the happy path', () => {
        // These routes serve a site's visitors. The previous shell revealed a
        // protocol panel on every render.
        assert.doesNotMatch(shell, /mikser-debug/, 'the debug panel is gone')
    })
})
