# dsh-reboot-lights — 需求文档

日期：2026-10-25
状态：需求已澄清，待用户发话开工

---

## 1. 要解决什么问题

DSH 会话一多，用户经常记不清「现在到底能不能重启 DSH」——有没有会话还在跑、有没有会话退出后需要手动收尾。重启 DSH 是低频但高危的操作，疏忽的代价是丢上下文、断任务。

**目标**：在 DSH 主页面上悬浮一个红绿灯，实时告诉用户当前能否执行 DSH 重启。

**明确不做**（用户两次澄清后收窄的范围）：
- 插件**不执行任何自动重启 / 自动退出 DSH 的动作**。它只收集、只显示。重启始终由用户手动完成。
- 插件**不自行检测** jobs / terminals / subagents / worktrees 等阻塞源。「能不能重启」的判断完全交给每个会话的 agent 自己做，因为它最了解自己正在干什么。

---

## 2. 核心机制

### 2.1 三方角色

| 角色 | 职责 |
|---|---|
| **各会话的 agent** | 被询问时判断自己当前状态，产出红绿灯裁决 + 理由 + 黄灯时的手动操作步骤 |
| **插件 host 半身** | 注册 tool 接收上报；主动给每个 live session 插 prompt 触发判断；聚合并裁决；维护共用 SOP 文档 |
| **插件 client 半身** | 在 GUI 右下角渲染悬浮红绿灯，展示聚合结果与各会话明细 |

### 2.2 数据流

```
用户点击红绿灯「重新检测」（或定时触发）
        │
        ▼
host 遍历 ctx.agents.list() —— 只含进程内 live agent，天然不会激活冷会话
        │
        ▼
对每个 live agent：agent.followup(createUserMessage({content, source:{kind:'user'}}))
「请判断当前你是否可以被 DSH 重启中断，并调用 reboot_light 上报」
        │
        ▼
每个 agent 自行判断 → 调用 reboot_light tool 上报：
  { light: 'red'|'yellow'|'green',
    reason: string,
    manualSteps?: string[] }      ← 仅 yellow 时提供
        │
        ▼
host 记录 Map<sessionId, 上报结果>，按规则聚合
        │
        ▼
client fetch('/api/reboot-lights/state') 轮询 → 渲染红绿灯
```

> ⚠️ **触发路径只能用 host 侧 `ctx.agents.list()` + `agent.followup()`**。
> client 侧的 `remote.session.prompt({sessionId, mode})` 会先 `resolveAgent(sessionId)`——
> **激活冷 agent 并触发一轮 LLM 调用**，不适合做探测触发。

### 2.3 聚合规则（用户拍板，极简）

> 只要所有有返回红绿灯值的会话中包含一个红灯，就显示红灯；
> 若没有红灯，所有都是绿灯，就显示绿灯；
> 其他情况显示黄灯。

即：
- 任一会话 `red` → **红灯**
- 全部已上报会话都是 `green` → **绿灯**
- 其他（存在 `yellow`、或有会话未上报 / 无响应 / 正在判断中）→ **黄灯**

「未上报」一律按最保守处理为黄灯，不假设为绿。

### 2.4 谁算「参与裁决的会话」

只有 **live agent** 参与——即 `ctx.agents.list()` 返回的集合。理由：
- 冷会话（已关闭、未恢复）本来就不占资源，重启不会丢它的东西，无需询问
- 用 `remote.session.prompt` 去问冷会话会把它激活，反而制造浪费

因此「未上报」指的是：**在 `ctx.agents.list()` 里、但这轮检测还没回来的 live agent**。

### 2.5 客户端侧辅助数据源（可选增强）

client 半身可直接读到两个权威源，用于在 agent 还没上报前就先显示「有会话在跑」：

