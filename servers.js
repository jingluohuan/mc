#!/usr/bin/env node
'use strict';
// ---------------------------------------------------------------------------
// ITLZMC 常驻服务器（「我的世界那种服务器」）
//  · 房间与世界状态存在服务器磁盘上，进程重启后自动恢复；房主/创建者退出房间照常运行
//  · 任何人都能从列表或邀请码加入，服务端是玩家状态与方块变更的唯一权威枢纽
//  · 服务器可启用原生插件，成员进入时自动下发源码
//  · /api/admin/* 管理后台接口（全平台 Web / EXE / APK 同源可用）
// 零第三方依赖，只用 Node 内置模块。
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Market = require('./market');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, '.itlzmc');
const SRV_DIR = path.join(DATA_DIR, 'servers');
const ADMIN_PASSWORD = process.env.QIUMC_ADMIN_PASSWORD || 'itlzmc-admin-2026';
const ADMIN_USERS = new Set(String(process.env.QIUMC_ADMIN_USERS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
const PUBLIC_BASE = process.env.QIUMC_PUBLIC_BASE || 'https://a23dc3393acb531d3.app.workbuddy.host';
const DEFAULT_SHARE = process.env.QIUMC_SHARE || '4AK3QS2M26';
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const MAX_BLOCKS = 120000;      // 单个服务器最多记录的方块变更
const MAX_CHAT = 60;
const MAX_LOGS = 240;
const SAVE_EVERY = 12000;

const servers = new Map();      // code -> server
const online = new Map();       // code -> Map(id -> member)
const sessions = new Map();     // token -> expireAt
const logs = [];
let seq = 1;

function now() { return Date.now(); }
function randCode(n = 6) {
  let s;
  do { s = ''; for (let i = 0; i < n; i++) s += CODE_ALPHABET[(Math.random() * CODE_ALPHABET.length) | 0]; }
  while (servers.has(s));
  return s;
}
function log(type, text) {
  logs.push({ at: now(), type: String(type || 'info'), text: String(text || '').slice(0, 300) });
  if (logs.length > MAX_LOGS) logs.splice(0, logs.length - MAX_LOGS);
  console.log('[服务器/' + type + '] ' + text);
}
function atomicWrite(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj), 'utf8');
  fs.renameSync(tmp, file);
}
function fileFor(code) { return path.join(SRV_DIR, code + '.json'); }

function blankWorld(seed) {
  return { blocks: {}, bes: {}, players: {}, env: { time: 1000, weather: 0, rain: 0 }, chat: [] };
}
function newServer(b) {
  const code = randCode(6);
  const seed = Number.isFinite(Number(b.seed)) && Number(b.seed) !== 0 ? Number(b.seed) : (Math.random() * 2 ** 31) | 0;
  const s = {
    code, name: String(b.name || '新的服务器').slice(0, 40),
    owner: String(b.owner || 'ITLZMC').slice(0, 24),
    ownerKey: String(b.ownerKey || ''),
    ownerUser: String(b.ownerUser || ''),
    created: now(), seed,
    gamemode: ['survival', 'creative', 'adventure'].includes(b.gamemode) ? b.gamemode : 'survival',
    max: Math.max(2, Math.min(32, Number(b.max) || 10)),
    motd: String(b.motd || '欢迎来到 ITLZMC 常驻服务器').slice(0, 120),
    plugins: Array.isArray(b.plugins) ? b.plugins.filter((x) => typeof x === 'string').slice(0, 24) : [],
    whitelist: [], banned: [], paused: false, public: b.public !== false,
    world: blankWorld(seed), dirty: true, startedAt: now(),
  };
  servers.set(code, s);
  online.set(code, new Map());
  saveServer(s);
  log('create', '创建常驻服务器 ' + code + ' · ' + s.name + '（种子 ' + seed + '）');
  return s;
}
function saveServer(s) {
  try { atomicWrite(fileFor(s.code), s); s.dirty = false; }
  catch (e) { console.error('[服务器] 写盘失败 ' + s.code, e.message); }
}
function loadServers() {
  fs.mkdirSync(SRV_DIR, { recursive: true });
  let files = [];
  try { files = fs.readdirSync(SRV_DIR).filter((f) => /\.json$/i.test(f)); } catch (e) { }
  for (const f of files) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(SRV_DIR, f), 'utf8'));
      if (!s || !s.code) continue;
      s.world = Object.assign(blankWorld(s.seed || 0), s.world || {});
      s.world.blocks = s.world.blocks || {}; s.world.bes = s.world.bes || {};
      s.world.players = s.world.players || {}; s.world.chat = s.world.chat || [];
      s.world.env = Object.assign({ time: 1000, weather: 0, rain: 0 }, s.world.env || {});
      s.plugins = Array.isArray(s.plugins) ? s.plugins : [];
      s.whitelist = Array.isArray(s.whitelist) ? s.whitelist : [];
      s.banned = Array.isArray(s.banned) ? s.banned : [];
      s.dirty = false;
      servers.set(s.code, s);
      online.set(s.code, new Map());
    } catch (e) { console.error('[服务器] 跳过损坏的存档 ' + f + '：' + e.message); }
  }
  log('boot', '已恢复 ' + servers.size + ' 个常驻服务器');
}
const autosave = setInterval(() => { for (const s of servers.values()) if (s.dirty) saveServer(s); }, SAVE_EVERY);
if (autosave.unref) autosave.unref();

