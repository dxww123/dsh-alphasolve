# AlphaSolve for DSH

[English](README.md)

让 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 按照 [AlphaSolve](https://github.com/tanzcoding/alphasolve) 的流程研究数学问题：尝试证明、独立检查、反复修改。

## 安装

1. 安装 **DeepSeek Harness 官方桌面端 0.2.0-rc.2**，配置好可用的模型。
2. 在插件管理中选择「添加插件」，输入 **`dsh-alphasolve`** 并安装，选择「立即启用」，按提示重启。
3. 按照[首次计算环境准备](docs/python-setup.zh-CN.md)配置 Python/SymPy。桌面端自带 Python，但安装插件**不会自动安装 SymPy**。

不需要 GitHub 账号，也不需要下载源码、自己编译。已安装旧包 `@dsh-external/dsh-alphasolve` 的用户，请先按[升级说明](docs/advanced.zh-CN.md#从-github-旧包升级)替换旧包。

## 开始求解

1. 新建一个文件夹，把题目写进 **`problem.md`**；如有思路、参考资料或想尝试的方法，可另外写进 **`hint.md`**。
2. 在 DSH 中打开这个文件夹作为工作区，使用 **standard** 模式新建对话。
3. 发送：

   > 用 AlphaSolve 求解 problem.md 中的问题。

点击对话顶部的 **AlphaSolve**，可以查看进度和各个参与者的具体工作记录。工作流确认得到解答后，会把结果写入文件夹中的 **`solution.md`**。

建议先用一道小题试试。多轮检查可能耗时很长、产生较多模型费用；默认同时运行两个求解任务。自动检查不能保证证明正确，结果仍需人工核验。

[npm 包](https://www.npmjs.com/package/dsh-alphasolve) · [进阶使用与开发](docs/advanced.zh-CN.md) · [兼容性说明](COMPATIBILITY.md) · [反馈问题](https://github.com/dxww123/dsh-alphasolve/issues)