| 源 | 形状 | 用途 |
|---|---|---|
| `ctx.get('uiSession').sessionStatus` | `Map<sessionId, {running, pendingInteraction, completionUnread}>`，`getSnapshot()/subscribe()` 双接口 | 有会话正在跑 / 有人在等你 / 有完成未读 |
| `ctx.get('sessions').list` | `{ids, byId, phase, projectionsBySession}`，`phase ∈ 'pending'\|'ready'` | 枚举全部会话（含冷会话），行含 `running` / `agentAvailable` / `origin` |

**M0-M1 阶段不必用这两个源**——红绿灯只显示 agent 上报的聚合结果就够了。它们留作后续「未上报时也能给出初步判断」的增强。

坑：`ctx.get()` 默认 `strict=true`，client 插件若比 uiSession 更早 apply 会拿到 `undefined`，**必须复刻 notify-me 的 1.5s 重试逻辑**。

---

## 3. 黄灯与 user_reboot_SOP.md

### 3.1 文档定位

- 文件名固定：`user_reboot_SOP.md`
- **所有返回黄灯的会话共用这一个文档**，不是每会话一个文件
- 每个黄灯会话在文档中写入**自己的独立章节**
- **不得影响/破坏其他会话已经编写好的内容**

### 3.2 写入规则（并发安全）

多个会话可能在同一时刻都判定为黄灯并同时要求写文档，必须串行化：

1. host 侧维护一个内存写队列（Promise 链），所有写操作排队执行，任一时刻只有一个写者在改文件
2. 每次写入 = 读全文 → 定位自己的章节锚点 → 只替换/插入自己那一段 → 写回
3. 章节锚点用 sessionId 派生，稳定且不会与会话标题变化耦合
4. 文件不存在时初始化（写入文档头 + 本文档用途说明）
5. 会话从黄灯转为绿/红时，**保留**其已写章节，并在章节头标注最新状态。理由：避免用户正看着的步骤突然消失；历史记录也有参考价值。（用户已确认）

### 3.3 章节结构（草案）

```markdown
# user_reboot_SOP — DSH 重启前待办

> 本文档由 dsh-reboot-lights 插件在各会话判定为黄灯时自动生成/更新。
> 每节对应一个会话，按会话分组。退出 DSH 后请逐节执行。

<!-- reboot-lights:section:session-<uuid> -->
## 会话：<displayTitle>

- 会话 ID：`session-<uuid>`
- 工作目录：`<cwd>`
- 判定时间：2026-10-25 19:40
- 理由：<agent 给的 reason>

### 需要手动执行的步骤

1. <manualSteps[0]>
2. <manualSteps[1]>

<!-- reboot-lights:section:end:session-<uuid> -->
```

锚点注释 `<!-- reboot-lights:section:...-->` 让「只改自己那段」可以精确实现：按 `section:<sessionId>` 到 `section:end:<sessionId>` 定位，整段替换。

### 3.4 打开文档

黄灯出现时，host 侧通过 `ctx.subprocess.spawn` 调 `open <path>`（macOS）把文档交给系统默认程序打开。已确认 `ctx.subprocess.spawn` **不受** `sandboxPolicy` gate（该 gate 只管模型侧 tool/fs 调用）。

**文档位置（已定）**：`~/user_reboot_SOP.md`，即用户主目录。理由：这份文档的使用场景就是「DSH 已经关了」，放主目录最好找；且多会话可能跨 workspace，放 workspace 会分裂。

---

## 4. 红绿灯 UI

### 4.1 挂载位置

`shell.overlay` slot（root 作用域，list kind，全屏浮层）。已实测该 slot 存在且被 dsh-worktable 用作悬浮分屏覆盖层，路径可行。

注册方式：

```js
ctx.slots.inject('shell.overlay', () => ctx.slots.register({
  name: 'shell.overlay',
  id: 'dsh-reboot-lights',
  order: 100,
}, TrafficLight))
```

### 4.2 视觉与交互

