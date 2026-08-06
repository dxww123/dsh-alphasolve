import { readFileSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

interface PackageManifest {
  name?: string
  main?: string
  exports?: Record<string, unknown>
  files?: string[]
  dsh?: { bundle?: { patch?: string } }
}

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8')) as PackageManifest

describe('DSH profile bundle', () => {
  it('publishes an in-package patch through the bundle manifest', () => {
    const patch = manifest.dsh?.bundle?.patch
    expect(patch).toBe('./cordis.patch.yml')
    expect(manifest.exports?.['./cordis.patch.yml']).toBe(patch)
    expect(manifest.files).toContain('cordis.patch.yml')
    expect(manifest.files).toContain(manifest.main?.replace(/^\.\//, ''))

    const patchPath = resolve(packageRoot, patch!)
    const packageRelativePath = relative(packageRoot, patchPath)
    expect(packageRelativePath.startsWith(`..${sep}`)).toBe(false)
    expect(readFileSync(patchPath, 'utf8')).not.toBe('')
  })

  it('inserts exactly one stable row that resolves back to this package', () => {
    const patchPath = resolve(packageRoot, manifest.dsh!.bundle!.patch!)
    const dataLines = readFileSync(patchPath, 'utf8')
      .split(/\r?\n/)
      .map(line => line.trimEnd())
      .filter(line => line.trim() !== '' && !line.trimStart().startsWith('#'))

    expect(dataLines).toEqual([
      '- insert:',
      '    - id: dsh-alphasolve',
      `      name: '${manifest.name}'`,
    ])
  })
})
