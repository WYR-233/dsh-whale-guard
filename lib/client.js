// dsh-whale-guard — client half：设置页「防呆」（状态 / 模式 / 规则清单 / 拦截日志）。
// 零构建手写 React，接线方式与本机其它 DSH 客户端插件一致：
//   window.__ModuleLoader__.load({ id, factory(require) }) → exports.apply / exports.inject
// 样式只用 Harness 主题令牌（--dsh-*），深浅主题都跟随宿主，不自带颜色。
window.__ModuleLoader__.load({ id: "dsh-whale-guard", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
const React = require("react");
const h = React.createElement;

const NS = "whale-guard";
const API = "/" + NS;

// ---------------- my icon (shared by the page header and the settings nav) ----------------
// 手绘矢量，和另两个自研插件（记忆库 / 语音朗读）成套；设计稿见 README。
// 数据是纯路径字符串：浏览器侧模块表只认 React，不能 import 另一个文件。
const ICON_D = [
  'M12 2.6 20 5.3v5.9c0 4.9-3.3 8.5-8 10.2-4.7-1.7-8-5.3-8-10.2V5.3z',
  'M12 16.1c0-2.4-1.3-3.4 0-4.4 1.3 1 0 2 0 4.4z',
  'M9.5 11.2c.6 2.6 1.6 3.3 2.5 2 .9 1.3 1.9.6 2.5-2-2.1-.5-2.6.6-2.5 1.3-.1-.7-.6-1.8-2.5-1.3z',
]
const NAV_MARK = 'data-whale-guard-icon'

/**
 * 渲染本插件的图标。
 * @param {{size?: number, className?: string, strokeWidth?: number}} [props] 参数
 * @returns {object} React 元素
 */
function Icon(props) {
  const size = (props && props.size) || 16
  const sw = (props && props.strokeWidth) || 1.7
  return h('svg', {
    viewBox: '0 0 24 24', width: size, height: size,
    className: props && props.className, [NAV_MARK]: '1',
    fill: 'none', stroke: 'currentColor', 'stroke-width': sw,
    'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true',
  }, ICON_D.map((d, i) => h('path', { key: i, d: d })))
}

/**
 * 把设置导航里本插件那一行的默认齿轮换成自己的图标。
 *
 * 为什么要在 DOM 上动手：DSH 的 `navIcon(id)` 是一张**写死的表**
 * （settings-general 里 `if (id === 'account') … return IconSettingsOutlineMedium`），
 * 未登记的 section 一律回退齿轮，而 `settings.section` 的注册选项只有 id/order/label，
 * 没有图标位。所以要么改 DSH 本体（每次升级被覆盖），要么只动「自己这一行」的图标节点。
 * 这里选后者：命中范围仅限本插件那一个 <svg.navIcon>，幂等、不动他人节点。
 * React 重渲染会把节点换回去，所以用 MutationObserver 持续纠偏（没命中时极廉价）。
 */
function installNavIcon() {
  if (typeof document === 'undefined') return
  const applyIcon = () => {
    const btns = document.querySelectorAll('button')
    for (const btn of btns) {
      const txt = (btn.textContent || '').trim()
      if (txt !== '防呆' && txt !== 'Guard') continue
      const old = btn.querySelector('svg')
      if (!old) continue
      if (old.hasAttribute(NAV_MARK)) return
      const span = document.createElement('span')
      span.style.display = 'inline-flex'
      span.style.flex = 'none'
      span.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" '
        + 'fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" '
        + NAV_MARK + '="1" class="' + (old.getAttribute('class') || '') + '">'
        + ICON_D.map((d) => '<path d="' + d + '"/>').join('') + '</svg>'
      old.replaceWith(span)
      return
    }
  }
  applyIcon()
  if (typeof MutationObserver !== 'undefined' && document.body) {
    let last = 0
    new MutationObserver(() => {
      const now = Date.now()
      if (now - last < 100) return
      last = now
      applyIcon()
    }).observe(document.body, { childList: true, subtree: true })
  }
}

// ---------------- i18n (zh / en) ----------------
const TEXT = {
  zh: {
    label: "防呆",
    statusTitle: "🛡️ 防呆守卫",
    on: "守卫运行中",
    off: "守卫已停用",
    offHint: "停用后不再拦截任何命令（修改插件配置里的 enabled 后重启生效）",
    mode: "处置方式",
    modeBlock: "拦截",
    modeWarn: "只提醒",
    modeBlockHint: "命中高危规则时拒绝执行该命令，并把替代写法交给模型自己改",
    modeWarnHint: "命中只给出提醒然后照常执行（观察期用，平时不建议）",
    rulesCount: "生效规则",
    tools: "预检工具",
    chainTitle: "受保护进程链",
    chainHint: "safe_kill 拒绝触碰这些进程（自身 + 全部祖先）",
    rulesTitle: "规则清单",
    rulesHint: "取消勾选＝停用该规则，立即生效（重启不丢）",
    builtin: "内置",
    custom: "自定义",
    sevBlock: "拦截",
    sevWarn: "警告",
    sevHint: "提示",
    locked: "已在插件配置里停用，设置页改不了",
    auditTitle: "最近拦截 / 提醒",
    auditEmpty: "还没有命中记录——说明最近没踩坑，挺好",
    auditBlocked: "已拦截",
    auditWarn: "提醒",
    pathsTitle: "文件位置",
    rulesFile: "规则文件（可自己加坑）",
    settingsFile: "设置页配置",
    auditFile: "审计日志",
    errStats: "取不到守卫状态（host 端路由没起来？重启后重试）",
    foot: "改完即时生效；守卫本体是 dsh-whale-guard 插件",
    copied: "已复制 ✓",
    copy: "复制路径",
  },
  en: {
    label: "Guard",
    statusTitle: "🛡️ Whale guard",
    on: "Guard is running",
    off: "Guard is disabled",
    offHint: "Nothing is blocked while disabled (set `enabled` in the plugin config and restart)",
    mode: "Response to a hit",
    modeBlock: "Block",
    modeWarn: "Warn only",
    modeBlockHint: "Refuse to run a dangerous command and hand the model a safe alternative",
    modeWarnHint: "Just warn and run anyway (observation mode; not recommended)",
    rulesCount: "Active rules",
    tools: "Checked tools",
    chainTitle: "Protected process chain",
    chainHint: "safe_kill refuses to touch these (itself plus every ancestor)",
    rulesTitle: "Rules",
    rulesHint: "Uncheck to disable a rule — applies immediately and survives restarts",
    builtin: "Built-in",
    custom: "Custom",
    sevBlock: "block",
    sevWarn: "warn",
    sevHint: "hint",
    locked: "Disabled in the plugin config; not editable here",
    auditTitle: "Recent blocks / warnings",
    auditEmpty: "No hits recorded yet — nothing has tripped the guard",
    auditBlocked: "blocked",
    auditWarn: "warned",
    pathsTitle: "Files",
    rulesFile: "Rules file (add your own cases here)",
    settingsFile: "Settings state",
    auditFile: "Audit log",
    errStats: "Cannot read guard status (host route missing? restart and retry)",
    foot: "Changes apply immediately; the guard itself is the dsh-whale-guard plugin",
    copied: "Copied ✓",
    copy: "Copy path",
  },
};

function fmtTime(iso) {
  if (!iso) return "-";
  try {
    const d = new Date(iso);
    const p = (x) => String(x).padStart(2, "0");
    return p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
  } catch (_) { return "-"; }
}

// ---------------- shared bits ----------------
const BORDER = "1px solid var(--dsh-border, rgba(127,127,127,.28))";

function Card(props) {
  return h("div", {
    style: Object.assign({
      border: BORDER, borderRadius: 10, padding: "12px 14px", marginBottom: 10,
      background: "var(--dsh-surface, rgba(127,127,127,.06))",
    }, props.style || {}),
  }, props.children);
}
function Row(props) {
  return h("div", { style: { display: "flex", justifyContent: "space-between", gap: 12, padding: "3px 0", alignItems: "baseline" } },
    h("span", { style: { opacity: .75, flex: "0 0 auto" } }, props.label),
    h("span", { style: { fontWeight: 600, textAlign: "right", wordBreak: "break-all" } }, props.value));
}
function Toggle(props) {
  return h("label", { style: { display: "flex", alignItems: "center", gap: 8, cursor: props.disabled ? "not-allowed" : "pointer", padding: "4px 0", opacity: props.disabled ? .55 : 1 } },
    h("input", {
      type: "checkbox", checked: !!props.checked, disabled: !!props.disabled,
      onChange: (e) => props.onChange(e.target.checked),
      style: { width: 16, height: 16, cursor: props.disabled ? "not-allowed" : "pointer" },
    }),
    h("span", null, props.label));
}
function Pill(props) {
  return h("span", {
    style: {
      border: BORDER, borderRadius: 999, padding: "1px 8px", fontSize: 11, fontWeight: 600,
      opacity: props.dim ? .6 : 1, whiteSpace: "nowrap",
    },
  }, props.children);
}
function CopyButton(props) {
  const [done, setDone] = React.useState(false);
  return h("button", {
    onClick: () => {
      try { navigator.clipboard.writeText(props.text); setDone(true); setTimeout(() => setDone(false), 1200); } catch (_) { }
    },
    style: {
      padding: "2px 8px", borderRadius: 6, cursor: "pointer", fontSize: 11,
      border: BORDER, background: "transparent", color: "inherit",
    },
  }, done ? props.copiedLabel : props.label);
}
function ModeButton(props) {
  const active = !!props.active;
  return h("button", {
    onClick: props.onClick,
    style: {
      padding: "4px 12px", borderRadius: 7, cursor: "pointer", fontSize: 13, fontWeight: active ? 700 : 400,
      border: BORDER, color: "inherit",
      background: active ? "var(--dsh-surface, rgba(127,127,127,.18))" : "transparent",
      opacity: active ? 1 : .65,
    },
  }, props.children);
}

// ---------------- page ----------------
function SettingsPage() {
  const [cfg, setCfg] = React.useState(null);
  const [stats, setStats] = React.useState(null);
  const [rules, setRules] = React.useState(null);
  const [audit, setAudit] = React.useState(null);
  const [err, setErr] = React.useState("");
  const t = React.useMemo(() => {
    const lang = (typeof navigator !== "undefined" && navigator.language ? navigator.language : "en").toLowerCase();
    return lang.indexOf("zh") === 0 ? TEXT.zh : TEXT.en;
  }, []);

  const load = () => {
    fetch(API + "/stats").then((r) => r.json()).then((j) => {
      if (j && j.ok) { setStats(j.stats); setCfg(j.config); } else setErr(t.errStats);
    }).catch(() => setErr(t.errStats));
    fetch(API + "/rules").then((r) => r.json()).then((j) => { if (j && j.ok) setRules(j.rules); }).catch(() => { });
    fetch(API + "/audit").then((r) => r.json()).then((j) => { if (j && j.ok) setAudit(j.entries); }).catch(() => { });
  };
  React.useEffect(load, []);

  const save = (patch) => {
    setCfg((c) => Object.assign({}, c, patch));
    fetch(API + "/config", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    }).then((r) => r.json()).then((j) => { if (j && j.ok) setCfg(j.config); }).catch(() => { });
  };
  const toggleRule = (id, on) => {
    const cur = (cfg && Array.isArray(cfg.rulesDisabled)) ? cfg.rulesDisabled : [];
    const next = on ? cur.filter((x) => x !== id) : cur.concat([id]);
    save({ rulesDisabled: next });
    setRules((rs) => (rs || []).map((r) => (r.id === id ? Object.assign({}, r, { enabled: on }) : r)));
  };

  if (err) return h(Card, null, h("div", { style: { color: "#e88" } }, "⚠ " + err));
  if (!stats) return h(Card, null, h("div", { style: { opacity: .7 } }, "…"));

  const s = stats;
  const sevLabel = (sev) => (sev === "block" ? t.sevBlock : sev === "warn" ? t.sevWarn : t.sevHint);
  const paths = s.paths || {};

  return h("div", null,
    // ① 状态
    h(Card, null,
      h("div", { style: { display: "flex", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap" } },
        h("span", { style: { display: "inline-flex", color: "var(--dsw-alias-brand-primary-new-color, currentColor)" } }, h(Icon, { size: 20 })),
        h("span", { style: { fontWeight: 700 } }, t.statusTitle),
        h(Pill, { dim: !s.enabled }, s.enabled ? t.on : t.off)),
      !s.enabled ? h("div", { style: { opacity: .7, fontSize: 12, marginBottom: 6 } }, t.offHint) : null,
      h(Row, { label: t.rulesCount, value: (s.rules ? s.rules.enabled : 0) + "  (" + t.builtin + " " + (s.rules ? s.rules.builtin : 0) + " + " + t.custom + " " + (s.rules ? s.rules.custom : 0) + ")" }),
      h(Row, { label: t.tools, value: (s.precheckTools || []).join(", ") })),

    // ② 处置方式
    h(Card, null,
      h("div", { style: { fontWeight: 700, marginBottom: 6 } }, t.mode),
      h("div", { style: { display: "flex", gap: 8, marginBottom: 6 } },
        h(ModeButton, { active: s.mode === "block", onClick: () => save({ mode: "block" }) }, t.modeBlock),
        h(ModeButton, { active: s.mode === "warn", onClick: () => save({ mode: "warn" }) }, t.modeWarn)),
      h("div", { style: { opacity: .65, fontSize: 12 } }, s.mode === "warn" ? t.modeWarnHint : t.modeBlockHint)),

    // ③ 保护链
    h(Card, null,
      h("div", { style: { fontWeight: 700, marginBottom: 6 } }, t.chainTitle),
      h("div", { style: { opacity: .65, fontSize: 12, marginBottom: 6 } }, t.chainHint),
      ...(s.protectedChain || []).map((p) => h("div", {
        key: p.pid,
        style: { fontSize: 12, padding: "2px 0", wordBreak: "break-all", fontFamily: "var(--dsh-mono, monospace)" },
      }, "PID " + p.pid + "  " + p.name + (p.cmdline ? " — " + p.cmdline : "")))),

    // ④ 规则清单
    h(Card, null,
      h("div", { style: { fontWeight: 700, marginBottom: 4 } }, t.rulesTitle),
      h("div", { style: { opacity: .65, fontSize: 12, marginBottom: 6 } }, t.rulesHint),
      ...(rules || []).map((r) => h("div", {
        key: r.id,
        style: { display: "flex", alignItems: "flex-start", gap: 8, padding: "4px 0", borderTop: "1px solid var(--dsh-border, rgba(127,127,127,.16))" },
      },
        h("input", {
          type: "checkbox", checked: !!r.enabled, disabled: !!r.fromConfig,
          onChange: (e) => toggleRule(r.id, e.target.checked),
          style: { width: 15, height: 15, marginTop: 2, cursor: r.fromConfig ? "not-allowed" : "pointer" },
        }),
        h("div", { style: { minWidth: 0, flex: 1 } },
          h("div", { style: { fontSize: 13, opacity: r.enabled ? 1 : .5 } }, r.title),
          h("div", { style: { fontSize: 11, opacity: .55, wordBreak: "break-all", fontFamily: "var(--dsh-mono, monospace)" } }, r.id)),
        h(Pill, { dim: !r.enabled }, sevLabel(r.severity)),
        r.user ? h(Pill, { dim: true }, t.custom) : null,
        r.fromConfig ? h(Pill, { dim: true }, "🔒") : null))),

    // ⑤ 拦截日志
    h(Card, null,
      h("div", { style: { fontWeight: 700, marginBottom: 6 } }, t.auditTitle),
      (!audit || audit.length === 0)
        ? h("div", { style: { opacity: .6, fontSize: 13 } }, t.auditEmpty)
        : h("div", null, ...audit.map((a, i) => h("div", {
          key: i,
          style: { fontSize: 12, padding: "4px 0", borderTop: i === 0 ? "none" : "1px solid var(--dsh-border, rgba(127,127,127,.16))" },
        },
          h("div", { style: { display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" } },
            h("span", { style: { opacity: .6, fontFamily: "var(--dsh-mono, monospace)" } }, fmtTime(a.at)),
            h(Pill, { dim: false }, a.blocked ? t.auditBlocked : t.auditWarn),
            h("span", { style: { fontWeight: 600 } }, a.title || a.ruleId || "")),
          a.command ? h("div", {
            style: {
              marginTop: 2, padding: "4px 6px", borderRadius: 5, fontSize: 11.5,
              fontFamily: "var(--dsh-mono, monospace)", whiteSpace: "pre-wrap", wordBreak: "break-all",
              background: "var(--dsh-code-bg, rgba(127,127,127,.12))",
            },
          }, a.command) : null)))),

    // ⑥ 文件位置
    h(Card, null,
      h("div", { style: { fontWeight: 700, marginBottom: 6 } }, t.pathsTitle),
      ...[[t.rulesFile, paths.rulesFile], [t.settingsFile, paths.settingsFile], [t.auditFile, paths.auditFile]]
        .filter((x) => x[1])
        .map((x, i) => h("div", { key: i, style: { display: "flex", gap: 8, alignItems: "center", padding: "3px 0", flexWrap: "wrap" } },
          h("span", { style: { opacity: .7, fontSize: 12, flex: "0 0 auto" } }, x[0]),
          h("code", { style: { fontSize: 11.5, wordBreak: "break-all", flex: "1 1 auto" } }, x[1]),
          h(CopyButton, { text: x[1], label: t.copy, copiedLabel: t.copied }))),
      h("div", { style: { marginTop: 8, opacity: .55, fontSize: 12 } }, t.foot)));
}

// ---------------- registration ----------------
// 客户端服务按「短名」注入（见 dsh-memory-lite / dsh-multi-tts 的客户端半边）。
const inject = ["slots", "locale"];

function apply(ctx) {
  installNavIcon()
  ctx.slots.inject("settings.section", () => ctx.slots.register({
    name: "settings.section",
    id: NS, order: 60, locale: NS,
    label: () => {
      const lang = (typeof navigator !== "undefined" && navigator.language ? navigator.language : "en").toLowerCase();
      return lang.indexOf("zh") === 0 ? TEXT.zh.label : TEXT.en.label;
    },
    inject: () => ({ api: API }),
  }, SettingsPage));
}

exports.inject = inject;
exports.apply = apply;
return module.exports; } });
