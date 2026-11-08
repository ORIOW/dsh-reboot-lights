# dsh-reboot-lights — DSH 重启安全红绿灯

DSH 插件：在 GUI 主页右下角悬浮红绿灯，提示当前是否可以安全重启 DSH。

- **只收集 + 显示**，绝不做自动重启 / 退出动作。
- 红灯 = 不允许重启；黄灯 = 需等待 / 退出后需手动执行操作；绿灯 = 可直接重启。

## 功能

- **右下角三态悬浮红绿灯**（`shell.overlay`）：聚合所有参与会话的 `reboot_light` 上报裁决。
- **「重新检测」按钮**：触发 `detect()`，只唤醒最近 15min 内活跃的会话，并自动跳过自动会话（如记忆中枢 / `dam-workbench-` 前缀），省 token。
- **面板显示**：每会话用「工作区名 · 会话名」展示，而非 sessionId。
- **黄灯手动步骤文档**：黄灯会话的手动步骤统一写入 `~/user_reboot_SOP.md`，各会话独立章节、锚点整段替换、串行写队列互不破坏。

## 架构

- **host 半身**（`lib/index.js`）：
  - 注册 `reboot_light` 工具，各会话 agent 上报 `{light, reason, manualSteps?}`。
  - `detect()` 通过 `ctx.agents.list()` + `ctx.sessionController.listState.list()`（async、按 15min 活跃过滤）找出目标会话，`agent.followup(createUserMessage(promptText))` 插入检测 prompt。
  - `writeSop()` 用 `node:fs/promises` 直写 `~/user_reboot_SOP.md`（绕过 cordis 沙箱的 `FS_SANDBOX_DENIED`），锚点整段替换 + 串行写队列。
  - 3 条 webServer 路由：`GET /state`、`POST /detect`、`POST /open-sop`。
- **client 半身**（`lib/client.js`）：`window.__ModuleLoader__.load` 信封，挂 `shell.overlay`，轮询 `/state` 聚合显示，面板带「重新检测」按钮。
- **消息构造收口**（`lib/user-message.js`）：`createUserMessage(text)` 是唯一构造入口，补齐 `id/role/content/source`，避免宿主读取端 `assertMessageEventShape` 判会话损坏。

## 安装

本地插件开发目录，经 `scripts/mount-reboot-lights.mjs` 挂载到 DSH profile（symlink + cordis.patch.yml insert）。

```bash
node scripts/mount-reboot-lights.mjs --apply
```

## 开发约定（硬约束）

- client 半身不使用 ESM（`window.__ModuleLoader__.load` 信封）。
- `role:'user'` 字面量只允许出现在 `lib/user-message.js`。
- 写主目录用户文档用 `node:fs/promises`，不走 cordis 沙箱 `ctx.fs`。
- 对外文档里的每条命令必须先在本机实测通过再写入。

## 验证

```bash
node --check lib/index.js lib/client.js lib/user-message.js
node scripts/check-user-message.mjs
```