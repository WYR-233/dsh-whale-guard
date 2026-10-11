// dsh-whale-guard — 鲸鱼娘防呆插件（Linux 侧）
//
// 一句话：把「昨天一天犯四次的低级错误」变成工具层面的硬拦截 + 安全替代。
//
// 三件东西
//   ① safe_kill 工具   —— 按模式杀进程，自动排除自身与祖先进程链（不再手写 pkill -f）
//   ② bash 命令预检    —— 挂 tools/pre-execute（拦）与 tools/post-execute（告警）
//   ③ 规则库           —— 内置 8 条真实教训，主人可随时加自己的（JSON 文件 + 插件配置）
//
// 设计取舍
//   · 纯 JS、零运行时依赖：只用 node:child_process + node:fs + node:os，不装任何包。
//   · 不依赖 ~/.local/bin：整条链路只用 pgrep + process.kill，非交互 shell 的 PATH 坑绕开了。
//   · deny 只在「必定自伤/灾难」时用；「可能吃亏」的用 warn/hint，绝不拦正常活。
//   · block 时把「为什么」和「替代写法」一起返回，让模型自己改对——而不是干等人工。
//
// 配置（cordis.patch.yml 的 config）
//   rulesFile?  用户规则 JSON 路径（默认 $DSH_HOME/whale-guard-rules.json，不存在也没关系）
//   stateDir?   本插件数据目录（默认 $DSH_HOME/whale-guard），放审计日志
//   enabled?    总开关（默认 true）
//   mode?       'block' | 'warn'：block 才真的拒绝危险命令；warn 只告警（默认 block）
//   precheckTools? 参与预检的工具名（默认 ['bash']）
//   rules?      { disable: string[], custom: Rule[] } 直接写在配置里的规则
//   safeKill?   safe_kill 工具相关：{ signal?: string, maxMatches?: number }
//   auditLog?   是否把命中写 JSONL 审计日志（默认 true）
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

import { DEFAULT_RULES, buildRuleTable, evaluate, renderHits } from './rules.js'
import { ancestorChain, listProcs, safeKill } from './procs.js'

export const name = 'whale-guard'
export const inject = ['tools', 'webServer']

const HOME = process.env.DSH_HOME || join(homedir(), '.dsh')

const DEFAULTS = {
  rulesFile: '',
  stateDir: '',
  enabled: true,
  mode: 'block',
  precheckTools: ['bash'],
  rules: null,
  safeKill: null,
  auditLog: true,
}

// 一次工具调用 → 一条待注入告警（按 callId 关联 pre/post 两个钩子）
const pending = new Map()

