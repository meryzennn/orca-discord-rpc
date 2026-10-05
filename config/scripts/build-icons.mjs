import { copyFileSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** The artwork the icons are derived from, kept at the repository root. */
export const SOURCE_ART = 'orca-rpc.png'

/** Both destinations, so the tray and the installer show the same mark. */
export const ICON_TARGETS = ['assets/tray.png', 'build/icon.png']

const PNG_SIGNATURE = '89504e47'

/** Reads the width and height out of a PNG's IHDR, so a bad source fails here and not in a build. */
export function readPngSize(bytes) {
  if (bytes.length < 24 || bytes.subarray(0, 4).toString('hex') !== PNG_SIGNATURE) {
    throw new Error('source artwork is not a png')
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

export function buildIcons(root = ROOT) {
  const source = join(root, SOURCE_ART)
  const bytes = readFileSync(source)
  const { width, height } = readPngSize(bytes)
  // Why square and large: electron-builder derives the .ico from this, and a non-square or
  // small image produces a broken or blurry installer icon.
  if (width !== height) {
    throw new Error(`${SOURCE_ART} must be square, got ${width}x${height}`)
  }
  if (width < 256) {
    throw new Error(`${SOURCE_ART} must be at least 256x256, got ${width}x${height}`)
  }
  const written = []
  for (const target of ICON_TARGETS) {
    const destination = join(root, target)
    mkdirSync(dirname(destination), { recursive: true })
    copyFileSync(source, destination)
    written.push(`${target} (${statSync(destination).size} bytes, ${width}x${height})`)
  }
  return written
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const line of buildIcons()) {
    console.log('wrote', line)
  }
}
