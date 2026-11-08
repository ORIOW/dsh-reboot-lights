#!/usr/bin/env node
/**
 * 把 dsh-reboot-lights 挂进 DSH profile（M0 挂载步骤）。
 *
 * 为什么需要单独一个脚本：DSH_HOME 不在会话沙箱可写范围内，
 * 所以挂载必须在提权下执行。本脚本与 `make zcode plugin` 仓库的
 * mount-zcode-native.mjs 同构，可直接对照。
 *
 * 做的事（幂等，可重复跑）：
 *   1. 备份 profiles/web/package.json 与 cordis.patch.yml
 *   2. package.json 的 dependencies 加 "dsh-reboot-lights": "link:<WORKSPACE>"
 *   3. package.json 的 dsh.profile.bundles 追加 "dsh-reboot-lights"（须保序）
 *   4. 调内置 pnpm install（link: 依赖只需 symlink，不联网）
 *   5. 建 node_modules/dsh-reboot-lights symlink 并校验 realpath
 *   6. cordis.patch.yml 追加 insert 块（已存在则跳过）
 *
 * 用法：
 *   node scripts/mount-reboot-lights.mjs            # 干跑，只打印将要做什么
 *   node scripts/mount-reboot-lights.mjs --apply    # 真执行
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, symlinkSync, unlinkSync, realpathSync, copyFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { spawnSync } from 'node:child_process'

const APPLY = process.argv.includes('--apply')
const WORKSPACE = dirname(import.meta.dirname)
const PKG_NAME = 'dsh-reboot-lights'
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), 'Library', 'Application Support', 'dsh-desktop', 'harness')
const PROFILE = join(DSH_HOME, 'profiles', 'web')
const PKG_JSON = join(PROFILE, 'package.json')
const PATCH_YML = join(PROFILE, 'cordis.patch.yml')
const NM_LINK = join(PROFILE, 'node_modules', PKG_NAME)
const PNPM = join(DSH_HOME, '.desktop-bin', 'pnpm')
const STAMP = new Date().toISOString().replace(/[:.]/g, '-')

const log = (m) => console.log(`${APPLY ? '' : '[dry-run] '}${m}`)

/** Fail loudly rather than half-applying. */
function must(cond, message) {
  if (!cond) { console.error(`ABORT: ${message}`); process.exit(1) }
}

must(existsSync(WORKSPACE), `workspace not found: ${WORKSPACE}`)
must(existsSync(join(WORKSPACE, 'package.json')), 'workspace has no package.json')
must(existsSync(PKG_JSON), `profile package.json not found: ${PKG_JSON}`)

const wsPkg = JSON.parse(readFileSync(join(WORKSPACE, 'package.json'), 'utf8'))
must(wsPkg.name === PKG_NAME, `workspace package name is "${wsPkg.name}", expected "${PKG_NAME}"`)

// ── 1. profile package.json ───────────────────────────────────────────────
const profile = JSON.parse(readFileSync(PKG_JSON, 'utf8'))
const depSpec = `link:${WORKSPACE}`
const alreadyDep = profile.dependencies?.[PKG_NAME] === depSpec
const bundles = profile.dsh?.profile?.bundles ?? []
const alreadyBundle = bundles.includes(PKG_NAME)

log(`dependencies["${PKG_NAME}"] = ${depSpec}  (currently: ${profile.dependencies?.[PKG_NAME] ?? 'absent'})`)
log(`dsh.profile.bundles includes "${PKG_NAME}": ${alreadyBundle}  (bundles count: ${bundles.length})`)

if (!alreadyDep || !alreadyBundle) {
  if (APPLY) {
    copyFileSync(PKG_JSON, `${PKG_JSON}.bak-rebootlights-${STAMP}`)
    profile.dependencies = { ...(profile.dependencies ?? {}), [PKG_NAME]: depSpec }
    if (!alreadyBundle) {
      profile.dsh = profile.dsh ?? {}
      profile.dsh.profile = profile.dsh.profile ?? {}
      // 保序追加：宿主按 bundles 顺序叠 patch 层
      profile.dsh.profile.bundles = [...bundles, PKG_NAME]
    }
    writeFileSync(PKG_JSON, `${JSON.stringify(profile, null, 2)}\n`)
    log('profile package.json updated')
  }
} else {
  log('profile package.json already correct — no change needed')
}

