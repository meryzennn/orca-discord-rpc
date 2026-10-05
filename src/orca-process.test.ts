import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  orcaProcessName,
  parseTasklist,
  parsePgrep,
  isOrcaRunning
} from './orca-process.ts'

describe('orcaProcessName', () => {
  it('names the executable per platform', () => {
    assert.equal(orcaProcessName('win32'), 'Orca.exe')
    assert.equal(orcaProcessName('darwin'), 'Orca')
    assert.equal(orcaProcessName('linux'), 'orca')
  })
})

describe('parseTasklist', () => {
  it('finds a row in the real default output, which is unquoted and space padded', () => {
    // Captured from `tasklist /FI "IMAGENAME eq Orca.exe" /NH` on Windows 11.
    const output = [
      '',
      'Orca.exe                     20036 Console                    1    237,604 K',
      'Orca.exe                      2948 Console                    1     39,732 K',
      ''
    ].join('\r\n')
    assert.equal(parseTasklist(output), true)
  })

  it('also accepts the quoted CSV shape', () => {
    assert.equal(parseTasklist('"Orca.exe","19052","Console","1","93,308 K"'), true)
  })

  it('reports no match for the tasklist info line', () => {
    // Why pinned: tasklist prints this on stdout and still exits 0, so the text is the signal.
    const output = 'INFO: No tasks are running which match the specified criteria.\r\n'
    assert.equal(parseTasklist(output), false)
  })

  it('ignores an unrelated process', () => {
    assert.equal(parseTasklist('notepad.exe                  10 Console   1   1 K'), false)
  })

  it('does not match a longer name that merely ends in orca.exe', () => {
    assert.equal(parseTasklist('NotOrca.exe                  10 Console   1   1 K'), false)
  })

  it('is false for empty output', () => {
    assert.equal(parseTasklist(''), false)
  })
})

describe('parsePgrep', () => {
  it('is true when a pid was printed', () => {
    assert.equal(parsePgrep('1234\n'), true)
    assert.equal(parsePgrep('1234\n5678\n'), true)
  })

  it('is false when nothing was printed', () => {
    assert.equal(parsePgrep(''), false)
    assert.equal(parsePgrep('\n'), false)
  })

  it('ignores non-numeric noise', () => {
    assert.equal(parsePgrep('pgrep: no matching processes found'), false)
  })
})

describe('isOrcaRunning', () => {
  it('runs tasklist on windows and reads the result', async () => {
    const calls: string[][] = []
    const running = await isOrcaRunning({
      platform: 'win32',
      exec: async (command, args) => {
        calls.push([command, ...args])
        return { stdout: '"Orca.exe","19052","Console","1","93,308 K"', failed: false }
      }
    })
    assert.equal(running, true)
    assert.equal(calls[0]?.[0], 'tasklist')
    // The filter value carries the executable name.
    assert.ok(calls[0]?.some((arg) => arg.includes('Orca.exe')))
  })

  it('is false when the process is not listed', async () => {
    const running = await isOrcaRunning({
      platform: 'win32',
      exec: async () => ({
        stdout: 'INFO: No tasks are running which match the specified criteria.',
        failed: false
      })
    })
    assert.equal(running, false)
  })

  it('is false when the probe itself fails', async () => {
    const running = await isOrcaRunning({
      platform: 'linux',
      exec: async () => ({ stdout: '', failed: true })
    })
    assert.equal(running, false)
  })

  it('uses pgrep off windows', async () => {
    const calls: string[][] = []
    const running = await isOrcaRunning({
      platform: 'darwin',
      exec: async (command, args) => {
        calls.push([command, ...args])
        return { stdout: '1234\n', failed: false }
      }
    })
    assert.equal(running, true)
    assert.equal(calls[0]?.[0], 'pgrep')
  })
})
