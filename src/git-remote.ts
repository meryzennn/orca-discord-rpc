import { execFile } from 'node:child_process'

export function normalizeRepoUrl(raw: string | null | undefined): string | null {
  const remote = raw?.trim()
  if (!remote || /[\s\\\x00-\x1f\x7f]/.test(remote) || /^[a-z]:/i.test(remote)) return null
  let source = remote
  if (!/^(https?|ssh):\/\//i.test(source)) {
    const scp = /^git@([^/:]+):(.+)$/.exec(source)
    if (!scp) return null
    source = `https://${scp[1]}/${scp[2]}`
  }
  try {
    const url = new URL(source)
    if (!['https:', 'http:', 'ssh:'].includes(url.protocol) || !url.hostname) return null
    const path = url.pathname.replace(/\/+$/, '').replace(/\.git$/i, '')
    if (!path || path === '/' || path.includes('//') || /[\\\x00-\x1f\x7f]/.test(decodeURIComponent(path))) return null
    const protocol = url.protocol === 'ssh:' ? 'https:' : url.protocol
    return new URL(`${protocol}//${url.hostname}${path}`).href
  } catch { return null }
}

export function readRepoUrl(directory: string, signal?: AbortSignal): Promise<string | null> {
  return new Promise<string | null>((resolve, reject) => {
    execFile('git', ['-C', directory, 'config', '--local', '--get', 'remote.origin.url'],
      { windowsHide: true, timeout: 1500, signal }, (error, stdout) => {
        if (error) reject(error)
        else resolve(normalizeRepoUrl(stdout))
      })
  }).catch(error => {
    if (error?.name === 'AbortError') throw error
    return null
  })
}
