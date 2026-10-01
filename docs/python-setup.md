# One-time Python/SymPy setup

[中文](python-setup.zh-CN.md) · [Back to the README](../README.md)

AlphaSolve uses SymPy for symbolic computation. Installing the plugin does not install these Python libraries. Complete this preparation once before your first problem; a new problem folder does not need another installation.

## Let the Desktop assistant prepare it

After installing and enabling the plugin, open a normal DSH conversation in **standard** mode and send the following. This step requires internet access and may ask for permission to install dependencies.

> Prepare the computation environment for the installed dsh-alphasolve plugin, without starting a mathematics problem. Use load_workspace_dependencies to get Desktop's Node.js and Python paths. Find the dsh-alphasolve package in the current Desktop profile, read its scripts/setup-python.mjs, and run that script with the returned Node.js executable and --python followed by the returned Python executable. Use this Desktop's DSH_HOME, or ~/.dsh if unset. Let the script create AlphaSolve's dedicated environment; do not install packages into Desktop's shared Python. Finally, use the dedicated Python to verify that SymPy is 1.14.0, mpmath is 1.3.0, and integrating x**2 from 0 to 1 gives exactly 1/3. Report whether all checks passed.

The setup script creates a separate environment containing **SymPy 1.14.0** and **mpmath 1.3.0**. Desktop's shared Python stays unchanged. If setup fails, resolve the reported download or path error before starting a solve.

This is an explicit preparation request to the assistant, not an automatic plugin installation step.

## Manual setup

Use the actual paths returned by `load_workspace_dependencies`. The installed script normally lives at:

```text
<DSH_HOME>/profiles/desktop/node_modules/dsh-alphasolve/scripts/setup-python.mjs
```

`DSH_HOME` defaults to `~/.dsh`. If Desktop uses a custom home, run setup with that same environment variable. For a custom profile, replace `desktop` with its name.

In Windows PowerShell, substitute the three paths:

```powershell
& '<Node.js executable>' '<installed setup-python.mjs>' --python '<Python executable>'
```

On macOS/Linux:

```sh
"<Node.js executable>" "<installed setup-python.mjs>" --python "<Python executable>"
```

The script requires Python 3.10 or newer. If Node.js and Python are already available in your terminal, you may instead run `node scripts/setup-python.mjs` from this repository.

The final output must report the dedicated interpreter's path and both library versions. The interpreter is at `<DSH_HOME>/runtimes/alphasolve-python/Scripts/python.exe` on Windows, or `<DSH_HOME>/runtimes/alphasolve-python/bin/python` on macOS/Linux. Re-running the script checks and reuses a valid existing environment.

Return to the [README](../README.md#solve-a-problem) to start solving. Details of custom interpreters and execution limits are in [advanced usage](advanced.md#python-and-sympy).
