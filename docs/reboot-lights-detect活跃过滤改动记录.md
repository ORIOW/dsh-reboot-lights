# detect 活跃过滤改动记录（2026-11-01）

## 背景与目标

`detect()` 原实现对所有 live agent 逐个 followup 唤醒一轮 LLM，token 开销大。
本次改动：只唤醒「最近 15 分钟有对话（或正在运行）」的 live 会话，并精简 prompt
让模型一句话 + 一个 `reboot_light` 上报，不做多余思考。

**改动范围：仅 host 半身 `lib/index.js`（413 → 444 行）。**
`lib/client.js`、package.json、cordis.patch.yml、tests 均未动。

## 改动点

### 1. inject

```js
/** tools 是硬依赖；sessionController 缺了时 detect 退化为全量触发；webServer 与 fs 走延迟注入，缺了也能起。 */
export const inject = ['tools', 'sessionController']
```

### 2. detect() → async + 活跃过滤

```js
  async function detect() {
    const agents = typeof ctx.agents?.list === 'function' ? ctx.agents.list() : []
    pendingRound = new Set()

    const bySession = new Map()
    try {
      const rows = ctx.sessionController?.listState?.list?.()
      if (Array.isArray(rows)) {
        for (const rowState of rows) {
          if (rowState && typeof rowState.sessionId === 'string') bySession.set(rowState.sessionId, rowState)
        }
      }
    } catch (error) {
      log(`listState unavailable (${error?.message ?? String(error)}) — will trigger all live agents`)
    }

    const cutoff = Date.now() - 15 * 60 * 1000
    const isRecent = (value) =>
      (typeof value === 'number' && value >= cutoff)
      || (typeof value === 'string' && Date.parse(value) >= cutoff)

    const targets = agents.filter((agent) => {
      const sid = agent?.id
      if (typeof sid !== 'string' || !sid) return false
      const rowState = bySession.get(sid)
      if (!rowState) return true // 无记录 → 保守触发
      const recent = isRecent(rowState.updatedAt)
      const running = rowState.running === true
      return recent || running
    })

    // ...（promptText 见下）...

    let triggered = 0
    for (const agent of targets) {
      const sessionId = agent?.id
      try {
        agent.followup({ content: [{ type: 'text', text: promptText }], source: { kind: 'user' } })
        pendingRound.add(sessionId)
        triggered += 1
      } catch (error) {
        log(`followup failed for ${sessionId}: ${error?.message ?? String(error)}`)
      }
    }

    const skipped = agents.length - targets.length
    log(`detect: triggered ${triggered} of ${agents.length} live agents (${skipped} inactive skipped)`)
    return { triggered, total: agents.length, active: targets.length }
  }
```

过滤规则：

- `updatedAt` 语义 = max(createdAt, lastPromptAt)（最近用户消息时间），兼容
  number（ms）与 ISO 字符串（`Date.parse`）。
- 15 分钟内有对话 **或** `running === true` → 触发。
- 会话在 listState 里无记录 → 保守触发（宁可多花 token 不漏判）。

### 3. promptText（精简后）

```js
    const promptText = [
      '【dsh-reboot-lights · 重启安全检测】',
      '请判断：本会话现在能否被 DSH 重启安全中断？',
      '判断后调用 `reboot_light` 工具上报 { light, reason, manualSteps? }：',
      '- light: "red"（不能中断，有进行中的关键工作）| "yellow"（需等待，或退出后需用户手动操作）| "green"（可直接重启）',
      '- reason: 一句话',
      '- manualSteps: 仅 yellow 时给，每项一句手动操作',
      '请简短回答，不要展开分析，只给最终裁决即可。',
      'red 只在确有关键工作无法中断时用；不确定判 yellow。',
    ].join('\n')
```

### 4. detect 路由 handler

```js
      path: '/api/reboot-lights/detect',
      handler: async (request, response) => {
        if (request.method !== 'POST') { /* ...405 不变... */ }
        let result
        try {
          result = await detect()
        } catch (error) { /* ...500 不变... */ }
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        response.end(JSON.stringify(result))
      },
```

## 与预期不符、已顺手修正的一点

detect 路由的 handler 原本**不是** async 箭头函数（`handler: (request, response) => {`），
直接加 `await` 会报 `SyntaxError: Unexpected reserved word`。已把 handler 标成
`async (request, response) =>`，其余不动。

## sessionController.listState 可用性

本地运行时无法验证宿主真实提供该接口。退化路径是安全的：整个取数包在 try/catch
里，`ctx.sessionController?.listState?.list?.()` 任何一层缺失/抛错都落到空 Map →
所有 live agent 保守触发，并打一条日志：

```
[reboot-lights] listState unavailable (…) — will trigger all live agents
```

## 保留不动的部分

- `exec.agent.session.id ?? exec.agent.id ?? 'unknown'` 身份解析
- writeSop / writeChain 串行化写入
- aggregate() 聚合规则
- GET /api/reboot-lights/state、POST /api/reboot-lights/open-sop 两条路由
- open-sop 的 ctx.subprocess 打开逻辑
- 所有 import（node:os / node:path / @deepseek-ai/dsh-tools / @deepseek-ai/schemastery）

## 自检

- `node --check lib/index.js`：通过
- 未安装插件、未改 profile（由使用者另行验证）

## warn 级打点（临时，验证用）

harness.log 只收 warn/error 级插件消息，`log()` 用的 `ctx.logger.info` 打不进日志
文件，detect 的运行结果和 host 启动标记在日志里永远看不到。为验证活跃过滤是否生效，
临时新增 warn 级帮助函数并把三条关键打点升级：

```js
  /** harness.log 只收 warn/error 级插件消息；关键验证打点临时走 warn（验证完降回）。 */
  const warnLog = (message) => {
    try { ctx.logger.warn(`[reboot-lights] ${message}`) } catch { /* logger 缺失时静默 */ }
  }
```

改为 `warnLog(...)` 的三条：

1. `listState unavailable (...) — will trigger all live agents`（listState 缺失退化提示）
2. `detect: triggered N of M live agents (K inactive skipped)`（detect 结果，验证活跃过滤的核心打点）
3. `host half active (M1: tool + detect + state route)`（host 启动标记）

其余打点（SOP 写入、followup 失败、上报等）仍走 info 级 `log()`，`log()` 本身未动。
**验证完成后请把这三条改回 `log(...)` 并删除 `warnLog`。**

## detect 500 修复（2026-11-03）

现象：POST /api/reboot-lights/detect 返回 500。

根因：`inject` 里没有 `agents`，detect() 访问 `ctx.agents.list()` 时 agents 服务
未注入、getter 抛错。

修复（两处，均最小化）：

1. 第 24 行：

```js
export const inject = ['tools', 'sessionController', 'agents']
```

2. detect 路由的 catch 块加一行，让真实错误进 harness.log（warnLog 是上一节
   临时引入的 warn 级帮助函数）：

```js
        } catch (error) {
          warnLog(`detect failed: ${error?.message ?? String(error)}`)
          response.writeHead(500, { 'content-type': 'application/json' })
```

其余逻辑（reports Map / pendingRound / writeChain / aggregate / listState 过滤 /
promptText / SOP / open-sop 路由）均未动。`node --check lib/index.js` 通过。

