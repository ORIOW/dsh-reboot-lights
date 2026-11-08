// dsh-reboot-lights — host 半身。
//
// 职责（M1-M3）：
//   1. 注册 `reboot_light` tool：每个会话的 agent 被询问时调用它上报
//      { light: 'red'|'yellow'|'green', reason, manualSteps?[] }
//   2. 提供 detect()：遍历 ctx.agents.list()，向每个 live agent 插一条 prompt
//      触发它做判断
//   3. 注册 webServer 路由：GET  /api/reboot-lights/state  聚合结果
//                            POST /api/reboot-lights/detect 触发检测
//                            POST /api/reboot-lights/open-sop 打开 SOP 文档
//   4. 黄灯时把各会话的 manualSteps 写进共用的 ~/user_reboot_SOP.md，
//      每会话独立章节，串行化写入，不破坏其他会话已写内容
//
// 硬性约束：任何向会话写入的消息都必须经 createUserMessage()
// （lib/user-message.js，唯一合法入口）。宿主对写入不做校验、原样落盘，
// 缺 id/role 的消息会让该会话在下次重启后从 UI 消失（数据仍在，只是载入被拒）。
// 详见 docs/reboot-lights-zcode任务书-会话损坏修复.md。
//
// 本插件**不做任何自动重启/退出 DSH 的动作**——只收集、只显示。

import { defineTool } from '@deepseek-ai/dsh-tools'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { existsSync } from 'node:fs'
import { stat, readFile, writeFile, mkdir } from 'node:fs/promises'
import Schema from '@deepseek-ai/schemastery'
import { createUserMessage } from './user-message.js'

export const name = 'dsh-reboot-lights'

/** tools 是硬依赖；agents/sessionProjections 未注入时显式访问会 getter 抛错（上次 detect 500 的教训）；sessionController 缺了时 detect 退化为全量触发；webServer 走延迟注入缺了也能起。SOP 文档写入不走 ctx.fs——那套是 cordis 沙箱化 fs，默认 workspace-write 模式只允许写工作区，~/user_reboot_SOP.md 在主目录会被 FS_SANDBOX_DENIED 拒绝；改用 node:fs/promises 直写主目录，天然不受 cordis 沙箱限制。 */
export const inject = ['tools', 'sessionController', 'agents', 'sessionProjections']

/**
 * 必须是真正的 Schemastery schema，不能写成普通空对象。
 * cordis 的 resolveConfig 会执行 `Config['~standard'].validate(config)`；
 * 普通对象没有 `~standard`，会在 apply 阶段抛
 * `TypeError: Cannot read properties of undefined (reading 'validate')`。
 * 本插件是 bundle 内的 required 条目，该错误会让 DSH 整体启动失败并进入安全模式。
 */
export const Config = Schema.object({})

/** 灯的三态。 */
const LIGHTS = ['red', 'yellow', 'green']

/** SOP 文档落点（用户已确认：放主目录，跨 workspace 不分裂、DSH 关掉后好找）。 */
const SOP_PATH = join(homedir(), 'user_reboot_SOP.md')

const SECTION_OPEN = '<!-- reboot-lights:section:'
const SECTION_CLOSE = '<!-- reboot-lights:section:end:'
const COMMENT_END = ' -->'

const SOP_HEADER = [
  '# user_reboot_SOP — DSH 重启前待办',
  '',
  '> 本文档由 dsh-reboot-lights 插件在各会话判定为黄灯时自动生成/更新。',
  '> 每节对应一个会话。退出 DSH 后请逐节执行。',
  '> 会话状态变化时，对应章节头部会标注最新状态；历史步骤保留不移除。',
  '',
].join('\n')

/**
 * 每会话最新一次上报。
 * @typedef {Object} Report
 * @property {'red'|'yellow'|'green'} light
 * @property {string} reason
 * @property {string[]} [manualSteps]  仅 yellow 时提供
 * @property {string} sessionId
 * @property {string} [title]
 * @property {number} at               上报时间戳（ms）
 * @property {'pending'|'reported'} state
 */

