#!/usr/bin/env node
'use strict';
// ---------------------------------------------------------------------------
// ITLZMC 一体化服务器：静态站点 + 房间服务 REST + 本地房间（WebRTC）信令。
// 零第三方依赖，只用 Node 内置模块；`node server.js` 即可，PORT 可覆盖。
//
// 前端协议对照：js/net.js 的 RoomService、js/p2p.js 的 LocalHost / LocalGuest。
//  · /p2p        WebSocket：host / join / signal / leave / gone / closed
//  · /api/public 公开房间列表（所有在线的本地房间）
//  · /api/plugins  ITLZMC 原生插件自动发现（plugins/ 目录，仅 .js / .zip）
//  · /api/market  插件市场：注册 / API Key / 提交前校验 / 校验通过才上架（见 market.js）
//  · /api/skin   正版玩家皮肤 + 官方披风代理（Mojang 官方接口，失败给明确中文提示）
//  · /api/servers 常驻服务器：长期运行、房主退出不停服、世界落盘、可加载原生插件
//  · /srv        WebSocket：常驻服务器成员状态 / 方块 / 聊天的权威枢纽
//  · /ws         保留路径：服务器房间需要 Java 版服务端协议桥，这里给出明确说明
// ---------------------------------------------------------------------------
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const Market = require('./market');
const Servers = require('./servers');

const ROOT = __dirname;
const PORT = Number(process.env.PORT || process.argv[2] || 8080);

// ---- 文本静态资源的 gzip 压缩缓存 -------------------------------------------------------------
// 客户端要拉 90 多个脚本（未压缩约 19 MB），压缩后约 4 MB；压缩本身有成本，所以按
// 路径 + 大小 + mtime 缓存结果，文件不变就只算一次。
const TEXT_EXT = new Set(['.js', '.mjs', '.css', '.json', '.html', '.htm', '.svg', '.txt', '.md', '.map']);
const GZ = new Map();
let GZ_BYTES = 0;
const GZ_LIMIT = 96 << 20;
function gzipped(full, st, buf) {
  const key = full + '|' + st.size + '|' + Math.floor(st.mtimeMs);
  const hit = GZ.get(key);
  if (hit) return hit;
  let out;
  try { out = zlib.gzipSync(buf, { level: 6 }); } catch (e) { return null; }
  if (out.length >= buf.length - 64) return null;      // 压不动（已压缩过 / 太小）：发原文
  if (GZ_BYTES + out.length > GZ_LIMIT) { GZ.clear(); GZ_BYTES = 0; }
  GZ.set(key, out); GZ_BYTES += out.length;
  return out;
}

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const SHARE = process.env.QIUMC_SHARE || '4AK3QS2M26';
const PUBLIC_BASE = process.env.QIUMC_PUBLIC_BASE || 'https://a23dc3393acb531d3.app.workbuddy.host';

// WebRTC 配置。默认局域网直连（零外部请求）；如需跨网，设置环境变量
// QIUMC_STUN / QIUMC_TURN / QIUMC_TURN_USER / QIUMC_TURN_CRED。
const ICE = (() => {
  const servers = [];
  // 房间数据由本服务直接中转，默认不需要 STUN/TURN，零外部连接。
  // 只有显式开启 WebRTC 直连模式时才用得上这些配置。
  const stun = process.env.QIUMC_STUN;
  if (stun && stun !== 'off') {
    for (const u of stun.split(',').map((s) => s.trim()).filter(Boolean)) servers.push({ urls: u });
  }
  if (process.env.QIUMC_TURN) servers.push({
    urls: process.env.QIUMC_TURN,
    username: process.env.QIUMC_TURN_USER || '',
    credential: process.env.QIUMC_TURN_CRED || '',
  });
  return { iceServers: servers, relayOnly: false };
})();

const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8', '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon', '.svg': 'image/svg+xml',
  '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
  '.wasm': 'application/wasm', '.bin': 'application/octet-stream', '.dat': 'application/octet-stream',
  '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.zip': 'application/zip',
};
const mime = (p) => MIME[path.extname(p).toLowerCase()] || 'application/octet-stream';

