#!/usr/bin/env node
'use strict';
// ---------------------------------------------------------------------------
// ITLZMC 插件市场后端（零第三方依赖，只用 Node 内置模块）
//
//  · 普通玩家浏览 / 安装 / 创作插件、下载 AI Skill 全部不需要登录。
//  · 只有「把插件提交上架到市场」才需要注册一个开发者账号，注册后发放
//    一枚 API Key（qkey_…）。把 Key 和 API 地址交给 AI，AI 即可通过
//    POST /api/plugins/submit 提交插件。
//  · 任何插件在上线前都要经过 validatePlugin()：字段规范 → 危险 API 黑名单
//    → 语法编译 → vm 沙箱试运行（超时 / 禁 eval / 无网络无存储）→ 至少注册
//    一项能力 → id 冲突检查。全部通过才写入已上架列表，市场里才看得见。
//  · 匿名可调用 /api/plugins/validate 先自检，但上架必须带有效 Key。
//
// 数据落在 <站点根>/.itlzmc/（server.js 静态路由已禁止对外访问），
// 已上架源码同步写一份到 market/<id>.js 供直接下载 / 引用。
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, '.itlzmc');
const ACC_FILE = path.join(DATA_DIR, 'accounts.json');
const MKT_FILE = path.join(DATA_DIR, 'market.json');
const PUB_DIR = path.join(ROOT, 'market');
// 部署平台的分享码：线上网关会把 ?sharecode= 当作访问凭据消费掉，转发到本服务的
// URL 里已经没有这个参数。/api/docs 要给 AI 拼「可直接复制的完整地址」，所以这里
// 内置一份默认值（可用环境变量 QIUMC_SHARE 覆盖），请求里读不到时用它兜底。
const DEFAULT_SHARE = process.env.QIUMC_SHARE || '4AK3QS2M26';
// 对外公开地址：网关转发时 Host 头会变成内部域名，/api/docs 要给 AI 的是
// 玩家真正访问的分享地址（可用 QIUMC_PUBLIC_BASE 覆盖）。
const PUBLIC_BASE = process.env.QIUMC_PUBLIC_BASE || 'https://a23dc3393acb531d3.app.workbuddy.host';

// 与 js/plugins.js 内置的官方插件、示例插件保持一致：这些 id 不允许被占用
const RESERVED_IDS = new Set([
  'itlzmc-double-drops', 'itlzmc-peaceful-night', 'itlzmc-glow-lamp', 'itlzmc-toolkit',
  'itlzmc-builtin-fix', 'itlzmc-demo-texture', 'itlzmc-demo-mechanic',
  'itlzmc-demo-command', 'itlzmc-demo-plugin-pack',
  'itlzmc', 'itlzmc-core', 'itlzmc-system', 'itlzmc-plugin-dev',
]);

const MAX_CODE = 64 * 1024;          // 单个插件源码上限 64 KB
const ID_RE = /^[a-z][a-z0-9_-]{2,47}$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9._-]+)?$/;
const USER_RE = /^[A-Za-z0-9_]{3,20}$/;
const CAPS = new Set(['texture', 'mechanic', 'command', 'recipe']);

let accounts = { users: [] };
let market = { plugins: [] };

// ---------------------------------------------------------------------------
// 持久化：目录自动创建，JSON 原子写（先写 .tmp 再 rename）
// ---------------------------------------------------------------------------
function atomicWrite(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}
function readJSON(file, fallback) {
  try { const v = JSON.parse(fs.readFileSync(file, 'utf8')); return v && typeof v === 'object' ? v : fallback; }
  catch (e) { return fallback; }
}
function initStore() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(PUB_DIR, { recursive: true });
  if (!fs.existsSync(ACC_FILE)) atomicWrite(ACC_FILE, { users: [] });
  if (!fs.existsSync(MKT_FILE)) atomicWrite(MKT_FILE, { plugins: [] });
  accounts = readJSON(ACC_FILE, { users: [] });
  market = readJSON(MKT_FILE, { plugins: [] });
  if (!Array.isArray(accounts.users)) accounts.users = [];
  if (!Array.isArray(market.plugins)) market.plugins = [];
}
const saveAccounts = () => atomicWrite(ACC_FILE, accounts);
const saveMarket = () => atomicWrite(MKT_FILE, market);

// ---------------------------------------------------------------------------
// 账号 / API Key
// ---------------------------------------------------------------------------
function hashPassword(pw, salt) {
  return crypto.scryptSync(String(pw), salt, 32).toString('hex');
}
function newKey() { return 'qkey_' + crypto.randomBytes(24).toString('hex'); }
function newSalt() { return crypto.randomBytes(16).toString('hex'); }
function findUser(name) {
  const n = String(name || '').toLowerCase();
  return accounts.users.find((u) => u.username.toLowerCase() === n) || null;
}
function userByKey(key) {
  if (!key) return null;
  return accounts.users.find((u) => u.apiKey === key) || null;
}
function publicUser(u) {
  return {
    username: u.username, apiKey: u.apiKey, createdAt: u.createdAt,
    submissions: (u.submissions || []).slice(-30).reverse(),
  };
}
function keyFrom(u, req) {
  let raw = req.headers['x-itlzmc-key'] || '';
  if (!raw) {
    const a = req.headers.authorization || '';
    raw = /^Bearer\s+/i.test(a) ? a.replace(/^Bearer\s+/i, '') : a;
  }
  let key = String(raw || '').trim();
  if (!key) key = String(u.searchParams.get('key') || '').trim();
  return key;
}

