// dsh-reboot-lights — UserMessage 唯一构造入口。
//
// 宿主对写入不做校验、原样落盘：缺 id/role 的 user/message 会让会话在
// 下次重启载入时被 assertMessageEventShape 判为损坏（数据还在，载入被拒）。
// 任何要 followup 的消息都必须经这里构造，不要在别处手写 message 字面量。
// 详见 docs/reboot-lights-zcode任务书-会话损坏修复.md。
//
// 只依赖 node:crypto，不 import 任何 DSH 包——这样 node 能直接跑起来做验证。

import { randomUUID } from 'node:crypto'

/** 构造宿主可直接持久化的完整 UserMessage。唯一合法入口，不要在别处手写 message 字面量。 */
export function createUserMessage(text) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}