- 右下角固定（`position: fixed; right/bottom`），圆形或圆角胶囊，三色：红 `#f85149` / 黄 `#d29922` / 绿 `#3fb950`
- 收起态只显示灯；点击展开为面板，列出每个会话的裁决、理由、黄灯章节链接
- 展开面板含「重新检测」按钮（触发一次全量 prompt 插入）和「打开 SOP 文档」按钮
- **不得拦截其他区域的点击**：容器根元素 `pointer-events: none`，只有灯本身和展开面板 `pointer-events: auto`
- 主题 token 走 `--dsw-alias-*`（背景 `--dsw-alias-bg-layer-*`、文字 `--dsw-alias-label-primary/secondary/tertiary`、边框 `--dsw-alias-border-l1/l2`）
- z-index 需高于 overlayLayer 自身（overlayLayer CSS 为 `z-index:20; pointer-events:none; inset:0`），参考 dsh-worktable 用 5000 量级
- 明暗主题都要可读

---

## 5. 已确认的技术结论（编码时直接照做）

来源：`/Applications/DSH Desktop.app/Contents/Resources/app.asar`（harness 0.2.1-rc.2，desktop shell dsh-desktop 0.12.1）。asar 是纯文本可 grep（`grep -aon`），行号已记录。

### 5.1 插件骨架

| 文件 | 要点 |
|---|---|
| `package.json` | `exports` 必须四项：`.` → `./lib/index.js`、`./client` → `./lib/client.js`、`./cordis.patch.yml`、`./package.json`。缺 `./cordis.patch.yml` 会 `ERR_PACKAGE_PATH_NOT_EXPORTED` |
| `package.json` → `dsh.bundle.patch` | `./cordis.patch.yml` |
| `package.json` → `dsh.client` | `{ platform: 'web', inject: ['@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-runtime'] }` |
| `cordis.patch.yml` | 一条 insert：`- insert: [{id: reboot-lights, name: dsh-reboot-lights}]` |
| `lib/index.js` | host 半身，ESM。`export function apply(ctx, config) {}` + 可选 `export const inject` / `export const Config` |
| `lib/client.js` | client 半身，**必须是 `window.__ModuleLoader__.load({id, factory})` 信封**，不能有 import/export 语句 |

**两个硬坑（用户踩过，其中一条已被实测推翻）**：
1. client 半身**不是 ESM**——字节被原样当经典 script 注入，写 `import` 会直接让整个 web 插件启动失败
2. ~~插件日志用 `console.log`，不要用 `ctx.logger`~~ —— **这条旧经验在 0.2.1-rc.2 已不成立**。实测 `~/Library/Logs/DSH Desktop/harness.log` 里含 `ctx.logger.warn()` 的输出（`[stderr] [harness-log] warn skill-registry: ...` 格式，对照 `cordis-plugin-loader/lib/index.js:590`），说明 harness 组装层给 logger 挂了 stderr exporter。`console.log` 走 stdout 也进同一文件（`[stdout]` 前缀）。**推荐用 `ctx.logger`**（带 name/level 可过滤）
3. 注册设置页用 `settings.section`，**不要用 `settings.plugin.item`**（该 slot 在 0.2.1-rc.2 不存在）

### 5.2 host 侧注册 tool

- **`defineTool` 的 `parameters` 同时接受简写 JSON Schema 对象字面量和 schemastery Schema**。官方样例 `dsh-tool-jobs/lib/index.js:297-381` 用的就是对象字面量：
  ```js
  parameters: { job_id: { type: "string", required: true, description: "..." },
                wait: { type: "boolean", description: "..." } },
  ```
  编译链 `parameterSchemaSpecToJsonSchema` → `compilePropertyMap` → `runSchemaCompiler({kind:'property-map'})`（asar:2258418/2258372）两种都吃
- **`output` 必填**，且 `output.render` 缺失会抛 TypeError。官方样例：
  ```js
  output: { schema: { type:"object", additionalProperties:false, properties:{ text:{type:"string",required:true} } },
            render: (_args, value) => [{ type:"text", text: "..." }] },
  ```