// ---------------------------------------------------------------------------
// 极简 WebSocket（RFC 6455）：服务端只需处理文本帧、分片、ping/close。
// ---------------------------------------------------------------------------
const liveSockets = new Set();   // 所有还活着的 WS，用于心跳保活
class WS {
  constructor(socket) {
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.frags = [];
    this.closed = false;
    this.lastSeen = Date.now();
    this.onmessage = null;
    this.onclose = null;
    socket.setNoDelay(true);
    liveSockets.add(this);
    socket.on('data', (d) => this.onData(d));
    socket.on('close', () => { this.closed = true; liveSockets.delete(this); if (this.onclose) this.onclose(); });
    socket.on('error', () => { this.closed = true; });
  }
  onData(d) {
    this.lastSeen = Date.now();
    this.buf = Buffer.concat([this.buf, d]);
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0], b1 = this.buf[1];
      const fin = !!(b0 & 0x80), op = b0 & 0x0f, masked = !!(b1 & 0x80);
      let len = b1 & 0x7f, off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) {
        if (this.buf.length < 10) return;
        const big = this.buf.readBigUInt64BE(2);
        if (big > 16n * 1024n * 1024n) { this.close(); return; }
        len = Number(big); off = 10;
      }
      let mask = null;
      if (masked) { if (this.buf.length < off + 4) return; mask = this.buf.subarray(off, off + 4); off += 4; }
      if (this.buf.length < off + len) return;
      const payload = Buffer.from(this.buf.subarray(off, off + len));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      this.buf = this.buf.subarray(off + len);

      if (op === 0x8) { this.close(); return; }
      if (op === 0x9) { // ping -> pong
        const h = payload.length < 126 ? Buffer.from([0x8a, payload.length]) : (() => { const b = Buffer.alloc(4); b[0] = 0x8a; b[1] = 126; b.writeUInt16BE(payload.length, 2); return b; })();
        try { this.socket.write(Buffer.concat([h, payload])); } catch (e) { }
        continue;
      }
      if (op === 0xa) continue;
      if (op === 0x0 || op === 0x1) {
        if (op === 0x1) this.frags = [payload]; else this.frags.push(payload);
        if (fin) {
          const text = Buffer.concat(this.frags).toString('utf8');
          this.frags = [];
          if (this.onmessage) { try { this.onmessage(text); } catch (e) { console.error('[ws] handler', e); } }
        }
        continue;
      }
      // 二进制帧：本服务用不到，忽略
    }
  }
  ping() {  // RFC6455 ping 帧；浏览器会自动回 pong，代理/NAT 就不会因为空闲掐连接
    if (this.closed) return;
    try { this.socket.write(Buffer.from([0x89, 0])); } catch (e) { }
  }
  send(obj) {
    if (this.closed) return;
    const p = Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj), 'utf8');
    let h;
    if (p.length < 126) h = Buffer.from([0x81, p.length]);
    else if (p.length < 65536) { h = Buffer.alloc(4); h[0] = 0x81; h[1] = 126; h.writeUInt16BE(p.length, 2); }
    else { h = Buffer.alloc(10); h[0] = 0x81; h[1] = 127; h.writeBigUInt64BE(BigInt(p.length), 2); }
    try { this.socket.write(Buffer.concat([h, p])); } catch (e) { }
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    try { this.socket.end(); } catch (e) { }
  }
}

// ---------------------------------------------------------------------------
// 房间表：本地房间（WebRTC）与传统房间（REST 创建）共用同一份登记。
// ---------------------------------------------------------------------------
const p2pRooms = new Map();   // code(大写) -> { code, name, owner, host, guests:Map, created, max, gamemode }
const svcRooms = new Map();   // code -> { code, name, owner, key, world, created, max, gamemode, ... }
let guestSeq = 1;

function publicRooms() {
  const out = [];
  for (const r of p2pRooms.values()) {
    if (!r.host || r.host.closed) continue;
    out.push({
      code: r.code, name: r.name || (r.owner + ' 的房间'), owner: r.owner,
      players: 1 + r.guests.size, max: r.max || 4, gamemode: r.gamemode || 'survival',
      state: 'running', created: r.created, started: r.started || r.created, kind: 'local',
    });
  }
  for (const r of svcRooms.values()) {
    out.push({
      code: r.code, name: r.name, owner: r.owner, players: 1, max: r.max || 4,
      gamemode: r.gamemode || 'survival', state: 'running', created: r.created, started: r.created, kind: 'service',
    });
  }
  return out;
}

