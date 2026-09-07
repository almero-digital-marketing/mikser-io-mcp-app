# Interactive apps in mikser

MCP Apps (SEP-1865) for mikser layouts: how frontmatter turns a layout into an
app, what the shell does for it, and how a click gets back to the server.

Moved here from mikser-io-mcp's `documentation/mcp.md` when the surface got its
own package and its own route; the vocabulary is renamed throughout (`mcpApp`,
`mikser_app_preview`, `mikser_app_action`, `ui://mikser/app-shell`,
`mikser://mcp-app/modes`) and no aliases for the old names exist.

## Layout frontmatter and MCP Apps

mikser layouts can carry YAML frontmatter just like documents do. The layouts plugin strips the frontmatter at read time and lifts the attributes into `entity.meta`, where any consumer can read them without coordinating with anyone else. `mikser_app_preview` consumes one specific namespace: `meta.mcpApp`.

mikser ships a **single static shell resource** at `ui://mikser/app-shell` that implements the MCP Apps protocol (the spec-required `ui/initialize` handshake, the `ui/notifications/tool-result` listener that injects content, the `tools/call` relay for clicks). `mikser_app_preview` declares `_meta.ui.resourceUri: 'ui://mikser/app-shell'`, so spec-conformant hosts fetch the shell once via `resources/read`, load it in a sandboxed iframe, then deliver the per-call rendered HTML to the iframe via `ui/notifications/tool-result`.

**That means your layouts are content-only.** No `<!DOCTYPE>`, no `<html>` / `<head>` / `<body>`, no MCP protocol script. The shell handles everything. Your layout produces a fragment that gets injected into the shell's `#mikser-app-root` div. Click handlers call `sendAction(action, payload)` — exposed as a global by the shell — and the shell relays them to `mikser_app_action` over `tools/call`.

```hbs
---
match: "@/articles/*"
mcpApp:
  mode: preview                # or "edit", "approval", or your own
  description: "Article preview with approve/reject controls"
  actions:                     # action names mikser_app_action will accept
    - approve
    - reject
  sandbox:                     # iframe sandbox flags the host should apply
    - allow-scripts
  # handler:                   # optional — external webhook for the action
  #   url: https://review.example.com/mikser/action
  #   secret: env:REVIEW_SIGNING_SECRET
---
<article>{{document.meta.title}}</article>
<button data-action="approve">Approve</button>
<button data-action="reject">Reject</button>
<script>
  // sendAction(action, payload?) is provided by the shell. Call it from
  // any click handler. It returns a Promise that resolves with
  // mikser_app_action's tool result (pure relay or handler-forwarded).
  document.querySelectorAll('[data-action]').forEach(b =>
    b.addEventListener('click', () => sendAction(b.dataset.action))
  )
</script>
```

That's an entire mcpApp layout. Compare with the v8.0.x version of this same example, which had ~50 lines of protocol boilerplate per layout — `ui/initialize` handshake, RPC helper, pending Map, postMessage shape. All of it lives in the shell now, so all layouts get the spec-correct protocol for free, and layout authoring is plain HTML + DOM.

**Discovery.** Before calling `mikser_app_preview`, the agent should read `mikser://mcp-app/modes` to see which modes are actually available in this project and which entity patterns each one covers. The resource is derived live from layout frontmatter, so adding a new `mcpApp`-decorated layout makes the new mode immediately discoverable — no tool re-registration, no restart.

**Dispatch.** When the agent calls `mikser_app_preview({ entityId: '/articles/launch', mode: 'preview' })`:

