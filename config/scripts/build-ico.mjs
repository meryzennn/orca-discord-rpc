import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** The source artwork; the tray icon, the installer icon and the exe icon all come from it. */
export const SOURCE_ART = 'orca-rpc.png'
export const ICO_TARGET = 'build/app.ico'

/**
 * Wraps a PNG in a one-entry ICO. Vista and later read PNG-compressed icon entries directly,
 * so no BMP conversion or multi-size set is needed.
 */
export function buildIco(png) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(1, 4) // image count

  const width = png.readUInt32BE(16)
  const height = png.readUInt32BE(20)

  const entry = Buffer.alloc(16)
  // Why 0: a 256px dimension is stored as 0, because the field is one byte.
  entry[0] = width >= 256 ? 0 : width
  entry[1] = height >= 256 ? 0 : height
  entry[2] = 0 // palette size
  entry[3] = 0 // reserved
  entry.writeUInt16LE(1, 4) // colour planes
  entry.writeUInt16LE(32, 6) // bits per pixel
  entry.writeUInt32LE(png.length, 8)
  entry.writeUInt32LE(6 + 16, 12) // data begins after the header and this entry

  return Buffer.concat([header, entry, png])
}

export function buildAppIco(root = ROOT) {
  const png = readFileSync(join(root, SOURCE_ART))
  if (png.length < 24 || png.subarray(0, 4).toString('hex') !== '89504e47') {
    throw new Error(`${SOURCE_ART} is not a png`)
  }

  const width = png.readUInt32BE(16)
  const height = png.readUInt32BE(20)
  if (width !== height) {
    throw new Error(`${SOURCE_ART} must be square, got ${width}x${height}`)
  }
  if (width < 256) {
    throw new Error(`${SOURCE_ART} must be at least 256x256, got ${width}`)
  }

  const target = join(root, ICO_TARGET)
  writeFileSync(target, buildIco(png))
  return target
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log('wrote', buildAppIco())
}
