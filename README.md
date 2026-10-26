# dsh-pet-wb 🐾

> [dsh-pet](https://github.com/PC2005-cloud/dsh-pet) 的 fork：一只住在桌面上的透明置顶小宠物，
> 本仓库只做两件事 —— **让它跟随 WorkBuddy 的会话状态**，以及**在 Windows 上能像普通应用一样常驻**。

<p align="center">
  <img alt="fork of dsh-pet" src="https://img.shields.io/badge/fork%20of-PC2005--cloud%2Fdsh--pet-8A2BE2">
  <img alt="base" src="https://img.shields.io/badge/base-v0.3.8-blue">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-green">
  <img alt="platform" src="https://img.shields.io/badge/platform-Windows%20%7C%20DSH-ff69b4">
</p>

## 📌 来源

| 项 | 内容 |
| --- | --- |
| 上游项目 | [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet)（作者 PC2005-cloud） |
| 本仓库 | [underwater133/dsh-pet-wb](https://github.com/underwater133/dsh-pet-wb) |
| 基线版本 | 上游 `main@dfc0396`（v0.3.8 + 2026-10-25 前全部提交） |
| 许可 | MIT，版权归上游作者，见 [LICENSE](LICENSE) |

**功能全集看上游**：动画池、点击/拖拽/甩抛、气泡与碎碎念、对话、余额展示、pet pack、多开、桌面透明窗……
这些本文档不重复，只说明本仓库改了什么、怎么用。配置项见 [`CONFIG.md`](CONFIG.md)，自己造宠物见 [`MAKE-YOUR-OWN-PET.md`](MAKE-YOUR-OWN-PET.md)，包内还有一份 [`dsh-pet/README.md`](dsh-pet/README.md)。

## 🔧 本仓库改了什么

相对上游 **25 个文件、+2016 / −426**，集中在三块：

### 1. WorkBuddy 工作状态联动（新增 `dsh-pet/src/workbuddy/`）

让桌宠感知 WorkBuddy 的"在思考 / 在干活 / 在整理 / 等你确认 / 干完了"，切换对应动画。

| WorkBuddy hook | 翻译成 DSH 事件 | 档位 |
| --- | --- | --- |
| `UserPromptSubmit` | `turn/start` | 0 思考 |
| `PreToolUse` | `tool/call` | 1 工作 |
| `PostToolUse` | `tool/result` | 2 整理 |
| `PermissionRequest` / `Notification(idle_prompt)` | `approval/asked` | 3 等待 |
| `Stop` | `turn/end completed` | 4 成功 |
| `Stop`（以问句收尾） | `turn/end blocked` | 3 等待（它在问你） |
| 会话结束 / 静默超时 | `turn/end aborted` | 清空回空闲 |

设计上有三条硬约束：

- **翻译而不重写**：hook 事件被翻译成 DSH 的 `session/event` 形状，直接复用上游原有的六档聚合（多会话优先级仲裁、终态过期清理、看门狗兜底），下游一行不改，两套宿主不会各自漂移；
- **正文不上行**：`prompt` / `tool_input` / `tool_result` / `last_assistant_message` 在**最靠近宿主的 hook 脚本里**就被丢弃，只留事件名、会话 id、工具名、通知类型、"最后一句是不是问句"这个布尔；不落盘、不出本机；
- **跑飞有兜底**：hook 是"尽力而为"的，崩溃/强杀/超时都会让 `Stop` 永远不来。每条非终态事件都重挂计时器，默认 10 分钟无后续就按 aborted 收掉（`DSH_PET_WB_IDLE_MS` 可调），不会永久卡在"正在进行中哦"。

配套脚本：`dsh-pet/scripts/workbuddy-hook.mjs`（投递，零依赖、250ms 上限、fail-open）、`install-workbuddy-hooks.mjs`（幂等安装/卸载，改 `~/.workbuddy/settings.json` 前先备份）。

### 2. 独立模式多了个宿主参数：`--host`

`dsh-pet-standalone` 原本默认 `--host dsh`，**不接任何会话事件**（宠物只有待机动画）。本仓库加了 `--host workbuddy`：

- 注册 `POST /wb/hook` 投递口（需 `x-dsh-pet-token`）；
- `GET /health` 多出 `workbuddy: { events, dropped, sessions, lastEventAt }` 计数，用来回答"宠物怎么不动了"；
- 事件总线接到伪 ctx 的 `session/event` 上，宿主半边零改动。

### 3. Windows 桌面常驻

| 改动 | 文件 | 说明 |
| --- | --- | --- |
| 一键启停器 | `dsh-pet/scripts/` 下的 `start-pet.ps1` / `.vbs`、`stop-pet.ps1` / `.vbs` | 隐藏窗口启动、首次自动建桌面快捷方式、体检 node/Electron/配置/hooks |

启停器的几个关键点：

- **零绝对路径**：包目录按脚本位置推导、桌面取系统 `Desktop`、`DSH_HOME` 读环境变量（缺省 `~/.dsh`）——仓库搬到哪、拷给谁都能用；
- **默认带 `--host workbuddy`**，并检查 hooks 是否已装（未装直接打印安装命令）；
- **快捷方式自愈**：删掉桌面图标后，跑一次启动器就补回来（包括宠物已经在跑的情况）；
- **退出交给上游**：托盘「退出」是上游能力（`GET/POST /dsh-pet-7340/quit` + `trayEnabled` 开关，issue #178），BRIDGE 模式下由宿主决定能否退，避免 helper 自己退了被当崩溃重启。本 fork 早期曾自带一套 `POST /shutdown` 的托盘退出，同步上游后已删除——只在启停器里保留一个 `stop-pet.vbs` 作为托盘之外的第二出口。

> 同步到 `dfc0396` 后，上游已自带托盘退出、日志落盘、托盘开关、单进程桌面应用与音效；本 fork 不再维护这些的本地实现。

## 🚀 快速开始（Windows + WorkBuddy）

前置：Node.js ≥ 18。

```powershell
cd D:\path\to\dsh-pet-wb\dsh-pet

# 1. 装依赖并完整构建（只跑 npm run bundle 会缺 shared-core.js，窗口会在但一个像素都没有）
npm install
npm run build

# 2. 把桌宠挂到 WorkBuddy 的 hooks 上（幂等；先备份 settings.json，--uninstall 可回滚）
node scripts\install-workbuddy-hooks.mjs

# 3. 完全退出 WorkBuddy 再启动（关窗口不算退出：hook 配置是启动时缓存的）
# 4. 起桌宠：双击 scripts\start-pet.vbs（首次会自动在桌面生成「桌宠」快捷方式）
#    命令行等价：node lib\standalone.js --host workbuddy
```

首次启动会按需下载 Electron（约 100MB，缓存在 `~/.dsh/electron/`），网络受限可设 `DSH_PET_ELECTRON_MIRROR`。

**验证联动是否生效**：在 WorkBuddy 里随便发一句话，然后看

```powershell
(Invoke-WebRequest http://127.0.0.1:3080/health -UseBasicParsing).Content
```

`workbuddy.events` 在涨就说明 hook 通了；一直是 0，多半是 WorkBuddy 没**完全退出**过（或 `/hooks` 面板里还有待审核的外部改动）。

**诊断**：`scripts\start-pet.ps1 -Check` 只体检（打印宿主模式、hooks 条数、配置条目），`-NoLaunch` 只补快捷方式，`-ShortcutOnly` 只补桌面图标。日志在 `dsh-pet/standalone.log`。

## 📖 说明与边界

**能用**：动画链、点击/拖拽/甩抛、右键菜单、多开、自定义动画与表情包、pet pack；`--host workbuddy` 下跟随会话状态切动画。

**不可用（独立模式下刻意不做）**：

- **余额**：WorkBuddy 的积分消耗只存在于服务端，本地没有明文留底，取它必须带登录态调未公开的计费接口。这块**故意不做**，余额路由照旧返回 `unsupported` 的结构化失败，不假装成功；
- **对话 / 碎碎念**：依赖 DSH 的模型通道，独立模式下返回 `provider-missing`；
- **DSH 系统通知**：同上。

**其他要知道的**：

- hook 属于 WorkBuddy 的未公开实现，随版本可能变化；每次 hook 都会起一个 node 进程，本机实测约 180ms/次（其中约 150ms 是 node 启动本身）；
- 配置与上游同一份（`$DSH_HOME/dsh-pet/main-config.jsonc` → 包内默认），设置页「桌宠配置」可改大小/位置/多开/显示位置；
- 桌面窗与浏览器 overlay 共用同一份素材与纯逻辑，`display` 决定每只宠物在哪一端出现；纯 `web` 模式不会启动 Electron，也就没有托盘，用 `stop-pet.vbs` 停止；
- 多开同一台机器只会跑一份服务，第二只会被判「已经在运行」并跳过（避免抢端口、互踩 Electron 缓存）。

## 🔄 与上游同步

```sh
git fetch upstream
git merge upstream/main      # 冲突基本只会在 README 与 standalone 接线（cli / context / options）
```

合并原则：**能跟上游就跟，本地只留 WorkBuddy 适配**。上一轮同步（`dfc0396`）就把本 fork 自带的托盘退出删掉了——上游的 `/quit` 方案更完整，没必要维护两套。

本仓库的包名是 **`dsh-pet-wb`**（与上游的 `dsh-pet` 区分开），可以独立 `npm publish`，不会覆盖上游的包。
唯一残留的同名点是 `bin`：命令仍叫 `dsh-pet-standalone`，与上游同时全局安装时会互相覆盖 PATH 上的同名命令——需要并存就先把这里改成 `dsh-pet-wb-standalone`。

## 📄 许可

MIT，原始版权归 PC2005-cloud；本仓库的改动同样以 MIT 发布。详见 [LICENSE](LICENSE)。
