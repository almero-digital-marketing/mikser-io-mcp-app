// The app shell: the document a host loads for every mikser app, and the only
// place the MCP Apps protocol appears.
//
// The protocol itself is NOT implemented here — it comes from
// @modelcontextprotocol/ext-apps, the official SDK, bundled into a single file
// by vite-plugin-singlefile as the SDK's own add-app-to-server skill
// prescribes. What is here is the part that is actually mikser's: take the
// rendered layout out of structuredContent, put it in the page, and give the
// layout `sendAction` so a click reaches the server.
//
// A layout is therefore a BODY FRAGMENT with no protocol code of its own, and
// the protocol can move with the SDK without touching a single layout.
import { App, applyDocumentTheme, applyHostStyleVariables, applyHostFonts } from '@modelcontextprotocol/ext-apps'

const ACTION_TOOL = 'mikser_app_action'

const root = document.getElementById('mikser-app-root')
const fault = document.getElementById('mikser-app-fault')

// What the layout's sendAction needs to name itself to the server. Filled from
// each tool result, so a layout never handles either id.
let context = { entityId: null, layoutId: null }

// Visible ONLY when something breaks. The previous shell showed a protocol log
// on every render, which is noise on a private preview and a leak on a public
// app — these routes are for a site's visitors.
function showFault(message) {
    fault.textContent = message
    fault.classList.add('shown')
}

function injectContent(structuredContent) {
    if (!structuredContent) {
        showFault('The server sent no app content for this call.')
        return
    }
    context = {
        entityId: structuredContent.entityId ?? null,
        layoutId: structuredContent.layoutId ?? null,
    }
    fault.classList.remove('shown')
    root.innerHTML = structuredContent.html ?? ''
    // innerHTML does not execute embedded <script> tags — re-create them so a
    // layout's own behaviour runs.
    for (const old of Array.from(root.querySelectorAll('script'))) {
        const replacement = document.createElement('script')
        for (const attribute of Array.from(old.attributes)) {
            replacement.setAttribute(attribute.name, attribute.value)
        }
        replacement.textContent = old.textContent
        old.parentNode.replaceChild(replacement, old)
    }
}

// Host look and safe areas, applied through the SDK's own helpers rather than
// a hand-rolled reading of the context.
function applyHostContext(hostContext) {
    if (!hostContext) return
    if (hostContext.theme) applyDocumentTheme(hostContext.theme)
    if (hostContext.styles) {
        applyHostStyleVariables(hostContext.styles)
        if (hostContext.styles.fontCss) applyHostFonts(hostContext.styles.fontCss)
    }
    const insets = hostContext.safeAreaInsets ?? hostContext.styles?.safeAreaInsets
    if (insets) {
        const style = document.documentElement.style
        for (const [side, value] of Object.entries(insets)) {
            if (typeof value === 'number') style.setProperty(`--mikser-safe-${side}`, `${value}px`)
        }
    }
}

const app = new App(
    { name: 'mikser-app-shell', version: __SHELL_VERSION__ },
    // No capabilities of its own: this shell serves content and relays one
    // action. Anything it claimed here it would have to honour.
    {},
)

// Handlers BEFORE connect, per the SDK's guidance — a result that arrives
// during the handshake is otherwise dropped, and the app renders empty with
// nothing saying why.
app.ontoolresult = (result) => injectContent(result?.structuredContent)
app.onhostcontextchanged = (params) => applyHostContext(params?.hostContext ?? params)

// The whole protocol surface a layout gets. Returns the server's own result,
// which for mikser is either the pure relay or the handler's JSON.
window.sendAction = async (action, payload = {}) => {
    try {
        return await app.callServerTool({
            name: ACTION_TOOL,
            arguments: { entityId: context.entityId, layoutId: context.layoutId, action, payload },
        })
    } catch (error) {
        // A click never disappears quietly: the layout gets the rejection to
        // show in its own words, the host gets it in its log, and the fault
        // line makes it visible even for a layout that ignores the promise.
        const message = error?.message ?? String(error)
        showFault(`Action "${action}" failed: ${message}`)
        app.sendLog?.({ level: 'error', data: `sendAction ${action} failed: ${message}` })
        throw error
    }
}

try {
    await app.connect()
    applyHostContext(app.getHostContext?.())
    // Let the host size the iframe to the layout instead of guessing.
    app.setupSizeChangedNotifications?.()
} catch (error) {
    showFault('This host did not complete the MCP Apps handshake, so actions cannot reach the server.')
    void error
}
