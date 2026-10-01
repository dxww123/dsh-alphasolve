# 首次计算环境准备

[English](python-setup.md) · [返回使用说明](../README.zh-CN.md)

AlphaSolve 使用 SymPy 做符号计算。安装插件不会自动安装这些 Python 库，第一次求解前需要准备一次；以后换题目文件夹不必重新安装。

## 让桌面端助手完成准备

安装并启用插件后，在 DSH 的 **standard** 模式下新开一个普通对话，发送以下内容。这一步需要联网，助手可能会请求安装依赖的权限。

> 请为已安装的 dsh-alphasolve 插件准备计算环境，暂不开始求解数学题。先调用 load_workspace_dependencies 获取桌面端的 Node.js 和 Python 路径。找到当前 Desktop profile 中的 dsh-alphasolve 包，读取 scripts/setup-python.mjs，用返回的 Node.js 执行该脚本，并通过 --python 指定返回的 Python。沿用当前桌面端的 DSH_HOME，未设置时使用 ~/.dsh。让脚本创建 AlphaSolve 专用环境，不要把库装进桌面端共享 Python。最后用专用 Python 验证 SymPy 为 1.14.0、mpmath 为 1.3.0，并确认 x**2 在 0 到 1 上的积分精确等于 1/3。请报告这些检查是否全部通过。

脚本会建立单独的环境，安装 **SymPy 1.14.0** 和 **mpmath 1.3.0**，不改动桌面端共享 Python。若准备失败，先解决提示的下载或路径问题，再开始求解。

这是一次需要明确发给助手的准备请求，不是插件安装时自动完成的步骤。

## 手动准备

使用 `load_workspace_dependencies` 返回的实际路径。安装后的脚本通常位于：

```text
<DSH_HOME>/profiles/desktop/node_modules/dsh-alphasolve/scripts/setup-python.mjs
```

`DSH_HOME` 默认是 `~/.dsh`。若桌面端使用了自定义目录，运行脚本时沿用相同的环境变量；若使用自定义 profile，把 `desktop` 换成对应名称。

Windows PowerShell 中替换下面的三个路径：

```powershell
& '<Node.js 可执行文件>' '<已安装的 setup-python.mjs>' --python '<Python 可执行文件>'
```

macOS/Linux：

```sh
"<Node.js 可执行文件>" "<已安装的 setup-python.mjs>" --python "<Python 可执行文件>"
```

脚本要求 Python 3.10 或更新版本。若终端里已有 Node.js 和 Python，也可以在本仓库目录直接运行 `node scripts/setup-python.mjs`。

完成时应输出专用解释器的路径和两个库的版本。Windows 下解释器位于 `<DSH_HOME>/runtimes/alphasolve-python/Scripts/python.exe`，macOS/Linux 下位于 `<DSH_HOME>/runtimes/alphasolve-python/bin/python`。再次运行脚本会检查并复用已有的有效环境。

准备完成后，返回[使用说明](../README.zh-CN.md#开始求解)开始求解。自定义解释器和计算限制见[进阶说明](advanced.zh-CN.md#python-与-sympy)。
