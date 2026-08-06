# AlphaSolve for DSH

[English](README.md)

AlphaSolve for DSH 把 AlphaSolve 的数学求解流程接入 DeepSeek Harness。插件安装后默认
休眠；只有用户明确提到 `AlphaSolve` 并要求用它求解当前工作区的 `problem.md` 时，
才会为该 session 加载求解工具。

## 兼容的 DSH 版本

当前版本针对以下 DSH snapshot 构建并通过测试：

```text
branch: snapshots/20260806T160212Z-279244acb0
commit: b3adbb736ae7dd3c7857eee5d97c82a3ac4ac96f
```

插件使用这一版 DSH 的 profile bundle 和 scoped Agent 生命周期接口。DSH snapshot
之间是独立 root，切换版本时不要把旧 snapshot merge 或 rebase 到新 snapshot。

## 安装

先切换并安装上述 DSH 版本：

```sh
cd /path/to/deepseek-harness
git fetch origin
git switch snapshots/20260806T160212Z-279244acb0
sh scripts/install.sh
(cd ~/.dsh/source/current && pnpm run build)
```

从 GitHub 安装插件时，建议锁定完整 commit SHA，并分别安装到 Web 和终端 profile：

```sh
gh auth login -h github.com
gh auth setup-git
dsh plugin --profile web add 'github:dsh-external/dsh-alphasolve#<完整-commit-SHA>'
dsh plugin --profile headless add 'github:dsh-external/dsh-alphasolve#<完整-commit-SHA>'
```

从本地 checkout 安装：

```sh
cd /path/to/dsh-alphasolve
dsh plugin --profile web add .
dsh plugin --profile headless add .
```

检查两个 profile 的组合结果：

```sh
dsh --profile web --dump-config
dsh --profile headless --dump-config
```

两份输出都应包含一条 `dsh-alphasolve`。自定义 profile 需要单独执行一次
`dsh plugin --profile <name> add ...`。安装或升级后应重新启动对应的 `dsh` 或
`dsh web` 进程；仅刷新浏览器页面不会加载新代码。

## 使用

在终端启动目录，或 `dsh web` 左侧工作区选择器选中的目录中，放置非空 UTF-8
`problem.md`；`hint.md` 可选。终端使用：

```sh
cd /path/to/problem-workspace
dsh --profile headless
```

Web 使用：

```sh
dsh web
```

然后向主 session 明确提出 AlphaSolve 求解请求，例如：

```text
请用 AlphaSolve 求解当前工作区 problem.md 中的问题，最多同时运行 2 个 worker。
```

触发消息必须同时包含完整单词 `AlphaSolve`（忽略 ASCII 大小写）和求解意图。只讨论
AlphaSolve、明确说不要使用它、写成 `alpha solve` 或 `alpha-solve` 都不会激活。
缺少 `problem.md` 时插件会直接说明并保持休眠；已有 `solution.md` 时，主 session 会
先询问是否允许备份并覆盖。

worker 并发容量默认是 `2`，可以在触发消息中明确指定。运行中也可以让主 session
调整容量；降低容量不会取消已经运行的 worker。

## 工作流程

1. 休眠 controller 检查直接用户消息；关键词和求解意图命中后，先确认工作区、
   `problem.md`、可选 `hint.md` 以及已有 `solution.md`。
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

所有 worker 都是 fresh Agent，不能使用 shell、通用代码执行、Web 或任意 subagent。
AlphaSolve 工具、prompt、并发状态和权限只属于触发它的 session；同一 `dsh web`
进程中的其他 session 不会因此新增 AlphaSolve 工具。
