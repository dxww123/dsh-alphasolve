# AlphaSolve for DSH

[English](README.md)

AlphaSolve for DSH 把
[AlphaSolve](https://github.com/tanzcoding/alphasolve) 的数学求解流程接入
DeepSeek Harness。插件安装后默认休眠；只有用户明确提到 `AlphaSolve` 并要求用它
求解当前工作区的 `problem.md` 时，才会为该 session 加载求解工具。

## 兼容的 DSH 版本

当前版本面向以下 DSH 发布版本和源码 revision：

```text
branch: master
commit: 477b4f420553e8a52c2fbccc464d7561b239c443
package version: 0.1.7-rc.2
```

插件要求 DSH `0.1.7-rc.2`、Cordis `4.0.4`、声明式 Agent preset、Session 投影和当前的 Agent 创建生命周期。不支持更早的 Harness 版本。

## 安装

先确认已安装的 `dsh` 来自上述兼容版本。使用源码 checkout 时，在该精确 revision
上构建：

```sh
cd /path/to/deepseek-harness
git fetch origin
git switch --detach 477b4f4205
pnpm install
pnpm run build
```

从 GitHub 安装插件时，建议锁定完整 commit SHA，并分别安装到 Web 和 Headless
profile：

```sh
gh auth login -h github.com
gh auth setup-git
dsh plugin --profile web add 'github:dxww123/dsh-alphasolve#<完整-commit-SHA>'
dsh plugin --profile headless add 'github:dxww123/dsh-alphasolve#<完整-commit-SHA>'
```

从本地 checkout 安装：

```sh
cd /path/to/dsh-alphasolve
dsh plugin --profile web add .
dsh plugin --profile headless add .
```

检查两个 profile 的组合结果：

```sh
dsh --version
dsh plugin --profile web list --depth 0
dsh plugin --profile headless list --depth 0
dsh --profile web --dump-config
dsh --profile headless --dump-config
```

`dsh --version` 应输出 `0.1.7-rc.2`，两份依赖列表都应显示
`@dsh-external/dsh-alphasolve`，两份 config dump 都应恰好包含一条
`dsh-alphasolve`。Headless profile 必须使用当前的 `base + headless` 组合，不能包含
Web bundle。自定义 profile 需要单独安装插件。安装或升级后应重新启动正在运行的
`dsh web` 进程；仅刷新浏览器页面不会加载新代码。

## 桌面端安装

使用 DeepSeek Harness Desktop `0.1.7-rc.2`。先在此仓库运行 `pnpm run build`，再运行 `pnpm pack` 生成安装包，通过桌面端的插件管理器安装该本地包，并按提示重启 Host。桌面端拥有独立的插件 profile；通过 CLI 安装到 Web 或 Headless 不会安装到桌面端。CLI 不能修改 Desktop profile。

## Python 与 SymPy

首次启动 compute helper 前，在本插件仓库运行环境准备脚本：

```sh
node scripts/setup-python.mjs
```

脚本需要 Python 3.10 或更新版本，在 `${DSH_HOME:-~/.dsh}/runtimes/alphasolve-python` 建立禁用系统 site-packages 的专用环境，并安装 SymPy 1.14.0 与 mpmath 1.3.0。插件在 Windows 使用其中的 `Scripts/python.exe`，在 macOS/Linux 使用 `bin/python`。helper 启动时会检查 SymPy 能否导入，缺少依赖时直接报告错误，不会退回算术计算器。启动 compute helper 时，Harness profile 需要提供 `subprocess` 和 `sandbox` 服务。

`compute` 和 `numerical_experiment` 都使用 `alphasolve_python`。每个 helper 拥有独立的持久 Python 进程：导入的模块、变量、函数和精确 SymPy 对象在该 helper 的多次调用之间保留，helper 结束后清理。超时、取消或解释器故障会结束进程，工具会说明状态已重置；下一次执行从新的计算命名空间开始。普通 Python 异常保留已有命名空间。成功结果包含 stdout、stderr、最后一个表达式、输出是否截断以及 SymPy 版本。只打印相关结果，代码与输出都有长度限制。

Python 使用 Harness 的只读进程策略，并叠加仅允许读取运行依赖的 Python 策略。项目输入通过 helper 获准的文件工具读取，再把所需定义写入代码。Python 不能写入项目文件、读取其他 worker 的草稿、启动子进程或访问网络。Windows 上 Harness 的只读后端报告为部分执行（partial）。Python 的审计与语法策略补充数学工作所需的限制，但不构成针对恶意代码或原生扩展的强沙箱。只有这两个 helper 角色获得此工具，普通 workflow 角色继续使用原有工具权限。

如需使用已有的 Python 3.10+ 环境，须安装 SymPy 1.14.0 与 mpmath 1.3.0，在 AlphaSolve 插件的部署配置中填写 `python.executable`。其余可选字段是 `timeoutMs`（默认 `300000`）、`maxOutputChars`（`65536`）、`maxCodeChars`（`200000`）和 `graceMs`（`1000`），均为不大于 `2147483647` 的正整数，其中 `maxOutputChars` 至少为 `1024`。这些字段属于插件的 Cordis 配置，不属于 `.alphasolve/config.json` 或模型配置。例如插件配置项可写为：

```yaml
name: '@dsh-external/dsh-alphasolve'
config:
  python:
    executable: 'C:/Python/python.exe'
    timeoutMs: 300000
```

修改此部署配置后重启 Host。数学 Session 与已有会话记录保留；Python 内存只存在于各自运行中的 helper。

`@dsh-external/dsh-alphasolve/python` 入口导出 `PythonSession` 和 `resolvePythonOptions`，供需要通过 Harness subprocess、sandbox 服务嵌入该解释器的调用方使用。

## 查看 worker 工作情况

在 Desktop 或 Web 的主会话顶部点击 **AlphaSolve**，打开右侧工作流面板。面板先按 worker、再按验证轮次归组；正在执行的 worker 和当前轮默认展开，已完成的 worker 与历史轮次可以折叠。每个角色显示状态和模型请求步数，点击 **查看执行记录** 会打开 Harness 原生会话，查看模型消息和工具调用。角色 Agent 结束并释放后，仍然可以查看其会话。角色调用的助手会话显示在该角色下面。

一个 worker 是工作流，不是单个子智能体会话。generator、各 verifier、reviser、定理检查器和辅助角色分别拥有独立 Session；这些角色会话不会出现在普通左侧会话列表中。worker 完成后，知识整理任务仍可能继续。

面板通过工作区文件监听读取当前主会话的 `.alphasolve/workflows/<主会话-id>.json`，不依赖 `detailedTrace`。请保留工作区中的该目录和 Harness 的 Session 存储：前者保存进度与会话链接，后者保存会话正文。恢复 AlphaSolve 时，旧运行中未结束的观察记录会标记为中断。

工作流关联从 0.3.0 起记录。早先角色的会话正文仍由 Harness 保存，但缺少完整的工作流索引，无法自动恢复所有归组关系。从没有客户端界面的旧版升级后，需要完整重启 Desktop 或 Web Host，仅刷新网页不足以加载新界面。

## 使用

在终端启动目录，或 `dsh web` 左侧工作区选择器选中的目录中，放置非空 UTF-8
`problem.md`；`hint.md` 可选。

Headless 是 one-shot surface：必须把完整的 AlphaSolve 请求作为 task 参数传入。它会
创建一个新的持久化 session，打印最终回答，然后退出：

```sh
cd /path/to/problem-workspace
dsh --profile headless "请用 AlphaSolve 求解 problem.md，最多同时运行 2 个 worker。"
```

长期运行的 Web surface 使用：

```sh
dsh web
```

选择包含 `problem.md` 的工作区，然后选择兼容的 Agent preset：

| Web preset | AlphaSolve 行为 |
|---|---|
| `standard` | 支持。 |
| `cordis` | 支持；AlphaSolve 对各 role 的更窄权限仍然生效。 |
| `ptc` | 支持。AlphaSolve 激活期间使用 native 工具呈现，`run_code` 仍被禁止；卸载后恢复 PTC 呈现。 |
| `minimal` | 返回 `agent_preset_missing_required_tools` 并拒绝激活；插件不会暗中补充缺少的权限。 |

自定义 preset 必须同时提供 `read`、`write`、`edit`、`glob` 和 `grep`，并且不能用
complete system prompt 压掉 AlphaSolve 的工作流 section；否则插件会返回
`agent_preset_blocks_alphasolve_prompt` 并拒绝激活。在 Web 主 session 中明确提出
AlphaSolve 求解请求，例如：

```text
请用 AlphaSolve 求解当前工作区 problem.md 中的问题，最多同时运行 2 个 worker。
```

触发消息必须同时包含完整单词 `AlphaSolve`（忽略 ASCII 大小写）和求解意图。只讨论
AlphaSolve、明确说不要使用它、写成 `alpha solve` 或 `alpha-solve` 都不会激活。
缺少 `problem.md` 时插件会直接说明并保持休眠；已有 `solution.md` 时，主 session 会
先询问是否允许备份并覆盖。

worker 并发容量默认是 `2`，可以在触发消息中明确指定。运行中也可以让主 session
调整容量；降低容量不会取消已经运行的 worker。

Web 进程重启后，只要重新打开的是同一个 session 和同一个工作区，插件就会在首条
后续消息交给模型前自动恢复此前已经激活的 AlphaSolve runtime；此时只说“继续”即可。
新 session、其他 session，以及已经调用过 `alphasolve_stop` 的 session 仍保持休眠，
必须重新明确提出包含 AlphaSolve 关键词的求解请求。Headless 的每个 one-shot task
始终创建新 session，不提供交互式续跑命令。

## 工作流程

1. 休眠 controller 检查直接用户消息；关键词和求解意图命中后，先确认当前 session
   的 Agent preset、必需文件工具、工作区、`problem.md`、可选 `hint.md` 以及已有
   `solution.md`。
2. preflight 通过后，只为当前 session 创建 runtime，并建立 `knowledge/`、
   `unverified_propositions/`、`verified_propositions/` 和 `.alphasolve/`。
3. 主 session 通过 `alphasolve_worker` 异步启动 worker；达到容量时不会排队。
   无参数 `alphasolve_wait` 等待第一个完成项，并返回自上次成功 wait 后尚未交付的
   全部完成结果。
4. 每个 worker 固定执行：

   ```text
   generator
   -> format/references、citation、failure-modes、stepwise、premise-chain verifier 全部通过
   -> 若数学检查失败，由 fresh reviser 修改同一候选并重新运行完整 verifier（最多 6 轮）
   -> 5 次独立 theorem-checker 检查
   ```

5. 通过检查的 proposition 才会晋升到 `verified_propositions/`。后台 curator 可以整理
   研究材料，主 session 也可以发起只读 research review，再据此拆分下一批 worker
   任务。
6. 当一个 verified proposition 解决原题时，插件原子写入 `solution.md`。最后一个成功
   工具结果先写入 session，runtime 随后在下一 step 前卸载。尚未求解时 runtime 继续
   驻留，等待用户指导或后续 worker。
7. 同 session 恢复时，插件会核对 session 标识、工作区和 `problem.md` digest，并恢复
   已持久化的容量及模型设置。旧进程结束时仍在运行的 worker 会保留已有 artifacts，
   并且只生成一次 `interrupted` 完成项；主 session 读取后可重新派发替代 worker。插件
   不会伪装成能从某个 LLM workflow 阶段的中间位置继续执行。

curator 在同一个主 Session、同一道题的同一轮求解中持续复用一个持久 Session，Desktop 重启或 AlphaSolve 重新激活后也会恢复。每个队列任务恢复对话历史，同时重新绑定当前任务的工具和权限。curator 复用已有的知识库结构记忆，只按需读取相关笔记与当前修改目标；健康检查仍会检查根索引。Session ID 保存在 `.alphasolve/curator/session.json`，对话历史由 Harness 保存。换主 Session、换题，或题目求解完成后重新开始一轮，会建立独立的 curator 对话。已保存的历史缺失或损坏时会明确报错。

所有 worker 都是 fresh Agent：先加入主 session 正在使用的同一 preset generation，
再叠加 AlphaSolve 针对各 role 的权限收窄。worker 不能使用 shell、`run_code`、Web 或
任意 subagent。AlphaSolve 工具、native 呈现覆盖、prompt、并发状态和权限只属于触发
它的 session；同一 `dsh web` 进程中的其他 session 不会因此新增这些能力。

## 角色文件查找

标准文件工具的路径以会话工作区为基准，worker 角色也遵循此规则。generator 的任务会给出命题文件和可用 worker hint 的准确路径，并已包含原题与可用提示；可选文件和索引可能不存在。

`glob` 的 `path` 可以省略、填写 `.` 或使用工作区内的绝对路径。它只搜索角色获准读取的目录和文件，并在返回路径或工具卡片数据前逐项检查权限及符号链接目标。generator 的宽范围搜索只展示自己的候选证明，verifier 仍保留独立的输入范围。`read`、`write`、`edit` 使用工作区相对路径；`grep` 必须显式指定可读文件或目录，例如 `knowledge`。

curator 工具使用工作区相对的 `knowledge/...` 路径，list/grep 还允许用 `.` 表示知识库根目录。curator 读取的结束行超过文件长度时会截到文件末尾，并返回实际行号范围。

## 开发与验证

将此仓库与对应版本的 `deepseek-harness` 仓库放在同一父目录中。开发依赖链接到 Harness 工作区包，`vitest.config.ts` 直接用 Harness 源码运行测试，并复用其标准装饰器转换。在编译 AlphaSolve 或运行打包安装验证之前，先安装并构建 Harness。

```sh
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm test
pnpm run test:packed
```

打包安装验证会在隔离的临时使用方目录中，通过真实 Cordis Loader 和当前 Harness 服务加载 tarball，不会发送模型请求。数学求解质量和桌面 UI 的完整流程需要使用已配置的模型提供方另行验证。

在 Windows 上，可以直接对已安装的桌面端做加载验证：

```sh
pnpm run test:desktop-load "C:/path/to/DeepSeek Harness"
```

该检查核对桌面端内置依赖版本，并在其 Electron Host 中加载插件；使用临时应用目录，不修改桌面端的 profile，不打开 UI，也不发送模型请求。
