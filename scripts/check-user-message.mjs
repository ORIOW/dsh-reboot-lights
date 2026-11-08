// dsh-reboot-lights — 回归检查：UserMessage 构造收敛是否仍然成立。
//
// 不依赖测试框架、不需要宿主、不联网。任一断言失败即以 1 退出。
// 背景：detect() 曾手搓缺 id/role 的 UserMessage，宿主原样落盘，
// 下次载入被 assertMessageEventShape 判为会话损坏（3 个真实会话中招）。
// 详见 docs/reboot-lights-zcode任务书-会话损坏修复.md。

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const failures = []

const assert = (condition, message) => {
  if (!condition) failures.push(message)
}

// 1-4. 动态加载构造函数，校验产物形状
const module = await import('../lib/user-message.js').catch((error) => {
  console.error('FAIL: cannot import lib/user-message.js:', error?.message ?? String(error))
  process.exit(1)
})
const { createUserMessage } = module

assert(typeof createUserMessage === 'function', 'createUserMessage is not a function')

const message = createUserMessage('probe')
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

assert(typeof message.id === 'string' && message.id.length > 0, `id must be a non-empty string, got: ${JSON.stringify(message.id)}`)
assert(UUID_V4.test(message.id), `id must be a UUID v4, got: ${message.id}`)
assert(message.role === 'user', `role must be 'user', got: ${JSON.stringify(message.role)}`)
assert(Array.isArray(message.content) && message.content[0]?.type === 'text', `content must be an array whose [0] is a text part, got: ${JSON.stringify(message.content)}`)
assert(message.source?.kind === 'user', `source.kind must be 'user', got: ${JSON.stringify(message.source?.kind)}`)
assert(message.content[0]?.text === 'probe', `text must be passed through, got: ${JSON.stringify(message.content[0]?.text)}`)

const second = createUserMessage('probe')
assert(message.id !== second.id, 'two calls returned the same id — id must not be a constant')
assert(UUID_V4.test(second.id), `second id must also be a UUID v4, got: ${second.id}`)

// 5. 静态检查 lib/index.js：followup 只出现 1 次，且必须走 createUserMessage
const indexPath = join(here, '..', 'lib', 'index.js')
const source = readFileSync(indexPath, 'utf8')

const followupCount = source.split('agent.followup(').length - 1
assert(followupCount === 1, `agent.followup( must appear exactly once in lib/index.js, found ${followupCount}`)

const inlineLiteral = /agent\.followup\(\s*\{/m.test(source)
assert(!inlineLiteral, 'agent.followup( is followed by an inline { ... } message literal — messages must go through createUserMessage()')

assert(source.includes('agent.followup(createUserMessage(promptText))'),
  'lib/index.js must call agent.followup(createUserMessage(promptText))')
assert(source.includes("import { createUserMessage } from './user-message.js'"),
  "lib/index.js must import createUserMessage from './user-message.js'")

if (failures.length > 0) {
  for (const failure of failures) console.error('FAIL:', failure)
  process.exit(1)
}
console.log('OK')
