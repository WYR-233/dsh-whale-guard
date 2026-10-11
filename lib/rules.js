// dsh-whale-guard · 规则引擎
//
// 设计要点
//   · 规则 = 纯数据 + 一个匹配函数；内置规则写在 DEFAULT_RULES，用户可加自己的。
//   · 先「清洗」命令文本再匹配：剥掉注释、把引号内容换成位置标记。
//     这样 `echo "rm -rf /"`（把危险字样当数据）不会被误判，
//     而 `pkill -f "FurMark_GUI"`（引号里是参数）仍能被正确识别。
//   · severity 三档：
//       block = 拒绝执行（连同「为什么」和「替代写法」一起返回）
//       warn  = 放行，但在工具结果里插一条醒目告警
//       hint  = 放行 + 一条轻提示

/** @typedef {'block'|'warn'|'hint'} Severity */

/** 引号内字面量的位置标记：主检测避开它，但段落里留着，好让「命令结构」不失真。 */
const QUOTED = '\u0001Q\u0001'

/**
 * 找第一个 heredoc 起始符（`<<` 或 `<<-` 后跟未加引号的标记名）。
 * 只认同一个命令里的第一次出现：heredoc 主体往往很长（整篇脚本），
 * 后面即使还有别的 heredoc，截断点也已经在更前面了。
 * @param {string} text 命令文本
 * @returns {number} 起始下标；没有则 -1
 */
function heredocParts(text) {
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch === "'" || ch === '"') {
      const quote = ch
      i++
      while (i < text.length) {
        if (text[i] === '\\' && quote === '"') { i += 2; continue }
        if (text[i] === quote) { i++; break }
        i++
      }
      continue
    }
    if (ch === '<' && text[i + 1] === '<') {
      // `<<EOF` / `<<-EOF` / `<<'EOF'` / `<<"EOF"` 都算；`<<<`（here-string）不算
      const m = /^<<-?\s*(?:'([A-Za-z_][A-Za-z0-9_]*)'|"([A-Za-z_][A-Za-z0-9_]*)"|([A-Za-z_][A-Za-z0-9_]*))/.exec(text.slice(i))
      if (m) {
        const marker = m[1] ?? m[2] ?? m[3]
        const eol = text.indexOf('\n', i)
        if (eol < 0) return { before: text, after: '' }
        const bodyStart = eol + 1
        // 找结束标记：独占一行的 marker
        const endRe = new RegExp('^\\s*' + marker + '\\s*$', 'm')
        const rest = text.slice(bodyStart)
        const em = endRe.exec(rest)
        const afterStart = em ? bodyStart + em.index + em[0].length : text.length
        return { before: text.slice(0, i), after: text.slice(afterStart) }
      }
    }
    i++
  }
  return { before: text, after: '' }
}

/**
 * 把命令文本切成「代码段」：剥掉 # 注释与 heredoc 主体，把引号内容替换成位置标记。
 * 之所以要切分：
 *   · `echo "rm -rf /"` 这种把危险字样当数据的情况不该误判；
 *   · heredoc 里常常是整篇脚本（`bash <<'EOF' … EOF`），那片内容是**数据**，
 *     不是马上要执行的命令，不该被预检当成命令扫（否则写脚本时会被自己的文本误拦）。
 * @param {string} command 原始命令
 * @returns {string[]} 每段文本（已压空白、去空段）
 */
export function codeSegments(command) {
  const text = String(command ?? '')
  // heredoc 的主体（喂给子进程的数据）不算命令；但它前后的命令行都要扫
  const parts = heredocParts(text)
  const head = parts.before
  const segments = []
  let buf = ''
  let i = 0
  while (i < head.length) {
    const ch = head[i]
    if (ch === '#' && (i === 0 || /[\s;&|(]/.test(head[i - 1]))) {
      while (i < head.length && head[i] !== '\n') i++
      continue
    }
    if (ch === "'" || ch === '"') {
      const quote = ch
      i++
      let closed = false
      while (i < head.length) {
        if (head[i] === '\\' && quote === '"') { i += 2; continue }
        if (head[i] === quote) { closed = true; i++; break }
        i++
      }
      if (closed) buf += QUOTED
      continue
    }
    if (ch === ';' || ch === '\n' || ch === '|' || ch === '&' || ch === '{' || ch === '}') {
      segments.push(buf)
      buf = ''
      i++
      continue
    }
    buf += ch === '\t' ? ' ' : ch
    i++
  }
  segments.push(buf)
  if (parts.after.trim() !== '') segments.push(...codeSegments(parts.after))
  return segments.map((s) => s.replace(/[ ]+/g, ' ').trim()).filter((s) => s !== '')
}

/**
 * 段落 → 供正则匹配的文本（引号内容隐去）。
 * @param {string} segment 一段代码
 * @returns {string} 清洗后的文本
 */
const segText = (segment) => String(segment ?? '').replaceAll(QUOTED, '').replace(/[ ]+/g, ' ').trim()

/**
 * 摘出命令里所有引号内的字面量（换行连接）。
 * 用途：判断 `pkill -f "<模式>"` 里的模式是否也出现在这条命令自身的命令行里。
 * @param {string} command 原始命令
 * @returns {string} 引号内容拼接
 */
export function quotedParts(command) {
  const out = []
  const re = /'([^']*)'|"((?:[^"\\]|\\.)*)"/g
  let m
  while ((m = re.exec(String(command ?? ''))) !== null) {
    const v = m[1] ?? String(m[2] ?? '').replace(/\\(.)/g, '$1')
    if (v !== '') out.push(v)
  }
  return out.join('\n')
}

