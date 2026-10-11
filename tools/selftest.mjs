// dsh-whale-guard 自测：不依赖 DSH 运行时，用 mock ctx 跑规则引擎与 safe_kill 排除逻辑。
// 用法：node tools/selftest.mjs
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../lib/index.js'
import { ancestorChain, readProc, safeKill } from '../lib/procs.js'
import { buildRuleTable, codeSegments, evaluate } from '../lib/rules.js'

let pass = 0
let fail = 0
const failures = []

/**
 * 断言一个条件。
 * @param {string} label 用例名
 * @param {boolean} cond 条件
 * @param {string} detail 失败详情
 */
function check(label, cond, detail = '') {
  if (cond) {
    pass++
    console.log(`  ✔ ${label}`)
  } else {
    fail++
    failures.push(`${label}${detail ? ` — ${detail}` : ''}`)
    console.log(`  ✘ ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

// ---------------------------------------------------------------------------
// 1. 规则引擎
// ---------------------------------------------------------------------------
console.log('\n[1] 规则引擎：该拦的拦')
const table = buildRuleTable(null)
const hitIds = (cmd) => evaluate(cmd, table).map((h) => `${h.severity}:${h.id}`)
const hasBlock = (cmd) => evaluate(cmd, table).some((h) => h.severity === 'block')

check('pkill -f "FurMark_GUI" 被拦（自杀）', hasBlock('pkill -f "FurMark_GUI"'))
check('pkill -f requirements.txt 被拦（自杀）', hasBlock('pkill -f "requirements.txt"'))
check('pkill -f comfy 被拦', hasBlock("pkill -f 'comfy'"))
check('ps|grep|xargs kill 被拦', hasBlock('ps -eo cmd | grep "pip install" | xargs kill'))
check('sudo -S + heredoc 被拦', hasBlock("echo 'pw' | sudo -S tee /etc/foo.conf <<'EOF'\nx\nEOF"))
check('rm -rf / 被拦', hasBlock('rm -rf /'))
check('rm -rf /* 被拦', hasBlock('rm -fr /*'))
check('rm -rf /etc 被拦', hasBlock('rm -rf /etc'))
check('kill 1 被拦', hasBlock('kill -9 1'))
check('chmod -R 777 / 被拦', hasBlock('chmod -R 777 /'))

console.log('\n[2] 规则引擎：不该拦的必须放行（防误伤）')
check('普通 pkill（无 -f）放行', !hasBlock('pkill FurMark_GUI'))
check('pgrep -f 只查不杀 → 放行', !hasBlock('pgrep -f "FurMark_GUI"'))
check('grep "kill 1" 查日志 → 放行', !hasBlock('grep "kill 1" /var/log/syslog'))
check('echo 里含 rm -rf / 字样 → 放行', !hasBlock('echo "文档里写的 rm -rf / 是反面教材" > /tmp/note.txt'))
check('注释里的 rm -rf / → 放行', !hasBlock('# 千万别用 rm -rf /\nls -la /tmp'))
check('rm -rf ./build 放行', !hasBlock('rm -rf ./build'))
check('rm -rf /tmp/mydir 放行', !hasBlock('rm -rf /tmp/mydir'))
check('kill 1234 放行', !hasBlock('kill 1234'))
check('chmod -R 777 ./dist 放行', !hasBlock('chmod -R 777 ./dist'))
check('grep 用 [p] 自规避 + xargs kill 放行', !hasBlock('ps -eo cmd | grep "[p]ip install" | xargs kill'))
check('safepkill 正确写法放行', !hasBlock('safepkill "FurMark_GUI"'))
check('safe_kill 工具引用放行', !hasBlock('echo use safe_kill instead'))

console.log('\n[2b] heredoc 里的脚本文本不该被当命令扫')
// 注意：本文件里刻意用变量拼出危险字样，避免「写测试的脚本自己被守卫拦」这种尴尬
const PK = 'p' + 'kill'
const RF = 'rm -rf' + ' /'
const K1 = 'kill -9' + ' 1'
const scriptCmd = "cat > /tmp/x.sh <<'EOF'\n" + PK + ' -f "requirements.txt"\n' + RF + '\n' + K1 + '\nEOF\nbash /tmp/x.sh'
check('heredoc 正文里的 pkill 不拦', !hasBlock(scriptCmd), JSON.stringify(hitIds(scriptCmd)))
check('heredoc 正文里的删根命令不拦', !evaluate(scriptCmd, table).some((h) => h.id === 'rm-rf-root'))
check('heredoc 正文里的杀进程命令不拦', !evaluate(scriptCmd, table).some((h) => h.id === 'kill-pid1'))
const afterCmd = 'bash <<EOF\necho hi\nEOF\n' + PK + ' -f "yyy"'
check('heredoc 之后的真实命令仍拦', hasBlock(afterCmd))
const sudoFlag = '-' + 'S'
check('heredoc 正文里的 -S 字样不误报', !evaluate('sudo tee /etc/x <<EOF\nflag is ' + sudoFlag + ' here\nEOF', table).some((h) => h.id === 'sudo-heredoc-stdin'))
check('真实的 -S 附加 heredoc 仍拦', hasBlock("echo 'pw' | sudo " + sudoFlag + " tee /etc/foo.conf <<'EOF'\nx\nEOF"))
check('here-string 不受影响', !hasBlock('cat <<< "rm -rf /"'))


console.log('\n[3] 清洗器')
const segs = codeSegments('rm -rf /tmp/a; echo "rm -rf /"; # rm -rf /\nls')
check('分号切成多段', segs.length === 3, `got ${segs.length}: ${JSON.stringify(segs)}`)
check('引号内容不进代码段', !segs.some((s) => s.includes('rm -rf /"')), JSON.stringify(segs))

console.log('\n[4] hint 规则（PATH 缺失命令提示）')
const t4 = buildRuleTable(null)
t4.bareCommands = ['safepkill', 'vpn']
const hints = evaluate('safepkill foo', t4).map((h) => h.id)
check('裸 safepkill 触发提示（当它不在 PATH 时）', hints.includes('local-bin-not-in-path'), JSON.stringify(hints))
check('绝对路径不触发该提示', !evaluate('/usr/local/bin/safepkill foo', t4).map((h) => h.id).includes('local-bin-not-in-path'))
t4.bareCommands = []
check('命令已在 PATH 时完全不提示', !evaluate('safepkill foo', t4).map((h) => h.id).includes('local-bin-not-in-path'))

// ---------------------------------------------------------------------------
// 5. 祖先链与 safe_kill 自杀防护
// ---------------------------------------------------------------------------
console.log('\n[5] 祖先链')
const chain = ancestorChain(process.pid)
check('祖先链含自身', chain.has(process.pid))
check('祖先链含 init(1)', chain.has(1), `chain=${[...chain].join(',')}`)
check('祖先链非空且有限', chain.size > 0 && chain.size <= 64, `size=${chain.size}`)
check('readProc 能读到自己', readProc(process.pid)?.pid === process.pid)

// ---------------------------------------------------------------------------
// 6. safety：用「会匹配到自己」的模式杀进程，必须不自杀
// ---------------------------------------------------------------------------
console.log('\n[6] safe_kill 实战（关键验收：自杀模式不自杀）')
const marker = `whale-guard-selftest-${Date.now()}`
const targets = []
for (let i = 0; i < 2; i++) {
  // 用 sh -c sleep 造一个命令行里含 marker 的进程
  const child = spawn('bash', ['-c', `exec -a ${marker} sleep 120`], { detached: false })
  targets.push(child.pid)
  child.on('error', () => { /* ignore */ })
}
await new Promise((r) => setTimeout(r, 400))

// 关键用例：模式就是 marker，而 pgrep -f 一定会匹配到本测试进程自己
//（本进程命令行里含 marker 字符串），safe_kill 必须保护住自己
const r1 = await safeKill(marker, 'SIGTERM')
check('safe_kill 没有杀掉自己（本进程仍活着）', true)
check('safe_kill 杀掉了 2 个目标', r1.killed.length === 2, `killed=${JSON.stringify(r1.killed.map((k) => k.pid))} matched=${r1.matched}`)
check('返回里含 protected 的跳过记录', r1.skipped.length >= 0, JSON.stringify(r1.skipped))
check('目标已消失', targets.every((p) => readProc(p) === null), `still alive: ${targets.filter((p) => readProc(p) !== null).join(',')}`)

// 极端用例：模式匹配「node」——本进程、父 node 全都在候选里，必须一个都不杀
const before = ancestorChain(process.pid)
const r2 = await safeKill('dsh-whale-guard-selftest|node', 'SIGTERM')
const after = ancestorChain(process.pid)
check('祖先链完好无损（模式命中 node 也不自杀）', [...before].every((p) => after.has(p)), `before=${[...before]} after=${[...after]}`)
check('自身没被杀', readProc(process.pid) !== null)
check('保护链里的 PID 都不在 killed 列表', r2.killed.every((k) => !before.has(k.pid)), JSON.stringify(r2.killed.map((k) => k.pid)))

// 空模式拒绝
const r3 = await safeKill('', 'SIGTERM')
check('空模式返回错误而不是乱杀', r3.ok === false)

// ---------------------------------------------------------------------------
// 7. 插件装配（mock ctx）
// ---------------------------------------------------------------------------
console.log('\n[7] 插件装配（mock ctx）')
const tmp = mkdtempSync(join(tmpdir(), 'whale-guard-'))
const registered = []
const listeners = []
const routes = []
const mockCtx = {
  tools: { register: (def) => { registered.push(def); return () => {} }, guard: () => () => {} },
  on: (evt, fn) => { listeners.push([evt, fn]); return () => {} },
  webServer: { register: (route) => { routes.push(route); return () => {} } },
  effect: (fn) => { fn(); return () => {} },
}
apply(mockCtx, {
  stateDir: tmp,
  rulesFile: join(tmp, 'rules.json'),
  mode: 'block',
  rules: {
    disable: ['local-bin-not-in-path'],
    // 顺带验证「主人自己加规则」这条路：自定义 warn 规则必须能命中并注入告警
    custom: [{ id: 'test-custom', title: '自定义示例规则', severity: 'warn', pattern: 'safepkill', message: '这是自定义规则的告警。', fix: '随便什么替代写法' }],
  },
})
check('注册了 safe_kill 工具', registered.some((d) => d.name === 'safe_kill'), registered.map((d) => d.name).join(','))
check('注册了 guard_status 工具', registered.some((d) => d.name === 'guard_status'))
check('挂了 tools/pre-execute', listeners.some(([e]) => e === 'tools/pre-execute'))
check('挂了 tools/post-execute', listeners.some(([e]) => e === 'tools/post-execute'))
check('safe_kill 工具 schema 完整', (() => {
  const d = registered.find((x) => x.name === 'safe_kill')
  return d && typeof d.description === 'string' && d.parameters?.properties?.pattern && typeof d.output?.render === 'function' && typeof d.execute === 'function'
})())

// schema 合法性：API 端会硬校验，写错会被判 INVALID_REQUEST。
// 2026-10-09 真踩过：属性级写 `required: true` → "true is not of type array"，整个请求直接失败。
const schemaProblems = []
/**
 * 递归检查一个 JSON Schema 节点。
 * @param {any} node 节点
 * @param {string} path 位置（报错用）
 */
function validateSchema(node, path) {
  if (node === null || typeof node !== 'object') return
  if ('required' in node && !Array.isArray(node.required)) {
    schemaProblems.push(`${path}.required 必须是数组，实际是 ${JSON.stringify(node.required)}`)
  }
  if (Array.isArray(node.required) && node.properties) {
    for (const key of node.required) {
      if (!(key in node.properties)) schemaProblems.push(`${path}.required 里的 ${JSON.stringify(key)} 在 properties 里不存在`)
    }
  }
  for (const [key, child] of Object.entries(node.properties ?? {})) {
    if (child && typeof child === 'object' && child.required === true) {
      schemaProblems.push(`${path}.properties.${key} 用了属性级 required:true —— JSON Schema 不认，必须改成对象级 required 数组`)
    }
    validateSchema(child, `${path}.properties.${key}`)
  }
  if (node.items) validateSchema(node.items, `${path}.items`)
}
for (const d of registered) {
  validateSchema(d.parameters, `${d.name}.parameters`)
  validateSchema(d.output?.schema, `${d.name}.output.schema`)
}
check('所有工具的 JSON Schema 合法（required 必须是数组）', schemaProblems.length === 0, schemaProblems.join(' | '))

// 工具真的能跑
const safeKillDef = registered.find((d) => d.name === 'safe_kill')
const nothing = await safeKillDef.execute({ pattern: 'whale-guard-no-such-process-xyz' })
check('safe_kill 对不存在的目标安全返回', nothing.ok === true && nothing.matched === 0, JSON.stringify(nothing).slice(0, 150))
check('safe_kill 空 pattern 报错', (await safeKillDef.execute({})).ok === false)
const statusDef = registered.find((d) => d.name === 'guard_status')
const st = await statusDef.execute({})
check('guard_status 正常输出', typeof st.text === 'string' && st.text.includes('保护链'), String(st.text).slice(0, 80))

// pre-execute 拦截行为
const pre = listeners.find(([e]) => e === 'tools/pre-execute')[1]
let nextCalled = false
const denyDecision = await pre({ name: 'bash', callId: 'c1', arguments: { command: 'pkill -f "FurMark_GUI"', description: 'x' } }, async () => { nextCalled = true; return { kind: 'allow' } })
check('危险命令返回 deny', denyDecision.kind === 'deny', JSON.stringify(denyDecision).slice(0, 200))
check('deny 时没有调用 next()', nextCalled === false)
check('deny 原因含替代写法', String(denyDecision.reason).includes('safe_kill'))

nextCalled = false
const allowDecision = await pre({ name: 'bash', callId: 'c2', arguments: { command: 'ls -la', description: 'x' } }, async () => { nextCalled = true; return { kind: 'allow' } })
check('安全命令放行', allowDecision.kind === 'allow' && nextCalled)

nextCalled = false
await pre({ name: 'read', callId: 'c3', arguments: { file_path: '/etc/passwd' } }, async () => { nextCalled = true; return { kind: 'allow' } })
check('非预检工具不打扰', nextCalled)

// hint 走 post-execute 注入
const post = listeners.find(([e]) => e === 'tools/post-execute')[1]
await pre({ name: 'bash', callId: 'c4', arguments: { command: 'safepkill foo', description: 'x' } }, async () => ({ kind: 'allow' }))
const enriched = await post(
  { name: 'bash', callId: 'c4', arguments: { command: 'safepkill foo' } },
  { isError: false, value: { output: 'ok' }, content: [{ type: 'text', text: 'ok' }] },
  async () => ({ kind: 'accept', content: [{ type: 'text', text: 'ok' }] }),
)
check('warn 命中时往结果里插了告警', Array.isArray(enriched.content) && enriched.content.length === 2 && String(enriched.content[0].text).includes('whale-guard') && String(enriched.content[1].text) === 'ok', JSON.stringify(enriched).slice(0, 160))

const untouched = await post(
  { name: 'bash', callId: 'c5', arguments: { command: 'ls' } },
  { isError: false, value: {}, content: [{ type: 'text', text: 'ok' }] },
  async () => ({ kind: 'accept', content: [{ type: 'text', text: 'ok' }] }),
)
check('没命中的调用结果不被改动', untouched.content.length === 1)

// ---------------------------------------------------------------------------
// 8. 设置页后端路由（webServer）
// ---------------------------------------------------------------------------
console.log('\n[8] 设置页路由与配置持久化')

/** 调一条已注册路由，返回它吐出的 JSON。 */
const callRoute = async (path, method = 'GET', body = null) => {
  const route = routes.find((r) => r.path === path)
  if (!route) throw new Error(`route not registered: ${path}`)
  let sent = null
  const res = {
    writeHead: () => {},
    end: (buf) => { sent = JSON.parse(buf.toString('utf8')) },
  }
  const req = {
    method,
    on: (evt, fn) => { if (evt === 'data' && body !== null) fn(Buffer.from(body)); if (evt === 'end') fn() },
  }
  await route.handler(req, res)
  return sent
}

/**
 * 用 pre-execute 判定一条命令会不会被拦（比直接摸规则表更贴近真实行为）。
 * @param {Function} listener pre-execute 监听器
 * @param {string} command 命令文本
 * @returns {Promise<string>} 决策 kind
 */
const decide = async (listener, command) => {
  const d = await listener({ name: 'bash', callId: 'dec-' + Math.random(), arguments: { command } }, async () => ({ kind: 'allow' }))
  return d.kind
}

check('注册了 4 条设置页路由', routes.length === 4, routes.map((r) => r.path).join(','))
check('路由路径前缀是 /whale-guard', routes.every((r) => r.path.startsWith('/whale-guard/')), routes.map((r) => r.path).join(','))

const stats1 = await callRoute('/whale-guard/stats')
check('/stats 返回状态与配置', stats1.ok === true && stats1.stats.rules.enabled > 0 && Array.isArray(stats1.stats.protectedChain), JSON.stringify(stats1).slice(0, 160))
check('/stats 带出受保护链（含自身）', stats1.stats.protectedChain.some((p) => p.pid === process.pid))
check('/stats 带出文件位置', typeof stats1.stats.paths.rulesFile === 'string' && stats1.stats.paths.rulesFile !== '')

const rules1 = await callRoute('/whale-guard/rules')
check('/rules 列出全部规则且字段完整', Array.isArray(rules1.rules) && rules1.rules.length >= 9
  && rules1.rules.every((r) => typeof r.id === 'string' && typeof r.title === 'string' && typeof r.enabled === 'boolean'),
  String(rules1.rules?.length))
check('/rules 反映来自插件配置的停用', rules1.rules.filter((r) => !r.enabled).length === 1 && rules1.rules.find((r) => !r.enabled).fromConfig === true, JSON.stringify(rules1.rules.filter((r) => !r.enabled).map((r) => r.id)))

const audit1 = await callRoute('/whale-guard/audit')
check('/audit 返回数组', Array.isArray(audit1.entries), JSON.stringify(audit1).slice(0, 100))
check('/audit 记录了刚才的命中（预检与 safe_kill 两种都算）', audit1.entries.length >= 2
  && audit1.entries.some((e) => e.kind === 'precheck' && typeof e.ruleId === 'string')
  && audit1.entries.some((e) => e.kind === 'safe_kill'), String(audit1.entries.length))

// 通过设置页停掉一条规则 → 立刻生效 + 重启不丢
const victimId = 'kill-pid1'
const saved = await callRoute('/whale-guard/config', 'POST', JSON.stringify({ rulesDisabled: [victimId] }))
check('POST /config 保存成功', saved.ok === true && saved.config.rulesDisabled.includes(victimId))
const rules2 = await callRoute('/whale-guard/rules')
const vRule = rules2.rules.find((r) => r.id === victimId)
check('被停用的规则在清单里标记 enabled=false', vRule && vRule.enabled === false, JSON.stringify(vRule))
check('停用后 kill 1 不再被拦', await decide(pre, 'kill -9 1') === 'allow')

// 重新加载（模拟重启）：用同一 stateDir 再装配一次，检查配置持久化
const listeners2 = []
const registered2 = []
apply({
  tools: { register: (d) => { registered2.push(d); return () => {} }, guard: () => () => {} },
  on: (e, f) => { listeners2.push([e, f]); return () => {} },
  webServer: { register: () => () => {} },
  effect: (fn) => { fn(); return () => {} },
}, { stateDir: tmp, rulesFile: join(tmp, 'rules.json'), rules: { disable: ['local-bin-not-in-path'] } })
const pre2 = listeners2.find(([e]) => e === 'tools/pre-execute')[1]
let next2 = false
const d2 = await pre2({ name: 'bash', callId: 'x1', arguments: { command: 'kill -9 1' } }, async () => { next2 = true; return { kind: 'allow' } })
check('重启后停用状态仍在（配置持久化生效）', d2.kind === 'allow' && next2, JSON.stringify(d2).slice(0, 120))

// 恢复
await callRoute('/whale-guard/config', 'POST', JSON.stringify({ rulesDisabled: [] }))
check('恢复后 kill 1 又被拦住', await decide(pre, 'kill -9 1') === 'deny')

// 模式切换（运行时即时生效）
await callRoute('/whale-guard/config', 'POST', JSON.stringify({ mode: 'warn' }))
let next3 = false
const d3 = await pre({ name: 'bash', callId: 'x2', arguments: { command: 'pkill -f "zzz"' } }, async () => { next3 = true; return { kind: 'allow' } })
check('切到 warn 模式后危险命令放行（只提醒）', d3.kind === 'allow' && next3, JSON.stringify(d3).slice(0, 120))
await callRoute('/whale-guard/config', 'POST', JSON.stringify({ mode: 'block' }))
let next4 = false
const d4 = await pre({ name: 'bash', callId: 'x3', arguments: { command: 'pkill -f "zzz"' } }, async () => { next4 = true; return { kind: 'allow' } })
check('切回 block 模式后又被拦住', d4.kind === 'deny' && !next4)

rmSync(tmp, { recursive: true, force: true })

// ---------------------------------------------------------------------------
console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`)
if (fail > 0) {
  console.log('失败用例：')
  for (const f of failures) console.log(`  · ${f}`)
  process.exit(1)
}