// 服务器时间照常流逝：即使房间空无一人，世界时钟与天气也在推进。
let envTick = 0;
const worldClock = setInterval(() => {
  envTick++;
  for (const s of servers.values()) {
    if (s.paused) continue;
    const e = s.world.env;
    e.time = (Number(e.time || 1000) + 20) % 24000;
    if (envTick % 90 === 0) {
      const r = Math.random();
      e.rain = r < 0.12 ? 1 : 0;
      e.weather += (e.rain - e.weather) * 0.35;
    }
    s.dirty = true;
    if (envTick % 3 === 0) broadcast(s.code, { t: 'env', time: e.time, weather: e.weather, rain: e.rain }, null);
  }
}, 1000);
if (worldClock.unref) worldClock.unref();

// ---------------------------------------------------------------------------
// 插件目录：官方插件 / 示例插件 / 插件市场已上架的插件
// ---------------------------------------------------------------------------
function parseMeta(src) {
  const head = (src.match(/ITLZMC\s*\.\s*(?:plugin|register)\s*\(\s*\{([\s\S]{0,900}?)\}\s*,/) || [])[1] || '';
  const get = (k) => { const m = head.match(new RegExp('\\b' + k + '\\s*:\\s*[\'"`]([^\'"`]*)[\'"`]')); return m ? m[1] : ''; };
  return { id: get('id'), name: get('name'), version: get('version'), description: get('description') };
}
function pluginCatalog() {
  const dirs = [
    { dir: path.join(ROOT, 'plugins', 'store'), source: 'official' },
    { dir: path.join(ROOT, 'plugins', 'examples'), source: 'example' },
    { dir: path.join(ROOT, 'market'), source: 'market' },
  ];
  const out = [];
  const seen = new Set();
  for (const d of dirs) {
    let files = [];
    try { files = fs.readdirSync(d.dir).filter((f) => /\.js$/i.test(f)); } catch (e) { continue; }
    for (const f of files) {
      const file = path.join(d.dir, f);
      let src = '';
      try { src = fs.readFileSync(file, 'utf8'); } catch (e) { continue; }
      if (src.length > 260 * 1024) continue;
      const meta = parseMeta(src);
      const id = (meta.id || f.replace(/\.js$/i, '')).slice(0, 64);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({
        id, name: meta.name || id, version: meta.version || '1.0.0',
        description: meta.description || 'ITLZMC 原生插件', source: d.source,
        size: Buffer.byteLength(src), file: path.relative(ROOT, file).replace(/\\/g, '/'),
      });
    }
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}
function pluginSources(ids) {
  const cat = pluginCatalog();
  const out = [];
  let total = 0;
  for (const id of ids || []) {
    const p = cat.find((x) => x.id === id);
    if (!p) continue;
    let code = '';
    try { code = fs.readFileSync(path.join(ROOT, p.file), 'utf8'); } catch (e) { continue; }
    if (total + code.length > 512 * 1024) break;
    total += code.length;
    out.push({ id: p.id, name: p.name, version: p.version, code });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 在线成员
// ---------------------------------------------------------------------------
function members(code) { return online.get(code) || new Map(); }
function broadcast(code, obj, exceptId) {
  for (const m of members(code).values()) {
    if (m.id === exceptId || !m.ws || m.ws.closed) continue;
    try { m.ws.send(obj); } catch (e) { }
  }
}
function publicList() {
  const out = [];
  for (const s of servers.values()) {
    const ms = members(s.code);
    out.push({
      code: s.code, name: s.name, owner: s.owner, players: ms.size, max: s.max,
      gamemode: s.gamemode, state: s.paused ? 'paused' : 'running',
      created: s.created, started: s.startedAt || s.created, kind: 'server',
      motd: s.motd, pluginCount: (s.plugins || []).length, public: s.public !== false,
      seed: s.seed,
    });
  }
  return out.sort((a, b) => b.players - a.players || b.created - a.created);
}
function publicView(s) {
  const ms = members(s.code);
  return {
    code: s.code, name: s.name, owner: s.owner, players: ms.size, max: s.max,
    gamemode: s.gamemode, seed: s.seed, motd: s.motd, paused: s.paused,
    pluginCount: (s.plugins || []).length, created: s.created,
    pluginIds: (s.plugins || []).slice(),
    members: [...ms.values()].map((m) => ({ id: m.id, name: m.name, at: m.at })),
  };
}
function kickMember(code, id, reason) {
  const m = members(code).get(id);
  if (!m) return false;
  try { if (m.ws && !m.ws.closed) m.ws.send({ t: 'kicked', reason: reason || '管理员请你离开服务器' }); } catch (e) { }
  try { if (m.ws && !m.ws.closed) m.ws.close(); } catch (e) { }
  return true;
}

// ---------------------------------------------------------------------------
// WebSocket /srv：成员加入、状态、方块、聊天、退出
// ---------------------------------------------------------------------------
function handleWS(ws) {
  let code = null, id = null, name = null, s = null, closed = false;
  const fail = (reason) => { try { ws.send({ t: 'error', reason }); } catch (e) { } };
  const leave = (why) => {
    if (closed) return;
    closed = true;
    const ms = members(code);
    if (ms && id) ms.delete(id);
    if (s) { s.dirty = true; log('leave', name + ' 离开 ' + code + (why ? '（' + why + '）' : '')); }
    if (code && id) broadcast(code, { t: 'gone', id, name }, id);
  };
  ws.onmessage = (text) => {
    let m;
    try { m = JSON.parse(text); } catch (e) { return; }
    if (m.t === 'ping') { try { ws.send({ t: 'pong' }); } catch (e) { } return; }
    if (m.t === 'join') {
      if (closed) return;
      code = String(m.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
      s = servers.get(code);
      if (!s) { fail('没有找到这个服务器（邀请码不对，或服务器已被删除）'); return; }
      if (s.paused) { fail('这个服务器暂时被管理员暂停了，稍后再来'); return; }
      name = String(m.name || 'Player').replace(/[^\w\u4e00-\u9fa5]/g, '').slice(0, 20) || 'Player';
      const lower = name.toLowerCase();
      if ((s.banned || []).includes(lower)) { fail('你被这个服务器封禁了'); return; }
      if ((s.whitelist || []).length && !(s.whitelist || []).includes(lower)) { fail('这个服务器开了白名单，你不在名单里'); return; }
      const ms = members(code);
      if (ms.size >= s.max) { fail('服务器满了（最多 ' + s.max + ' 人）'); return; }
      id = 's' + (seq++);
      const peers = [...ms.values()].map((x) => ({ id: x.id, name: x.name, look: x.look || null, pos: x.pos || null }));
      ms.set(id, { id, name, ws, look: m.look || null, pos: null, at: now() });
      const blocks = Object.entries(s.world.blocks).map(([k, v]) => {
        const [x, y, z] = k.split(',').map(Number);
        return [x, y, z, v[0], v[1], v[2]];
      });
      const bes = Object.entries(s.world.bes).map(([k, v]) => [k, v]);
      try {
        ws.send({
          t: 'joined', id, server: publicView(s), peers,
          blocks, bes, env: s.world.env, chat: (s.world.chat || []).slice(-30),
          plugins: pluginSources(s.plugins), saved: s.world.players[lower] || null,
        });
      } catch (e) { }
      broadcast(code, { t: 'peer', id, name, look: m.look || null }, id);
      s.dirty = true;
      log('join', name + ' 加入 ' + code + '（' + ms.size + '/' + s.max + ' 人）');
      return;
    }
    if (!s || closed || !id) return;
    const me = members(code).get(id);
    if (!me) return;
    switch (m.t) {
      case 'state':
        me.pos = Array.isArray(m.pos) ? m.pos.slice(0, 3).map((v) => Number(v) || 0) : me.pos;
        me.look = m.look || me.look;
        if (m.name) me.name = String(m.name).slice(0, 20);
        broadcast(code, { t: 'state', id, name: me.name, pos: m.pos, yaw: m.yaw, pitch: m.pitch,
          sneak: m.sneak, swing: m.swing, held: m.held, armor: m.armor, look: m.look, mode: m.mode, swim: m.swim }, id);
        break;
      case 'blocks': {
        const list = Array.isArray(m.list) ? m.list.slice(0, 512) : [];
        const good = [];
        for (const b of list) {
          if (!Array.isArray(b) || b.length < 4) continue;
          const [x, y, z, bid] = b;
          if (![x, y, z, bid].every((v) => Number.isFinite(+v))) continue;
          const k = [Math.round(x), Math.round(y), Math.round(z)].join(',');
          s.world.blocks[k] = [Math.round(bid), Math.round(b[4] || 0), b[5] ? 1 : 0];
          good.push([Math.round(x), Math.round(y), Math.round(z), Math.round(bid), Math.round(b[4] || 0), b[5] ? 1 : 0]);
        }
        const keys = Object.keys(s.world.blocks);
        if (keys.length > MAX_BLOCKS) {
          for (const k of keys.slice(0, keys.length - MAX_BLOCKS)) delete s.world.blocks[k];
        }
        if (good.length) broadcast(code, { t: 'blocks', list: good }, id);
        s.dirty = true;
        break;
      }
      case 'be': {
        const k = String(m.k || '').slice(0, 80);
        if (!k || !m.data || typeof m.data !== 'object') break;
        s.world.bes[k] = m.data;
        broadcast(code, { t: 'be', k, data: m.data }, id);
        s.dirty = true;
        break;
      }
      case 'pstate': {
        if (m.data && typeof m.data === 'object') s.world.players[name.toLowerCase()] = m.data;
        s.dirty = true;
        break;
      }
      case 'chat': {
        const text = String(m.text || '').replace(/[\r\n]/g, ' ').slice(0, 256).trim();
        if (!text) break;
        const rec = { at: now(), name, text };
        s.world.chat.push(rec);
        if (s.world.chat.length > MAX_CHAT) s.world.chat.shift();
        broadcast(code, { t: 'chat', name, text }, null);
        s.dirty = true;
        log('chat', code + ' <' + name + '> ' + text);
        break;
      }
      case 'leave': leave('主动退出'); break;
      default: break;
    }
  };
  ws.onclose = () => leave('连接断开');
}

// ---------------------------------------------------------------------------
// 鉴权
// ---------------------------------------------------------------------------
function adminFrom(ctx) {
  const { req, u } = ctx;
  const tok = String(req.headers['x-itlzmc-admin'] || u.searchParams.get('admin') || '').trim();
  if (tok && (sessions.get(tok) || 0) > now()) return { via: 'token' };
  const key = String(req.headers['x-itlzmc-key'] || u.searchParams.get('key') || '').trim();
  if (key) {
    const user = typeof Market.userByKey === 'function' ? Market.userByKey(key) : null;
    if (user && (user.admin || ADMIN_USERS.has(String(user.username).toLowerCase()))) return { via: 'key', user };
  }
  return null;
}
function ownerOk(s, b) {
  return !!b && !!s && !!s.ownerKey && String(b.ownerKey || '') === s.ownerKey;
}

// ---------------------------------------------------------------------------
// HTTP API
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
  const deny = () => { sendJson(res, 401, { ok: false, error: '需要管理员权限：请在管理后台登录，或使用管理员 API Key' }); return true; };

  // ---- 公开：服务器列表 / 详情 / 插件目录 ----
  if (p === '/api/servers' && GET) {
    sendJson(res, 200, { ok: true, servers: publicList(), total: servers.size });
    return true;
  }
  if (p === '/api/server-plugins' && GET) {
    sendJson(res, 200, { ok: true, plugins: pluginCatalog().map((x) => ({ id: x.id, name: x.name, version: x.version, description: x.description, source: x.source, size: x.size })) });
    return true;
  }
  // 任何人都能开一个常驻服务器（不强制登录）；ownerKey 是本机身份，用来管理自己开的服。
  if (p === '/api/servers' && POST) {
    const b = await json();
    const s = newServer(b);
    sendJson(res, 200, { ok: true, code: s.code, server: publicView(s) });
    return true;
  }
  let m = p.match(/^\/api\/servers\/([A-Z0-9]{4,12})(?:\/(.*))?$/);
  if (m) {
    const code = m[1], sub = m[2] || '', s = servers.get(code);
    if (sub === '' && GET) {
      if (!s) { sendJson(res, 404, { ok: false, error: '没有这个服务器' }); return true; }
      sendJson(res, 200, { ok: true, server: publicView(s) });
      return true;
    }
    if (sub === 'manage' && POST) {
      const b = await json();
      if (!s) { sendJson(res, 404, { ok: false, error: '没有这个服务器' }); return true; }
      if (!adminFrom(ctx) && !ownerOk(s, b)) { sendJson(res, 403, { ok: false, error: '只有服务器创建者或管理员能改设置' }); return true; }
      applyUpdate(s, b, false);
      sendJson(res, 200, { ok: true, server: publicView(s) });
      return true;
    }
    if (sub === 'delete' && POST) {
      const b = await json();
      if (!s) { sendJson(res, 200, { ok: true }); return true; }
      if (!adminFrom(ctx) && !ownerOk(s, b)) { sendJson(res, 403, { ok: false, error: '只有服务器创建者或管理员能删除' }); return true; }
      for (const mem of members(code).values()) kickMember(code, mem.id, '服务器已被删除');
      online.delete(code); servers.delete(code);
      try { fs.unlinkSync(fileFor(code)); } catch (e) { }
      log('delete', '删除常驻服务器 ' + code + ' · ' + s.name);
      sendJson(res, 200, { ok: true });
      return true;
    }
  }

  // ---- 管理后台 ----
  if (p === '/api/admin/session' && POST) {
    const b = await json();
    if (String(b.password || '') !== ADMIN_PASSWORD) { sendJson(res, 401, { ok: false, error: '管理员口令不对' }); return true; }
    const token = 'qadm_' + crypto.randomBytes(24).toString('hex');
    sessions.set(token, now() + 24 * 3600 * 1000);
    sendJson(res, 200, { ok: true, token, expiresIn: 86400 });
    return true;
  }
  if (p.startsWith('/api/admin/')) {
    if (!adminFrom(ctx)) return deny();
    if (p === '/api/admin/overview' && GET) {
      let players = 0;
      for (const ms of online.values()) players += ms.size;
      let accounts = 0;
      try { accounts = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'accounts.json'), 'utf8')).users.length; } catch (e) { }
      sendJson(res, 200, {
        ok: true,
        servers: servers.size, onlineServers: [...online.values()].filter((x) => x.size > 0).length,
        players, accounts, plugins: pluginCatalog().length,
        logs: logs.slice(-40).reverse(), uptime: Math.round(process.uptime()),
        publicBase: PUBLIC_BASE, sharecode: DEFAULT_SHARE,
      });
      return true;
    }
    if (p === '/api/admin/servers' && GET) {
      sendJson(res, 200, { ok: true, servers: [...servers.values()].map((s) => Object.assign(publicView(s), {
        whitelist: s.whitelist, banned: s.banned, plugins: s.plugins,
        blockChanges: Object.keys(s.world.blocks).length, blockEntities: Object.keys(s.world.bes).length,
        savedPlayers: Object.keys(s.world.players).length, public: s.public !== false,
      })) });
      return true;
    }
    if (p === '/api/admin/servers' && POST) {
      const b = await json();
      const s = newServer(Object.assign({}, b, { owner: b.owner || '管理员' }));
      sendJson(res, 200, { ok: true, code: s.code, server: publicView(s) });
      return true;
    }
    let a = p.match(/^\/api\/admin\/servers\/([A-Z0-9]{4,12})(?:\/(.*))?$/);
    if (a) {
      const code = a[1], sub = a[2] || '', s = servers.get(code);
      if (!s) { sendJson(res, 404, { ok: false, error: '没有这个服务器' }); return true; }
      if (sub === '' && POST) {
        const b = await json();
        applyUpdate(s, b, true);
        sendJson(res, 200, { ok: true, server: publicView(s) });
        return true;
      }
      if (sub === 'delete' && POST) {
        for (const mem of members(code).values()) kickMember(code, mem.id, '服务器已被管理员删除');
        online.delete(code); servers.delete(code);
        try { fs.unlinkSync(fileFor(code)); } catch (e) { }
        log('delete', '管理员删除 ' + code);
        sendJson(res, 200, { ok: true }); return true;
      }
      if (sub === 'kick' && POST) {
        const b = await json();
        const ok = kickMember(code, String(b.id || ''), b.reason);
        log('kick', code + ' 踢出 ' + (b.id || '?') + '：' + (ok ? '成功' : '不在线'));
        sendJson(res, 200, { ok }); return true;
      }
      if (sub === 'ban' && POST) {
        const b = await json();
        const n = String(b.name || '').toLowerCase();
        if (!n) { sendJson(res, 400, { ok: false, error: '要填玩家名' }); return true; }
        if (!s.banned.includes(n)) s.banned.push(n);
        const ms = members(code);
        for (const mem of ms.values()) if (mem.name.toLowerCase() === n) kickMember(code, mem.id, '你被封禁了');
        s.dirty = true; saveServer(s);
        log('ban', code + ' 封禁 ' + n);
        sendJson(res, 200, { ok: true, banned: s.banned }); return true;
      }
      if (sub === 'unban' && POST) {
        const b = await json();
        s.banned = s.banned.filter((x) => x !== String(b.name || '').toLowerCase());
        s.dirty = true; saveServer(s);
        sendJson(res, 200, { ok: true, banned: s.banned }); return true;
      }
      if (sub === 'whitelist' && POST) {
        const b = await json();
        const list = Array.isArray(b.list) ? b.list.map((x) => String(x).toLowerCase().slice(0, 20)).filter(Boolean).slice(0, 100) : [];
        s.whitelist = list; s.dirty = true; saveServer(s);
        log('setting', code + ' 白名单更新为 ' + list.length + ' 人');
        sendJson(res, 200, { ok: true, whitelist: s.whitelist }); return true;
      }
      if (sub === 'broadcast' && POST) {
        const b = await json();
        const text = String(b.text || '').slice(0, 256);
        if (text) { broadcast(code, { t: 'chat', name: '【管理员】', text, sys: true }, null); log('broadcast', code + '：' + text); }
        sendJson(res, 200, { ok: true }); return true;
      }
    }
    if (p === '/api/admin/plugins' && GET) {
      const cat = pluginCatalog();
      const usage = {};
      for (const s of servers.values()) for (const id of s.plugins) usage[id] = (usage[id] || 0) + 1;
      sendJson(res, 200, { ok: true, plugins: cat.map((x) => Object.assign({}, x, { usedBy: usage[x.id] || 0 })) });
      return true;
    }
    if (p === '/api/admin/plugins/source' && GET) {
      const id = String(u.searchParams.get('id') || '');
      const cat = pluginCatalog().find((x) => x.id === id);
      if (!cat) { sendJson(res, 404, { ok: false, error: '没有这个插件' }); return true; }
      sendJson(res, 200, { ok: true, id, code: fs.readFileSync(path.join(ROOT, cat.file), 'utf8') });
      return true;
    }
    if (p === '/api/admin/plugins/withdraw' && POST) {
      const b = await json();
      const cat = pluginCatalog().find((x) => x.id === String(b.id || ''));
      if (!cat) { sendJson(res, 404, { ok: false, error: '没有这个插件' }); return true; }
      if (cat.source !== 'market') { sendJson(res, 400, { ok: false, error: '官方 / 示例插件不能下架，只能在服务器里停用' }); return true; }
      for (const s of servers.values()) { s.plugins = s.plugins.filter((x) => x !== cat.id); s.dirty = true; }
      try { fs.unlinkSync(path.join(ROOT, cat.file)); } catch (e) { }
      log('plugin', '下架市场插件 ' + cat.id);
      sendJson(res, 200, { ok: true }); return true;
    }
    if (p === '/api/admin/accounts' && GET) {
      let users = [];
      try {
        users = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'accounts.json'), 'utf8')).users.map((u2) => ({
          username: u2.username, createdAt: u2.createdAt, admin: !!(u2.admin || ADMIN_USERS.has(u2.username.toLowerCase())),
          submissions: (u2.submissions || []).length, apiKey: u2.apiKey,
        }));
      } catch (e) { }
      sendJson(res, 200, { ok: true, accounts: users });
      return true;
    }
    if (p === '/api/admin/logs' && GET) {
      sendJson(res, 200, { ok: true, logs: logs.slice(-120).reverse() });
      return true;
    }
    if (p === '/api/admin/rooms' && GET) {
      sendJson(res, 200, { ok: true, rooms: typeof ctx.localRooms === 'function' ? ctx.localRooms() : [] });
      return true;
    }
    if (p === '/api/admin/rooms/close' && POST) {
      const b = await json();
      const ok = typeof ctx.closeLocalRoom === 'function' ? ctx.closeLocalRoom(String(b.code || '')) : false;
      log('room', '关闭本地房间 ' + (b.code || '?') + '：' + (ok ? '成功' : '没找到'));
      sendJson(res, 200, { ok }); return true;
    }
    sendJson(res, 404, { ok: false, error: '没有这个管理接口' });
    return true;
  }
  return false;   // 不是本模块的路由
}