- handler 签名 `execute(args, exec)`；`args` 已按 `parameters` 校验过，校验失败抛 `ToolArgsError`
- `exec` 构造处（`dsh-tools/lib/index.js:3230-3252`）：`{ token, callId, rootCallId, name, signal, agent?, parent?, schema?, deferContext(), concludeTurn() }`
- **调用方 sessionId = `exec.agent.session.id`**（`dsh-tools/lib/index.js:1531` 实证 `calls.run(exec.agent.session.id, ...)`）。`agent.id` 与 `sessionId` 同值，`dsh-tool-jobs` 就直接用 `exec.agent?.id`
- `run_code` 是保留名，不可注册
- 官方样例在 `dsh-tool-jobs/lib/index.js:297-381`，可直接照抄结构

### 5.3 host 侧主动给 live session 插 prompt

`ctx.agents.list()` 返回 live Agent 数组。Agent 上有三个 inbox 写入方法（asar:603804 起）：

```js
send(message, target, wakeup)   // 底层
followup(input)  → send(input, 'next-turn', true)   // 下一轮 + 唤醒
steer(input)     → send(input, 'next-step', true)   // 下一步 + 唤醒
inject(input)    → send(input, 'next-step', false)  // 下一步 + 不唤醒
```

消息构造参考 asar:597610：

```js
const message = createUserMessage({ content, source: { kind: 'user' } })
agent.followup(message)
```

**选型**：要「触发一次判断」，用 `followup`（会唤醒 agent 跑一轮）。`inject` 不唤醒，会一直躺在 inbox 里直到有其他输入，不适合。`steer` 会插到当前 step 前，干扰正在进行的回合，不适合。

副作用：会产生一条可见的用户消息（source 为 user）并触发一次 LLM 调用。这是必要的代价——判断必须由模型做。

**live agent 的权威集合**：`ctx.agents.list()`（`dsh-agent/lib/index.js`，`list()` = "All live agents, in registration order"）。关键事实：
- `agent.id` 与 `sessionId` **是同一个 id**（`dsh-agent/lib/index.js` 的 `get(id)` 注释原文 "the shared agent/session id"）
- agent 对象带 `get status()`，`phase.kind ∈ idle|maintenance → 'idle'`，其余 → `'running'`（`dsh-agent-loop/lib/index.js:775-800`）
- agents 注册表按 agent 生命周期（dispose 即注销）；`ctx.sessions.list()` 按 session 生命周期，更宽但权威性次之

⇒ **「活着且能插 prompt 的会话」就用 `ctx.agents.list()`**，不需要额外合并 sessions 列表。

### 5.3b 上报状态的两种落地方式

| 方式 | 做法 | 评价 |
|---|---|---|
| **A. host 内存 Map（推荐）** | tool handler 写 `Map<sessionId, 上报结果>`，webServer 路由直接返回 | 最简单。DSH 重启后旧裁决无意义，本就不该保留 |
| B. 扫 session 事件 | host 调 `ctx.sessionQuery.filterEvents(sessionId, [{kind:'type', values:['tool/result']}])` 反查每次上报 | 权威可重建，但每次都要全扫；且 `ctx.sessionQuery` 对**冷会话**的覆盖度未实测 |

`ctx.sessionQuery` 契约（`dsh-session-query/lib/index.js:1041-1200`）：
- `readSession(sessionId)` → `{session: header, inheritedEventCount, events: []}`，注释原文 "without making it live"
- `listEvents(sessionId)` → `[{sessionId, seq, type, time, surface}]` 升序
- `filterEvents(sessionId, filters)` → filters 是 ANDed 数组 `{kind:'seq'|'time'|'type'|'surface'|'text'}`

**M0-M1 用方式 A**。方式 B 留作后续「刷新页面后恢复上次检测结果」的备选——但注意刷新页面后 agent 仍然 live，内存 Map 也在，其实不需要 B。

### 5.4 client → host 数据通道（推荐方案）

**方案 A（推荐）：host 注册 webServer 路由 + client fetch。**