export function apply(ctx, pluginConfig) {
  const cfg = { ...DEFAULTS, ...(pluginConfig || {}) }
  const stateDir = resolveDir(cfg.stateDir) || join(HOME, 'whale-guard')
  const rulesFile = resolveDir(cfg.rulesFile) || join(HOME, 'whale-guard-rules.json')
  const auditFile = join(stateDir, 'audit.jsonl')
  const NS = 'whale-guard'
  const toolName = 'safe_kill'
  const precheckTools = new Set(Array.isArray(cfg.precheckTools) && cfg.precheckTools.length > 0 ? cfg.precheckTools.map(String) : ['bash'])
  const defaultSignal = typeof cfg.safeKill?.signal === 'string' && cfg.safeKill.signal !== '' ? cfg.safeKill.signal : 'SIGTERM'
  const configMode = cfg.mode === 'warn' ? 'warn' : 'block'
  // 最近命中记录（内存环形缓冲，供 guard_status 展示；进程重启即清空）
  const recentHits = []
  // 「运行时模式」：设置页改过就以设置页为准（即时生效，不用重启）
  const liveMode = () => {
    const m = loadSettings().mode
    return m === 'warn' ? 'warn' : (m === 'block' ? 'block' : configMode)
  }

  // ---------- 用户规则文件（带 mtime 缓存；用户改完即刻生效，不用重启） ----------
  let cacheMtime = -1
  let cacheRules = null
  const loadUserRules = () => {
    try {
      if (!existsSync(rulesFile)) {
        cacheMtime = -1
        cacheRules = []
        return cacheRules
      }
      const st = statSync(rulesFile)
      const mtime = st.mtimeMs
      if (mtime === cacheMtime && cacheRules) return cacheRules
      const raw = JSON.parse(readFileSync(rulesFile, 'utf8'))
      const list = Array.isArray(raw) ? raw : (Array.isArray(raw?.custom) ? raw.custom : [])
      cacheMtime = mtime
      cacheRules = list
      return cacheRules
    } catch {
      return cacheRules ?? []
    }
  }

  // ---------- 设置页可改的运行时配置（存 stateDir/config.json，重启不丢） ----------
  const settingsFile = join(stateDir, 'config.json')
  const loadSettings = () => {
    const out = { rulesDisabled: [], mode: '' }
    try {
      const raw = JSON.parse(readFileSync(settingsFile, 'utf8'))
      if (raw && typeof raw === 'object') {
        if (Array.isArray(raw.rulesDisabled)) out.rulesDisabled = raw.rulesDisabled.map(String).filter((s) => s !== '')
        if (raw.mode === 'block' || raw.mode === 'warn') out.mode = raw.mode
      }
    } catch { /* 没有配置文件 / 坏文件 → 用默认值，绝不清空用户数据 */ }
    return out
  }
  const saveSettings = (patch) => {
    const next = { ...loadSettings(), ...patch }
    try {
      if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true })
      const tmp = settingsFile + '.tmp'
      writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { encoding: 'utf8' })
      renameSync(tmp, settingsFile)
    } catch { /* 尽力而为，写不进去也不影响拦截 */ }
    return next
  }

  // ---------- 规则表：配置里的 disable/custom + 设置页开关 + 用户 JSON 文件 ----------
  // bareCommands = 「存在于 ~/.local/bin 但不在当前 PATH 里」的自建命令名。
  // 非交互 shell 的 PATH 常缺这个目录，写裸命令名会 command not found —— 命中就提醒一次。
  const localBinCommands = scanLocalBin()
  const ruleTable = () => {
    const fromConfig = cfg.rules && typeof cfg.rules === 'object' ? cfg.rules : {}
    const fileRules = loadUserRules()
    const table = buildRuleTable({
      disable: [...(Array.isArray(fromConfig.disable) ? fromConfig.disable : []), ...loadSettings().rulesDisabled],
      custom: [...(Array.isArray(fromConfig.custom) ? fromConfig.custom : []), ...fileRules],
    })
    table.bareCommands = localBinCommands
    return table
  }

  // ---------- 审计日志（尽力而为；写不进去也不影响拦截） ----------
  const audit = (entry) => {
    if (cfg.auditLog === false) return
    try {
      if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true })
      appendFileSync(auditFile, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n', 'utf8')
    } catch { /* 忽略 */ }
  }

  // 首次加载若规则文件不存在，就落一份带注释的模板，方便主人自己加坑
  if (!existsSync(rulesFile)) {
    try {
      writeFileSync(rulesFile, JSON.stringify(TEMPLATE_RULES, null, 2) + '\n', { encoding: 'utf8' })
    } catch { /* 目录不可写就跳过 */ }
  }

  // =========================================================================
  // ① safe_kill 工具
  // =========================================================================
  ctx.tools.register({
    name: toolName,
    description:
      'Safely kill processes by command-line pattern, automatically excluding this process and its whole '
      + 'ancestor chain — use this INSTEAD of `pkill -f`, which matches its own command line and kills the '
      + 'caller (a real, repeated accident). Returns the matched PIDs, the killed list, and which PIDs were '
      + 'skipped because they belong to the caller chain. Prefers SIGTERM; pass signal to escalate.',
    parameters: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Process match pattern, same semantics as `pgrep -f` (matched against the full command line, extended regex). e.g. "FurMark_GUI", "requirements.txt".',
        },
        signal: {
          type: 'string',
          description: `POSIX signal name to send. Default "${defaultSignal}". Use SIGKILL only when SIGTERM is ignored — it cannot be caught or cleaned up.`,
          enum: ['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGHUP', 'SIGQUIT'],
        },
      },
      required: ['pattern'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean' },
          matched: { type: 'integer' },
          killed: { type: 'array', items: { type: 'object', additionalProperties: true } },
          skipped: { type: 'array', items: { type: 'object', additionalProperties: true } },
          survivors: { type: 'array', items: { type: 'integer' } },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => {
        if (!value || value.ok !== true) {
          return [{ type: 'text', text: `safe_kill 失败：${(value && value.error) || '未知错误'}` }]
        }
        const lines = [`safe_kill 结果：匹配 ${value.matched ?? 0} 个进程，已终止 ${(value.killed ?? []).length} 个。`]
        for (const k of value.killed ?? []) lines.push(`  ✔ PID ${k.pid}  ${k.name} — ${k.cmdline}  [${k.signal}]`)
        for (const s of value.skipped ?? []) {
          lines.push(`  ⊘ PID ${s.pid} 跳过：${s.reason}${s.name ? ` (${s.name})` : ''}`)
        }
        if ((value.survivors ?? []).length > 0) {
          lines.push(`  ⚠ 仍在运行的 PID：${value.survivors.join(', ')}（SIGTERM 可能被忽略，可改用 signal: "SIGKILL"）`)
        }
        if ((value.killed ?? []).length === 0 && (value.matched ?? 0) === 0) {
          lines.push('  （没有进程匹配该模式——目标可能已经不在运行）')
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    timeoutMs: 20_000,
    isConcurrencySafe: () => false,
    presentCall: (args) => ({
      card: 'generic',
      title: `安全杀进程 ${args?.pattern ?? ''}`,
      kind: 'execute',
      rawInput: args,
    }),
    async execute(args) {
      if (cfg.enabled === false) return { ok: false, error: 'whale-guard 已在插件设置里关闭' }
      const pattern = String(args?.pattern ?? '').trim()
      if (pattern === '') return { ok: false, error: '缺少 pattern 参数' }
      const signal = typeof args?.signal === 'string' && args.signal !== '' ? args.signal : defaultSignal
      const result = await safeKill(pattern, signal)
      audit({ kind: 'safe_kill', pattern, signal, matched: result.matched, killed: result.killed.length })
      return result
    },
  })

  // 顺手把祖先链暴露成一个小工具，排障时一眼看明白「哪些 PID 不许杀」
  ctx.tools.register({
    name: 'guard_status',
    description:
      'Show the whale-guard status: which PID chain is protected from safe_kill (this process plus all '
      + 'ancestors), how many rules are active, and recent pre-check hits. Use it to diagnose why a command '
      + 'was blocked or to list the exact PIDs that safe_kill will refuse to touch.',
    parameters: { type: 'object', properties: {}, required: [] },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: value.text ?? '(no status)' }],
    },
    timeoutMs: 10_000,
    async execute() {
      const table = ruleTable()
      const chain = [...ancestorChain(process.pid)]
      const procs = chain.map((pid) => {
        const p = listProcs().find((x) => x.pid === pid)
        return `  PID ${pid}${p ? `  ${p.name} — ${p.cmdline.slice(0, 90)}` : '  (读不到)'}`
      })
      const lines = [
        `whale-guard 状态`,
        `  插件开关：${cfg.enabled === false ? '关闭' : '开启'}    预检模式：${liveMode()}    预检工具：${[...precheckTools].join(', ')}`,
        `  规则文件：${rulesFile}`,
        `  设置页配置（重启不丢）：${settingsFile}`,
        `  生效规则：${table.length} 条（内置 ${table.filter((r) => !r.user).length} + 自定义 ${table.filter((r) => r.user).length}）`,
        `  审计日志：${auditFile}`,
        `  safe_kill 保护链（自身 + 全部祖先，拒绝杀）：`,
        ...procs,
      ]
      if (recentHits.length > 0) {
        lines.push(`  最近命中（最新 ${recentHits.length} 条）：`)
        for (const h of recentHits.slice(-8)) {
          lines.push(`    [${h.at}] ${h.severity} ${h.ruleId} ← ${h.command.slice(0, 80)}`)
        }
      } else {
        lines.push('  最近命中：无')
      }
      return { text: lines.join('\n') }
    },
  })

  // =========================================================================
  // =========================================================================
  // ③ 设置页（Harness 设置 → 防呆）：状态 / 开关 / 规则清单 / 审计日志
  // =========================================================================
  if (ctx.webServer) {
    const sendJson = (res, code, obj) => {
      const body = Buffer.from(JSON.stringify(obj), 'utf8')
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length })
      res.end(body)
    }
    const readBody = (req) => new Promise((resolve) => {
      const chunks = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', () => resolve(''))
    })

    // 规则清单：已禁用的也要报出来（前端需要一个完整的勾选列表）
    const ruleCensus = () => {
      const fromConfig = cfg.rules && typeof cfg.rules === 'object' ? cfg.rules : {}
      const configDisabled = new Set(Array.isArray(fromConfig.disable) ? fromConfig.disable.map(String) : [])
      const runtimeDisabled = new Set(loadSettings().rulesDisabled)
      const active = ruleTable()
      return active.map((r) => ({
        id: r.id,
        title: r.title,
        severity: r.severity,
        user: !!r.user,
        fromConfig: configDisabled.has(r.id),
        enabled: true,
      })).concat(
        DEFAULT_RULES.filter((r) => configDisabled.has(r.id) || runtimeDisabled.has(r.id)).map((r) => ({
          id: r.id,
          title: r.title,
          severity: r.severity,
          user: false,
          fromConfig: configDisabled.has(r.id),
          enabled: false,
        })),
      )
    }

    // 审计日志尾部（只读最近若干条；文件不存在就当空）
    const readAudit = (limit) => {
      try {
        if (!existsSync(auditFile)) return []
        const lines = readFileSync(auditFile, 'utf8').split(/\r?\n/).filter((l) => l.trim() !== '')
        return lines.slice(-limit).map((l) => {
          try { return JSON.parse(l) } catch { return null }
        }).filter(Boolean).reverse()
      } catch {
        return []
      }
    }

    const statsPayload = () => {
      const table = ruleTable()
      const enabled = table.length
      return {
        enabled: cfg.enabled !== false,
        mode: liveMode(),
        rules: { enabled, builtin: table.filter((r) => !r.user).length, custom: table.filter((r) => r.user).length },
        precheckTools: [...precheckTools],
        protectedChain: [...ancestorChain(process.pid)].map((pid) => {
          const p = listProcs().find((x) => x.pid === pid)
          return { pid, name: p?.name ?? '', cmdline: (p?.cmdline ?? '').slice(0, 90) }
        }),
        recentHits: recentHits.slice(-10).reverse(),
        paths: { rulesFile, settingsFile, auditFile, stateDir },
      }
    }

    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: `/${NS}/stats`,
      handler: (req, res) => sendJson(res, 200, { ok: true, stats: statsPayload(), config: loadSettings() }),
    }))

    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: `/${NS}/rules`,
      handler: (req, res) => sendJson(res, 200, { ok: true, rules: ruleCensus() }),
    }))

    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: `/${NS}/audit`,
      handler: (req, res) => sendJson(res, 200, { ok: true, entries: readAudit(60) }),
    }))

    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: `/${NS}/config`,
      handler: async (req, res) => {
        if (req.method === 'GET') return sendJson(res, 200, { ok: true, config: loadSettings() })
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
        let body = {}
        try {
          body = JSON.parse(await readBody(req)) || {}
        } catch {
          return sendJson(res, 400, { ok: false, error: 'bad-json' })
        }
        const patch = {}
        if (Array.isArray(body.rulesDisabled)) {
          patch.rulesDisabled = body.rulesDisabled.map(String).filter((s) => s !== '')
        }
        if (body.mode === 'block' || body.mode === 'warn') patch.mode = body.mode
        return sendJson(res, 200, { ok: true, config: saveSettings(patch) })
      },
    }))
  }

  // ② 命令预检：pre-execute 决定放行/拦截，post-execute 把告警贴进结果
  // =========================================================================
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (cfg.enabled === false) return next()
    if (!precheckTools.has(String(exec?.name ?? ''))) return next()

    const command = extractCommand(exec)
    if (command === '') return next()

    const hits = evaluate(command, ruleTable())
    if (hits.length === 0) return next()

    const hasBlock = hits.some((h) => h.severity === 'block')
    const blocked = hasBlock && liveMode() === 'block'
    const text = renderHits(hits)

    for (const h of hits) {
      const rec = { at: new Date().toISOString(), ruleId: h.id, title: h.title, severity: h.severity, blocked, command: command.slice(0, 400) }
      recentHits.push(rec)
      if (recentHits.length > 50) recentHits.shift()
      audit({ kind: 'precheck', ...rec })
    }

    if (blocked) {
      const worst = hits.find((h) => h.severity === 'block')
      return {
        kind: 'deny',
        reason: `${text}\n\n（命令未执行。请按上面的「安全替代写法」重写命令后重试；若你确信必须原样执行，请先向主人说明理由。）`,
        info: { name: 'whale-guard', code: 'WHALE_GUARD_BLOCKED', reason: worst?.id ?? 'rule-hit' },
      }
    }

    // warn / hint：放行，但把告警登记到本次 callId，等 post-execute 贴进结果
    pending.set(String(exec.callId ?? exec.rootCallId ?? ''), { text, rules: hits.map((h) => h.id) })
    if (pending.size > 100) {
      const firstKey = pending.keys().next().value
      pending.delete(firstKey)
    }
    return next()
  })

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const key = String(exec?.callId ?? exec?.rootCallId ?? '')
    const note = pending.get(key)
    if (!note) return next()
    pending.delete(key)

    const decision = await next()
    if (decision?.kind !== 'accept') return decision
    // 只在原结果的 content 前面加一段告警，绝不吞掉工具自己的输出。
    // 只回传 kind/content/additionalContexts 三个合法字段（accept 的 value 与 content 互斥）。
    const base = Array.isArray(decision.content)
      ? decision.content
      : (Array.isArray(result?.content) ? [...result.content] : [])
    return {
      kind: 'accept',
      content: [{ type: 'text', text: note.text + '\n\n———\n' }, ...base],
      ...(decision.additionalContexts ? { additionalContexts: decision.additionalContexts } : {}),
    }
  })

  // =========================================================================
  // ③ 启动自检（写一行日志，方便排障时确认插件真的装上了）
  // =========================================================================
  console.log(`[whale-guard] 已加载：规则 ${ruleTable().length} 条，预检 ${[...precheckTools].join('/')}，模式 ${configMode}，规则文件 ${rulesFile}`)
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * 从工具调用参数里取出命令文本（bash 工具用 `command`）。
 * @param {any} exec 工具执行上下文
 * @returns {string} 命令文本，取不到返回空串
 */
