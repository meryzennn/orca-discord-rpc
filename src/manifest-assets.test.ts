import { it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Orca refuses a plugin whose manifest names an image outside its limits, and then the plugin
 * cannot be installed at all. These are the limits from the manifest schema (orca-plugin.v2).
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MAX_SCREENSHOTS = 6
const MAX_SCREENSHOT_BYTES = 1536 * 1024
const MAX_TOTAL_BYTES = 8 * 1024 * 1024

type Screenshot = { path: string; alt: string; caption?: string }

function imageSize(bytes: Buffer): { width: number; height: number } {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
  }
  assert.equal(bytes.readUInt16BE(0), 0xffd8, 'not a PNG or JPEG')
  let offset = 2
  while (offset + 9 < bytes.length) {
    assert.equal(bytes[offset], 0xff)
    const marker = bytes[offset + 1] ?? 0
    // SOF0 to SOF15, except the DHT, JPG and DAC markers that share the range.
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) }
    }
    offset += 2 + bytes.readUInt16BE(offset + 2)
  }
  throw new Error('no frame header found')
}

it('keeps every manifest screenshot inside Orca image limits', () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'orca-plugin.json'), 'utf8')) as { screenshots?: Screenshot[] }
  const screenshots = manifest.screenshots ?? []
  assert.ok(screenshots.length > 0 && screenshots.length <= MAX_SCREENSHOTS)
  let total = 0
  for (const shot of screenshots) {
    assert.match(shot.path, /\.(png|jpe?g)$/i, shot.path)
    assert.ok(!shot.path.split(/[\\/]/).includes('..'), shot.path)
    const bytes = readFileSync(join(ROOT, shot.path))
    total += bytes.length
    assert.ok(bytes.length <= MAX_SCREENSHOT_BYTES, `${shot.path} is ${bytes.length} bytes`)
    const { width, height } = imageSize(bytes)
    assert.ok(width >= 1280 && height >= 800, `${shot.path} is ${width}x${height}, minimum 1280x800`)
    assert.ok(width <= 2560 && height <= 1600, `${shot.path} is ${width}x${height}, maximum 2560x1600`)
    assert.ok(shot.alt.length > 0 && shot.alt.length <= 160, `${shot.path} alt is ${shot.alt.length} characters`)
    assert.ok((shot.caption ?? '').length <= 120, `${shot.path} caption is too long`)
  }
  assert.ok(total <= MAX_TOTAL_BYTES, `images total ${total} bytes`)
})

it('keeps the manifest cover inside Orca cover limits and out of the screenshot strip', () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'orca-plugin.json'), 'utf8')) as
    { cover?: { path: string; alt: string }; screenshots?: Screenshot[] }
  assert.ok(manifest.cover, 'the plugin page needs a cover')
  assert.match(manifest.cover.path, /\.(png|jpe?g)$/i)
  const bytes = readFileSync(join(ROOT, manifest.cover.path))
  // The cover limit (1024 KB) is lower than the screenshot limit.
  assert.ok(bytes.length <= 1024 * 1024, `${manifest.cover.path} is ${bytes.length} bytes`)
  const { width, height } = imageSize(bytes)
  assert.ok(width >= 800 && height >= 500, `${manifest.cover.path} is ${width}x${height}, minimum 800x500`)
  assert.ok(manifest.cover.alt.length > 0 && manifest.cover.alt.length <= 160)
  assert.ok(!(manifest.screenshots ?? []).some(shot => shot.path === manifest.cover?.path), 'cover repeated as a screenshot')
})

it('only links README images that exist', () => {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')
  const images = [...readme.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map(match => match[1]!)
  assert.ok(images.length > 0)
  for (const path of images) assert.ok(readFileSync(join(ROOT, path)).length > 0, path)
})