- 静态 client 插件**没有** `host.call`——那只对 dynamic cordis 包可用（`harness.handle` 配对，asar:1075512）
- `ctx.inject(['webServer'], (webCtx) => { ctx.effect(() => webCtx.webServer.register({kind:'exact', path, handler})) })` —— **必须延迟注入**：`ctx.get('webServer')` 返回 undefined、路由会消失。真实样例 dsh-zcode-connector:115-144；**M1 实测确认**（dsh-zcode-native M1 findings）：handler 拿 Node 原生 req/res，`(kind, path)` 重复注册抛错（`dsh-host-webserver/lib/index.js:326-333`）
- client 侧直接 `fetch('/api/reboot-lights/state')`，同源带 cookie，无需额外鉴权。dsh-worktable 的 client 就是这么读 `/api/worktable/*` 的（`lib/client.js:19009` 等处）
- 状态接口返回聚合结果 + 每会话明细；再加一个 `POST /api/reboot-lights/detect` 触发检测

### 5.4b client 半身可直接读的权威源（无需经过 host）

调研确认 client 半身自己能读到「每会话当前状态」，不依赖 host 中转：

**① `ctx.get('uiSession').sessionStatus`** — `Map<sessionId, {running, pendingInteraction, completionUnread}>`，手写 observable store（`getSnapshot()` + `subscribe()`）。写入点 `dsh-client-ui-session/lib/client.js:976-991`；`running` 由 Host `ctx.on('agent/status', ...)` → `ctx.emit('api-session/status', agent.id, status==='running')` 驱动（`dsh-api-session-controller/lib/types/index.js:271-273`）。

`pendingInteraction` 是 domain 类实例（如 `PendingApproval`，`kind ∈ 'approval'|'plan-review'|'question'`），**不是 plain JSON**；判定「有待处理交互」只检查非空即可。

**② `ctx.get('sessions').list`** — `getSnapshot()` 返回 `{ids, byId, phase, projectionsBySession}`；`byId[id]` 行字段：`id, displayTitle, running, retainedBy, blank, updatedAt, formatStatus, parentId, origin, title, cwd?, projectionValues`（`dsh-api-session-controller/lib/types/client/sessions/service.js:513-587`）。`phase ∈ 'pending'|'ready'`，**只有 `ready` 才是可信全量**。

**③ slot 提供的 hooks** — `shell.overlay` 的组件能从 slot catalog 拿到 `useSessionStatus` / `useSessions` 等标准 hooks（`dsh-client-ui-session/lib/client.js:1104-1108` 的 `ctx.slots.provideRoot`）。完整签名待实测。

**两个必须避开的坑**：
- `ctx.uiSession` 直接属性读会抛 `cannot get property "uiSession" without inject`，**必须走 `ctx.get()`**
- `ctx.get()` 默认 `strict=true`，client 插件比 uiSession 更早 apply 会拿到 `undefined`，**必须复刻 notify-me 的 1.5s 重试 timer**
- 冷会话行 `running`/`agentAvailable` 恒 false（`list.js:2186 summarizeCold`）

**`remote.session.control` 流不能单独作数据源**：`SessionControlFrame` 的 baseline 只含 `projections`（`SessionProjectionMap` 全键含 `inbox / subagentTiming / userQuestions / todos / agentTeam / goal / plan`），**没有 `running` 布尔值**，且 baseline 只覆盖 attached session。

### 5.5 红绿灯 UI

`shell.overlay` 注册见 4.1。`overlayLayer` CSS = `z-index:20; pointer-events:none; inset:0`（asar 实测），子元素需显式 `pointer-events:auto`。

**调研补充的关键细节**：

