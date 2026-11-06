import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync } from 'node:fs'
import { join } from 'node:path'
import type { ModelResolver } from './types.ts'
import {
  MODEL_OVERLAP_BYTES, TAIL_BYTES, normalizePath, nonEmpty, readLastModel, samePath
} from './session-files.ts'

/** The notice Antigravity injects into a user turn when the model changes. */
const SETTINGS_CHANGE = /<USER_SETTINGS_CHANGE>([\s\S]*?)<\/USER_SETTINGS_CHANGE>/g
// Why lazy: greedy "from ..." would run on to the last " to " in the notice's following sentence.
const MODEL_CHANGE = /`Model Selection` (?:from [^\n`]+? )?to ([^\n`]+?)(?:\.\s|\.?$)/g

/**
 * Why entries are parsed and not the raw text: the transcript also records tool calls, tool
 * output and thinking, and any of them can quote the notice (as this very feature's own
 * development did), usually JSON-escaped several times. Only the notice Antigravity injects
 * into a user turn (`source: USER_EXPLICIT`, in `content`) is a real model change.
 */
export function lastAntigravityModelIn(text: string): string | null {
  let last: string | null = null
  for (const line of text.split('\n')) {
    let content: unknown
    try {
      const entry: unknown = JSON.parse(line)
      if (entry === null || typeof entry !== 'object' || !('source' in entry) || entry.source !== 'USER_EXPLICIT' ||
        !('content' in entry)) continue
      content = entry.content
    } catch {
      // A reverse-read block may start or end partway through a JSONL record.
      continue
    }
    if (typeof content !== 'string') continue
    for (const change of content.matchAll(SETTINGS_CHANGE)) {
      for (const match of (change[1] ?? '').matchAll(MODEL_CHANGE)) {
        const model = match[1]?.trim()
        if (model && !model.startsWith('<')) last = model
      }
    }
  }
  return last
}

function defaultAntigravityModel(agyHome: string): string | null {
  for (const dir of [agyHome, join(agyHome, '..')]) {
    const settings = join(dir, 'settings.json')
    if (!existsSync(settings)) continue
    try {
      const raw: unknown = JSON.parse(readFileSync(settings, 'utf8').replace(/^\uFEFF/, ''))
      if (raw && typeof raw === 'object' && 'model' in raw && typeof raw.model === 'string' && raw.model.trim()) {
        return raw.model.trim()
      }
    } catch {}
  }
  return null
}

function newestAntigravityConversation(agyHome: string, worktreePath: string): string | null {
  const history = join(agyHome, 'history.jsonl')
  if (!existsSync(history)) return null
  const wanted = normalizePath(worktreePath)
  const fd = openSync(history, 'r')
  try {
    const size = fstatSync(fd).size
    const buffer = Buffer.alloc(Math.min(size, TAIL_BYTES))
    let position = Math.max(0, size - buffer.length)
    while (position >= 0) {
      const read = readSync(fd, buffer, 0, Math.min(buffer.length, size - position), position)
      const lines = buffer.toString('utf8', 0, read).split('\n')
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i]?.trim()
        if (!line) continue
        try {
          const entry: unknown = JSON.parse(line)
          if (entry && typeof entry === 'object' && 'workspace' in entry && typeof entry.workspace === 'string') {
            if (samePath(normalizePath(entry.workspace), wanted) && 'conversationId' in entry && typeof entry.conversationId === 'string') {
              return entry.conversationId
            }
          }
        } catch {}
      }
      if (position === 0) break
      position = Math.max(0, position - TAIL_BYTES + MODEL_OVERLAP_BYTES)
    }
  } finally { closeSync(fd) }
  return null
}

export function newestAntigravityModel(agyHome: string, worktreePath: string): string | null {
  if (!existsSync(agyHome)) return null
  const conversationId = newestAntigravityConversation(agyHome, worktreePath)
  if (conversationId) {
    const transcript = join(agyHome, 'brain', conversationId, '.system_generated', 'logs', 'transcript.jsonl')
    if (existsSync(transcript)) {
      const fromTranscript = readLastModel(transcript, lastAntigravityModelIn)
      if (fromTranscript) return fromTranscript
    }
  }
  return defaultAntigravityModel(agyHome)
}

export const resolveAntigravityModel: ModelResolver = (worktreePath, sources) =>
  newestAntigravityModel(nonEmpty(sources.env('ANTIGRAVITY_HOME')) ?? join(sources.home, '.gemini', 'antigravity-cli'), worktreePath)
