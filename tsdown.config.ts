import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  clean: false,
  dts: false,
  deps: {
    neverBundle: [
      'cordis',
      'schemastery',
      /^@deepseek-ai\//,
    ],
  },
})