// 极简失败限流：同一用户名 5 分钟内连续失败 8 次就暂时拒绝
const fails = new Map();
function tooManyFails(name) {
  const k = String(name || '').toLowerCase(), now = Date.now();
  const a = (fails.get(k) || []).filter((t) => now - t < 5 * 60 * 1000);
  fails.set(k, a);
  return a.length >= 8;
}
function noteFail(name) {
  const k = String(name || '').toLowerCase();
  const a = fails.get(k) || []; a.push(Date.now()); fails.set(k, a);
}
function clearFails(name) { fails.delete(String(name || '').toLowerCase()); }

function logSubmission(u, rec) {
  if (!Array.isArray(u.submissions)) u.submissions = [];
  u.submissions.push(Object.assign({ at: Date.now() }, rec));
  if (u.submissions.length > 60) u.submissions = u.submissions.slice(-60);
  saveAccounts();
}

// ---------------------------------------------------------------------------
// 静态扫描：剥离注释（正确跳过字符串字面量），再检查危险调用
// ---------------------------------------------------------------------------
function stripComments(src) {
  let out = '', i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c; out += c; i++;
      while (i < n) {
        if (src[i] === '\\') { out += src[i] + (src[i + 1] || ''); i += 2; continue; }
        out += src[i];
        if (src[i] === quote) { i++; break; }
        i++;
      }
      continue;
    }
    out += c; i++;
  }
  return out;
}

