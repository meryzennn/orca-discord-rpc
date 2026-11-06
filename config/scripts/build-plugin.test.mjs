import { it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { buildPlugin } from './build-plugin.mjs'

it('builds a worker that imports outside the repo without node_modules', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'orca-rpc-bundle-'))
  try {
    const bundle = join(directory, 'runtime.mjs')
    await buildPlugin(bundle)
    const script = `import assert from 'node:assert/strict';
      import { isBuiltin, registerHooks } from 'node:module';
      registerHooks({ resolve(specifier, context, nextResolve) {
        assert.ok(isBuiltin(specifier) || specifier === ${JSON.stringify(pathToFileURL(bundle).href)},
          'Unbundled dependency: ' + specifier);
        return nextResolve(specifier, context);
      } });
      const m = await import(${JSON.stringify(pathToFileURL(bundle).href)});
      assert.equal(typeof m.default, 'function');
      assert.equal(typeof m.deactivate, 'function');
      console.log('worker import ok');`
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: directory, encoding: 'utf8', windowsHide: true
    })
    assert.equal(output.trim(), 'worker import ok')
    assert.doesNotMatch(readFileSync(bundle, 'utf8'), /[ \t]+\r?$/m)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