/**
 * 提取 `pkill` 的 `-f` 模式候选（引号内的字面量 + 关键字后面的裸词）。
 * @param {string} segment 一段代码
 * @param {string} quoted 全命令引号内容
 * @returns {string[]} 模式候选
 */
function pkillPatternCandidates(segment, quoted) {
  const out = new Set()
  for (const q of quoted.split('\n')) {
    if (q !== '') out.add(q)
  }
  const m = String(segment).match(/\bpkill\b\s+((?:-[a-zA-Z]+\s+)*)-[a-zA-Z]*f\s+(.*)$/)
  if (m) {
    for (const w of m[2].replaceAll(QUOTED, ' ').split(/\s+/)) {
      if (w !== '' && !w.startsWith('-')) out.add(w)
    }
  }
  return [...out]
}

/**
 * 提取 `grep` 的模式参数：引号内的字面量，以及紧跟在引号标记后面的裸词。
 * 这类模式的用途是「筛进程列表」，所以只要它本身（或它匹配的字面量）出现在
 * 这条命令自身里，grep 就会把「正在跑这条命令的进程」也列进结果。
 * @param {string[]} segments 代码段
 * @param {string} quoted 全命令引号内容
 * @returns {string[]} 模式候选
 */
function grepPatterns(segments, quoted) {
  const out = []
  for (const q of quoted.split('\n')) {
    if (q !== '') out.push(q)
  }
  for (const seg of segments) {
    const t = segText(seg)
    if (!/(?:^|\s)grep\b/.test(t)) continue
    // 剥掉 'grep' 本身与所有选项，剩下的词才是模式
    for (const w of t.replace(/(?:^|\s)grep\b/, ' ').split(/\s+/)) {
      if (w === '' || w.startsWith('-')) continue
      if (/^[A-Za-z0-9_.@/+-]+$/.test(w)) out.push(w)
    }
  }
  return [...new Set(out)]
}

