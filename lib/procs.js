// dsh-whale-guard · 安全杀进程核心
//
// 为什么要有它：`pkill -f <模式>` 会匹配「完整命令行」，而执行这条命令的 shell
// 自己命令行里就含该模式 → pkill 把发起者一起杀了（2026-10-09 一天犯 4 次）。
//
// 本模块不用 shell 拼字符串，而是：
//   ① 用 pgrep -f 拿候选 PID（只读，不杀）
//   ② 读 /proc 自己算出「自身 + 全部祖先进程」排除名单
//   ③ 逐个 process.kill()，跳过排除名单里的 PID
// 这样既没有自杀风险，也不受「非交互 shell PATH 不含 ~/.local/bin」影响 ——
// 整条链路只有 pgrep(系统 /usr/bin 或 /bin 里必有) + Node 自己的 process.kill。
import { spawn } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'

/**
 * 跑一个短命令并收全输出（不经过 shell，无注入面）。
 * @param {string} cmd 可执行文件
 * @param {string[]} args 参数
 * @param {number} timeoutMs 超时
 * @returns {Promise<{code:number,stdout:string,stderr:string}>} 结果
 */
function run(cmd, args, timeoutMs = 10_000) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(cmd, args, { windowsHide: true })
    } catch (error) {
      resolve({ code: -1, stdout: '', stderr: String(error?.message ?? error) })
      return
    }
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* ignore */ }
    }, timeoutMs)
    child.stdout?.on('data', (c) => { stdout += c.toString('utf8') })
    child.stderr?.on('data', (c) => { stderr += c.toString('utf8') })
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ code: -1, stdout, stderr: stderr + String(e?.message ?? e) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout, stderr })
    })
  })
}

/**
 * 读 /proc/PID 的基本信息。
 * @param {number} pid 进程号
 * @returns {{pid:number,name:string,cmdline:string,ppid:number}|null} 读不到返回 null
 */
export function readProc(pid) {
  try {
    const dir = `/proc/${pid}`
    const cmdline = readFileSync(`${dir}/cmdline`, 'utf8').split('\0').filter((s) => s !== '').join(' ')
    const stat = readFileSync(`${dir}/stat`, 'utf8')
    // stat 格式: pid (comm) state ppid ...  comm 可能带空格和括号，从最后一个 ')' 往回切
    const close = stat.lastIndexOf(')')
    const open = stat.indexOf('(')
    const name = close > open ? stat.slice(open + 1, close) : ''
    const rest = stat.slice(close + 2).split(' ')
    const ppid = Number.parseInt(rest[1] ?? '', 10)
    return { pid, name, cmdline, ppid: Number.isFinite(ppid) ? ppid : 0 }
  } catch {
    return null
  }
}

/**
 * 算出「自身 + 全部祖先进程」PID 集合：这些谁都不许杀。
 * 这正是 safepkill 脚本的核心思路，这里在 Node 里原生实现。
 * @param {number} startPid 起点（默认当前进程）
 * @returns {Set<number>} 排除集合
 */
export function ancestorChain(startPid = process.pid) {
  const chain = new Set()
  let pid = startPid
  let guard = 0
  while (pid > 0 && guard < 64) {
    chain.add(pid)
    const info = readProc(pid)
    if (!info || info.ppid === pid) break
    pid = info.ppid
    guard++
  }
  return chain
}

/**
 * 列出本机所有进程（读 /proc，不依赖 ps 命令）。
 * @returns {Array<{pid:number,name:string,cmdline:string,ppid:number}>} 进程列表
 */
export function listProcs() {
  const out = []
  let names = []
  try {
    names = readdirSync('/proc')
  } catch {
    return out
  }
  for (const n of names) {
    if (!/^\d+$/.test(n)) continue
    const info = readProc(Number(n))
    if (info) out.push(info)
  }
  return out
}

/**
 * 按模式找候选进程：优先 pgrep -f（与 pkill -f 语义一致），失败则退回 /proc 扫描。
 * @param {string} pattern 匹配模式
 * @returns {Promise<number[]>} 候选 PID
 */
export async function findPids(pattern) {
  const r = await run('pgrep', ['-f', '--', pattern])
  if (r.code === 0 || r.code === 1) {
    return r.stdout.split(/\s+/).filter((s) => /^\d+$/.test(s)).map(Number)
  }
  // pgrep 不可用：退回纯 JS 匹配（不依赖外部命令）
  let re
  try {
    re = new RegExp(pattern)
  } catch {
    re = null
  }
  return listProcs().filter((p) => (re ? re.test(p.cmdline) : p.cmdline.includes(pattern))).map((p) => p.pid)
}

/**
 * 安全地按模式杀进程：自动排除自身与祖先进程链。
 * @param {string} pattern 进程匹配模式（pgrep -f 语义）
 * @param {string} signal 信号名，默认 SIGTERM
 * @returns {Promise<{ok:boolean,matched:number,killed:Array<object>,skipped:Array<object>,error?:string}>} 结果
 */
export async function safeKill(pattern, signal = 'SIGTERM') {
  const pat = String(pattern ?? '')
  if (pat.trim() === '') return { ok: false, matched: 0, killed: [], skipped: [], error: 'pattern 不能为空' }

  const exclude = ancestorChain(process.pid)
  const candidates = await findPids(pat)
  const killed = []
  const skipped = []

  for (const pid of candidates) {
    const info = readProc(pid)
    const label = info ? `${info.name} — ${info.cmdline.slice(0, 120)}` : '(进程已退出)'
    if (pid === process.pid || exclude.has(pid)) {
      skipped.push({ pid, reason: '自身或祖先进程（排除名单）', name: info?.name ?? '', cmdline: info?.cmdline ?? '' })
      continue
    }
    if (info === null) {
      skipped.push({ pid, reason: '读不到 /proc，进程可能已退出', name: '', cmdline: '' })
      continue
    }
    try {
      process.kill(pid, signal)
      killed.push({ pid, name: info.name, cmdline: info.cmdline.slice(0, 200), signal })
    } catch (error) {
      skipped.push({ pid, reason: `kill 失败：${error?.code ?? error?.message ?? error}`, name: info.name, cmdline: label })
    }
  }

  // 稍等一下让进程真正退出，再复查一次信号是否送达（SIGTERM 可能被忽略）
  let survivors = []
  if (killed.length > 0) {
    await new Promise((r) => setTimeout(r, 120))
    survivors = killed.filter((k) => readProc(k.pid) !== null).map((k) => k.pid)
  }

  return {
    ok: true,
    matched: candidates.length,
    killed,
    skipped,
    survivors,
    excluded: [...exclude],
  }
}
