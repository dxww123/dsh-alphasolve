#!/usr/bin/env node

/** Verify the shipped lazy client factory requests only modules supplied by Harness. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'

const packageRequire = createRequire(import.meta.url)
const registrations = []
runInNewContext(await readFile(new URL('../lib/client.js', import.meta.url), 'utf8'), {
  window: { __ModuleLoader__: { load(registration) { registrations.push(registration) } } },
}, { timeout: 1000 })
assert.equal(registrations.length, 1)
const registration = registrations[0]
assert.equal(registration.id, '@dsh-external/dsh-alphasolve')
assert.equal(typeof registration.factory, 'function')

// Rendering is covered by client-workflow.spec.ts. This facade checks that
// materialization does not require workspace helpers or zod from the shell table.
const baseline = new Map([
  ['react', packageRequire('react')],
  ['react/jsx-runtime', packageRequire('react/jsx-runtime')],
  ['@deepseek-ai/cordis', packageRequire('@deepseek-ai/cordis')],
  ['@deepseek-ai/dsh-client-ui-primitives', Object.freeze({})],
])
const requested = new Set()
const client = registration.factory(specifier => {
  assert.ok(baseline.has(specifier), `Client requested an unavailable Harness module: ${specifier}`)
  requested.add(specifier)
  return baseline.get(specifier)
})
assert.equal(typeof client.apply, 'function')
assert.equal(client.WORKFLOW_TAB_KIND, 'alphasolve-workflows')
assert.equal(client.WORKFLOW_TAB_ID, '@dsh-external/dsh-alphasolve/workflows')
assert.ok(Array.isArray(client.inject) && client.inject.includes('remote.workspaceFiles'))
assert.ok(requested.has('react') && requested.has('@deepseek-ai/dsh-client-ui-primitives'))
console.log(`client-bundle-ok (${requested.size} shared module requests; helpers and validation bundled)`)
