/** Install the pinned mathematical runtime in AlphaSolve's dedicated virtual environment. */
import { spawn } from 'node:child_process'
import { lstat, mkdir, readFile, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

const pins = { sympy: '1.14.0', mpmath: '1.3.0' }
const args = process.argv.slice(2)
const help = 'Usage: node scripts/setup-python.mjs [--python <absolute Python executable>]\nCreates DSH_HOME/runtimes/alphasolve-python (default: ~/.dsh/runtimes/alphasolve-python).'
if (args.length === 1 && args[0] === '--help') {
  console.log(help)
  process.exit(0)
}
if (args.length !== 0 && (args.length !== 2 || args[0] !== '--python' || !path.isAbsolute(args[1]))) {
  console.error(help)
  process.exit(1)
}
const python = args[1] ?? (process.platform === 'win32' ? 'python' : 'python3')
const runtimeRoot = path.join(path.resolve(process.env.DSH_HOME || path.join(homedir(), '.dsh')), 'runtimes', 'alphasolve-python')
const runtimePython = path.join(runtimeRoot, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')

/** Run an executable directly, forwarding installer progress and bounding probe output. */
function run(executable, argv, capture = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, argv, { shell: false, windowsHide: true, stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit' })
    let output = ''
    let overflow = false
    if (capture) child.stdout.on('data', chunk => {
      output += chunk.toString('utf8')
      if (output.length > 65536) {
        overflow = true
        child.kill()
      }
    })
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (overflow) reject(new Error('Python probe exceeded its output limit'))
      else if (code !== 0 || signal !== null) reject(new Error(`${executable} exited with code ${code}, signal ${signal}`))
      else resolve(output.trim())
    })
  })
}

/** Reject an existing directory unless it is a private Python virtual environment. */
async function verifyEnvironment() {
  const cfg = await readFile(path.join(runtimeRoot, 'pyvenv.cfg'), 'utf8')
  if (!/^include-system-site-packages\s*=\s*false\s*$/mi.test(cfg)) {
    throw new Error(`Refusing ${runtimeRoot}: its virtual environment must disable system site packages`)
  }
  const info = JSON.parse(await run(runtimePython, ['-I', '-B', '-c', 'import json,sys; print(json.dumps({"prefix":sys.prefix,"basePrefix":sys.base_prefix,"version":list(sys.version_info[:2])}))'], true))
  const actualPrefix = await realpath(info.prefix)
  const expectedPrefix = await realpath(runtimeRoot)
  const samePath = process.platform === 'win32' ? actualPrefix.toLowerCase() === expectedPrefix.toLowerCase() : actualPrefix === expectedPrefix
  if (!samePath || info.prefix === info.basePrefix || info.version[0] !== 3 || info.version[1] < 10) {
    throw new Error(`Refusing ${runtimeRoot}: expected its own Python 3.10+ virtual environment`)
  }
}

try {
  const version = JSON.parse(await run(python, ['-I', '-B', '-c', 'import json,sys; print(json.dumps(list(sys.version_info[:2])))'], true))
  if (version[0] !== 3 || version[1] < 10) throw new Error('AlphaSolve requires Python 3.10 or newer')
  await mkdir(path.dirname(runtimeRoot), { recursive: true })
  let existing
  try {
    existing = await lstat(runtimeRoot)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  if (existing) {
    if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error(`Refusing to overwrite non-venv path ${runtimeRoot}`)
    await verifyEnvironment()
  } else {
    // Exclusive creation avoids replacing a path another installer acquired.
    await mkdir(runtimeRoot)
    await run(python, ['-I', '-B', '-m', 'venv', runtimeRoot])
    await verifyEnvironment()
  }
  await run(runtimePython, ['-I', '-B', '-m', 'pip', '--isolated', '--disable-pip-version-check', 'install', '--no-input', '--require-virtualenv', '--only-binary=:all:', `sympy==${pins.sympy}`, `mpmath==${pins.mpmath}`])
  const installed = JSON.parse(await run(runtimePython, ['-I', '-B', '-c', 'import json,sympy,mpmath; print(json.dumps({"sympy":sympy.__version__,"mpmath":mpmath.__version__}))'], true))
  if (installed.sympy !== pins.sympy || installed.mpmath !== pins.mpmath) throw new Error('Installed mathematical libraries do not match the required versions')
  console.log(JSON.stringify({ python: runtimePython, ...installed }, null, 2))
} catch (error) {
  console.error(`AlphaSolve Python setup failed: ${error.message}`)
  process.exitCode = 1
}
