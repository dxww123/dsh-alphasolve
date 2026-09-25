import { defineConfig } from 'vitest/config'
import ts from 'typescript'
import { standardDecoratorPlugin } from '../deepseek-harness/vitest.shared.ts'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const harnessRoot = fileURLToPath(new URL('../deepseek-harness/', import.meta.url))
const { config, error } = ts.readConfigFile(path.join(harnessRoot, 'tsconfig.base.json'), ts.sys.readFile)
if (error) throw new Error(ts.flattenDiagnosticMessageText(error.messageText, '\n'))

// Exercise the checked-out Harness source, including its transitive workspace imports.
const alias = Object.entries(config.compilerOptions.paths as Record<string, string[]>)
  .filter(([name]) => !name.includes('*'))
  .map(([name, targets]) => ({ find: new RegExp('^' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'), replacement: path.resolve(harnessRoot, targets[0]!) }))

export default defineConfig({
  plugins: [standardDecoratorPlugin()],
  resolve: { alias },
  test: { include: ['tests/**/*.spec.ts'] },
})