- slot 声明 `{kind:'list', scope:'root'}`，渲染处 `renderSlot("shell.overlay", {})`，**props 恒为 `{}`**
- registration：`id` **必填**（`dsh-client-ui-slots/lib/index.js:182` 缺 id 直接抛错）；`order`/`label`/`priority` 可选；同 id+priority 重复注册抛错
- overlayLayer 实际 CSS：
  ```css
  .overlayLayer{z-index:20;pointer-events:none;position:absolute;inset:0}
  .overlayLayer>*{pointer-events:auto}
  ```
  ⇒ **外层已自动点击穿透，直接子元素自动恢复点击**。挂载根元素必须紧贴红绿灯本身，**不要包一个全屏 `inset:0` 的 div**（那会把整个屏幕的点击都吃掉）
- 定位用 `position:absolute; right:16px; bottom:16px`，**不要用 `fixed`**（会逃出 frame 的 `overflow:hidden` 与 Windows titlebar padding）
- **底部避让**：`.frame` 是 `grid-template-rows:minmax(0,1fr) auto`，`shell.bottom`（composer）占第二行，而 overlayLayer 覆盖整个 frame ⇒ `bottom:16px` 会压在 composer 右下（发送按钮区）。建议 bottom 取值高于 bottomRow 实际高度，或改用右侧居中
- macOS 顶部避让变量 `--dsh-frame-overlay-top`
- 真实样例：`dsh-client-ui-schedule/lib/client.js:7420` 注册 `shell.overlay`

### 5.6 写文档并打开

**写文件**（`ctx.fs`）：
```js
const target = await ctx.fs.resolve(absPath, { cwd, signal })   // → {targetKey, displayPath}
await ctx.fs.writeText(target, content, expected?, signal)      // → {operation:'create'|'update', version, before, after}
```
`expected.kind` 支持 `replaceIfVersion` / `createIfAbsent`。官方样例 `dsh-tool-fs/lib/index.js:606-610`。

**打开文件**：**host 半身没有官方入口**。官方只在 Desktop 主进程 `out/main/index.js:23304-23312`（`ipcMain.handle("harness:open-in-finder")` → `shell.openPath(path)`，带 `assertTrustedMainWindowEvent`），经 contextBridge 给 renderer（`out/preload/index.cjs:1700` `openInFinder`）。host 插件拿不到。

host 侧两条替代（推荐序）：
1. **`ctx.subprocess.spawn` 跑 `open <path>`**（推荐）。`ctx.sandboxPolicy.resolve({session})` 只返 `{mode, workspaceRoot}` 给 bash/fs 用（`dsh-sandbox-policy/lib/index.js:133-141`），**不门控 subprocess**（`dsh-subprocess-local/lib/index.js:1547` 全函数无 sandboxPolicy 读取）。官方 host 侧 spawn 先例：`dsh-host-open-in-app/lib/index.js:349`
2. 注册 webServer 路由返 HTML，client 侧 `window.open`

`ctx.subprocess.spawn` spec（`SubprocessSpawnSpec`，asar:2236072）+ 文档样例（asar:2211655）：
```js
const executable = await ctx.subprocess.resolveExecutable('bash')
const handle = ctx.subprocess.spawn({
  argv: [executable, '-c', 'echo hello'],
  cwd: '/workspace',
  stdio: { stdin: 'ignore', stdout: { maxBytes: 64*1024 }, stderr: 'inherit' },
  graceMs: 5000,
})
await handle.done
const output = handle.collected.stdout?.readFrom(0)
```
打开 SOP 文档即 `argv: [executable, '-c', "open '<absPath>'"]`。

### 5.7 插件自有存储（不需要）

`ctx.storage` / `storageDomain` 提供持久化 KV/文件存储（`StorageForms` 接口在 0.2.1-rc.2 是空的，asar:2235936，具体 form 由各 facility 挂载）。

**本插件不需要它**：红绿灯状态是「本轮检测的快照」，DSH 重启后所有 agent 都要重新判断一遍，持久化旧裁决没有意义还会误导。所以 host 侧用一个**纯内存 `Map<sessionId, 上报结果>`** 就够，随插件生命周期生灭。

### 5.8 DSH 自身重启机制（本插件不用，仅供理解）

