import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildIco } from './build-ico.mjs'

/** A minimal PNG header claiming the given size, enough for the ICO wrapper. */
function pngHeader(width, height, bodyBytes = 64) {
  const bytes = Buffer.alloc(24 + bodyBytes)
  bytes.write('89504e470d0a1a0a', 0, 'hex')
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  return bytes
}

describe('buildIco', () => {
  it('writes an ico header with one entry', () => {
    const ico = buildIco(pngHeader(256, 256))
    assert.equal(ico.readUInt16LE(0), 0, 'reserved')
    assert.equal(ico.readUInt16LE(2), 1, 'type: icon')
    assert.equal(ico.readUInt16LE(4), 1, 'one image')
  })

  it('records 0 for a 256px dimension, which is the ico convention', () => {
    const ico = buildIco(pngHeader(256, 256))
    assert.equal(ico[6], 0, 'width 256 is stored as 0')
    assert.equal(ico[7], 0, 'height 256 is stored as 0')
  })

  it('stores a smaller dimension as-is', () => {
    const ico = buildIco(pngHeader(64, 64))
    assert.equal(ico[6], 64)
    assert.equal(ico[7], 64)
  })

  it('declares 32 bits per pixel', () => {
    const ico = buildIco(pngHeader(256, 256))
    // Bits per pixel lives at entry offset 6, which is file offset 12.
    assert.equal(ico.readUInt16LE(12), 32)
    // Colour planes at entry offset 4, which is file offset 10.
    assert.equal(ico.readUInt16LE(10), 1)
  })

  it('embeds the png verbatim after the directory entry', () => {
    const png = pngHeader(256, 256)
    const ico = buildIco(png)
    const offset = ico.readUInt32LE(18)
    assert.equal(offset, 22, 'data starts after the 6-byte header and the 16-byte entry')
    assert.deepEqual(ico.subarray(offset), png)
  })

  it('records the png length', () => {
    const png = pngHeader(256, 256)
    const ico = buildIco(png)
    assert.equal(ico.readUInt32LE(14), png.length)
  })
})