/** @type {Array<object>} */
export const DEFAULT_RULES = [
  // ① pkill -f 自杀（2026-10-09 一天犯 4 次，最痛）
  {
    id: 'pkill-self-match',
    title: 'pkill -f 会匹配到自己，等于自杀',
    severity: 'block',
    message:
      '`pkill -f <模式>` 匹配的是**完整命令行**，而这条命令自己的命令行里就含该模式，'
      + '所以 pkill 一定会把发起者自己（连同父进程链）一起干掉。结果不是「杀掉了目标」，而是「把自己干没了」。',
    fix:
      '改用 safe_kill 工具（自动排除自身+祖先进程链）：\n'
      + '  safe_kill({ pattern: "<要杀的模式>" })\n'
      + '或改用命令行脚本 safepkill（同样排除了自身与祖先）：\n'
      + '  /usr/local/bin/safepkill "<要杀的模式>"',
    test: (c) => {
      for (const seg of c.segments) {
        const flat = segText(seg)
        if (!/\bpkill\b/.test(flat)) continue
        if (!/(?:^|\s)-[a-zA-Z]*f(?:[a-zA-Z]*)?(?:\s|$)/.test(flat)) continue
        for (const pat of pkillPatternCandidates(flat, c.quoted)) {
          const needle = pat.replace(/\\(.)/g, '$1')
          if (needle === '') continue
          const esc = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          // 在「命令行 + 引号字面量」里找：命中即说明模式会被 pgrep 匹配到自身
          if (new RegExp(esc, 'i').test(c.effective)) return true
        }
      }
      return false
    },
  },

  // ①' ps | grep | xargs kill 同款自杀（grep 进程自己也被列进去）
  {
    id: 'grep-xargs-kill-self-match',
    title: 'ps|grep|xargs kill 会连自己一起杀',
    severity: 'block',
    message:
      '`ps ... | grep "<模式>" | xargs kill` 里的 grep 进程，其命令行本身就包含这条命令的全文，'
      + '于是 grep 把「正在执行的这条命令」也列进结果，kill 顺手把自己一起收掉。',
    fix:
      '改用 safe_kill 工具：\n  safe_kill({ pattern: "<要杀的模式>" })\n'
      + '若坚持用管道写法，grep 模式必须加中括号自规避：`grep "[p]ip install"`。',
    test: (c) => {
      const command = c.command
      if (!/\bxargs\b/.test(command)) return false
      if (!/\bgrep\b/.test(command)) return false
      // kill 必须是「命令」（不在引号里、不是被杀掉的 grep 参数字面量）
      const killed = /(?:^|[\s;&|])kill\b/.test(segText(c.segments.join(' ; ')))
      if (!killed) return false
      // grep 的模式若也出现在这条命令自身里（且不是 [x] 自规避写法）→ grep 会列到自己 → 自杀
      for (const needle of grepPatterns(c.segments, quotedParts(command))) {
        if (needle.length < 3) continue
        if (/[\\^$.*+?()[\]{}]/.test(needle)) continue // 正则元字符 / [x] 自规避写法 → 不会自我匹配
        if (command.includes(needle)) return true
      }
      return false
    },
  },

  // ② sudo -S 配 heredoc 抢 stdin：密码喂不进去
  {
    id: 'sudo-heredoc-stdin',
    title: 'sudo -S 与 heredoc 抢 stdin，密码喂不进去',
    severity: 'block',
    message:
      '`echo 密码 | sudo -S ... <<EOF` 里，sudo 的 `-S` 要从 stdin 读密码，'
      + 'heredoc 也要占用同一个 stdin，两者互抢 → 密码永远喂不进去（表现是「提权卡住」或「密码错」）。',
    fix:
      '先落盘、再提权搬运，两件事分开：\n'
      + '  ① write 工具把内容写到 /tmp/x.conf\n'
      + '  ② echo \'密码\' | sudo -S cp /tmp/x.conf /etc/foo.conf',
    test: (c) => {
      // heredoc 标记会随切段丢掉，所以「有没有 heredoc」看原文，「sudo -S」看命令行
      if (!/<<[^<]/.test(c.command)) return false
      const cmdline = c.segments.map(segText)
      return cmdline.some((t) => /(?:^|\s)sudo\b/.test(t) && /(?:^|\s)-[a-zA-Z]*S(?:\s|$)/.test(t))
    },
  },

  // ③ 非交互 shell 里 sudo 要 -S 或 pkexec（只提示，不拦）
  {
    id: 'sudo-needs-tty',
    title: '非交互 shell 下 sudo 拿不到终端',
    severity: 'hint',
    message:
      'bash 工具跑的是**非交互 shell**：没有 TTY，sudo 默认要读终端拿密码，会直接失败或挂住。',
    fix: '喂密码用 `sudo -S`（但别与 heredoc 同用），弹 KDE 图形密码框用 `pkexec`。',
    test: (c) => {
      if (process.stdout.isTTY) return false
      // 只看真正的命令行（heredoc 主体里的 sudo 说明文字不算）
      const cmdline = c.segments.map(segText).join(' ')
      if (!/(?:^|[\s;|&])sudo\b/.test(cmdline)) return false
      if (/(?:^|\s)-\w*S\b/.test(cmdline)) return false
      if (/(?:^|\s)-\w*n\b/.test(cmdline)) return false
      return true
    },
  },

  // ④ 灾难级删除
  {
    id: 'rm-rf-root',
    title: '递归删根目录 / 系统目录',
    severity: 'block',
    message: '`rm -rf /` 及同义变体会递归清空根或系统目录；本机没有回档点，删掉就等于重装系统。',
    fix: '删除前先确认真实绝对路径：要删项目目录就写全路径，并先 `ls` 核一遍再动手。',
    test: (c) => {
      for (const seg of c.segments) {
        const t = segText(seg)
        const m = t.match(/\brm\b((?:\s+-{1,2}[a-zA-Z-]+)*)\s+(.*)$/)
        if (!m) continue
        const opts = m[1] + ' '
        const recursive = /(?:^|\s)-[a-zA-Z]*r/i.test(opts) || /--recursive/.test(opts)
        const force = /(?:^|\s)-[a-zA-Z]*f/i.test(opts) || /--force/.test(opts)
        if (!(recursive && force)) continue
        for (const tgt of m[2].split(/\s+/).filter((x) => x !== '' && !x.startsWith('-'))) {
          if (/^\/+\*?$/.test(tgt)) return true
          if (/^\/(?:etc|usr|var|boot|bin|sbin|lib|lib64|opt|home|root|dev|proc|sys)\/?\*?$/.test(tgt)) return true
        }
      }
      return false
    },
  },

  // ⑤ 杀 init / PID 1
  {
    id: 'kill-pid1',
    title: '杀 PID 1（init / systemd）',
    severity: 'block',
    message: 'PID 1 是 init/systemd，杀它等于让整个系统当场崩溃或重启，多半不是本意。',
    fix: '重启服务用 `systemctl restart <服务名>`；用户级服务用 `systemctl --user restart <服务名>`。',
    test: (c) =>
      c.segments.some((seg) => {
        const t = segText(seg)
        if (!/\bkill\b/.test(t)) return false
        if (/\b(?:pgrep|pkill|killall|killall5)\b/.test(t)) return false
        return /\bkill\b(?:\s+-{1,2}[a-zA-Z0-9]+)*\s+(?:--\s+)?1(?=\s|$)/.test(t)
      }),
  },

  // ⑥ 权限递归放开到关键目录
  {
    id: 'chmod-r777-root',
    title: '递归 777 / 改属主覆盖关键目录',
    severity: 'block',
    message: '把整棵系统目录树改成 777（全权限）会破坏安全模型，且很难回退。',
    fix: '按需给单个路径授权：`chmod 755 <路径>`；确要递归先缩小到项目目录并写全路径。',
    test: (c) =>
      c.segments.some((seg) => {
        const t = segText(seg)
        if (!/(?:^|\s)ch(?:mod|own)\b/.test(t)) return false
        if (!/(?:^|\s)-[a-zA-Z]*R/.test(t) && !/--recursive/.test(t)) return false
        if (/\bchmod\b/.test(t) && !/777/.test(t)) return false
        return t.split(/\s+/).some((w) => /^\/(?:etc|usr|var|boot|bin|sbin|lib|lib64|opt|home|root|dev|proc|sys)\/?\*?$/.test(w) || /^\/+\*?$/.test(w))
      }),
  },

  // ⑦ 包管理器没走国内镜像 → 慢几十到几百倍
  {
    id: 'pip-no-mirror',
    title: 'pip 未走国内镜像（会慢几十到几百倍）',
    severity: 'hint',
    message: '这条 pip 命令没有指定镜像源；本机 ~/.config/pip/pip.conf 配的是阿里云，漏写会直连 PyPI（国内极慢）。',
    fix: '显式走镜像：`pip install -i https://mirrors.aliyun.com/pypi/simple <包名>`。',
    test: (c) =>
      /\bpip3?\s+install\b/.test(c.searchable)
      && !/-i\s+\S+|--index-url/.test(c.searchable),
  },

  // ⑧ 非交互 shell 的 PATH 坑（只在命令确实调用了「PATH 里找不到的自建命令」时提示）
  {
    id: 'local-bin-not-in-path',
    title: '这个自建命令不在 PATH 里，会「找不到」',
    severity: 'warn',
    message:
      'bash 工具每次都是**全新的非交互 shell**：`~/.bashrc` 不加载（里面定义的函数/别名全用不了），'
      + 'PATH 也不含 `~/.local/bin`。所以直接写命令名很可能报 `command not found`。',
    fix: '用绝对路径（例如 ~/.local/bin/<命令>），或把脚本软链到 /usr/local/bin 下。',
    test: (c) => c.bareCommands.some((n) => new RegExp(`(?:^|[;&]\\s*|\\bsudo\\s+)${n}\\b`).test(c.searchable)),
  },
]

