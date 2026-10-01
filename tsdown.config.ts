import { defineConfig } from 'tsdown'

const clientExternals = new Set([
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
  '@deepseek-ai/cordis', '@deepseek-ai/dsh-client-ui-primitives',
])

export default defineConfig([
  {
    entry: ['src/index.ts'],
    tsconfig: 'tsconfig.host.json',
    outDir: 'lib',
    format: 'esm',
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    clean: false,
    dts: false,
    deps: { neverBundle: [/^@deepseek-ai\//] },
  },
  {
    entry: { python: 'src/python-runtime.ts' },
    tsconfig: 'tsconfig.host.json',
    outDir: 'lib',
    format: 'esm',
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    clean: false,
    dts: false,
    deps: { neverBundle: [/^@deepseek-ai\//] },
  },
  {
    entry: { client: 'src/client/index.tsx' },
    tsconfig: 'tsconfig.client.json',
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    target: 'es2024',
    clean: false,
    dts: false,
    deps: {
      neverBundle: specifier => clientExternals.has(specifier),
      alwaysBundle: specifier => !clientExternals.has(specifier),
    },
    inputOptions: {
      onLog(level, log, defaultHandler) {
        if (log.code === 'UNRESOLVED_IMPORT') throw new Error(log.message)
        defaultHandler(level, log)
      },
    },
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: 'window.__ModuleLoader__.load({ id: "dsh-alphasolve", factory: (require) => {',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      footer: 'return module.exports; } });',
    },
  },
])