1. The plugin walks the catalog for layouts where `meta.mcpApp.mode === 'preview'`.
2. Among those, it picks the one whose `meta.match` pattern matches the entity (using mikser's `matchEntity` — same matcher used by the layouts plugin).
3. It runs the layout through the renderer chain (`render-hbs`, `render-eta`, `render-liquid`, etc.) producing a **content fragment** — not a full document — for the entity.
4. It returns a tool result with: `content[0].text` = the rendered fragment (fallback for non-UI hosts), `structuredContent` = `{ html, entityId, layoutId, mode, mcpApp: {...} }` (what the iframe receives), and `_meta.ui.resourceUri` = `ui://mikser/app-shell` (on the tool definition, telling the host *which iframe* to render this into).

Spec-conformant hosts read the resourceUri off the tool, fetch the shell, load it in a sandboxed iframe, and post `structuredContent` to the iframe via `ui/notifications/tool-result`. The shell injects `structuredContent.html` into its root div. The user clicks; the shell calls `tools/call mikser_app_action`; the host bridges that to mikser as a real MCP call. The agent sees two tool invocations in the conversation: the render, then the action. This is the [MCP Apps spec](https://github.com/modelcontextprotocol/ext-apps) pull model — no suspended promises, no HTTP callbacks.

**Actions come back to the agent.** `mikser_app_action` validates the action against the layout's declared `mcpApp.actions` list and returns `{ entityId, action, payload }` as the tool result. The HTTP `handler.url` this section used to document is gone — see the README on why, and the ADR for what replaces it.

A few constraints worth knowing when authoring `mcpApp` layouts:

- **Layouts are body fragments, not full documents.** The shell wraps `<!DOCTYPE>` / `<html>` / `<head>` / `<body>` around your content. Adding them yourself is harmless but redundant — the host strips them during innerHTML injection. Inline `<style>` is fine (browsers honor it inside a div). Inline `<script>` is fine (the shell re-executes innerHTML-injected scripts so they take effect).
- **`sendAction(action, payload?)` is the only protocol API you need.** It's exposed on `window` by the shell. Returns a Promise resolving with `mikser_app_action`'s tool result. The shell handles `ui/initialize`, target origins, timeouts, and the pending-id dance. Layouts that try to reimplement the protocol won't break, but they also don't gain anything.
- **The iframe is cross-origin from the host and the default CSP blocks all network.** Per MCP Apps spec, "The Host and the Sandbox MUST have different origins" and the default CSP is `default-src 'none'; connect-src 'none'`. So `fetch` to *any* URL from inside the iframe is blocked — including back to mikser. The shell's only outbound channel is `window.parent.postMessage`.
- **Same layout system, different output path.** The MCP Apps layout doesn't have to be the same file as your production layout; declare a focused, sandbox-safe variant under a distinct name. mikser's auto-match won't pick it up for normal rendering as long as the filename doesn't collide.
- **Frontmatter is stripped at read time.** The layouts plugin parses YAML inside `readLayoutContent`, populates `entity.meta`, and stores a clean body. The renderer never sees the YAML.
- **ECT is the exception.** `mikser-io-render-ect` still file-loads layouts through ECT's own resolver, so YAML frontmatter on `.ect` layouts renders as literal text. Pick `hbs` / `eta` / `liquid` for layouts that need `mcpApp` frontmatter.

### Worked examples

MCP Apps is a novel concept and the conventions get easier to internalise once you see them on real layouts. Seven examples below — varied template engines (`hbs`, `eta`, `liquid`), varied interaction patterns (pure render, single button, multi-action approval, form submission, multi-select picker, status switcher, multi-step wizard), varied domains (article, product, SEO, tags, support ticket, onboarding). Copy-and-modify is the intended workflow.

Each agent call looks like `mikser_app_preview({ entityId: '...', mode: '<mode>' })`. The host renders the returned HTML in a sandboxed iframe. The iframe then speaks JSON-RPC over `postMessage` to the host (per the [MCP Apps spec](https://github.com/modelcontextprotocol/ext-apps)) — each click becomes a `tools/call` against `mikser_app_action`, which the host bridges to mikser over the normal MCP transport. Examples 2–7 use the same `sendAction(action, payload)` helper shown in the canonical sample above; the helper handles the `ui/initialize` handshake and the per-click RPC.

#### 1. Pure preview — no JS, no action

The minimum-viable case. The agent shows the user what an article looks like rendered; the user reads it; no interaction is needed. Use this when you just want a visual confirmation step.

```hbs
---
match: "@/articles/*"
mcpApp:
  mode: preview
  description: "Read-only article preview. Use to visually confirm a proposed edit before committing."
  actions: []
  sandbox: []
---
<style>
  article h1 { margin-bottom: 0.25em; }
  article .meta { color: #6b7280; font-size: 0.875em; margin-bottom: 1.5em; }
</style>
<article>
  <h1>{{document.meta.title}}</h1>
  <div class="meta">{{date document.meta.date 'MMMM D, YYYY'}}{{#if document.meta.author}} · by {{document.meta.author}}{{/if}}</div>
  <div>{{markdown document.content}}</div>
</article>
```

The empty `actions: []` and `sandbox: []` signal "this is read-only — no script execution needed." The agent invokes it and shows the result; the user reads it; the conversation continues. No back-channel.

#### 2. Single-action button — publish / unpublish

One button. One action name. Useful for binary state changes: publish a draft, archive a stale post, flag an issue.

```hbs
---
match: "@/products/*"
mcpApp:
  mode: publish-switch
  description: "Product publish switcher. Shows the current state and one button to flip it. Result includes the desired new state."
  actions: [toggle-publish]
  sandbox: [allow-scripts]
---
<style>
  body { font: 16px system-ui; padding: 2em; }
  #toggle { padding: 0.6em 1.4em; font-size: 1em; border: 0; border-radius: 4px; background: #2563eb; color: white; cursor: pointer; }
</style>
<h2>{{document.meta.title}}</h2>
<p>SKU: <code>{{document.meta.sku}}</code></p>
<p>Current status:
  {{#if document.meta.published}}
    <span style="color: #10b981;">● Published</span>
  {{else}}
    <span style="color: #6b7280;">● Draft</span>
  {{/if}}
</p>
<button id="toggle">
  {{#if document.meta.published}}Unpublish{{else}}Publish now{{/if}}
</button>
<script>
  document.getElementById('toggle').addEventListener('click', () =>
    sendAction('toggle-publish', { published: {{#if document.meta.published}}false{{else}}true{{/if}} })
  )
</script>
```

The payload includes the **desired new state**, computed by the template — so the agent doesn't have to flip the boolean itself. This is the cheapest pattern: one button, one structured result.

#### 3. Multi-action approval — approve / reject / request-changes

Three buttons, three actions. The agent's tool call resolves with whichever action the user clicked. Useful for moderation flows where the agent proposed an edit and wants explicit human consent.

```hbs
---
match: "@/blog/*"
mcpApp:
  mode: approval
  description: "Editorial approval for a blog post. Returns one of approve / reject / request-changes. For request-changes, payload includes a free-text note from the reviewer."
  actions: [approve, reject, request-changes]
  sandbox: [allow-scripts]
---
<style>
  body { font: 16px system-ui; max-width: 720px; margin: 2em auto; padding: 0 1em; }
  .actions { display: flex; gap: 0.5em; align-items: center; }
  .actions button { padding: 0.5em 1em; border: 0; border-radius: 4px; color: white; cursor: pointer; }
  .approve  { background: #10b981; }
  .reject   { background: #ef4444; }
  .changes  { background: #f59e0b; }
  textarea  { width: 100%; margin-top: 0.5em; padding: 0.5em; font: inherit; }
</style>
<article>
  <h1>{{document.meta.title}}</h1>
  <div style="color: #6b7280; margin-bottom: 1em;">{{date document.meta.date 'MMM D, YYYY'}}</div>
  <div>{{markdown document.content}}</div>
</article>

<hr style="margin: 2em 0; border: 0; border-top: 1px solid #e5e7eb;">

<div class="actions">
  <button class="approve" data-action="approve">Approve</button>
  <button class="reject"  data-action="reject">Reject</button>
  <button class="changes" data-action="request-changes">Request changes…</button>
</div>

<details style="margin-top: 1em;">
  <summary style="cursor: pointer; color: #6b7280;">Note for the author (only sent with "Request changes")</summary>
  <textarea id="note" rows="3"></textarea>
</details>

<script>
  document.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', () => {
      const action  = btn.dataset.action
      const payload = action === 'request-changes'
        ? { note: document.getElementById('note').value }
        : {}
      sendAction(action, payload)
    })
  })
</script>
```

Notice the structured payload only attaches when relevant. The agent's next step depends on the action: approve → publish; reject → log + notify; request-changes → re-edit with the note in context.

#### 4. Form submission — SEO fields (Liquid)

Show several fields with current values; collect edits; send a patch object back. Useful when the agent wants the user to fine-tune specific metadata without re-running an LLM pass.

```liquid
---
match: "@/articles/*"
mcpApp:
  mode: edit-seo
  description: "Edit SEO fields (title, description, og:image alt) inline. Result payload is a patch object with only the changed fields."
  actions: [save, cancel]
  sandbox: [allow-scripts]
---
<style>
  body { font: 16px system-ui; max-width: 600px; margin: 2em auto; padding: 0 1em; }
  form { display: grid; gap: 1em; }
  label > div { font-weight: 500; }
  input, textarea { width: 100%; padding: 0.5em; font: inherit; }
  .actions { display: flex; gap: 0.5em; margin-top: 0.5em; }
  .actions button { padding: 0.5em 1em; border: 0; border-radius: 4px; cursor: pointer; }
  .save   { background: #2563eb; color: white; }
  .cancel { background: #e5e7eb; }
</style>
<h2>SEO · {{ document.meta.title }}</h2>
<form id="seo">
  <label>
    <div>Title (max 60 chars)</div>
    <input name="seoTitle" value="{{ document.meta.seo.title }}" maxlength="60">
  </label>
  <label>
    <div>Description (max 160 chars)</div>
    <textarea name="seoDescription" rows="3" maxlength="160">{{ document.meta.seo.description }}</textarea>
  </label>
  <label>
    <div>OG image alt</div>
    <input name="ogImageAlt" value="{{ document.meta.seo.ogImageAlt }}">
  </label>
  <div class="actions">
    <button type="button" class="save"   data-action="save">Save</button>
    <button type="button" class="cancel" data-action="cancel">Cancel</button>
  </div>
</form>

<script>
  const initial = {
    seoTitle:       {{ document.meta.seo.title | json }},
    seoDescription: {{ document.meta.seo.description | json }},
    ogImageAlt:     {{ document.meta.seo.ogImageAlt | json }},
  }
  document.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.action
      const payload = {}
      if (action === 'save') {
        const fd = new FormData(document.getElementById('seo'))
        for (const [k, v] of fd.entries()) {
          if (v !== initial[k]) payload[k] = v   // diff: only send changed fields
        }
      }
      sendAction(action, payload)
    })
  })
</script>
```

Note the diff-on-submit: the layout sends only the fields the user actually changed. The agent's next step is one `mikser_edit_entity` call per changed field — `{ id: entityId, find: 'description: old text', replace: 'description: new text' }` — so the fields the user did not touch are not rewritten at all.

#### 5. Multi-select picker — tags (Eta)

Show available choices, let the user multi-select, send the final selection back. Eta syntax here for variety; same idea works in any engine.

```eta
---
match: "@/blog/*"
mcpApp:
  mode: tag-picker
  description: "Multi-select tag picker. Payload is the final array of tag slugs (not a diff)."
  actions: [save, cancel]
  sandbox: [allow-scripts]
---
<style>
  body { font: 16px system-ui; padding: 2em; max-width: 500px; }
  #tags { display: flex; flex-wrap: wrap; gap: 0.4em; margin: 1em 0; }
  #tags button { padding: 0.4em 0.8em; border-radius: 999px; border: 1px solid #d1d5db; background: white; color: #1f2937; cursor: pointer; }
  #tags button.selected { background: #2563eb; color: white; }
  .actions { display: flex; gap: 0.5em; }
  .actions button { padding: 0.5em 1em; border: 0; border-radius: 4px; cursor: pointer; }
  .save   { background: #10b981; color: white; }
  .cancel { background: #e5e7eb; }
</style>
<h3>Tags for: <%= it.document.meta.title %></h3>
<div id="tags">
  <% for (const tag of it.runtime.allTags || []) { %>
    <% const selected = (it.document.meta.tags || []).includes(tag) %>
    <button type="button" data-tag="<%= tag %>" class="<%= selected ? 'selected' : '' %>"><%= tag %></button>
  <% } %>
</div>
<div class="actions">
  <button class="save"   data-action="save">Save</button>
  <button class="cancel" data-action="cancel">Cancel</button>
</div>

<script>
  document.querySelectorAll('[data-tag]').forEach(btn => {
    btn.addEventListener('click', () => btn.classList.toggle('selected'))
  })
  document.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.action
      const tags = Array.from(document.querySelectorAll('[data-tag].selected')).map(b => b.dataset.tag)
      sendAction(action, { tags })
    })
  })
</script>
```

`it.runtime.allTags` is exposed from a sidecar `tag-picker.eta.js` that populates the candidate list before render. The selection is sent as a flat array — the agent decides whether to compute a diff or just overwrite.

#### 6. Status switcher — support ticket triage

A row of mutually exclusive status options with the current one highlighted. One click → one action. Returns the chosen status as the payload.

```hbs
---
match: "@/support/tickets/*"
mcpApp:
  mode: triage
  description: "Set a support ticket's status. Returns one action `set-status` with the chosen value in payload.status."
  actions: [set-status]
  sandbox: [allow-scripts]
---
<style>
  body { font: 16px system-ui; padding: 2em; max-width: 600px; }
  .statuses { display: flex; gap: 0.5em; margin-top: 1.5em; }
  .statuses button { padding: 0.5em 1em; border: 0; border-radius: 4px; cursor: pointer; background: #e5e7eb; color: #1f2937; }
  .statuses button.current { background: #2563eb; color: white; }
  blockquote { border-left: 3px solid #e5e7eb; padding-left: 1em; margin: 1em 0; color: #4b5563; }
</style>
<h2>Ticket #{{document.meta.ticketId}}</h2>
<p style="color: #6b7280;">{{document.meta.subject}}</p>
<blockquote>{{document.meta.firstMessage}}</blockquote>

<div class="statuses">
  {{#each (array "open" "in-progress" "waiting-on-customer" "resolved" "won't-fix")}}
    <button data-status="{{this}}" class="{{#eq this ../document.meta.status}}current{{/eq}}">{{this}}</button>
  {{/each}}
</div>

<script>
  document.querySelectorAll('[data-status]').forEach(btn => {
    btn.addEventListener('click', () =>
      sendAction('set-status', { status: btn.dataset.status })
    )
  })
</script>
```

Single action with a parameterised payload — the user picks the value, the agent's next step is uniform regardless of which status was chosen.

#### 7. Multi-step wizard — onboarding flow

The iframe holds its own state across multiple steps; only the final submission calls `sendAction`. Good when the interaction is genuinely multi-step (multiple form pages, confirm-then-go) and bouncing through the agent between steps would be expensive.

```hbs
---
match: "@/onboarding/*"
mcpApp:
  mode: setup
  description: "Three-step onboarding wizard. The iframe handles steps internally; the agent only sees the final `complete` action with the merged answers, or `cancel` if abandoned."
  actions: [complete, cancel]
  sandbox: [allow-scripts]
---
<style>
  body { font: 16px system-ui; padding: 2em; max-width: 520px; }
  #progress { display: flex; gap: 0.25em; margin-bottom: 2em; }
  #progress > div { flex: 1; height: 4px; background: #e5e7eb; }
  input, select { width: 100%; padding: 0.5em; font: inherit; }
  .nav { display: flex; gap: 0.5em; margin-top: 2em; }
  .nav button { padding: 0.5em 1em; border: 0; border-radius: 4px; cursor: pointer; }
  #back   { background: #e5e7eb; }
  #next   { background: #2563eb; color: white; }
  #cancel { margin-left: auto; background: transparent; color: #6b7280; }
</style>

<div id="progress">
  <div data-step="1"></div>
  <div data-step="2"></div>
  <div data-step="3"></div>
</div>

<div data-step="1" class="step">
  <h2>What's your team name?</h2>
  <input name="teamName">
</div>
<div data-step="2" class="step" hidden>
  <h2>How many people?</h2>
  <input name="teamSize" type="number" min="1" max="10000">
</div>
<div data-step="3" class="step" hidden>
  <h2>Primary content type?</h2>
  <select name="contentType">
    <option>blog</option>
    <option>documentation</option>
    <option>marketing-site</option>
    <option>knowledge-base</option>
  </select>
</div>

<div class="nav">
  <button id="back" hidden>Back</button>
  <button id="next">Next</button>
  <button id="cancel">Cancel</button>
</div>

<script>
  const state = { step: 1, answers: {} }
  const totalSteps = 3
  function render() {
    document.querySelectorAll('[data-step].step').forEach(el => {
      el.hidden = Number(el.dataset.step) !== state.step
    })
    document.querySelectorAll('#progress [data-step]').forEach(el => {
      el.style.background = Number(el.dataset.step) <= state.step ? '#2563eb' : '#e5e7eb'
    })
    document.getElementById('back').hidden = state.step === 1
    document.getElementById('next').textContent = state.step === totalSteps ? 'Done' : 'Next'
  }
  function captureCurrent() {
    const input = document.querySelector(`[data-step="${state.step}"].step input, [data-step="${state.step}"].step select`)
    if (input) state.answers[input.name] = input.value
  }
  document.getElementById('next').addEventListener('click', () => {
    captureCurrent()
    if (state.step < totalSteps) { state.step++; render() }
    else { sendAction('complete', state.answers) }
  })
  document.getElementById('back').addEventListener('click', () => {
    captureCurrent(); state.step--; render()
  })
  document.getElementById('cancel').addEventListener('click', () => sendAction('cancel'))
  render()
</script>
```

State lives inside the iframe; the agent only sees the final merged answers (or `cancel`). One `mikser_app_action` call covers the whole wizard. This pattern is worth it when the back-and-forth would otherwise burn 3–4 agent turns.

### Design principles

The seven examples above lean on the same conventions. Worth naming them so they're easy to extend.

- **`sendAction(action, payload?)` is the contract** — exposed on `window` by the shell at `ui://mikser/app-shell`. Layouts call it; the shell relays `tools/call` against `mikser_app_action` to the host; the host bridges it to mikser. Returns a Promise resolving with `mikser_app_action`'s tool result. `action` MUST be a name declared in your layout's `mcpApp.actions` list — mikser rejects anything else. You don't need to thread `entityId` / `layoutId` yourself; the shell tracks both from `ui/notifications/tool-result`.
- **Layouts are body fragments, not full documents.** No `<!DOCTYPE>`, no `<html>` / `<head>` / `<body>` — the shell wraps your content. Inline `<style>` and `<script>` are fine and survive `innerHTML` injection (the shell re-executes scripts).
- **Embed entity data with `{{{json document.id}}}` (or the equivalent in your engine).** Triple-stash in Handlebars / `| json` in Liquid / `<%= JSON.stringify(it.x) %>` in Eta. Prevents injection if a field contains quotes — never interpolate raw string fields into a `'string-literal'` in script tags.
- **Pick the smallest sandbox that works.** Pure render: `sandbox: []` (no scripts at all). Click-only interaction: `sandbox: [allow-scripts]`. `postMessage` works at `allow-scripts` because it's not a network operation in the CSP sense. Don't ship `allow-same-origin` casually — it lifts most of the cross-origin protection the host's double-iframe setup gives you.
- **Send only what changed.** Multi-field forms (#4) should diff against the initial values and post only the deltas. Single-state toggles (#2, #6) send the target state, not the current state. Wizards (#7) send the merged final answers. Smaller payloads are cheaper for the agent to reason about.
- **Style inline, ship self-contained.** No external CSS, no web fonts, no analytics — the default MCP Apps CSP is `default-src 'none'; connect-src 'none'`. The shell's only outbound channel is `postMessage` to the host. System fonts (`font-family: system-ui`) and inline `<style>` are fine; everything else has to be embedded.
- **Use the layout body to compute what the agent shouldn't.** Example #2's payload pre-computes the *new* publish state. Example #4 pre-computes the diff. Pushing logic to render-time means the agent receives ready-to-act-on data rather than raw inputs it has to interpret.
- **Don't smuggle long content through the payload.** If the user types a 2000-word note, send back a reference id and call `mikser_read_entity` later — not as a single huge `payload.note` string. Tool results live in the agent's context window.
- **For anything beyond relaying, the handler belongs beside the layout.** An action that should reach a Slack notification, a JIRA transition or a queue is application semantics, and mikser's answer is a handler in the project rather than a webhook mikser calls. The `mcpApp.handler.url` this document used to prescribe is gone: it was a whole HTTP protocol — an endpoint to mount, an HMAC to verify, a timeout, and a click that could end up neither relayed nor handled — to reach code that already lives in the project.

These conventions aren't enforced by the engine — they're just what makes layouts compose with agents cleanly. The contract is the MCP Apps spec; mikser's role is to ship the shell (`ui://mikser/app-shell`), render the layout against the entity, and accept the resulting `tools/call`. Application semantics live in the agent that receives the relay, or in the project's own handler — never in mikser.

