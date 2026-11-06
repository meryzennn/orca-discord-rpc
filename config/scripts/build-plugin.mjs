import { build } from 'esbuild'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const licenseFallbacks = {
  '@sapphire/async-queue@1.5.5': join(ROOT, 'config', 'licenses', 'sapphire-MIT.txt'),
  '@sapphire/snowflake@3.5.5': join(ROOT, 'config', 'licenses', 'sapphire-MIT.txt')
}

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
    legalComments: 'eof',
    external: ['bufferutil', 'utf-8-validate'],
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" }
  })
  const bundle = readFileSync(outputFile, 'utf8')
  const legalComment = bundle.lastIndexOf('\n/*! Bundled license information:')
  if (legalComment !== -1) {
    // esbuild preserves trailing whitespace from dependency notices in its EOF comment.
    writeFileSync(outputFile, bundle.slice(0, legalComment) + bundle.slice(legalComment).replace(/[ \t]+$/gm, ''), 'utf8')
  }
  const packages = new Map()
  for (const input of Object.keys(result.metafile.inputs)) {
    if (!input.replaceAll('\\', '/').includes('node_modules/')) continue
    let directory = dirname(resolve(ROOT, input))
    while (!existsSync(join(directory, 'package.json'))) {
      const parent = dirname(directory)
      if (parent === directory) throw new Error(`Missing package metadata for ${input}`)
      directory = parent
    }
    if (packages.has(directory)) continue
    const pkg = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
    const identity = `${pkg.name}@${pkg.version}`
    const licenses = readdirSync(directory).filter(name => /^(licen[sc]e|copying|notice|third_party_license)([.-]|$)/i.test(name)).sort()
    const notice = licenses.length > 0
      ? licenses.map(name => readFileSync(join(directory, name), 'utf8')).join('\n')
      : licenseFallbacks[identity] && readFileSync(licenseFallbacks[identity], 'utf8')
    if (!notice) throw new Error(`Missing dependency license notice for ${identity}`)
    packages.set(directory, `${identity}\n${notice}`)
  }
  writeFileSync(join(dirname(outputFile), 'THIRD-PARTY-NOTICES.txt'), [...packages.values()].sort().join('\n\n'), 'utf8')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await buildPlugin()
  console.log('Built plugin/runtime.mjs and dependency notices')
}