// ---------------------------------------------------------------------------
// 用户规则（JSON）→ 运行时可用的规则对象
// ---------------------------------------------------------------------------

/**
 * 把一条用户 JSON 规则编成内部规则对象。
 * @param {any} raw 用户规则
 * @returns {object|null} 编好的规则，缺字段则 null
 */
function compileUserRule(raw) {
  if (!raw || typeof raw !== 'object') return null
  if (typeof raw.id !== 'string' || raw.id.trim() === '') return null
  const severity = ['block', 'warn', 'hint'].includes(raw.severity) ? raw.severity : 'warn'
  let test = null
  if (typeof raw.pattern === 'string' && raw.pattern !== '') {
    const re = safeRegExp(raw.pattern, raw.flags)
    if (!re) return null
    test = (c) => re.test(c.command)
  } else if (Array.isArray(raw.pattern) && raw.pattern.length > 0) {
    const res = raw.pattern.map((p) => safeRegExp(p, raw.flags)).filter(Boolean)
    if (res.length === 0) return null
    test = (c) => res.some((re) => re.test(c.command))
  } else if (typeof raw.builtin === 'string') {
    const builtin = DEFAULT_RULES.find((r) => r.id === raw.builtin)
    test = builtin ? builtin.test : null
  }
  if (!test) return null
  return {
    id: raw.id,
    title: typeof raw.title === 'string' ? raw.title : raw.id,
    severity,
    message: typeof raw.message === 'string' ? raw.message : '',
    fix: typeof raw.fix === 'string' ? raw.fix : '',
    test,
    user: true,
  }
}