// ── 2. pnpm install ───────────────────────────────────────────────────────
// `link:` 依赖不需要网络：pnpm 只建 symlink。但完整 `pnpm install` 会重新解析
// profile 里其他依赖，本机有 git 依赖（aegis → github:GanyuanRan/Aegis#<sha>）
// 在没有 GitHub SSH 访问时会失败。那与本插件无关，不能中断挂载：
// link: 依赖由第 3 步的 symlink 满足即可，故非零退出仅告警。
let installOk = false
if (APPLY) {
  must(existsSync(PNPM), `bundled pnpm not found: ${PNPM}`)
  log(`running: ${PNPM} install`)
  const r = spawnSync(PNPM, ['install'], { cwd: PROFILE, encoding: 'utf8', stdio: 'inherit' })
  installOk = r.status === 0
  if (!installOk) {
    console.warn(
      `\nWARNING: pnpm install exited ${r.status}.\n` +
      `  最常见原因：既有的 git 依赖 "aegis" 无法在无 GitHub SSH 访问时拉取，\n` +
      `  与 ${PKG_NAME} 无关。继续：link: 依赖由下面第 3 步的 symlink 满足，\n` +
      `  现有 node_modules 不受影响。\n`,
    )
  }
} else {
  log(`would run: ${PNPM} install`)
}

// ── 3. node_modules symlink ───────────────────────────────────────────────
// pnpm 的 link: 协议通常会自建这个 symlink，install 成功时这步一般是幂等空操作。
// 保留它有两个理由：install 失败时的回退，以及 realpath 比对能抓住
// 「项目搬家后 symlink 还指向旧路径」这种静默失败。
let linkOk = false
try {
  if (existsSync(NM_LINK)) linkOk = realpathSync(NM_LINK) === realpathSync(WORKSPACE)
} catch { linkOk = false }
log(`node_modules/${PKG_NAME} -> ${WORKSPACE}  (already correct: ${linkOk})`)

if (!linkOk) {
  if (APPLY) {
    mkdirSync(join(PROFILE, 'node_modules'), { recursive: true })
    try { unlinkSync(NM_LINK) } catch { /* nothing to remove */ }
    symlinkSync(WORKSPACE, NM_LINK, 'dir')
    must(realpathSync(NM_LINK) === realpathSync(WORKSPACE), 'symlink realpath mismatch after creation')
    log('symlink created and verified')
  }
}

// ── 4. profile cordis.patch.yml insert block ──────────────────────────────
const patch = readFileSync(PATCH_YML, 'utf8')
const hasBlock = /id:\s*reboot-lights\b/.test(patch)
log(`cordis.patch.yml already has reboot-lights insert: ${hasBlock}`)

if (!hasBlock) {
  if (APPLY) {
    copyFileSync(PATCH_YML, `${PATCH_YML}.bak-rebootlights-${STAMP}`)
    const block = [
      '',
      '# dsh-reboot-lights — 重启安全红绿灯（M0 骨架）',
      '- insert:',
      '    - id: reboot-lights',
      `      name: ${PKG_NAME}`,
      '',
    ].join('\n')
    writeFileSync(PATCH_YML, `${patch.replace(/\s*$/, '\n')}${block}`)
    log('profile cordis.patch.yml updated')
  }
} else {
  log('cordis.patch.yml already has the insert block — no change needed')
}

console.log(APPLY
  ? '\nAPPLIED. 重启 DSH Desktop 后验证 GUI 右下角是否出现灰色圆点。'
  : '\nDRY RUN complete. 加 --apply 真执行。')
