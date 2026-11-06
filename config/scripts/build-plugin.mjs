import { build } from 'esbuild'
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

export async function buildPlugin(outputFile = join(ROOT, 'plugin', 'runtime.mjs')) {
  mkdirSync(dirname(outputFile), { recursive: true })
  const result = await build({
    absWorkingDir: ROOT,
    entryPoints: ['src/orca-plugin.ts'],
    outfile: outputFile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    metafile: true,
    legalComments: 'eof'
  })
  const dependencies = Object.keys(result.metafile.inputs).filter(input => input.replaceAll('\\', '/').includes('node_modules/'))
  if (dependencies.length) throw new Error('Plugin runtime must use Node built-ins and project source only')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await buildPlugin()
  console.log('Built plugin/runtime.mjs (Node built-ins only)')
}