/**
 * 安全地编译一个用户正则。
 * @param {any} pattern 正则字符串
 * @param {any} flags 标志
 * @returns {RegExp|null} 编译失败返回 null
 */
function safeRegExp(pattern, flags) {
  try {
    return new RegExp(String(pattern), typeof flags === 'string' ? flags : '')
  } catch {
    return null
  }
}

/**
 * 合并内置规则与用户规则。
 * @param {any} rulesConfig 插件配置的 rules 字段
 * @returns {object[]} 生效规则表
 */
export function buildRuleTable(rulesConfig) {
  const cfg = rulesConfig && typeof rulesConfig === 'object' ? rulesConfig : {}
  const disabled = new Set(Array.isArray(cfg.disable) ? cfg.disable.map(String) : [])
  const table = DEFAULT_RULES.filter((r) => !disabled.has(r.id)).map((r) => ({ ...r, user: false }))
  for (const raw of Array.isArray(cfg.custom) ? cfg.custom : []) {
    const rule = compileUserRule(raw)
    if (rule) table.push(rule)
  }
  // 同一条规则表，两种读法：数组（跑匹配）+ `rules` 自引用（给设置页序列化）。
  table.rules = table
  return table
}

/**
 * 对命令文本跑一遍规则表。
 * @param {string} command 原始命令
 * @param {object[]} table 规则表
 * @returns {Array<object>} 命中规则（block → warn → hint 排序）
 */
export function evaluate(command, table) {
  const raw = String(command ?? '')
  const segments = codeSegments(raw)
  // 两个视角：
  //   searchable = 真正的命令行 + 引号字面量（heredoc 正文已排除——那片是喂给子进程的数据）
  //   quoted     = searchable 里的引号内容（引号已被抹成位置标记，所以单独摘出来）
  const segTextAll = segText(segments.join(' ; '))
  const searchable = (segTextAll + ' ' + quotedParts(raw)).trim()
  const bareCommands = Array.isArray(table.bareCommands) ? table.bareCommands : []
  const ctx = { command: raw, segments, flat: searchable, searchable, bareCommands,
    effective: searchable, quoted: quotedParts(raw) }
  const hits = []
  for (const rule of table) {
    let matched = false
    try {
      matched = rule.test(ctx)
    } catch { /* 单条规则出错不影响其他规则 */ }
    if (matched) hits.push(rule)
  }
  const rank = { block: 0, warn: 1, hint: 2 }
  hits.sort((a, b) => (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9))
  return hits
}

/**
 * 把命中渲染成给模型看的中文告警块。
 * @param {Array<object>} hits 命中规则
 * @returns {string} Markdown 文本；无命中返回空串
 */
export function renderHits(hits) {
  if (!hits || hits.length === 0) return ''
  const label = { block: '【已拦截】', warn: '【警告】', hint: '【提示】' }
  const parts = hits.map((h) => {
    const lines = [`${label[h.severity] ?? '【提示】'} ${h.title}（规则 ${h.id}）`, h.message]
    if (h.fix) lines.push('安全替代写法：', h.fix)
    return lines.join('\n')
  })
  const worst = hits[0]
  const head = worst.severity === 'block'
    ? '🛡️ whale-guard 预检未通过：这条命令会伤到自己或系统，已被拦下（未执行）。'
    : '🛡️ whale-guard 预检提醒（命令已放行）：'
  return `${head}\n\n${parts.join('\n\n')}`
}
