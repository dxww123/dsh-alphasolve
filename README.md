# AlphaSolve for DSH

[中文使用说明](README.zh-CN.md)

AlphaSolve helps you work on difficult mathematics problems in [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): it develops candidate proofs, checks them independently, and revises them. It follows the workflow of [AlphaSolve](https://github.com/tanzcoding/alphasolve).

## Install

These npm instructions apply to published `dsh-alphasolve@0.4.0` and DSH `0.2.0-rc.2`. The current source checkout targets DSH `0.2.1-alpha.1`; those changes are not yet published to npm. For that version, [build from source and install locally](docs/advanced.md#development-and-validation).

1. Install **DeepSeek Harness Desktop 0.2.0-rc.2** and configure a working model connection.
2. Open the plugin manager, choose **Add plugin**, enter **`dsh-alphasolve`**, and install. Choose **Enable now** and restart if prompted.
3. Complete the [one-time Python/SymPy setup](docs/python-setup.md). Desktop includes Python, but installing the plugin does **not** install SymPy.

The npm installation needs no GitHub account or source build. If you have the older `@dsh-external/dsh-alphasolve` package, [replace it before installing this one](docs/advanced.md#upgrading-from-the-github-package).

## Solve a problem

1. Create a folder and put your question in **`problem.md`**. You may add **`hint.md`** for ideas, references, or approaches to try.
2. Open that folder as a workspace in DSH and start a conversation in **standard** mode.
3. Send:

   > Use AlphaSolve to solve the problem in problem.md.

Click **AlphaSolve** at the top of the conversation to see progress and open each participant's working transcript. When the workflow accepts a solution, it writes **`solution.md`** in your folder.

Start with a small problem. Repeated checking can take a long time and incur substantial model charges; the default is two parallel solving tasks. Automated checks do not guarantee a correct proof—review the mathematics yourself.

[npm package](https://www.npmjs.com/package/dsh-alphasolve) · [Advanced usage and development](docs/advanced.md) · [Compatibility](COMPATIBILITY.md) · [Report a problem](https://github.com/dxww123/dsh-alphasolve/issues)
