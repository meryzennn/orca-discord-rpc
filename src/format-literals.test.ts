import { it } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

/**
 * Discord-facing words belong in config/presence-format.json and agent names in
 * config/agents.json. This fails when one of them reappears as a string literal in source.
 */
const FORBIDDEN = [
  'Agent:', 'Folder:', 'Private Project', 'Working', 'Idle', 'Using Orca', 'View Repository', 'Branch', '📁', '·',
  'Oh My Pi', 'Antigravity', 'OpenCode', 'Qwen Code', 'Command Code', 'Codex', 'Claude',
  'agent working', 'agents working', 'active workspace', 'active workspaces'
]

const SOURCE = dirname(fileURLToPath(import.meta.url))

/** Text of every string and template literal; comments and regular expressions are not literals. */
function stringLiterals(name: string, code: string): string[] {
  const source = ts.createSourceFile(name, code, ts.ScriptTarget.Latest, true)
  const literals: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) literals.push(node.text)
    node.forEachChild(visit)
  }
  visit(source)
  return literals
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : []
  })
}

it('keeps Discord-facing text and agent names out of source literals', () => {
  const files = sourceFiles(SOURCE)
  assert.ok(files.length > 10)
  const found: string[] = []
  for (const file of files) {
    for (const literal of stringLiterals(file, readFileSync(file, 'utf8'))) {
      for (const word of FORBIDDEN) {
        if (literal.includes(word)) found.push(`${file.slice(SOURCE.length + 1)}: ${JSON.stringify(literal)} contains ${JSON.stringify(word)}`)
      }
    }
  }
  assert.deepEqual(found, [])
})

it('scans literals but not comments or regular expressions', () => {
  const code = '// Claude\nconst a = `Agent: ${x} Idle`; const b = "Working"; const c = /"Codex"/g'
  assert.deepEqual(stringLiterals('probe.ts', code), ['Agent: ', ' Idle', 'Working'])
})
