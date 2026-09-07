// vite writes src/app/index.html as public/index.html; the resource is served
// as app-shell.html, so the build finishes by naming it that. One file in,
// one file out — anything else vite emitted would be unreachable inside the
// iframe anyway.
import { renameSync, existsSync, rmSync } from 'node:fs'

if (!existsSync('public/index.html')) {
    console.error('build: vite produced no public/index.html — nothing to name')
    process.exit(1)
}
if (existsSync('public/app-shell.html')) rmSync('public/app-shell.html')
renameSync('public/index.html', 'public/app-shell.html')
console.log('build: public/app-shell.html')