function extractCommand(exec) {
  const args = exec?.arguments
  if (args === null || typeof args !== 'object') return ''
  for (const key of ['command', 'cmd', 'script', 'code']) {
    const v = args[key]
    if (typeof v === 'string' && v !== '') return v
  }
  return ''
}

/**
 * 解析路径：空 → ''，绝对路径原样，相对路径按 $DSH_HOME 展开。
 * @param {any} value 配置值
 * @returns {string} 绝对路径或 ''
 */
function resolveDir(value) {
  const v = String(value ?? '').trim()
  return v === '' ? '' : (isAbsolute(v) ? v : join(HOME, v))
}

/**
 * 找出 ~/.local/bin 里存在、但当前进程 PATH 中找不到的可执行文件名。
 * 这些命令在 bash 工具（非交互 shell）里直接写名字会 command not found。
 * @returns {string[]} 命令名列表
 */
function scanLocalBin() {
  const dir = join(homedir(), '.local', 'bin')
  let entries = []
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }
  const pathDirs = String(process.env.PATH ?? '').split(':').filter((d) => d !== '')
  const found = []
  for (const n of entries) {
    if (n.startsWith('.')) continue
    if (!/^[A-Za-z0-9._+-]+$/.test(n)) continue
    try {
      if (!statSync(join(dir, n)).isFile()) continue
    } catch {
      continue
    }
    const inPath = pathDirs.some((d) => existsSync(join(d, n)))
    if (!inPath) found.push(n)
  }
  return found
}

// 首次运行落地的规则模板：主人照着加自己的坑即可（改完存盘立即生效，不用重启）
const TEMPLATE_RULES = {
  _说明: [
    '这是 dsh-whale-guard 的用户规则文件。数组里每条规则 = 一个要拦/要提醒的坑。',
    '字段：id(唯一名) / title(一句话) / severity(block=拒绝|warn=告警放行|hint=轻声提示)',
    '      pattern(正则字符串 或 正则数组，对整条命令文本匹配) / message(为什么错) / fix(正确写法)',
    '改完存盘立即生效，不用重启 DSH。',
    '内置规则若想关掉：在插件配置里加 rules: { disable: ["<内置规则id>"] }。',
  ],
  custom: [
    {
      id: '示例-删git目录前先确认',
      title: '示例：递归删 .git 目录',
      severity: 'warn',
      pattern: 'rm\\s+-[a-z]*r[a-z]*f?[a-z]*\\s+[^\\s]*\\.git\\b',
      message: '递归删 .git 会把仓库历史一起带走，想回退就没机会了。',
      fix: '先确认路径：ls -la <路径>/.git；真要删就写全路径再动手。',
    },
  ],
}