export function apply(ctx, config) {
  /** @type {Map<string, Report>} */
  const reports = new Map()
  /** 本轮检测已触发的 sessionId 集合（用于区分「未触发」与「已触发未回」）。 */
  let pendingRound = new Set()
  /** 写队列：所有 SOP 文档写操作串行化，任一时刻只有一个写者在改文件。 */
  let writeChain = Promise.resolve()

  const log = (message) => {
    try { ctx.logger.info(`[reboot-lights] ${message}`) } catch { /* logger 缺失时静默 */ }
  }
  /** harness.log 只收 warn/error 级插件消息；关键验证打点临时走 warn（验证完降回）。 */
  const warnLog = (message) => {
    try { ctx.logger.warn(`[reboot-lights] ${message}`) } catch { /* logger 缺失时静默 */ }
  }

  // ────────────────────────── SOP 文档 ──────────────────────────
  /**
   * 渲染一个会话的章节。状态变化时更新头部标注，但保留已写步骤
   * （用户已确认：避免正看着的步骤突然消失）。
   */
  function renderSection(report) {
    const statusLabel = report.light === 'red' ? '🔴 不可重启'
      : report.light === 'green' ? '🟢 可重启（本节步骤已过期，保留仅供参考）'
        : '🟡 需等待'
    const steps = Array.isArray(report.manualSteps) ? report.manualSteps : []
    const lines = [
      `${SECTION_OPEN}${report.sessionId}${COMMENT_END}`,
      `## 会话：${report.title || report.sessionId}`,
      '',
      `- 会话 ID：\`${report.sessionId}\``,
      `- 当前状态：${statusLabel}`,
      `- 判定时间：${new Date(report.at).toLocaleString('zh-CN')}`,
      `- 理由：${report.reason || '（未提供）'}`,
      '',
    ]
    if (steps.length > 0) {
      lines.push('### 需要手动执行的步骤', '')
      steps.forEach((step, i) => lines.push(`${i + 1}. ${step}`))
      lines.push('')
    } else if (report.light === 'yellow') {
      lines.push('### 需要手动执行的步骤', '', '（该会话未提供具体步骤）', '')
    }
    lines.push(`${SECTION_CLOSE}${report.sessionId}${COMMENT_END}`, '')
    return lines.join('\n')
  }

  /**
   * 把若干章节合并进现有全文：命中锚点的整段替换，未命中的追加到末尾。
   * 只动自己的锚点段，其他内容原样保留。
   */
  function mergeSections(existing, reports) {
    let text = typeof existing === 'string' && existing.trim()
      ? existing
      : SOP_HEADER

    for (const report of reports) {
      const openTag = `${SECTION_OPEN}${report.sessionId}${COMMENT_END}`
      const closeTag = `${SECTION_CLOSE}${report.sessionId}${COMMENT_END}`
      const start = text.indexOf(openTag)
      const end = text.indexOf(closeTag)

      if (start !== -1 && end !== -1 && end > start) {
        // 命中：只替换 [openTag, closeTag 结尾] 这一段。
        // renderSection 自带尾部换行，若原段后面还跟着空行会叠成两个，
        // 这里把紧随其后的一個空行一起吃进去，保持段间距一致。
        const after = end + closeTag.length
        const skip = text.slice(after).match(/^\n?\n/)
        text = text.slice(0, start) + renderSection(report)
          + text.slice(after + (skip ? skip[0].length : 0))
      } else {
        // 未命中：追加到末尾（段前补一个空行，避免和上一节粘在一起）
        const sep = text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n'
        text += `${sep}${renderSection(report)}`
      }
    }
    return text
  }

  /**
   * 串行化写入 SOP 文档。返回一个 Promise，写队列保证同一时刻只有一个写者。
   * @param {Report[]} reports 本次要写入/更新的会话上报
   */
  function writeSop(reports) {
    if (!Array.isArray(reports) || reports.length === 0) return Promise.resolve()
    const run = writeChain.then(async () => {
      // 用 node:fs/promises 直写主目录，不走 ctx.fs——那套是 cordis 沙箱化 fs，
      // 默认 workspace-write 只允许写工作区，~/user_reboot_SOP.md 在主目录会被
      // FS_SANDBOX_DENIED 拒绝（之前注入 'fs' 也写不出就是这个原因）。
      let existing = ''
      try {
        const st = await stat(SOP_PATH).catch(() => undefined)
        if (st && st.isFile()) existing = await readFile(SOP_PATH, 'utf8')
      } catch (error) {
        log(`SOP read skipped (${error?.message ?? String(error)}) — will create`)
      }

      const next = mergeSections(existing, reports)
      if (next === existing) return

      try {
        await mkdir(dirname(SOP_PATH), { recursive: true })
        await writeFile(SOP_PATH, next, 'utf8')
        warnLog(`SOP updated: ${SOP_PATH} (${reports.length} section(s))`)
      } catch (error) {
        warnLog(`SOP write failed: ${error?.message ?? String(error)}`)
      }
    }).catch((error) => {
      warnLog(`SOP write chain error: ${error?.message ?? String(error)}`)
    })
    // 队列尾部更新，但失败不能堵死后续写入
    writeChain = run
    return run
  }

  // ────────────────────────── 聚合 ──────────────────────────
  /**
   * 聚合规则（用户拍板）：
   *   任一会话 red → 红
   *   全部已上报会话都是 green → 绿
   *   其他（有 yellow / 有会话未上报 / 有会话已触发未回）→ 黄
   */
  function aggregate() {
    const items = []
    let anyRed = false
    let anyYellow = false
    let anyGreen = false

    for (const report of reports.values()) {
      items.push(report)
      if (report.light === 'red') anyRed = true
      else if (report.light === 'yellow') anyYellow = true
      else if (report.light === 'green') anyGreen = true
    }

    // 已触发但还没回音的会话，按最保守算黄
    let awaiting = 0
    for (const sid of pendingRound) {
      const report = reports.get(sid)
      if (!report || report.state !== 'reported') awaiting += 1
    }

    let light
    if (anyRed) light = 'red'
    else if (!anyYellow && awaiting === 0 && anyGreen && items.length > 0) light = 'green'
    else light = 'yellow'

    return {
      light,
      counts: { red: items.filter((r) => r.light === 'red').length,
        yellow: items.filter((r) => r.light === 'yellow').length,
        green: items.filter((r) => r.light === 'green').length,
        awaiting },
      items,
      detectedAt: Date.now(),
    }
  }

  // ────────────────────────── 触发检测 ──────────────────────────
  // 自动会话识别：DSH 无官方 auto 标记，靠约定前缀。
  // dsh-auto-memory 会话 title=记忆中枢 #N，或 sessionId 前缀 dam-workbench-。
  const AUTO_TITLE_PREFIX = '记忆中枢'
  const AUTO_SESSION_PREFIX = 'dam-workbench-'

  /**
   * 自动会话（如 dsh-auto-memory 的记忆中枢）即便 15min 内活跃也不该被
   * detect 唤醒——白烧 token。title 投影拿不到时不误判（返回 false，
   * 走正常活跃判定），保证不误杀普通会话。
   */
  function isAutoSession(agent, bySession) {
    const sid = agent?.id
    if (typeof sid === 'string' && sid.startsWith(AUTO_SESSION_PREFIX)) return true
    // 有 title 投影才看 title（拿不到不误判为自动）
    try {
      const snap = ctx.sessionProjections?.snapshot?.(agent.session, ['title'])
      const title = snap && snap.values && snap.values.title
      return typeof title === 'string' && title.startsWith(AUTO_TITLE_PREFIX)
    } catch {
      return false
    }
  }

  /**
   * 向「最近 15 分钟有对话」的 live agent 插一条 prompt，请它判断自己
   * 能否被重启中断。其余不活跃会话跳过——followup 会真的跑一轮 LLM，
   * 唤醒僵尸会话纯属浪费 token。
   *
   * 只用 `ctx.agents.list()` —— 它只含进程内 live agent，
   * 天然不会激活冷会话。`remote.session.prompt` 会 resolveAgent
   * 激活冷 agent 并触发一轮 LLM，这里刻意避开。
   *
   * 活跃判定来自 sessionController.listState（updatedAt 语义 =
   * max(createdAt, lastPromptAt)，最近一条用户消息时间），拿不到就
   * 保守地全量触发。
   *
   * 注入的消息必须经 createUserMessage()：宿主对写入不做校验、原样落盘，
   * 缺 id/role 的消息会让该会话在下次重启后消失（数据仍在，只是载入被拒）。
   * 详见 docs/reboot-lights-zcode任务书-会话损坏修复.md。
   */
  async function detect() {
    const agents = typeof ctx.agents?.list === 'function' ? ctx.agents.list() : []
    pendingRound = new Set()

    const bySession = new Map()
    try {
      // list() 是 async 方法（返回 Promise）：同步调用时 Array.isArray 恒为
      // false → bySession 永远空 → 活跃过滤整体失效、全量唤醒。
      const rows = await ctx.sessionController?.listState?.list?.()
      if (Array.isArray(rows)) {
        for (const rowState of rows) {
          if (rowState && typeof rowState.sessionId === 'string') bySession.set(rowState.sessionId, rowState)
        }
      }
    } catch (error) {
      warnLog(`listState unavailable (${error?.message ?? String(error)}) — will trigger all live agents`)
    }

    const cutoff = Date.now() - 15 * 60 * 1000
    const isRecent = (value) =>
      (typeof value === 'number' && value >= cutoff)
      || (typeof value === 'string' && Date.parse(value) >= cutoff)

    const targets = agents.filter((agent) => {
      if (isAutoSession(agent, bySession)) return false // 自动会话直接跳过，即便 15min 内活跃
      const sid = agent?.id
      if (typeof sid !== 'string' || !sid) return false
      const rowState = bySession.get(sid)
      if (!rowState) return true // 无记录 → 保守触发
      const recent = isRecent(rowState.updatedAt)
      const running = rowState.running === true
      return recent || running
    })

    const promptText = [
      '【dsh-reboot-lights · 重启安全检测】',
      '请判断：本会话现在能否被 DSH 重启安全中断？',
      '判定依据：',
      '- light: "red"（不能中断，有进行中的关键工作）| "yellow"（需等待，或退出后需用户手动操作）| "green"（可直接重启）',
      '- reason: 一句话',
      '- manualSteps: 仅 yellow 时给，每项一句手动操作',
      'red 只在确有关键工作无法中断时用；不确定判 yellow。',
      '你必须调用 `reboot_light` 工具上报裁决，禁止只在正文里作答——正文里不要给最终结论，工具调用就是唯一上报出口。',
    ].join('\n')

    let triggered = 0
    for (const agent of targets) {
      const sessionId = agent?.id
      try {
        // followup = next-turn + 唤醒：会真的跑一轮，判断必须由模型做。
        // 消息必须经 createUserMessage() 构造（完整 UserMessage：id/role/
        // content/source 四键齐全）。宿主原样落盘、写入不校验，缺 id 的
        // user/message 会在下次载入时被 assertMessageEventShape 判为会话损坏。
        agent.followup(createUserMessage(promptText))
        pendingRound.add(sessionId)
        triggered += 1
      } catch (error) {
        log(`followup failed for ${sessionId}: ${error?.message ?? String(error)}`)
      }
    }

    const skipped = agents.length - targets.length
    warnLog(`detect: triggered ${triggered} of ${agents.length} live agents (${skipped} inactive skipped)`)
    return { triggered, total: agents.length, active: targets.length }
  }

  // ────────────────────────── 注册 tool ──────────────────────────
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'reboot_light',
    description: '上报本会话当前能否被 DSH 重启安全中断。当用户或系统要求做重启安全检测时调用。'
      + 'light=red 表示不能重启；yellow 表示需要等待或退出 DSH 后需用户手动执行 manualSteps 里的操作；'
      + 'green 表示可以直接重启。',
    parameters: {
      light: { type: 'string', enum: LIGHTS, required: true, description: 'red | yellow | green' },
      reason: { type: 'string', required: true, description: '一句话说明为什么' },
      manualSteps: {
        type: 'array',
        description: '仅 light=yellow 时必填。用户退出 DSH 后需要手动执行的操作，按执行顺序排列',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { text: { type: 'string', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      // 调用方身份：agent.id 与 sessionId 同值；agentless 调用时退回 unknown。
      const sessionId = exec?.agent?.session?.id ?? exec?.agent?.id ?? 'unknown'
      const light = LIGHTS.includes(args?.light) ? args.light : 'yellow'
      const reason = typeof args?.reason === 'string' ? args.reason : ''
      const manualSteps = Array.isArray(args?.manualSteps)
        ? args.manualSteps.filter((s) => typeof s === 'string')
        : []

      /** @type {Report} */
      const report = {
        light,
        reason,
        sessionId,
        manualSteps: light === 'yellow' ? manualSteps : undefined,
        at: Date.now(),
        state: 'reported',
      }
      reports.set(sessionId, report)

      // 黄灯（或状态从黄变成非黄）都要落到 SOP 文档。
      // 非黄也写：用户已确认要保留历史章节并标注最新状态。
      void writeSop([report])

      const text = light === 'green'
        ? `已上报：可以重启（${reason}）`
        : light === 'red'
          ? `已上报：不能重启（${reason}）`
          : `已上报：需要等待，退出 DSH 后需手动执行 ${manualSteps.length} 步（${reason}）`

      log(`report from ${sessionId}: ${light} — ${reason}`)
      return { text }
    },
  })), 'reboot-lights: reboot_light tool')

  // ────────────────────────── webServer 路由 ──────────────────────────
  // 必须延迟注入：ctx.get('webServer') 在组合期返回 undefined，路由会消失。
  ctx.inject(['webServer'], (webCtx) => {
    ctx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: '/api/reboot-lights/state',
      handler: (request, response) => {
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          response.writeHead(405, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ error: 'GET only' }))
          return
        }
        const body = JSON.stringify(aggregate())
        response.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        })
        response.end(body)
      },
    }), 'reboot-lights: GET /api/reboot-lights/state')

    ctx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: '/api/reboot-lights/detect',
      handler: async (request, response) => {
        if (request.method !== 'POST') {
          response.writeHead(405, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ error: 'POST only' }))
          return
        }
        let result
        try {
          result = await detect()
        } catch (error) {
          warnLog(`detect failed: ${error?.message ?? String(error)}`)
          response.writeHead(500, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ error: error?.message ?? String(error) }))
          return
        }
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        response.end(JSON.stringify(result))
      },
    }), 'reboot-lights: POST /api/reboot-lights/detect')

    ctx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: '/api/reboot-lights/open-sop',
      handler: (request, response) => {
        if (request.method !== 'POST') {
          response.writeHead(405, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ error: 'POST only' }))
          return
        }
        const send = (code, body) => {
          response.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
          response.end(JSON.stringify(body))
        }
        // ctx.subprocess.spawn 不受 sandboxPolicy gate（该 gate 只管模型侧 tool/fs）。
        // 官方先例：dsh-host-open-in-app/lib/index.js:349。
        void (async () => {
          try {
            const executable = await ctx.subprocess.resolveExecutable('bash')
            const handle = ctx.subprocess.spawn({
              argv: [executable, '-c', `open '${SOP_PATH}'`],
              cwd: homedir(),
              stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: 'inherit' },
              graceMs: 5000,
            })
            await handle.done
            log(`opened SOP: ${SOP_PATH}`)
            send(200, { ok: true, path: SOP_PATH })
          } catch (error) {
            log(`open SOP failed: ${error?.message ?? String(error)}`)
            send(500, { ok: false, error: error?.message ?? String(error), path: SOP_PATH })
          }
        })()
      },
    }), 'reboot-lights: POST /api/reboot-lights/open-sop')

    // ── 临时诊断路由：dump 聚合内部状态，定位「上报了但面板没显示」的键不匹配 ──
    ctx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: '/api/reboot-lights/debug',
      handler: (request, response) => {
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          response.writeHead(405, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ error: 'GET only' }))
          return
        }
        const agents = (typeof ctx.agents?.list === 'function') ? ctx.agents.list() : []
        const agentIds = agents.map((a) => a?.id).filter((x) => typeof x === 'string')
        const reportEntries = [...reports.entries()].map(([sid, r]) => ({ sid, light: r.light, at: r.at }))
        const body = JSON.stringify({
          reportsKeys: reportEntries,
          pendingRound: [...pendingRound],
          liveAgentIds: agentIds,
          reportsKeysMissingFromLive: reportEntries
            .map((e) => e.sid)
            .filter((sid) => !agentIds.includes(sid)),
          aggregate: aggregate(),
          sopExists: (() => {
            try { return existsSync(SOP_PATH) } catch { return null }
          })(),
        })
        response.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        })
        response.end(body)
      },
    }), 'reboot-lights: GET /api/reboot-lights/debug')
  })

  warnLog('host half active (M1: tool + detect + state route)')
}
