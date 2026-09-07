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
import { readFileSync } from 'node:fs'

const { version } = JSON.parse(readFileSync('./package.json', 'utf8'))

export default defineConfig({
    root: 'src/app',
    define: { __SHELL_VERSION__: JSON.stringify(version) },
    plugins: [viteSingleFile()],
    build: {
        outDir: '../../public',
        emptyOutDir: false,
        rollupOptions: { output: { entryFileNames: 'app-shell.js' } },
    },
})
