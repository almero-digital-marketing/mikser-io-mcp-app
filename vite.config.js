// Builds the app shell into ONE self-contained HTML file.
//
// `vite-plugin-singlefile` is what the SDK's add-app-to-server skill
// prescribes, and the reason is the iframe: an app resource is delivered as a
// single document with no network of its own (the spec's CSP is
// `default-src 'none'`), so a build that emits separate asset files produces a
// page whose scripts can never load.
//
// The output is committed and published, so installing this package needs no
// build — `npm run build` is for whoever changes the shell.
import { defineConfig } from 'vite'
import { viteSingleFile } from 'vite-plugin-singlefile'

// The version is NOT baked in. Doing that made the built file change on every
// bump, and since `prepack` rebuilds it, the release tool's own change
// detection (npm pack --dry-run) dirtied the tree it was about to judge and
// then refused to judge it. The shell carries a placeholder instead and
// index.js substitutes the real version when it serves the resource.
export const SHELL_VERSION_TOKEN = '__MIKSER_APP_SHELL_VERSION__'

export default defineConfig({
    root: 'src/app',
    define: { __SHELL_VERSION__: JSON.stringify(SHELL_VERSION_TOKEN) },
    plugins: [viteSingleFile()],
    build: {
        outDir: '../../public',
        emptyOutDir: false,
        rollupOptions: { output: { entryFileNames: 'app-shell.js' } },
    },
})
