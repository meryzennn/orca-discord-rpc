import { build } from 'esbuild'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

const result = await build({
  entryPoints: [join(ROOT, 'src', 'electron', 'main.ts')],
  outfile: join(ROOT, 'out', 'main.cjs'),
  bundle: true,
  // Why cjs: Electron's main process is happiest with CommonJS.
  // Why node20: the module level Electron 44 provides.
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  // Why external: electron is supplied by the runtime, and the RPC client is a normal
  // production dependency that electron-builder packs from node_modules.
  external: ['electron', '@xhayper/discord-rpc'],
  sourcemap: false,
  metafile: true,
  logLevel: 'info'
})

const bytes = Object.values(result.metafile.outputs)[0]?.bytes ?? 0
console.log(`bundled out/main.cjs (${bytes} bytes)`)