function newCode(n = 6) {
  const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let s;
  do { s = ''; for (let i = 0; i < n; i++) s += A[(Math.random() * A.length) | 0]; }
  while (p2pRooms.has(s) || svcRooms.has(s));
  return s;
}

// 断线宽限：房主 90s、客人 60s 内回来就恢复原房间，不踢人、不丢槽位。
const GRACE_HOST = 90 * 1000, GRACE_GUEST = 60 * 1000, MAX_QUEUE = 400;

function handleP2P(ws) {
  let role = null, code = null, id = null;
  const pushQueue = (arr, frame) => {
    if (!arr) return;
    arr.push(frame);
    if (arr.length > MAX_QUEUE) arr.shift();
  };
  // 「有人离开」必须立刻告诉房主：房主会移除这个玩家的模型，
  // 否则该玩家会静止在原地变成一坨空气，直到断线宽限结束才消失。
  // away=true：只是暂时掉线，房主静默移除模型，60s 内回来还能恢复槽位。
  const notifyHostGone = (room, gid, away) => {
    if (room && room.host && !room.host.closed && !room.hostOffline) room.host.send({ t: 'gone', id: gid, away: !!away });
  };
  // 主动退出：立刻删槽位、关掉可能还半开着的旧连接、通知房主，不走 60s 宽限。
  const removeGuest = (room, gid) => {
    const g = room.guests.get(gid);
    if (!g) return null;
    clearTimeout(g.timer); g.timer = null;
    if (g.ws && !g.ws.closed && g.ws !== ws) { try { g.ws.close(); } catch (e) { } }
    g.ws = null; g.left = true;
    room.guests.delete(gid);
    return g;
  };
  ws.onmessage = (text) => {
    let m;
    try { m = JSON.parse(text); } catch (e) { return; }
    if (m.t === 'ping') { ws.send({ t: 'pong' }); return; }
    // 房主主动关闭房间：立刻解散所有人，不留 90s 僵尸房间。
    if (m.t === 'close' && role === 'host') {
      const room = p2pRooms.get(code);
      if (room) {
        clearTimeout(room.hostTimer);
        for (const g of room.guests.values()) {
          clearTimeout(g.timer);
          if (g.ws && !g.ws.closed) { try { g.ws.send({ t: 'closed' }); } catch (e) { } }
        }
        room.guests.clear(); room.closedByHost = true;
        p2pRooms.delete(code);
        console.log('[房间] 房主关闭 ' + code);
      }
      return;
    }
    // 客人主动退出：马上从房间移除并通知房主（客人自己回主界面）。
    if (m.t === 'leave' && role === 'guest') {
      const room = p2pRooms.get(code);
      if (room && id) {
        const g = removeGuest(room, id);
        notifyHostGone(room, id);
        console.log('[房间] ' + ((g && g.name) || id) + ' 主动离开 ' + code);
      }
      return;
    }
    if (m.t === 'host') {
      code = String(m.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
      if (code.length < 6) { ws.send({ t: 'error', reason: '邀请码要 6–12 位英文字母或数字' }); return; }
      const prev = p2pRooms.get(code);
      if (prev && !m.resume) {
        // 不是重连：旧房主还在线就拒绝；已经离线/关掉的僵尸房间直接让位，允许立刻重开同一个邀请码。
        if (prev.host && !prev.host.closed && prev.host !== ws) {
          ws.send({ t: 'error', reason: '这个邀请码已经有人开了，换一个吧' }); return;
        }
        clearTimeout(prev.hostTimer);
        p2pRooms.delete(code);
      }
      if (prev && m.resume) {
        // 房主自己掉线后重连：接管原房间，客人和房间号原样保留。
        clearTimeout(prev.hostTimer); prev.hostTimer = null;
        prev.host = ws; prev.hostOffline = false;
        role = 'host';
        const peers = [...prev.guests.values()].filter((g) => !g.offline).map((g) => ({ id: g.id, name: g.name }));
        ws.send({ t: 'hosted', ice: ICE, resumed: true, peers });
        for (const f of (prev.hostQueue || [])) ws.send(f);
        prev.hostQueue = [];
        console.log('[房间] 房主重连 ' + code + '，保留 ' + peers.length + ' 位客人');
        return;
      }
      const owner = String(m.name || 'Host').slice(0, 24);
      const room = { code, name: owner + ' 的世界', owner, host: ws, guests: new Map(), created: Date.now(),
        started: Date.now(), key: String(m.key || ''), max: Math.max(2, Math.min(10, Number(m.max) || 4)),
        gamemode: String(m.gamemode || 'survival'), hostQueue: [], hostOffline: false };
      p2pRooms.set(code, room);
      role = 'host';
      ws.send({ t: 'hosted', ice: ICE });
      console.log('[房间] 开房 ' + code + ' · ' + owner);
      return;
    }
    if (m.t === 'join') {
      code = String(m.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
      const room = p2pRooms.get(code);
      if (!room || room.hostOffline || !room.host || room.host.closed) {
        ws.send({ t: 'error', reason: '没有找到这个房间（邀请码不对，或者房主已经关了）' }); return;
      }
      const rid = String(m.resume || '');
      const old = rid ? room.guests.get(rid) : null;
      if (old) {
        // 客人重连：无论旧连接是不是还被服务器当成「在线」（半开连接很常见），
        // 都复用原来的槽位与 id，绝不新建第二个玩家。否则房主那边会多出一个
        // 静止的重复玩家，看上去就是「看不到对方 / 一坨空气」。
        clearTimeout(old.timer); old.timer = null;
        if (old.ws && old.ws !== ws && !old.ws.closed) { try { old.ws.close(); } catch (e) { } }
        old.ws = ws; old.offline = false; old.left = false;
        id = old.id; role = 'guest';
        ws.send({ t: 'joined', host: room.owner, ice: ICE, resumed: true, id });
        // 掉线时房主已经把这个玩家的模型撤掉了，回来要让房主重新建一个，
        // 并且标记为重连（不再重发整个世界存档，避免客人世界被重载）。
        if (room.host && !room.host.closed && !room.hostOffline)
          room.host.send({ t: 'peer', id, name: old.name, resumed: true });
        for (const f of (old.queue || [])) ws.send(f);
        old.queue = [];
        console.log('[房间] ' + old.name + ' 重连 ' + code);
        return;
      }
      if (room.guests.size >= (room.max || 4) - 1) { ws.send({ t: 'error', reason: '房间已经满人了（最多 4 人）' }); return; }
      id = 'g' + (guestSeq++);
      const gname = String(m.name || 'Friend').slice(0, 24);
      room.guests.set(id, { ws, name: gname, id, offline: false, queue: [] });
      role = 'guest';
      ws.send({ t: 'joined', host: room.owner, ice: ICE, id });
      room.host.send({ t: 'peer', id, name: gname });
      console.log('[房间] ' + gname + ' 加入 ' + code);
      return;
    }
    const room = p2pRooms.get(code);
    if (!room) return;
    if (role === 'host') {
      if (m.t === 'signal' && m.to) {
        const g = room.guests.get(m.to);
        if (!g) return;
        const frame = { t: 'signal', data: m.data };
        if (g.offline || !g.ws || g.ws.closed) pushQueue(g.queue, frame);   // 客人暂时掉线：先存着
        else g.ws.send(frame);
      } else if (m.t === 'leave' && m.id) {
        const g = room.guests.get(m.id);
        if (g) { clearTimeout(g.timer); if (g.ws && !g.ws.closed) g.ws.send({ t: 'closed' }); room.guests.delete(m.id); }
      }
    } else if (role === 'guest') {
      if (m.t === 'signal') {
        const frame = { t: 'signal', from: id, data: m.data };
        if (!room.host || room.host.closed || room.hostOffline) pushQueue(room.hostQueue, frame);  // 房主暂时掉线：先存着
        else room.host.send(frame);
      }
    }
  };
  ws.onclose = () => {
    const room = p2pRooms.get(code);
    if (!room) return;
    if (role === 'host') {
      if (room.closedByHost || room.host !== ws) return;   // 主动关房 / 已被重连的新连接接管
      room.host = null; room.hostOffline = true;
      clearTimeout(room.hostTimer);
      room.hostTimer = setTimeout(() => {
        const r = p2pRooms.get(code);
        if (!r || !r.hostOffline) return;
        for (const g of r.guests.values()) { clearTimeout(g.timer); if (g.ws && !g.ws.closed) g.ws.send({ t: 'closed' }); }
        p2pRooms.delete(code);
        console.log('[房间] 房主长时间未回来，关闭 ' + code);
      }, GRACE_HOST);
      console.log('[房间] 房主短暂掉线，保留房间 ' + code + ' ' + (GRACE_HOST / 1000) + 's');
    } else if (role === 'guest' && id) {
      const g = room.guests.get(id);
      if (!g || g.ws !== ws || g.left) return;
      g.ws = null; g.offline = true;
      // 掉线的这一刻就让房主把模型撤掉，不再留一坨静止的空气；
      // 槽位仍保留 60s，回来时服务端会发 peer(resumed) 让房主重建。
      notifyHostGone(room, id, true);
      clearTimeout(g.timer);
      g.timer = setTimeout(() => {
        const r = p2pRooms.get(code); if (!r) return;
        const q = r.guests.get(id);
        if (!q || !q.offline) return;
        r.guests.delete(id);
        if (r.host && !r.host.closed) r.host.send({ t: 'gone', id });
        console.log('[房间] 有人离开 ' + code);
      }, GRACE_GUEST);
      console.log('[房间] 客人短暂掉线 ' + code);
    }
  };
}

// 每 20s 一次 ping；手机切后台、代理空闲超时也不会把连接掐掉。
// 超过 120s 完全没有任何帧才判定为死连接。
const heartbeat = setInterval(() => {
  const now = Date.now();
  for (const ws of liveSockets) {
    if (ws.closed) { liveSockets.delete(ws); continue; }
    if (now - ws.lastSeen > 120000) { ws.close(); continue; }
    ws.ping();
  }
}, 20000);
if (heartbeat.unref) heartbeat.unref();

function handleVanillaWS(ws) {
  // 服务器房间要连真实的 Java 版服务端协议桥；本一体化服务只提供本地房间。
  // 给一个明确答复后关闭，避免客户端一直停在「正在连接房间」。
  ws.onmessage = () => {
    ws.send({ t: 'chat', text: '这个地址提供的是本地房间联机：请用「多人游戏 → 开房间」，或在暂停菜单点「开房间」。' });
    setTimeout(() => ws.close(), 300);
  };
}

// ---------------------------------------------------------------------------
// 正版玩家皮肤代理（Mojang 官方接口）。失败一律返回中文说明，不再出现
// 「联机服务器没有回应」这种含糊报错。
// ---------------------------------------------------------------------------
function fetchURL(url, timeout = 8000, redirects = 3) {
  return new Promise((resolve, reject) => {
    let mod = url.startsWith('http:') ? http : https;
    const req = mod.get(url, { headers: { 'User-Agent': 'ITLZMC/1.0' }, timeout }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        fetchURL(new URL(res.headers.location, url).toString(), timeout, redirects - 1).then(resolve, reject);
        return;
      }
      const chunks = [];
      res.on('data', (c) => { chunks.push(c); if (Buffer.concat(chunks).length > 8 * 1024 * 1024) req.destroy(new Error('too big')); });
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

async function lookupSkin(name) {
  const a = await fetchURL('https://api.mojang.com/users/profiles/minecraft/' + encodeURIComponent(name), 6000);
  if (a.status !== 200 || !a.body.length) throw new Error('没有找到这个正版玩家名，请检查拼写');
  const uuid = JSON.parse(a.body.toString('utf8')).id;
  const b = await fetchURL('https://sessionserver.mojang.com/session/minecraft/profile/' + uuid + '?unsigned=false', 8000);
  if (b.status !== 200) throw new Error('暂时读不到这位玩家的皮肤资料，请稍后再试');
  const props = JSON.parse(b.body.toString('utf8')).properties || [];
  const tex = props.find((p) => p.name === 'textures');
  if (!tex) throw new Error('这位玩家没有公开皮肤');
  const data = JSON.parse(Buffer.from(tex.value, 'base64').toString('utf8')).textures || {};
  const skin = data.SKIN;
  if (!skin || !skin.url) throw new Error('这位玩家没有公开皮肤');
  const img = await fetchURL(skin.url.replace(/^http:/, 'https:'), 10000);
  if (img.status !== 200 || !img.body.length) throw new Error('皮肤图片下载失败，请稍后再试');
  // 官方披风（Mojang CAPE）：和皮肤一起回传，客户端注册成一款可同步的披风。
  // 大多数玩家没有官方披风，此时 cape = null，皮肤照常可用。
  let cape = null;
  try {
    const c = data.CAPE;
    if (c && c.url) {
      const ci = await fetchURL(c.url.replace(/^http:/, 'https:'), 10000);
      if (ci.status === 200 && ci.body.length && ci.body.length < 1024 * 1024) cape = ci.body.toString('base64');
    }
  } catch (e) { /* 没有官方披风就当没有，不影响皮肤 */ }
  return { png: img.body.toString('base64'), slim: !!(skin.metadata && skin.metadata.model === 'slim'), cape };
}

// ---------------------------------------------------------------------------
// HTTP：静态文件 + REST
// ---------------------------------------------------------------------------
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let n = 0;
    req.on('data', (c) => { n += c.length; if (n <= 32 * 1024 * 1024) chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

const server = http.createServer(async (req, res) => {
  let u;
  try { u = new URL(req.url, 'http://' + (req.headers.host || 'localhost')); }
  catch (e) { res.writeHead(400); res.end('bad request'); return; }
  const p = decodeURIComponent(u.pathname);

  // ---- REST ----
  if (p.startsWith('/api/')) {
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' }); res.end(); return; }
    try {
      // 插件市场后端：账号 / API Key / 校验 / 上架。返回 true 表示已处理完。
      if (await Market.handle({ p, method: req.method, u, req, res, sendJson, readBody })) return;
      if (await Servers.handle({ p, method: req.method, u, req, res, sendJson, readBody,
        localRooms: () => publicRooms(),
        closeLocalRoom: (raw) => {
          const c = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
          const r = p2pRooms.get(c);
          let ok = false;
          if (r) {
            clearTimeout(r.hostTimer);
            for (const g of r.guests.values()) { clearTimeout(g.timer); if (g.ws && !g.ws.closed) g.ws.send({ t: 'closed' }); }
            if (r.host && !r.host.closed) r.host.close();
            p2pRooms.delete(c); ok = true;
          }
          if (svcRooms.delete(c)) ok = true;
          return ok;
        } })) return;
      if (p === '/api/public') {
        // 常驻服务器和临时本地房间都出现在大厅；前者房主退出也照常运行。
        const list = publicRooms().concat(Servers.publicList().filter((s) => s.public !== false).map((s) => Object.assign({}, s, { server: true })));
        return sendJson(res, 200, { rooms: list, capacity: { sizes: { 4: true, 6: true, 8: true, 10: true }, max: 32 }, maintenance: null });
      }
      if (p === '/api/capacity') return sendJson(res, 200, { sizes: { 4: true, 6: true, 8: true, 10: true }, max: 4, reason: '' });
      if (p === '/api/plugins') {
        const dir = path.join(ROOT, 'plugins');
        let plugins = [];
        try {
          plugins = fs.readdirSync(dir, { withFileTypes: true })
            .filter((e) => e.isFile() && /\.(js|zip)$/i.test(e.name))
            .map((e) => ({
              name: e.name, dir: 'plugins', url: 'plugins/' + e.name,
              type: /\.zip$/i.test(e.name) ? 'zip' : 'js',
              size: fs.statSync(path.join(dir, e.name)).size,
            }));
        } catch (e) { }
        plugins.sort((a, b) => a.url.localeCompare(b.url));
        return sendJson(res, 200, { plugins, api: '1.0' });
      }
      if (p === '/api/p2p/has') return sendJson(res, 200, { has: p2pRooms.has(String(u.searchParams.get('code') || '').toUpperCase().replace(/[^A-Z0-9]/g, '')) });
      if (p === '/api/skin') {
        const name = String(u.searchParams.get('name') || '').trim();
        if (!/^[A-Za-z0-9_]{3,16}$/.test(name)) return sendJson(res, 200, { error: '输入正版玩家名（3–16 个英文字母、数字或下划线）' });
        try { return sendJson(res, 200, await lookupSkin(name)); }
        catch (e) { return sendJson(res, 200, { error: e.message || '暂时查不到这位玩家的皮肤，请稍后再试（也可以直接选预设皮肤）' }); }
      }
      if (p === '/api/rooms' && req.method === 'GET') {
        const key = u.searchParams.get('key') || '';
        const mine = [];
        for (const r of p2pRooms.values()) {
          if (r.key !== key || !r.host || r.host.closed) continue;
          mine.push({ code: r.code, name: r.name, owner: r.owner, playerCount: 1 + r.guests.size, players: [], max: r.max,
            gamemode: r.gamemode, created: r.created, state: 'running', kind: 'local' });
        }
        for (const r of svcRooms.values()) {
          if (r.key !== key) continue;
          mine.push({ code: r.code, name: r.name, owner: r.owner, playerCount: 1, players: r.players || [], max: r.max,
            gamemode: r.gamemode, created: r.created, state: 'running', kind: 'service' });
        }
        return sendJson(res, 200, mine);
      }
      if (p === '/api/rooms' && req.method === 'POST') {
        const b = JSON.parse((await readBody(req)).toString('utf8') || '{}');
        const code = newCode(6);
        const r = {
          code, name: String(b.name || '新的房间').slice(0, 40), owner: String(b.owner || 'Host').slice(0, 24),
          key: String(b.key || ''), gamemode: b.gamemode || 'survival', difficulty: b.difficulty,
          pvp: !!b.pvp, seed: b.seed, size: Number(b.size) || 4, max: Number(b.size) || 4,
          created: Date.now(), world: null, guestMode: false, players: [],
        };
        svcRooms.set(code, r);
        console.log('[房间] 登记 ' + code + ' · ' + r.name);
        return sendJson(res, 200, { code });
      }
      let m = p.match(/^\/api\/rooms\/([A-Z0-9]{4,12})(\/.*)?$/);
      if (m) {
        const code = m[1], sub = m[2] || '', r = svcRooms.get(code);
        if (sub === '/delete' && req.method === 'POST') {
          if (r) svcRooms.delete(code);
          const lr = p2pRooms.get(code);
          if (lr && lr.host && !lr.host.closed) lr.host.close();
          return sendJson(res, 200, { ok: true });
        }
        if (sub === '/world' && req.method === 'POST') { const raw = await readBody(req); if (r) r.world = raw; return sendJson(res, 200, { ok: true, bytes: raw.length }); }
        if (sub === '/manage' && req.method === 'POST') {
          const b = JSON.parse((await readBody(req)).toString('utf8') || '{}');
          if (r) { if (b.name) r.name = String(b.name).slice(0, 40); if (b.value !== undefined) r.guestMode = !!b.value; }
          return sendJson(res, 200, { guestMode: r ? r.guestMode : false, max: r ? r.max : 4, players: r ? r.players : [] });
        }
        if (sub === '/report' && req.method === 'POST') { await readBody(req); return sendJson(res, 200, { ok: true }); }
        if (!sub && req.method === 'GET') {
          if (!r) return sendJson(res, 404, { error: '房间不存在' });
          return sendJson(res, 200, { code: r.code, name: r.name, owner: r.owner, guestMode: r.guestMode, players: r.players, max: r.max, gamemode: r.gamemode, created: r.created });
        }
      }
      return sendJson(res, 404, { error: '没有这个接口' });
    } catch (e) {
      console.error('[api]', e);
      return sendJson(res, 200, { error: '请求没有处理成功：' + (e.message || e) });
    }
  }

  // ---- 静态文件 ----
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
  let rel = p === '/' ? '/index.html' : p;
  rel = rel.replace(/^\/+/, '');
  // 开发者账号库（含 API Key 与密码哈希）与任何点开头的目录一律禁止静态读取。
  if (/(^|\/)(\.itlzmc|\.git|data|node_modules)(\/|$)/i.test(rel) || /(^|\/)\.[^/]/.test(rel)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('forbidden'); return;
  }
  const full = path.resolve(ROOT, rel);
  if (!full.startsWith(ROOT + path.sep) && full !== path.join(ROOT, 'index.html')) { res.writeHead(403); res.end('forbidden'); return; }
  fs.stat(full, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('404'); return; }
    // 缓存策略（性能关键）：
    //  · 脚本 / 样式表在 index.html 里都带 ?v=版本号，URL 一变就是新资源，所以可以长缓存
    //    （immutable）——浏览器与 Worker 的 importScripts 都直接命中本地缓存，不再重复下载。
    //    以前这里对 .js 用 no-store，导致每次进游戏（含每个 Worker 各一份）都要重新拉约 18 MB。
    //  · 没带版本号的（手工调试、插件平台直接引用）退回 ETag 协商：命中时只回 304，省掉整个响应体。
    //  · HTML 仍然 no-store，保证改完立刻生效。
    const ext = path.extname(full).toLowerCase();
    const baseTag = 'W/"' + st.size.toString(16) + '-' + Math.floor(st.mtimeMs).toString(36);
    const versioned = /[?&]v=/.test(req.url || '');
    const cacheable = ext === '.js' || ext === '.mjs' || ext === '.css' || ext === '.json';
    const text = TEXT_EXT.has(ext);
    const gzOK = text && st.size > 1024 && /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
    const tag = gzOK ? baseTag + '-gz"' : baseTag + '"';
    const cc = (ext === '.html' || ext === '.htm')
      ? 'no-store, must-revalidate'
      : cacheable && versioned
        ? 'public, max-age=2592000, immutable'
        : cacheable
          ? 'public, no-cache'
          : 'public, max-age=31536000, immutable';
    if (cacheable && req.headers['if-none-match'] === tag) {
      res.writeHead(304, { ETag: tag, 'Cache-Control': cc, 'Content-Length': 0 });
      res.end(); return;
    }
    if (gzOK) {
      // 文本资源压缩后约为 1/4（93 个脚本 18.9 MB → 约 4 MB），压缩结果按 mtime 缓存，只算一次
      fs.readFile(full, (e2, buf) => {
        if (e2) { res.writeHead(500); res.end(); return; }
        const g = gzipped(full, st, buf);
        if (!g) {
          res.writeHead(200, { 'Content-Type': mime(full), 'Content-Length': buf.length, 'ETag': baseTag + '"', 'Cache-Control': cc });
          if (req.method === 'HEAD') res.end(); else res.end(buf);
          return;
        }
        res.writeHead(200, {
          'Content-Type': mime(full), 'Content-Length': g.length, 'Content-Encoding': 'gzip',
          'ETag': tag, 'Cache-Control': cc, 'Vary': 'Accept-Encoding',
        });
        if (req.method === 'HEAD') res.end(); else res.end(g);
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': mime(full), 'Content-Length': st.size, 'ETag': tag, 'Cache-Control': cc, 'Accept-Ranges': 'bytes' });
    if (req.method === 'HEAD') { res.end(); return; }
    const s = fs.createReadStream(full);
    s.on('error', () => { try { res.end(); } catch (e) { } });
    s.pipe(res);
  });
});

server.on('upgrade', (req, socket, head) => {
  let u;
  try { u = new URL(req.url, 'http://' + (req.headers.host || 'localhost')); } catch (e) { socket.destroy(); return; }
  const key = req.headers['sec-websocket-key'];
  if (!key || (u.pathname !== '/p2p' && u.pathname !== '/ws' && u.pathname !== '/srv')) { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  const ws = new WS(socket);
  if (head && head.length) ws.onData(head);
  if (u.pathname === '/p2p') handleP2P(ws);
  else if (u.pathname === '/srv') Servers.handleWS(ws);
  else handleVanillaWS(ws);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { try { Servers.shutdown(); } catch (e) { } process.exit(0); });
}

server.listen(PORT, '0.0.0.0', () => {
  console.log('ITLZMC 服务已启动 -> http://localhost:' + PORT + '/');
  console.log('  静态站点 + 房间 REST + /p2p 信令（ICE: ' + (ICE.iceServers.length ? ICE.iceServers.map((s) => s.urls).join(', ') : '局域网直连') + '）');
  console.log('  常驻服务器：/api/servers · /srv（长期运行、房主退出不停服、世界落盘、服务器插件）');
  console.log('  插件市场 API：/api/docs · /api/market · /api/plugins/submit（校验通过才上架）');
});