// 命中任意一条即拒绝上架，并给出具体中文原因
const FORBIDDEN = [
  [/\beval\s*\(/, '不允许 eval()：动态执行代码无法校验'],
  [/\bnew\s+Function\s*\(/, '不允许 new Function()：动态构造函数无法校验'],
  [/\bFunction\s*\(/, '不允许 Function()：动态构造函数无法校验'],
  [/\bfetch\s*\(/, '不允许 fetch()：插件必须完全离线，不能发网络请求'],
  [/\bXMLHttpRequest\b/, '不允许 XMLHttpRequest：插件不能发网络请求'],
  [/\bWebSocket\s*\(/, '不允许 WebSocket：插件不能建立外部连接'],
  [/\bEventSource\b/, '不允许 EventSource：插件不能建立外部连接'],
  [/navigator\.sendBeacon/, '不允许 sendBeacon：插件不能向外发送数据'],
  [/\bdocument\.cookie\b/, '不允许读写 document.cookie'],
  [/\blocalStorage\b/, '不允许直接访问 localStorage（请用插件句柄 P.storage）'],
  [/\bsessionStorage\b/, '不允许直接访问 sessionStorage（请用插件句柄 P.storage）'],
  [/\bindexedDB\b/, '不允许访问 indexedDB'],
  [/\brequire\s*\(/, '不允许 require()：插件运行在浏览器沙箱，没有 Node 模块'],
  [/\bprocess\b/, '不允许访问 process：插件没有 Node 运行时'],
  [/\bglobalThis\b/, '不允许访问 globalThis'],
  [/\b__dirname\b|\b__filename\b|\bimportScripts\b/, '不允许访问 Node / Worker 全局'],
  [/\bdocument\.write\s*\(/, '不允许 document.write() 改写页面'],
  [/<script\b/i, '不允许注入 <script> 标签'],
  [/\binnerHTML\s*=|outerHTML\s*=/, '不允许改写页面 DOM（innerHTML / outerHTML）'],
  [/\bwindow\.location\b|\blocation\s*\.\s*(href|assign|replace)\b/, '不允许读取或跳转页面地址'],
  [/\bwhile\s*\(\s*(true|1)\s*\)/, '不允许无条件死循环 while(true)'],
  [/\bfor\s*\(\s*;\s*;\s*\)/, '不允许无条件死循环 for(;;)'],
  [/https?:\/\//i, '不允许引用外部网址（贴图请用 data:image/png;base64 内嵌）'],
];

// ---------------------------------------------------------------------------
// 沙箱试运行：mock 一份与 js/plugins.js 一致的插件句柄，让 factory 真正跑一遍
// ---------------------------------------------------------------------------
function sandboxRun(script, label) {
  const reg = {
    metas: [],
    counts: { hooks: 0, commands: 0, blocks: 0, items: 0, textures: 0, recipes: 0, intercepts: 0, keybinds: 0 },
    keybinds: [],
    logs: [],
  };
  const inc = (k) => { reg.counts[k] = (reg.counts[k] || 0) + 1; };
  const noop = () => { };
  const logger = { log: (...a) => reg.logs.push(a.map(String).join(' ')), warn: noop, error: noop, info: noop };
  // 从 P.addKey 的各种写法里提取按键声明，登记进 report.keybinds
  const keyMeta = (a, b) => {
    let id = '', code = '', label = '';
    if (a && typeof a === 'object') { id = a.id || ''; code = a.code || a.default || a.key || ''; label = a.label || a.name || ''; }
    else if (typeof a === 'string') {
      id = a;
      if (b && typeof b === 'object') { code = b.code || b.default || b.key || ''; label = b.label || b.name || ''; }
      else if (typeof b === 'string') code = b;
    }
    if (!code) code = id;
    return { id: String(id || code || 'key'), code: String(code || ''), label: String(label || '') };
  };

  const QPlugins = {
    version: 'qiumc13', api: '1.0',
    list: () => reg.metas.map((m) => ({ id: m.id, name: m.name })),
    hookStats: () => [], commands: () => ({}), isEnabled: () => true,
    on: (e, f) => { inc('hooks'); return noop; }, once: (e, f) => { inc('hooks'); return noop; },
    off: noop, emit: () => ({ cancelled: false, cancel: noop }),
    game: () => ({}), player: () => ({}), world: () => ({}),
    addTexture: () => 0, defineBlock: () => ({}), addCommand: () => ({}),
    addKey: (a, b) => { inc('keybinds'); reg.keybinds.push(keyMeta(a, b)); return 'ok'; },
    onKey: (a, b) => { inc('keybinds'); reg.keybinds.push(keyMeta({ id: 'key-' + a, code: a }, b)); return 'ok'; },
    keybinds: () => reg.keybinds.slice(), isKeyDown: () => false,
  };

  function makeHandle(meta) {
    const h = {
      ITLZMC: null, Plugins: QPlugins,
      on: (e, f) => {
        if (typeof e !== 'string' || !e) throw new Error('P.on() 需要事件名');
        if (typeof f !== 'function') throw new Error('P.on() 需要回调函数');
        inc('hooks'); return noop;
      },
      once: (e, f) => { if (typeof f !== 'function') throw new Error('P.once() 需要回调函数'); inc('hooks'); return noop; },
      off: noop,
      emit: () => ({ cancelled: false, cancel() { this.cancelled = true; return this; }, preventDefault: noop, stop: noop }),
      defineBlock: (o) => { if (!o || !o.key) throw new Error('P.defineBlock() 需要 key'); inc('blocks'); return String(o.key); },
      defineItem: (o) => { if (!o || !o.key) throw new Error('P.defineItem() 需要 key'); inc('items'); return String(o.key); },
      addTexture: (n, u) => { if (!n || typeof u !== 'string') throw new Error('P.addTexture() 需要名称和 data:image 数据'); inc('textures'); return 5000 + reg.counts.textures; },
      addTextureAt: (i, u) => { if (typeof u !== 'string') throw new Error('P.addTextureAt() 需要 data:image 数据'); inc('textures'); return Number(i) || 0; },
      addShaped: () => { inc('recipes'); return true; },
      addShapeless: () => { inc('recipes'); return true; },
      addSmelting: () => { inc('recipes'); return true; },
      addRecipe: () => { inc('recipes'); return true; },
      addCommand: (n, d) => {
        if (!n) throw new Error('P.addCommand() 需要指令名');
        if (typeof d !== 'function' && !(d && typeof d.fn === 'function')) throw new Error('P.addCommand() 需要函数或 { fn }');
        inc('commands'); return String(n).replace(/^\//, '');
      },
      addKey: (a, b) => { inc('keybinds'); reg.keybinds.push(keyMeta(a, b)); return keyMeta(a, b).id; },
      key: (a, b) => { inc('keybinds'); reg.keybinds.push(keyMeta(a, b)); return keyMeta(a, b).id; },
      bindKey: (a, b) => { inc('keybinds'); reg.keybinds.push(keyMeta(a, b)); return keyMeta(a, b).id; },
      onKey: (a, b) => { inc('keybinds'); const m = keyMeta({ id: 'key-' + a, code: a }, b); reg.keybinds.push(m); return m.id; },
      isKeyDown: () => false,
      intercept: () => { inc('intercepts'); return noop; },
      method: () => ({ before: noop, after: noop }),
      config: (k, d) => d, setConfig: () => { },
      storage: { get: (k, d) => d, set: (k, v) => v, all: () => ({}), clear: () => { } },
      game: () => ({}), player: () => ({}), world: () => ({}),
      give: () => true, message: noop,
      log: (...a) => reg.logs.push(a.map(String).join(' ')), warn: noop,
    };
    Object.defineProperty(h, 'id', { get: () => (meta && meta.id) || label });
    Object.defineProperty(h, 'meta', { get: () => meta || {} });
    return h;
  }

  const ITLZMC = {
    Plugins: QPlugins, Plugin: QPlugins, plugin: null, register: null,
  };
  ITLZMC.plugin = function (meta, factory) {
    const m = Object.assign({ id: '', name: '', version: '1.0.0', description: '', api: '1.0', capabilities: [], requires: [] }, meta || {});
    reg.metas.push(m);
    const h = makeHandle(m);
    h.ITLZMC = ITLZMC;
    if (typeof factory === 'function') factory(h, m);
    return m;
  };
  ITLZMC.register = ITLZMC.plugin;

  const fakeWin = {
    addEventListener: noop, removeEventListener: noop, dispatchEvent: () => true,
    ITLZMC: null, location: { href: '', search: '' },
  };
  const fakeDoc = {
    addEventListener: noop, removeEventListener: noop, activeElement: null,
    body: null, head: null, createElement: () => ({ style: {}, setAttribute: noop, appendChild: noop }),
  };
  const sandbox = {
    ITLZMC,
    // 最小 DOM stub：只让「自己监听 keydown」的老写法不在校验阶段被 ReferenceError 拒掉，
    // 回调不会真的执行，也接触不到任何真实浏览器对象。
    window: fakeWin, document: fakeDoc,
    KeyboardEvent: function (type, init) { this.type = type; Object.assign(this, init || {}); },
    navigator: { userAgent: '', maxTouchPoints: 0 },
    console: logger,
    // 定时器只登记不执行，避免插件在校验阶段留下后台任务
    setTimeout: () => 0, clearTimeout: noop, setInterval: () => 0, clearInterval: noop,
    queueMicrotask: noop,
  };
  // codeGeneration.strings=false 让沙箱内的 eval / new Function 直接抛 EvalError
  const ctx = vm.createContext(sandbox, { name: 'ITLZMC 插件校验沙箱', codeGeneration: { strings: false, wasm: false } });
  const t0 = Date.now();
  script.runInContext(ctx, { timeout: 1000, breakOnSigint: true });
  reg.durationMs = Date.now() - t0;
  return reg;
}

// ---------------------------------------------------------------------------
// 完整校验：返回 { ok, errors, warnings, report }
// ---------------------------------------------------------------------------
function validatePlugin(body) {
  const errors = [], warnings = [];
  const code = typeof body.code === 'string' ? body.code : '';
  const bytes = Buffer.byteLength(code, 'utf8');
  const report = { bytes, checks: [], registered: null, meta: null, keybinds: [], sandbox: 'not-run' };
  const pass = (t) => report.checks.push({ name: t, ok: true });
  const fail = (t, msg) => { errors.push(msg); report.checks.push({ name: t, ok: false, detail: msg }); };

  // 1) 源码基本检查
  if (!code.trim()) fail('源码非空', '插件源码不能为空');
  else pass('源码非空');
  if (bytes > MAX_CODE) fail('源码大小', '源码超过 64 KB（当前 ' + bytes + ' 字节），请精简后再提交');
  else if (code.trim()) pass('源码大小 ' + bytes + ' B');
  if (!/ITLZMC\s*\.\s*plugin\s*\(/.test(code)) fail('注册入口', '源码里没有 ITLZMC.plugin(...) 调用，不是 ITLZMC 原生插件');
  else pass('注册入口 ITLZMC.plugin()');

  // 1b) AI 改插件最容易改坏的写法：明确拒绝并给出修法，别让它「静默失效」
  {
    const shape = stripComments(code);
    if (/^await\s/m.test(shape)) fail('顶层 await', '插件是普通脚本，不支持顶层 await：把异步逻辑放进同步 factory 或 P.on(...) 回调');
    if (/ITLZMC\s*\.\s*(?:plugin|register)\s*\([\s\S]{0,700}?,\s*async\b/.test(shape))
      fail('异步 factory', 'factory 不能是 async：ITLZMC 同步执行 factory，async 里的注册会被丢掉，改成 function (P) { ... }');
    if (/ITLZMC\s*\.\s*Mods\b|\bForge\b|\bFabric\b|mods\.toml|fabric\.mod\.json|mcmod\.info|\.jar\b/.test(shape))
      fail('命名空间', '用了已删除的 Mod / 模组命名空间：ITLZMC 只加载原生插件，注册入口是 ITLZMC.plugin(...)');
  }

  // 2) 危险 API 黑名单（先剥离注释，避免注释里的说明误伤）
  const clean = stripComments(code);
  let blocked = false;
  for (const [re, why] of FORBIDDEN) {
    if (re.test(clean)) { fail('安全检查', why); blocked = true; }
  }
  if (!blocked) pass('安全检查（无网络 / 无存储 / 无动态执行 / 无外链）');

  // 3) 语法编译
  let script = null;
  try {
    script = new vm.Script(code, { filename: 'plugin.js' });
    pass('语法编译');
  } catch (e) {
    fail('语法编译', 'JavaScript 语法错误：' + (e.message || e));
  }

  // 4) 沙箱试运行
  let reg = null;
  if (script && !blocked) {
    try {
      reg = sandboxRun(script, body.id || 'submitted-plugin');
      report.sandbox = 'ok';
      report.keybinds = reg.keybinds.slice();
      pass('沙箱试运行 ' + reg.durationMs + 'ms');
    } catch (e) {
      report.sandbox = 'failed';
      const msg = /Script execution timed out/i.test(String(e && e.message))
        ? '插件在沙箱里执行超时（超过 1 秒），可能存在死循环'
        : '插件在沙箱里执行出错：' + (e && e.message ? e.message : e);
      fail('沙箱试运行', msg);
    }
  }

  // 5) 元数据：一律以源码里 ITLZMC.plugin 的声明为准，不接受伪造
  let meta = null;
  if (reg) {
    if (!reg.metas.length) fail('插件声明', '源码没有真正调用 ITLZMC.plugin()，没有注册任何插件');
    else {
      meta = reg.metas[0];
      report.meta = {
        id: meta.id, name: meta.name, version: meta.version,
        description: meta.description, capabilities: meta.capabilities, api: meta.api,
      };
      if (body.id && String(body.id) !== String(meta.id))
        fail('id 一致', '提交的 id（' + body.id + '）与源码里声明的 id（' + meta.id + '）不一致，请改成一致');
      else pass('id 与源码声明一致');
      if (!ID_RE.test(String(meta.id || '')))
        fail('id 规范', '插件 id 不合规：必须以小写字母开头，只用小写字母 / 数字 / _ / -，长度 3–48（当前 "' + meta.id + '"）');
      else pass('id 规范');
      if (RESERVED_IDS.has(String(meta.id)))
        fail('id 保留', '这个 id 是官方内置插件保留的，换一个自己的 id');
      else pass('id 未被保留');
      if (!meta.name || String(meta.name).length > 40)
        fail('名称', '插件 name 必须是 1–40 个字符');
      else pass('名称');
      if (!SEMVER_RE.test(String(meta.version || '')))
        fail('版本号', 'version 必须是三段式语义版本，例如 1.0.0（当前 "' + meta.version + '"）');
      else pass('版本号');
      if (String(meta.description || '').length > 300) fail('简介长度', 'description 请控制在 300 字以内');
      if (meta.api && String(meta.api) !== '1.0')
        warnings.push('源码声明的 api 是 ' + meta.api + '，当前市场使用 API 1.0，请确认兼容性');
      if (!Array.isArray(meta.capabilities)) meta.capabilities = [];
      const unknown = meta.capabilities.filter((c) => !CAPS.has(c));
      if (unknown.length) warnings.push('未识别的能力标签：' + unknown.join('、') + '（可用：texture / mechanic / command / recipe）');
    }
  }

  // 6) 至少注册一项能力（防止空插件 / 只写日志的插件混进市场）
  if (reg) {
    report.registered = reg.counts;
    const total = Object.values(reg.counts).reduce((a, b) => a + b, 0);
    if (total === 0) fail('实际能力', '插件没有注册任何东西（指令 / 机制钩子 / 贴图 / 方块 / 配方都没有），不允许上架空插件');
    else pass('实际能力：' + JSON.stringify(reg.counts));

    // 声明与实际是否对得上（只警告，不阻止）
    if (meta && Array.isArray(meta.capabilities)) {
      const c = reg.counts;
      const pairs = [
        ['command', c.commands > 0, '声明了 command（指令）但没有注册任何指令'],
        ['texture', (c.textures + c.blocks + c.items) > 0, '声明了 texture（贴图）但没有注册贴图 / 方块 / 物品'],
        ['mechanic', (c.hooks + c.intercepts) > 0, '声明了 mechanic（机制）但没有挂任何事件钩子'],
        ['recipe', c.recipes > 0, '声明了 recipe（配方）但没有注册任何配方'],
      ];
      for (const [cap, ok, why] of pairs) if (meta.capabilities.includes(cap) && !ok) warnings.push(why);
      if (!meta.capabilities.length) warnings.push('没有声明 capabilities，市场里不会显示能力标签');
    }
  }

  // 跨端按键：直接监听物理键盘的插件在手机端会失效，提醒改用声明式 P.addKey
  if (/addEventListener\s*\(\s*['"]key(?:down|up)|onkeydown\s*=/.test(clean) &&
      !report.keybinds.length) {
    warnings.push('插件直接监听了 keydown/keyup，手机端没有物理键盘会失效；'
      + '请改用 P.addKey(\'veinMine\', { code:\'Backquote\', label:\'连锁挖矿\', onDown: fn })，'
      + '引擎会在桌面转发物理键、在手机自动生成屏幕按钮');
  }
  if (report.keybinds.length) pass('按键声明：' + report.keybinds.length + ' 个（手机端自动生成屏幕按钮）');

  const ok = errors.length === 0;
  if (ok) pass('全部校验通过，可以上架');
  return { ok, errors, warnings, report };
}

// ---------------------------------------------------------------------------
// 上架：只有 validatePlugin() 全绿才会调用
// ---------------------------------------------------------------------------
function publish(user, body, validation) {
  const meta = validation.report.meta;
  const id = meta.id;
  const existing = market.plugins.find((p) => p.id === id);
  if (existing && existing.author !== user.username)
    return { error: '插件 id「' + id + '」已经被其它开发者占用，请换一个 id' };

  const now = Date.now();
  const rec = {
    id,
    name: String(meta.name).slice(0, 40),
    version: String(meta.version),
    description: String(meta.description || '').slice(0, 300),
    capabilities: (meta.capabilities || []).filter((c) => CAPS.has(c)),
    author: user.username,
    api: String(meta.api || '1.0'),
    code: body.code,
    changelog: String(body.changelog || '').slice(0, 300),
    submittedAt: existing ? existing.submittedAt : now,
    updatedAt: now,
    installs: existing ? (existing.installs || 0) : 0,
    keybinds: validation.report.keybinds || [],
    report: {
      bytes: validation.report.bytes,
      registered: validation.report.registered,
      checks: validation.report.checks.length,
      warnings: validation.warnings,
    },
  };
  if (existing) Object.assign(existing, rec);
  else market.plugins.push(rec);
  saveMarket();
  try { fs.writeFileSync(path.join(PUB_DIR, id + '.js'), body.code, 'utf8'); } catch (e) { }
  return { plugin: marketRecord(rec) };
}

// 对外列表里保留 code（前端安装需要），但去掉内部字段
function marketRecord(p) {
  return {
    id: p.id, name: p.name, version: p.version, description: p.description,
    capabilities: p.capabilities || [], author: p.author, api: p.api,
    changelog: p.changelog || '', submittedAt: p.submittedAt, updatedAt: p.updatedAt,
    installs: p.installs || 0, source: 'community',
    keybinds: p.keybinds || [],
    report: p.report || null, code: p.code,
  };
}

// ---------------------------------------------------------------------------
// API 文档（GET /api/docs，给 AI 直接读的机器可读说明）
// ---------------------------------------------------------------------------
function docs(sharecode, origin) {
  // 网关会吃掉请求里的 sharecode，所以读不到时用内置默认分享码兜底，
  // 保证 full_urls 永远是「带 sharecode 的、可直接复制的完整地址」。
  const sc = String(sharecode || DEFAULT_SHARE || '');
  const qs = sc ? '?sharecode=' + encodeURIComponent(sc) : '';
  const host = String(origin || '').replace(/\/+$/, '');
  const U = (name) => host + '/api/' + name + qs;
  return {
    name: 'ITLZMC 插件市场 API',
    version: '1.0',
    base: '/api/',
    api_base: host + '/api/',
    sharecode_required: true,
    sharecode: sc || null,
    sharecode_note: '本站部署在分享网关后面：每一个 API 请求的 URL 末尾都必须带 ?sharecode=<分享码>'
      + '（GET 和 POST 都要带），漏了会被 403 拦截。下面 full_urls 里的地址已经拼好、带齐 sharecode，直接复制用。'
      + '默认分享码是 ' + DEFAULT_SHARE + '；若你手上的本站地址里分享码不同，把地址里的 ?sharecode= 换成那个值即可。',
    full_urls: {
      docs: U('docs'), market: U('market'), register: U('auth/register'),
      login: U('auth/login'), validate: U('plugins/validate'),
      submit: U('plugins/submit'), mine: U('plugins/mine'),
      withdraw: U('plugins/withdraw'), install: U('market/install'),
    },
    curl_submit: 'curl -X POST "' + U('plugins/submit') + '" '
      + '-H "Content-Type: application/json" -H "X-ITLZMC-Key: <你的Key>" -d @body.json',
    auth: '只在上架 / 管理自己的插件时需要。把 Key 放在 X-ITLZMC-Key 请求头（或 Authorization: Bearer <key>，或 ?key=）。',
    anonymous: '浏览市场、下载插件源码、下载 AI Skill、调用 /api/plugins/validate 自检都不需要注册或登录。',
    flow: [
      '1. POST /api/auth/register {"username","password"} → 拿到 apiKey（注册完立刻发 Key）',
      '2. 把 apiKey 和「带 sharecode 的完整 /api/ 地址」交给 AI（见 full_urls，漏带会被 403 拦截）',
      '3. AI 写好 ITLZMC 原生插件（ITLZMC.plugin(meta, factory)）',
      '4. 可选：POST /api/plugins/validate {"code": "<源码>"} 先自检，无需 Key',
      '5. POST /api/plugins/submit  带 X-ITLZMC-Key，{"code": "<源码>"}',
      '6. 服务端自动校验；全部通过才上架，/api/market 立刻可见，玩家在插件市场一键安装',
    ],
    endpoints: [
      { method: 'POST', path: '/api/auth/register', auth: false, body: { username: '3–20 位字母数字下划线', password: '至少 6 位' }, returns: 'username, apiKey' },
      { method: 'POST', path: '/api/auth/login', auth: false, body: { username: '', password: '' }, returns: 'username, apiKey' },
      { method: 'GET', path: '/api/auth/me', auth: true, returns: '账号信息 + 近期提交记录' },
      { method: 'POST', path: '/api/auth/key', auth: '当前 Key 或用户名+密码', body: { username: '可选', password: '可选' }, returns: '重新生成的新 apiKey（旧 Key 立即失效）' },
      { method: 'GET', path: '/api/market', auth: false, returns: '已上架插件列表（含 code 源码），离线时前端回退到内置官方插件' },
      { method: 'POST', path: '/api/market/install', auth: false, body: { id: '' }, returns: '安装计数 +1，可 fire-and-forget' },
      { method: 'POST', path: '/api/plugins/validate', auth: false, body: { code: '<插件完整源码>' }, returns: '{ ok, errors, warnings, report }，只校验不入库' },
      { method: 'POST', path: '/api/plugins/submit', auth: true, body: { code: '<插件完整源码>', id: '可选，须与源码内 meta.id 一致', changelog: '可选' }, returns: '校验通过 → { ok, plugin }；未通过 → 422 { ok:false, errors, warnings, report }' },
      { method: 'GET', path: '/api/plugins/mine', auth: true, returns: '我上架的插件 + 近期提交记录' },
      { method: 'POST', path: '/api/plugins/withdraw', auth: true, body: { id: '' }, returns: '下架自己的插件' },
      { method: 'GET', path: '/api/docs', auth: false, returns: '本文档' },
    ],
    plugin_format: {
      minimal: "ITLZMC.plugin({ id:'my-plugin', name:'我的插件', version:'1.0.0', description:'说明', api:'1.0', capabilities:['command'] }, function (P) { P.addCommand('hello', { fn: function (ctx) { ctx.say('你好'); } }); });",
      meta: { id: '^[a-z][a-z0-9_-]{2,47}$ 且不能占用官方保留 id', name: '1–40 字', version: '三段式语义版本，如 1.0.0', description: '≤300 字', capabilities: 'texture / mechanic / command / recipe', api: '1.0' },
      handle: 'P.on / P.addCommand / P.addKey / P.isKeyDown / P.addTexture / P.defineBlock / P.addShapeless / P.intercept / P.storage / P.log 等，详见 AI SKILL 的 references/API.md 与 KEYS.md',
      keybinds: '跨端按键：用 P.addKey(id, { code, label, onDown, onUp, mode }) 声明，桌面自动转发物理键、手机自动生成屏幕虚拟按钮；'
        + '不要用 window.addEventListener(\'keydown\'...)（手机没有物理键盘）。'
        + '常见安全 code：Backquote（波浪键 `）、KeyB、KeyG、Digit0、F6、F7；避开原版已占用的 KeyV / KeyE / Space 等。'
        + '按住状态用 P.isKeyDown(id) 读取；事件还可监听 keyDown / keyUp。',
    },
    validation: [
      '源码非空且 ≤64 KB，必须调用 ITLZMC.plugin()',
      '禁止 eval / new Function / fetch / XMLHttpRequest / WebSocket / require / process / globalThis / localStorage / document.cookie / innerHTML / 页面跳转 / 死循环 / 任何 http(s) 外链',
      '必须通过 JavaScript 语法编译',
      '必须在 vm 沙箱里真正执行一遍 factory（1 秒超时、禁用动态代码生成、无网络无存储），抛异常即拒绝',
      '元数据以源码里 ITLZMC.plugin 的声明为准，不能伪造；id / name / version 必须符合规范',
      '必须实际注册至少一项能力（指令 / 钩子 / 贴图 / 方块 / 物品 / 配方）',
      'id 不能与官方内置插件或他人已上架插件冲突',
    ],
    note: '只支持 ITLZMC 原生插件，不加载任何 Mod / 模组、无 Forge / Fabric / .jar。',
  };
}

// ---------------------------------------------------------------------------
// 路由：由 server.js 在 /api/ 分支最前面调用；返回 true 表示已处理
// ---------------------------------------------------------------------------
async function handle(ctx) {
  const { p, method, u, req, res, sendJson, readBody } = ctx;
  const GET = method === 'GET', POST = method === 'POST';
  let body = null;
  const json = async () => {
    if (body) return body;
    try { body = JSON.parse((await readBody(req)).toString('utf8') || '{}'); }
    catch (e) { body = {}; }
    if (!body || typeof body !== 'object') body = {};
    return body;
  };

  if (p === '/api/docs' && GET) {
    let sc = '';
    try { if (u && u.searchParams) sc = u.searchParams.get('sharecode') || ''; } catch (e) { }
    if (!sc) { const m = String(req.url || '').match(/[?&]sharecode=([^&]+)/); if (m) sc = decodeURIComponent(m[1]); }
    // 网关剥掉 sharecode、且把 Host 改写成内部域名时，还原「玩家真正访问的对外地址」，
    // 让 full_urls / curl_submit 是 AI 可以直接复制的完整 URL。
    const h = req.headers || {};
    const rawHost = String(h.host || '');
    let origin = '';
    if (/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(rawHost)) {
      origin = 'http://' + rawHost;                       // 本机调试
    } else {
      const fwd = String(h['x-forwarded-host'] || h['x-original-host'] || '').split(',')[0].trim();
      let refHost = '';
      try { refHost = new URL(String(h.referer || '')).host; } catch (e) { }
      // 只接受对外域名，内部网关域名（cloudstudio / sandbox / e2b）一律不用
      const usable = (x) => x && !/cloudstudio|sandbox|e2b\.bj|localhost|127\.0\.0\.1/.test(x);
      const cand = [fwd, refHost, /\.app\.workbuddy\.host|\.workbuddy\.link/.test(rawHost) ? rawHost : ''].find(usable);
      origin = cand ? 'https://' + cand : PUBLIC_BASE;
    }
    sendJson(res, 200, docs(sc, origin)); return true;
  }

  // ---- 账号 ----
  if (p === '/api/auth/register' && POST) {
    const b = await json();
    const username = String(b.username || '').trim();
    const password = String(b.password || '');
    if (!USER_RE.test(username)) { sendJson(res, 400, { ok: false, error: '用户名要 3–20 位，只能用英文字母、数字、下划线' }); return true; }
    if (password.length < 6 || password.length > 128) { sendJson(res, 400, { ok: false, error: '密码要 6–128 位' }); return true; }
    if (tooManyFails(username)) { sendJson(res, 429, { ok: false, error: '尝试太频繁，请 5 分钟后再试' }); return true; }
    if (findUser(username)) { sendJson(res, 409, { ok: false, error: '这个用户名已经被注册了，直接登录即可' }); return true; }
    const salt = newSalt();
    const user = {
      username, salt, hash: hashPassword(password, salt),
      apiKey: newKey(), createdAt: Date.now(), submissions: [],
    };
    accounts.users.push(user); saveAccounts(); clearFails(username);
    console.log('[市场] 新开发者注册 ' + username);
    sendJson(res, 200, { ok: true, username, apiKey: user.apiKey, message: '注册成功。把下面这枚 API Key 交给 AI，它就能通过 /api/plugins/submit 提交插件。' });
    return true;
  }
  if (p === '/api/auth/login' && POST) {
    const b = await json();
    const username = String(b.username || '').trim(), password = String(b.password || '');
    const user = findUser(username);
    if (!user || tooManyFails(username) || hashPassword(password, user.salt) !== user.hash) {
      noteFail(username);
      sendJson(res, 401, { ok: false, error: '用户名或密码不对（忘记 Key 也可以直接登录取回）' });
      return true;
    }
    clearFails(username);
    sendJson(res, 200, { ok: true, username: user.username, apiKey: user.apiKey });
    return true;
  }
  if (p === '/api/auth/key' && POST) {
    const b = await json();
    // 两种重置方式：带当前有效 Key（前端一键重置），或用户名 + 密码（Key 丢了也能换）
    const byKey = userByKey(keyFrom(u, req));
    const user = byKey || findUser(b.username);
    const allowed = user && (byKey || hashPassword(String(b.password || ''), user.salt) === user.hash);
    if (!allowed) {
      sendJson(res, 401, { ok: false, error: '用户名或密码不对，或 API Key 已失效' }); return true;
    }
    user.apiKey = newKey(); saveAccounts();
    sendJson(res, 200, { ok: true, username: user.username, apiKey: user.apiKey, message: '旧 Key 已失效，请把新 Key 重新交给 AI' });
    return true;
  }
  if (p === '/api/auth/me' && GET) {
    const user = userByKey(keyFrom(u, req));
    if (!user) { sendJson(res, 401, { ok: false, error: 'API Key 无效或缺失，请先在「插件市场 → 开发者」注册 / 登录' }); return true; }
    sendJson(res, 200, { ok: true, user: publicUser(user) });
    return true;
  }

  // ---- 市场（公开） ----
  if (p === '/api/market' && GET) {
    const plugins = market.plugins.map(marketRecord);
    sendJson(res, 200, { ok: true, plugins, count: plugins.length, api: docs().version });
    return true;
  }
  if (p === '/api/market/install' && POST) {
    const b = await json();
    const rec = market.plugins.find((x) => x.id === String(b.id || ''));
    if (rec) { rec.installs = (rec.installs || 0) + 1; saveMarket(); }
    sendJson(res, 200, { ok: !!rec, installs: rec ? rec.installs : 0 });
    return true;
  }

  // ---- 校验 / 提交 / 管理 ----
  if (p === '/api/plugins/validate' && POST) {
    const b = await json();
    const v = validatePlugin(b);
    sendJson(res, v.ok ? 200 : 422, v);
    return true;
  }
  if (p === '/api/plugins/submit' && POST) {
    const user = userByKey(keyFrom(u, req));
    if (!user) { sendJson(res, 401, { ok: false, error: '提交插件需要 API Key：请在「插件市场 → 开发者」注册或登录，把 Key 放进 X-ITLZMC-Key 请求头' }); return true; }
    const b = await json();
    const v = validatePlugin(b);
    const id = (v.report.meta && v.report.meta.id) || String(b.id || '(未声明 id)');
    if (!v.ok) {
      logSubmission(user, { id, status: 'rejected', errors: v.errors, warnings: v.warnings });
      console.log('[市场] 拒绝 ' + user.username + ' 提交的 ' + id + '：' + v.errors[0]);
      sendJson(res, 422, { ok: false, error: '校验没通过，插件没有上架', errors: v.errors, warnings: v.warnings, report: v.report });
      return true;
    }
    const out = publish(user, b, v);
    if (out.error) {
      logSubmission(user, { id, status: 'rejected', errors: [out.error] });
      sendJson(res, 409, { ok: false, error: out.error, report: v.report });
      return true;
    }
    logSubmission(user, { id, name: out.plugin.name, status: 'published', version: out.plugin.version });
    console.log('[市场] 上架 ' + id + ' v' + out.plugin.version + ' · 作者 ' + user.username);
    sendJson(res, 200, {
      ok: true, message: '校验全部通过，插件已上架，现在所有人在插件市场都能看到并一键安装',
      plugin: out.plugin, warnings: v.warnings, report: v.report,
    });
    return true;
  }
  if (p === '/api/plugins/mine' && GET) {
    const user = userByKey(keyFrom(u, req));
    if (!user) { sendJson(res, 401, { ok: false, error: 'API Key 无效或缺失' }); return true; }
    const mine = market.plugins.filter((x) => x.author === user.username).map(marketRecord);
    sendJson(res, 200, { ok: true, plugins: mine, submissions: (user.submissions || []).slice(-30).reverse() });
    return true;
  }
  if (p === '/api/plugins/withdraw' && POST) {
    const user = userByKey(keyFrom(u, req));
    if (!user) { sendJson(res, 401, { ok: false, error: 'API Key 无效或缺失' }); return true; }
    const b = await json();
    const id = String(b.id || '');
    const i = market.plugins.findIndex((x) => x.id === id && x.author === user.username);
    if (i < 0) { sendJson(res, 404, { ok: false, error: '没有找到你上架的这个插件' }); return true; }
    market.plugins.splice(i, 1); saveMarket();
    try { fs.unlinkSync(path.join(PUB_DIR, id + '.js')); } catch (e) { }
    logSubmission(user, { id, status: 'withdrawn' });
    sendJson(res, 200, { ok: true, message: '已下架 ' + id });
    return true;
  }

  return false;   // 交给 server.js 的其它路由 / 静态文件处理
}

initStore();
module.exports = { handle, validatePlugin, docs, userByKey, findUser };
