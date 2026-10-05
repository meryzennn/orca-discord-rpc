import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildIcons, readPngSize, ICON_TARGETS, SOURCE_ART } from './build-icons.mjs'

const REAL_SOURCE = join(process.cwd(), SOURCE_ART)

/** A minimal valid PNG header for a given size, enough for the size reader. */
function pngHeader(width, height) {
  const bytes = Buffer.alloc(24)
  bytes.write('89504e470d0a1a0a', 0, 'hex')
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  return bytes
}

describe('readPngSize', () => {
  it('reads the dimensions', () => {
    assert.deepEqual(readPngSize(pngHeader(512, 512)), { width: 512, height: 512 })
  })

  it('rejects a file that is not a png', () => {
    assert.throws(() => readPngSize(Buffer.from('not a png at all, really')), /not a png/)
  })
})

describe('buildIcons', () => {
  let root
  before(() => {
    root = mkdtempSync(join(tmpdir(), 'icons-'))
    writeFileSync(join(root, SOURCE_ART), pngHeader(512, 512))
  })
  after(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('copies the source to every target', () => {
    buildIcons(root)
    for (const target of ICON_TARGETS) {
      assert.ok(existsSync(join(root, target)), `missing ${target}`)
      assert.deepEqual(readPngSize(readFileSync(join(root, target))), { width: 512, height: 512 })
    }
  })

  it('rejects a non-square source', () => {
    const bad = mkdtempSync(join(tmpdir(), 'icons-bad-'))
    writeFileSync(join(bad, SOURCE_ART), pngHeader(512, 256))
    assert.throws(() => buildIcons(bad), /square/)
    rmSync(bad, { recursive: true, force: true })
  })

  it('rejects a source too small for the installer icon', () => {
    const small = mkdtempSync(join(tmpdir(), 'icons-small-'))
    writeFileSync(join(small, SOURCE_ART), pngHeader(64, 64))
    assert.throws(() => buildIcons(small), /at least 256/)
    rmSync(small, { recursive: true, force: true })
  })
})

describe('the committed artwork', () => {
  it('is a square png large enough for the installer', () => {
    const { width, height } = readPngSize(readFileSync(REAL_SOURCE))
    assert.equal(width, height)
    assert.ok(width >= 256, `only ${width}px`)
  })
})