- 官方重启：`ipcMain.handle("harness:restart")`（asar:5992458）→ `window.dshDesktop.restartHarness()`，只重启 harness 子进程，不重启 Electron。guard 要求 sender 是 mainWindow.webContents 且 phase 为 ready
- `app.relaunch()` 只在 updater/recovery 路径，插件拿不到
- host 侧插件 `process.exit()` 会被识别为 harness crash（`pluginFailures` 解析）→ 触发 Safe Mode 恢复 UI，**绝不能这么干**
- 退出生命周期：`stopChild` SIGTERM → 4s → SIGKILL（asar:5982538）；`createProcessShutdown` 超时 5s（asar:595986）；desktop `before-quit`（asar:5994141）flushSync + `Promise.all([runtime.stop()]).finally(app.quit())`

---

## 6. 必须实测才能确认的点

上线前一定要在真实 DSH 里验证的假设：

**编码前就能定的（已查实，只剩选型）**
1. `reboot_light` 可见性方案：常驻 vs 注册+默认 deny+检测时 allow。注意 `ctx.tools.restrict` **只能在 agent scope 上下文调用**，全局调用会被拒（`dsh-tools/lib/index.js:497-501`：「a context-global restriction would mask every agent」）

**M1 必须实测**
2. `exec.agent.session.id` 在 tool handler 里取不到（agentless 调用时 `exec.agent` 为 undefined）
3. `createUserMessage` 能否从 host 插件 ctx 导入（`agent.followup()` 的入参构造）
4. `ctx.agents.list()` 只返回 live agent，且对每个都能成功 `followup`
5. agent 被插 prompt 后是否真的会调用 `reboot_light`（tool 描述要写得足够明确，必要时在 prompt 里点名）
6. `ctx.inject(['webServer'], ...)` 延迟注入的时序；重复 `(kind, path)` 注册会抛错（`dsh-host-webserver/lib/index.js:326-333`）

**M2 必须实测**
7. `shell.overlay` 注册后组件实际渲染位置、z-index 层级、是否被其他浮层盖住
8. **`bottom:16px` 是否与 composer 右下发送按钮重叠**（overlayLayer 覆盖整个 frame，需真实 GUI 上看）
9. `useSessionStatus` hook 的完整签名（catalog 只给了类型名，未给 `(selector)=>value` 语义）
10. boot race 实际窗口：client 插件与 uiSession 的 apply 先后未固定，重试 1.5s 是否够

**M3 必须实测**
11. `ctx.subprocess.spawn` 跑 `open` 在 Desktop 宿主里是否真的不被沙箱拦（spec 字段形状也需逐字段核对）
12. 多会话同时写 `user_reboot_SOP.md` 时串行化队列是否真的生效
13. `ctx.fs.resolve(absPath)` 的 `cwd` 该传什么（插件没有 session cwd）

**通用**
14. 红绿灯在明暗两种主题下的可读性

---

## 7. 实施计划（待用户发话）

| 阶段 | 内容 | 验收 |
|---|---|---|
| M0 骨架 | package.json / cordis.patch.yml / lib/index.js / lib/client.js，client 注册一个 shell.overlay 静态灯 | 插件被宿主加载，GUI 右下角出现灰灯 |
| M1 上报链路 | host 注册 `reboot_light` tool + `createUserMessage`/`followup` 触发 + webServer 状态路由 | 手动触发后，目标会话调用 tool，状态路由返回该会话裁决 |
| M2 聚合与 UI | 聚合规则 + 红绿灯三态 + 展开面板（会话明细） | 多会话场景下红绿灯状态正确 |
| M3 SOP 文档 | 串行化写入 `user_reboot_SOP.md` + 锚点章节 + `open` 打开 | 多会话并发写不丢内容；黄灯时文档自动打开 |
| M4 打磨 | 主题 token、明暗适配、tool 可见性控制、重新检测按钮、localStorage 偏好 | 视觉与原生一致；不干扰正常会话 |

编码工作交由 ZCode 执行。