function applyUpdate(s, b, isAdmin) {
  if (b.name !== undefined) s.name = String(b.name).slice(0, 40);
  if (b.motd !== undefined) s.motd = String(b.motd).slice(0, 120);
  if (b.gamemode !== undefined && ['survival', 'creative', 'adventure'].includes(b.gamemode)) s.gamemode = b.gamemode;
  if (b.max !== undefined) s.max = Math.max(2, Math.min(32, Number(b.max) || 10));
  if (b.paused !== undefined) s.paused = !!b.paused;
  if (b.public !== undefined) s.public = b.public !== false;
  if (Array.isArray(b.plugins)) {
    const valid = new Set(pluginCatalog().map((x) => x.id));
    s.plugins = b.plugins.filter((x) => valid.has(String(x))).slice(0, 24);
  }
  if (isAdmin && b.seed !== undefined && Number.isFinite(Number(b.seed))) s.seed = Number(b.seed);
  s.dirty = true; saveServer(s);
  log('setting', s.code + ' 设置已更新（' + (isAdmin ? '管理员' : '创建者') + '）');
  // 插件改动立刻推给在线成员：客户端收到后幂等加载，不必重进服务器
  broadcast(s.code, { t: 'plugins', plugins: pluginSources(s.plugins) }, null);
}

loadServers();
module.exports = { handle, handleWS, publicList, log, shutdown: () => { for (const s of servers.values()) if (s.dirty) saveServer(s); } };
