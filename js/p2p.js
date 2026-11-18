'use strict';
// ---------------------------------------------------------------------------
// Local rooms (multiplayer/ROOMS_TODO.md 房间政策「本地房间」): the host plays its own single-player world and up to
// 3 friends join it over WebRTC (the room service only does the matchmaking: multiplayer/rooms/p2p.js; with a TURN
// relay configured every connection goes through it, so nobody sees another player's address).
// A guest runs the normal game on a world of the same seed - generation is deterministic - and only what is shared
// travels: the chunks the host's world changed (asked for when the guest needs them), every block change both ways,
// chests / furnaces / other block entities (both ways, the newest wins), the host's mobs, dropped items and orbs
// (snapshots, drawn as mirrors), the players (where they are, what they hold, skins and capes), time, weather, chat,
// markers. A guest keeps its own inventory, crafting, health and hunger; what it hits goes to the host's mob, what
// hits it (the host's mobs pick their target among all players) comes back as damage. Its items dropped land in the
// host's world for anyone to pick up. Guests stay in the overworld; the host doesn't leave it while guests are in.
// The host's world is saved as always; a guest's inventory and place are kept in it for the next visit.
// ---------------------------------------------------------------------------
const P2P_MAX = 4;
const p2pUrl = () => {
  const sc = new URLSearchParams(location.search).get('sharecode');
  return RoomService.base().replace(/^http/, 'ws') + '/p2p' + (sc ? '?sharecode=' + encodeURIComponent(sc) : '');
};
const p2pBlocks = { applying: 0 };
// the record of a chunk <-> bytes (the save format: RLE blocks and metas, waterlogged cells)
function p2pPackChunk(rec) {
  const b = new Uint8Array(rec.b.buffer, rec.b.byteOffset, rec.b.byteLength), m = new Uint8Array(rec.m.buffer, rec.m.byteOffset, rec.m.byteLength);
  const w = rec.w ? new Uint8Array(rec.w.buffer, rec.w.byteOffset, rec.w.byteLength) : new Uint8Array(0);
  const out = new Uint8Array(12 + b.length + m.length + w.length), dv = new DataView(out.buffer);
  dv.setUint32(0, rec.b.length); dv.setUint32(4, rec.m.length); dv.setUint32(8, rec.w ? rec.w.length : 0);
  out.set(b, 12); out.set(m, 12 + b.length); out.set(w, 12 + b.length + m.length);
  return out;
}
function p2pUnpackChunk(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), nb = dv.getUint32(0), nm = dv.getUint32(4), nw = dv.getUint32(8);
  const copy = (o, n, T, sz) => { const a = new T(n); new Uint8Array(a.buffer).set(u8.subarray(o, o + n * sz)); return a; };
  const rec = { b: copy(12, nb, Uint16Array, 2), m: copy(12 + nb * 2, nm, Uint16Array, 2) };
  if (nw) rec.w = copy(12 + nb * 2 + nm * 2, nw, Uint32Array, 4);
  return rec;
}
// binary frames: [u8 kind][u32 request id][payload] (kind 1: a chunk record)
function p2pFrame(kind, id, payload) { const out = new Uint8Array(5 + payload.length); out[0] = kind; new DataView(out.buffer).setUint32(1, id); out.set(payload, 5); return out; }
// what a block entity is worth comparing (JSON without the parts that are only the client's)
const beJson = (be) => { try { return JSON.stringify(be, (k, v) => (k === 'open' || k === 'lid' || k === 'viewers' ? undefined : v)); } catch (e) { return ''; } };
const beKey = (k) => typeof k === 'string' && /^-?\d+,-?\d+,-?\d+$/.test(k);

// ITLZMC：房间数据统一由 /p2p 服务器中转（复用现成的 signal 通道），
// 不再依赖 WebRTC 点对点打洞 —— 手机网络 / 对称 NAT 下也能进房间，
// 不会出现「没连上房主」。二进制区块帧用 base64 过 JSON。
function p2pB64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
function p2pUnB64(b) {
  const s = atob(b), u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u;
}

// ---- the matchmaking socket and one peer connection ----
// relay=true：所有游戏数据经 /p2p 服务器转发（默认）。WebRTC 直连保留为可选实现。
class P2PLink {
  constructor(ice, onMsg, onState, relay = true) {
    this.ice = ice; this.onMsg = onMsg; this.onState = onState; this.pending = [];
    this.relay = relay;
  }
  make(sendSignal) {
    if (this.relay) { this.sendSignal = sendSignal; return null; } // 服务器已经把两边接好
    const pc = this.pc = new RTCPeerConnection({ iceServers: this.ice.iceServers || [], iceTransportPolicy: this.ice.relayOnly ? 'relay' : 'all' });
    pc.onicecandidate = (e) => { if (e.candidate) sendSignal({ cand: e.candidate.toJSON() }); };
    pc.onconnectionstatechange = () => this.onState(pc.connectionState);
    return pc;
  }
  wire(dc) {
    if (this.relay || !dc) return;
    this.dc = dc; dc.binaryType = 'arraybuffer';
    dc.onopen = () => this.onState('open');
    dc.onclose = () => this.onState('closed');
    dc.onmessage = (e) => { try { this.onMsg(typeof e.data === 'string' ? JSON.parse(e.data) : new Uint8Array(e.data)); } catch (err) { console.warn('p2p message', err); } };
  }
  async signal(d, sendSignal) {
    if (this.relay) {
      if (d && Object.prototype.hasOwnProperty.call(d, 'relay')) {
        const x = d.relay;
        this.onMsg(x && x.__bin ? p2pUnB64(x.__bin) : x);
      }
      return;
    }
    const pc = this.pc;
    if (d.sdp) {
      await pc.setRemoteDescription(d.sdp);
      for (const c of this.pending) await pc.addIceCandidate(c).catch(() => { });
      this.pending = [];
      if (d.sdp.type === 'offer') { await pc.setLocalDescription(await pc.createAnswer()); sendSignal({ sdp: pc.localDescription.toJSON() }); }
    } else if (d.cand) { if (pc.remoteDescription) await pc.addIceCandidate(d.cand).catch(() => { }); else this.pending.push(d.cand); }
  }
  send(o) {
    if (this.relay) {
      if (!this.sendSignal) return false;
      this.sendSignal({ relay: o instanceof Uint8Array ? { __bin: p2pB64(o) } : o });
      return true;
    }
    const dc = this.dc; if (!dc || dc.readyState !== 'open') return false; if (dc.bufferedAmount > 8 << 20) return false;
    dc.send(o instanceof Uint8Array ? o : JSON.stringify(o)); return true;
  }
  close() {
    if (this.relay) { this.sendSignal = null; return; }
    try { this.dc && this.dc.close(); } catch (e) { } try { this.pc && this.pc.close(); } catch (e) { }
  }
}

// ---- a guest's stand-in on the host: drawn like another player, hit by the host's mobs (the damage goes to the guest) ----
class GuestAvatar extends NetPlayer {
  constructor(game, peer, x, y, z) {
    super(game, x, y, z, peer.name);
    this.peer = peer; this.remote = true; this.alwaysTick = true; this.persistent = false; this.creative = false; this.spectator = false;
    this.netPos = [x, y, z]; this.lerpN = 0; this.tick = netEntityTick;
    // (what mob code reads of "the player")
    const self = this;
    this.inv = { get held() { return self.heldId != null ? { id: self.heldId, count: 1, dmg: 0 } : null; }, get slots() { return [...new Array(36).fill(null), ...(self.armorItems || [null, null, null, null])]; }, armorPoints: () => 0, armorToughness: () => 0 };
  }
  eye() { return this.sneaking ? 1.27 : 1.62; }
  hurt(a, src) {
    if (this.creative || this.spectator || this.deadGuest) return false;
    const s = src || {}, from = s.attacker || s.entity || s.source;
    this.peer.link.send({ t: 'hurt', dmg: a, kind: s.type || 'mob', from: from && from.pos ? from.pos.map((v) => +v.toFixed(2)) : null, name: from && (from.name || from.type) });
    this.hurtTime = 10;
    return true;
  }
  isSavedEntity() { return false; }
}
(() => {
  // (avatars are never saved with the world, nor counted as mobs)
  const ise = Game.prototype.isSavedEntity;
  Game.prototype.isSavedEntity = function (e) { return e instanceof GuestAvatar || e.p2pMirror ? false : ise.call(this, e); };
})();

// ================================== the host ==================================
class LocalHost {
  constructor(g, code) {
    this.g = g; this.code = code; this.peers = new Map(); this.nextEnt = 1; this.blocks = []; this.beSent = new Map();
    this.state = 'connecting'; this.chunkLists = new Map();
    this.outQueue = []; this.retry = 0; this.stopped = false; this.everHosted = false;
    this.heartbeat = null; this.retryTimer = null; this._res = null; this._rej = null;
  }
  open() {
    return new Promise((res, rej) => { this._res = res; this._rej = rej; this._connect(); });
  }
  _resolveOnce() {
    if (!this._res) return;
    const r = this._res; this._res = null; this._rej = null; r();
  }
  _startHeartbeat() {
    this._stopHeartbeat();
    this.heartbeat = setInterval(() => {
      if (this.ws && this.ws.readyState === 1) { try { this.ws.send(JSON.stringify({ t: 'ping' })); } catch (e) { } }
    }, 20000);
  }
  _stopHeartbeat() { if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = null; } }
  _flush() {
    const q = this.outQueue.splice(0);
    for (const f of q) { try { this.ws.send(JSON.stringify(f)); } catch (e) { } }
  }
  sig(id, data) {
    const f = { t: 'signal', to: id, data };
    if (this.ws && this.ws.readyState === 1) { try { this.ws.send(JSON.stringify(f)); } catch (e) { } }
    else if (this.outQueue.length < 400) this.outQueue.push(f);   // 掉线期间先存着，重连后补发
  }
  _connect() {
    if (this.stopped) return;
    const ws = this.ws = new WebSocket(p2pUrl());
    ws.onopen = () => {
      this.retry = 0;
      ws.send(JSON.stringify({ t: 'host', code: this.code, resume: this.everHosted || undefined,
        token: Account.token || undefined, name: (Account.loggedIn && Account.name) || this.g.settings.netName || 'Host',
        key: RoomService.key(), gamemode: this.g.mode || 'survival', max: P2P_MAX }));
      this._startHeartbeat();
    };
    ws.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch (err) { return; }
      if (m.t === 'hosted') {
        const wasHosted = this.everHosted;
        this.everHosted = true;
        this.ice = m.ice; this.sponsor = m.sponsorText ? { text: m.sponsorText, seconds: m.sponsorSeconds } : null;
        this.state = 'open';
        if (m.resumed && wasHosted) {
          // 以服务端的名册为准：房主掉线期间离开的人立刻清掉，回来的人补建模型，
          // 避免重连后世界里留着已经走掉玩家的一坨空气。
          const ids = new Set((m.peers || []).map((q) => q.id));
          for (const pid of [...this.peers.keys()]) if (!ids.has(pid)) this.dropPeer(pid, null);
          for (const q of (m.peers || [])) if (!this.peers.has(q.id)) this.addPeer(q.id, q.name);
          this._flush();
          clearTimeout(this.retryTimer);
          this.g.ui.message('已重新连上游戏服务器', '#55FF55');
        }
        this._resolveOnce();   // 幂等：首次开房或误判恢复都能正常完成
      }
      else if (m.t === 'error') { this.stopped = true; this.state = 'closed'; if (this._rej) this._rej(new Error(m.reason)); }
      else if (m.t === 'peer') this.addPeer(m.id, m.name, !!m.resumed);
      else if (m.t === 'signal') { const p = this.peers.get(m.from); if (p) p.link.signal(m.data, (d) => this.sig(p.id, d)).catch((err) => console.warn('p2p signal', err)); }
      // away=静默掉线（60s 内可能回来），不带 away 才是真的退出/被踢/超时
      else if (m.t === 'gone') this.dropPeer(m.id, m.away ? null : '离开了');
    };
    ws.onclose = () => {
      this._stopHeartbeat();
      if (this.stopped || this.state === 'closed') return;
      if (!this.everHosted) {   // 第一次就握手失败：正常报错，不无限重试
        this.stopped = true; this.state = 'closed';
        if (this._rej) this._rej(new Error('连不上游戏服务器'));
        return;
      }
      this.state = 'reconnecting';
      this.g.ui.message('正在重新连接游戏服务器…', '#FFCC66');
      this._scheduleRetry();
    };
  }
  _scheduleRetry() {
    if (this.stopped) return;
    const delays = [700, 1500, 3000, 5000, 8000];
    const d = delays[Math.min(this.retry++, delays.length - 1)];
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this._connect(), d);
  }
  async addPeer(id, name, resumed) {
    // 半开连接 / 掉线重连时服务端会再发一次 peer：先把旧模型撤掉，绝不出现两个一样的玩家。
    if (this.peers.has(id)) this.dropPeer(id, null);
    const p = { id, name, avatar: null, state: null, look: null, joined: false, resumed: !!resumed };
    p.link = new P2PLink(this.ice, (m) => this.onMsg(p, m), (st) => {
      if (st === 'open') this.welcome(p);
      if ((st === 'failed' || st === 'closed' || st === 'disconnected') && this.peers.get(id) === p) this.dropPeer(id, st === 'failed' ? '没连上（网络不通）' : '离开了');
    }, true);
    // 服务器中转：不建 RTCPeerConnection，也就没有打洞失败这一说。
    p.link.make((d) => this.sig(id, d));
    this.peers.set(id, p);
    if (resumed) {
      // 只是掉线回来：不重发整个世界（客人世界不用重载），只重建模型 + 补一帧实体快照。
      const sp = this.g.player ? this.g.player.pos : [0, 80, 0];
      this.spawnAvatar(p, [sp[0] + 3, sp[1], sp[2] + 3], false);
    } else {
      // 等客人就绪（基站的 joined 可能比 peer 晚到）再发世界数据。
      setTimeout(() => { if (this.peers.get(id) === p && !p.joined) this.welcome(p); }, 300);
    }
  }
  spawnAvatar(p, cp, announce) {
    const g = this.g;
    p.avatar = new GuestAvatar(g, p, cp[0], cp[1], cp[2]);
    p.avatar.netPos = [...cp]; p.avatar.prev = [...cp]; p.avatar.lerpN = 0;
    g.entities.push(p.avatar);
    p.joined = true;
    // 立刻补一帧实体快照，客人进房间 / 重连当下就能看到所有人
    this.guardSnapshot && this.guardSnapshot(p);
    if (announce) {
      g.ui.message(`${p.name} 加入了游戏`, '#FFFF55');
      this.toAll({ t: 'chat', sys: true, text: `${p.name} 加入了游戏` }, p);
      Telemetry.count && Telemetry.count('p2p_guest');
    }
  }
  dropPeer(id, why) {
    const p = this.peers.get(id); if (!p) return;
    const silent = why == null;      // 静默 = 只是暂时掉线，服务端还留着槽位
    this.peers.delete(id);
    p.link.close();
    if (p.avatar) {
      p.avatar.dead = true;
      const g = this.g, i = g.entities.indexOf(p.avatar);
      if (i >= 0) g.entities.splice(i, 1);   // 立刻从世界移除，别留一坨静止的空气
      p.avatar = null;
    }
    if (p.joined && !silent) { this.g.ui.message(`${p.name} ${why}`, '#FFFF55'); this.toAll({ t: 'chat', sys: true, text: `${p.name} ${why}` }); }
    // 静默掉线不能发 leave：服务端要保留槽位，等 60s 内重连。
    if (!silent && this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify({ t: 'leave', id }));
  }
  toAll(o, except) { for (const p of this.peers.values()) if (p.joined && p !== except) p.link.send(o); }
  // 单个快照出错（皮肤/披风查询偶发失败）不能让整个 tick 停摆，更不能让所有人都消失
  guardSnapshot(p) { try { p.link.send(this.snapshot(p)); } catch (e) { console.warn('[ITLZMC] 快照跳过', e); } }
  // the first message: the world (seed, settings, the host's changed chunks and its block entities), the guest's own
  // last visit, where to appear
  welcome(p) {
    const g = this.g, w = g.world, m = g.worldMeta;
    const keys = new Set(w.savedIndex || []);
    for (const ch of w.chunks.values()) if (ch.modified) keys.add(ckey(ch.cx, ch.cz));
    let saved = (m.guests || {})[p.name.toLowerCase()] || null;
    // (left while dead: back at the spawn point, alive)
    if (saved && !(saved.health > 0)) saved = { ...saved, health: 20, food: 20, sat: 5, pos: [...(g.player.spawn || m.spawn || g.player.pos)] };
    const sp = g.player.pos;
    const bes = [...g.blockEntities].filter(([k]) => beKey(k)).map(([k, be]) => [k, JSON.parse(beJson(be) || 'null')]), parts = [];
    for (let i = 0, cur = [], n = 0; i <= bes.length; i++) {
      if (i === bes.length || n > 150000) { if (cur.length) parts.push({ t: 'wbes', list: cur }); cur = []; n = 0; if (i === bes.length) break; }
      cur.push(bes[i]); n += JSON.stringify(bes[i]).length;
    }
    const kl = [...keys];
    for (let i = 0; i < kl.length; i += 15000) parts.push({ t: 'wkeys', list: kl.slice(i, i + 15000) });
    for (const q of parts) p.link.send(q);
    p.link.send({
      t: 'welcome', name: m.name, seed: m.seed, gen: m.gen, mode: g.mode === 'spectator' ? 'survival' : g.mode, difficulty: g.difficulty, hardcore: !!g.hardcore,
      time: g.worldTime, weather: g.weather, rain: g.rainTarget, spawn: g.player.spawn || m.spawn, near: [sp[0], sp[1], sp[2]], host: (Account.loggedIn && Account.name) || 'Host',
      saved, sponsor: this.sponsor, players: [...this.peers.values()].filter((q) => q.joined).map((q) => q.name),
    });
    // 客人替身不能生成在房主身上（第一人称会完全看不见），优先用已收到的客人坐标。
    const cp = (p.state && Array.isArray(p.state.pos)) ? p.state.pos : [sp[0] + 3, sp[1], sp[2] + 3];
    this.spawnAvatar(p, cp, true);
  }
  onMsg(p, m) {
    const g = this.g;
    if (m instanceof Uint8Array) return;
    switch (m.t) {
      case 'state': {
        p.state = m; const a = p.avatar; if (!a || !Array.isArray(m.pos)) return;
        a.netPos = m.pos.slice(0, 3); a.lerpN = 2; a.netYaw = m.yaw; a.netHead = m.yaw; a.netPitch = m.pitch; a.sneaking = !!m.sneak;
        if (m.swing) a.swingT = 6; a.heldId = m.held ?? null; a.armorItems = (m.armor || []).map((id) => (id == null ? null : { id, count: 1 }));
        a.creative = m.mode === 'creative'; a.spectator = m.mode === 'spectator'; a.deadGuest = !!m.dead; a.flying = !!m.flying; a.netSwim = !!m.swim;
        if (m.look) a.look = m.look;
        break;
      }
      case 'chunk': {
        // a chunk the host's world changed: from memory (loaded) or the save
        const w = g.world, k = ckey(m.cx, m.cz), ch = w.chunks.get(k);
        const reply = (rec) => p.link.send(p2pFrame(1, m.id, rec ? p2pPackChunk(rec) : new Uint8Array(0)));
        if (ch && ch.modified) reply(encodeChunk(ch));
        else if (w.savedChunks && w.savedChunks.has(k)) reply(w.savedChunks.get(k));
        else DB.getChunk(w.savedStore, m.cx, m.cz).then((r) => reply(r || (ch ? encodeChunk(ch) : null)), () => reply(null));
        break;
      }
      case 'b': for (const [x, y, z, id, meta, wl] of m.list || []) { if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(z) || !BLOCKS[id]) continue; p2pBlocks.from = p; g.world.setBlock(x, y, z, id, meta | 0, 3); if (wl !== undefined) g.world.setWaterlogged(x, y, z, !!wl); p2pBlocks.from = null; } break;
      case 'be': if (beKey(m.k) && m.data && typeof m.data === 'object') { const be = g.blockEntities.get(m.k); if (be) Object.assign(be, m.data); else g.blockEntities.set(m.k, m.data); this.beSent.set(m.k, beJson(g.blockEntities.get(m.k))); this.toAll({ t: 'be', k: m.k, data: m.data }, p); } break;
      case 'drop': if (m.stack && ITEMS[m.stack.id] && Array.isArray(m.pos)) { const e = g.dropItem(m.pos[0], m.pos[1], m.pos[2], fixSavedStack({ ...m.stack }), m.vel); if (e) e.pickup = 40; } break;
      case 'pickup': {
        const e = g.entities.find((q) => q.p2pId === m.id && !q.dead), a = p.avatar;
        // (an item just dropped waits its pickup delay, as for the host)
        if (!e || !a || (e.pickup > 0) || Math.hypot(e.pos[0] - a.pos[0], e.pos[1] - a.pos[1], e.pos[2] - a.pos[2]) > 4) break;
        if (e instanceof ItemEntity && e.stack) { p.link.send({ t: 'give', stack: e.stack }); e.dead = true; Sound.ev && Sound.ev('entity.item.pickup', e.pos, 0.2, 1.5); }
        else if (e instanceof ExperienceOrb) { p.link.send({ t: 'xp', n: e.value || e.v || 1 }); e.dead = true; }
        break;
      }
      case 'hit': {
        const e = g.entities.find((q) => q.p2pId === m.id && !q.dead);
        if (e && e.hurt && typeof m.dmg === 'number' && m.dmg > 0 && m.dmg < 100) e.hurt(m.dmg, { type: 'player', attacker: p.avatar, player: true, kb: m.kb });
        break;
      }
      case 'chat': { const t = String(m.text || '').slice(0, 256); if (!t) break; g.ui.message(`<${p.name}> ${t}`); this.toAll({ t: 'chat', name: p.name, text: t }, p); break; }
      case 'mark': if (Array.isArray(m.pos)) { Marks.add(p.name, m.pos.map((v) => v | 0)); g.ui.message(`${p.name} 标记了一个位置`, '#FFD24A'); this.toAll({ t: 'mark', name: p.name, pos: m.pos }, p); } break;
      case 'pstate': { const M = g.worldMeta; if (M && m.data) { (M.guests || (M.guests = {}))[p.name.toLowerCase()] = m.data; } break; }
    }
  }
  // every tick: block changes out; every other tick: what each guest sees; every half second: block entities that changed
  tick() {
    const g = this.g;
    if (!this.peers.size) { this.blocks.length = 0; return; }
    if (this.blocks.length) {
      const list = this.blocks.splice(0);
      this.toAll({ t: 'B', list });
    }
    for (const p of this.peers.values()) if (p.joined && p.avatar) this.guardSnapshot(p);
    if (g.tickCount % 10 === 0) {
      for (const [k, be] of g.blockEntities) {
        if (!beKey(k)) continue;
        const j = beJson(be);
        if (this.beSent.get(k) !== j) { this.beSent.set(k, j); this.toAll({ t: 'be', k, data: JSON.parse(j) }); }
      }
    }
    if (g.tickCount % 40 === 0) this.toAll({ t: 'env', time: g.worldTime, weather: g.weather, rain: g.rainTarget, difficulty: g.difficulty });
  }
  // the entities near a guest: mobs, items, orbs, and the other players
  snapshot(p) {
    const g = this.g, a = p.avatar, R2 = 64 * 64, ents = [];
    for (const e of g.entities) {
      if (e.dead || e === a) continue;
      // 玩家永远同步（走远了也互相看得见），只有怪物/掉落物按距离裁剪
      if (!(e instanceof GuestAvatar)) {
        const dx = e.pos[0] - a.pos[0], dz = e.pos[2] - a.pos[2];
        if (dx * dx + dz * dz > R2) continue;
      }
      if (!e.p2pId) e.p2pId = this.nextEnt++;
      const r = [e.p2pId, 0, +e.pos[0].toFixed(2), +e.pos[1].toFixed(2), +e.pos[2].toFixed(2), +(e.yaw || 0).toFixed(2)];
      if (e instanceof GuestAvatar) { r[1] = 'player'; r.push({ name: e.name, look: e.look || null, held: e.heldId ?? null, armor: (e.armorItems || []).map((s) => s && s.id), sneak: !!e.sneaking, swing: e.swingT > 0, pitch: e.netPitch || 0, swim: !!e.netSwim }); }
      else if (e instanceof ItemEntity) { if (!e.stack) continue; r[1] = 'item'; r.push({ id: e.stack.id, n: e.stack.count }); }
      else if (e instanceof ExperienceOrb) { r[1] = 'xp'; r.push({ v: e.value || e.v || 1 }); }
      else if (e instanceof Mob && e.type) {
        r[1] = e.type;
        r.push({ b: +(e.bodyYaw ?? e.yaw ?? 0).toFixed(2), h: +(e.headYaw || 0).toFixed(2), p: +(e.pitch || 0).toFixed(2), ls: +(e.limbSwing || 0).toFixed(2), la: +(e.limbAmt || 0).toFixed(2),
          baby: e.baby ? 1 : 0, sh: e.sheared ? 1 : 0, wc: e.woolColor || 0, sz: typeof e.size === 'number' ? e.size : undefined, fuse: e.fuse, ht: e.hurtTime || 0, dt: e.deathTime || 0, sw: e.swingT || 0, held: e.heldId ?? (e.hand && e.hand.id), name: e.customName });
      } else continue;
      ents.push(r);
    }
    // the host itself, as a player
    const hp = g.player;
    let myLook = null;
    try { myLook = Skins.mine(g); } catch (e) { }
    ents.push([-1, 'player', +hp.pos[0].toFixed(2), +hp.pos[1].toFixed(2), +hp.pos[2].toFixed(2), +hp.yaw.toFixed(2), { name: (Account.loggedIn && Account.name) || 'Host', look: myLook, held: hp.inv.held ? hp.inv.held.id : null, armor: hp.inv.slots.slice(36, 40).map((s) => s && s.id), sneak: !!hp.sneaking, swing: hp.swingT > 0, pitch: hp.pitch, swim: !!hp.swimming }]);
    return { t: 'E', list: ents };
  }
  // a block changed in the host's world (game play, not generation): to the guests, and the chunk marked changed
  onBlock(x, y, z, id, meta, wl) { if (this.peers.size) this.blocks.push([x, y, z, id, meta, wl]); }
  kick(id) { const p = this.peers.get(id); if (!p) return; p.link.send({ t: 'kicked', reason: '房主请你离开了房间' }); setTimeout(() => this.dropPeer(id, '被房主请出了房间'), 300); }
  close() {
    this.stopped = true; this.state = 'closed';
    clearTimeout(this.retryTimer); this._stopHeartbeat();
    for (const p of this.peers.values()) {
      p.link.send({ t: 'closed' }); p.link.close();
      if (p.avatar) { p.avatar.dead = true; const i = this.g.entities.indexOf(p.avatar); if (i >= 0) this.g.entities.splice(i, 1); }
    }
    this.peers.clear();
    qiumcHideParty();
    // 明确告诉服务端「房间关了」：立刻解散，不留 90s 僵尸房间。
    if (this.ws && this.ws.readyState === 1) { try { this.ws.send(JSON.stringify({ t: 'close' })); } catch (e) { } }
    try { this.ws && this.ws.close(); } catch (e) { }
    if (this.g.p2pHost === this) this.g.p2pHost = null;
  }
}

// ================================== the guest ==================================
class LocalGuest {
  constructor(g, code, name) {
    this.g = g; this.code = code; this.name = name; this.reqs = new Map(); this.nextReq = 1;
    this.mirrors = new Map(); this.picks = new Map(); this.beSnap = new Map(); this.outBlocks = [];
    this.state = 'connecting'; this.resumeId = null; this.outQueue = []; this.retry = 0;
    this.heartbeat = null; this.retryTimer = null; this.lostTimer = null; this.connectTimer = null;
  }
  _sig(d) {
    const f = { t: 'signal', data: d };
    if (this.ws && this.ws.readyState === 1) { try { this.ws.send(JSON.stringify(f)); } catch (e) { } }
    else if (this.outQueue.length < 400) this.outQueue.push(f);   // 掉线期间先存着
  }
  _flush() {
    const q = this.outQueue.splice(0);
    for (const f of q) { try { this.ws.send(JSON.stringify(f)); } catch (e) { } }
  }
  _startHeartbeat() {
    this._stopHeartbeat();
    this.heartbeat = setInterval(() => {
      if (this.ws && this.ws.readyState === 1) { try { this.ws.send(JSON.stringify({ t: 'ping' })); } catch (e) { } }
    }, 20000);
  }
  _stopHeartbeat() { if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = null; } }
  join() {
    return new Promise((res, rej) => { this.res = res; this.rej = rej; this._connect(); });
  }
  _connect() {
    if (this.state === 'left') return;
    const ws = this.ws = new WebSocket(p2pUrl());
    ws.onopen = () => {
      this.retry = 0;
      ws.send(JSON.stringify({ t: 'join', code: this.code, resume: this.resumeId || undefined,
        token: Account.token || undefined, name: this.name }));
      this._startHeartbeat();
    };
    ws.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch (err) { return; }
      if (m.t === 'joined') {
        clearTimeout(this.connectTimer);
        this.hostName = m.host;
        if (m.id) this.resumeId = m.id;
        if (m.resumed && this.link) {   // 重连成功：房间、世界不用重建，但镜像要重建
          this.state = 'joined';
          clearTimeout(this.lostTimer); this.lostTimer = null;
          for (const e of this.mirrors.values()) e.dead = true;
          this.mirrors.clear();
          this._flush();
          this.sendState(true);
          this.g.ui.message('已重新连上游戏服务器', '#55FF55');
          return;
        }
        this.link = new P2PLink(m.ice, (x) => this.onMsg(x), (st) => {
          if ((st === 'failed' || st === 'closed' || st === 'disconnected') && this.state !== 'left') this.lost('和房主的连接断开了');
        }, true);
        this.link.make((d) => this._sig(d));
        for (const d of this.early || []) this.link.signal(d, () => { });
        this.early = [];
        this.connectTimer = setTimeout(() => { if (this.state === 'connecting') this.lost('连接超时：房主没有回应，请让房主重新开房间'); }, 30000);
      } else if (m.t === 'signal') {
        const f = (d) => this._sig(d);
        if (!this.link) (this.early || (this.early = [])).push(m.data);
        else this.link.signal(m.data, f).catch((err) => console.warn('p2p', err));
      }
      else if (m.t === 'error') { this.state = 'left'; this.rej && this.rej(new Error(m.reason)); }
      else if (m.t === 'closed') this.lost('房主关闭了房间');
    };
    ws.onerror = () => {
      if (this.state === 'connecting' && !this.resumeId) { this.state = 'left'; this.rej && this.rej(new Error('连不上游戏服务器')); }
    };
    ws.onclose = () => {
      this._stopHeartbeat();
      clearTimeout(this.connectTimer);
      if (this.state === 'left') return;
      if (this.state === 'connecting' && !this.resumeId) {
        this.state = 'left'; this.rej && this.rej(new Error('连不上游戏服务器')); return;
      }
      this.state = 'reconnecting';
      if (!this.lostTimer) {
        this.g.ui.message('正在重新连接游戏服务器…', '#FFCC66');
        this.lostTimer = setTimeout(() => this.lost('连接中断，没能重新连上房主'), 90000);
      }
      this._scheduleRetry();
    };
  }
  _scheduleRetry() {
    if (this.state === 'left') return;
    const delays = [700, 1500, 3000, 5000, 8000];
    const d = delays[Math.min(this.retry++, delays.length - 1)];
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this._connect(), d);
  }
  clearMirrors() {
    // 回主界面前把房间里的其他玩家模型全部撤掉，标题画面不该残留任何房间实体。
    const g = this.g;
    for (const e of this.mirrors.values()) { e.dead = true; const i = g.entities.indexOf(e); if (i >= 0) g.entities.splice(i, 1); }
    this.mirrors.clear();
  }
  lost(why) {
    if (this.state === 'left') return;
    const was = this.state; this.state = 'left';
    clearTimeout(this.retryTimer); clearTimeout(this.lostTimer); clearTimeout(this.connectTimer);
    this._stopHeartbeat();
    // 被踢 / 房主关房时也明确告知服务端，房间名册立刻删掉我。
    if (this.ws && this.ws.readyState === 1) { try { this.ws.send(JSON.stringify({ t: 'leave' })); } catch (e) { } }
    qiumcHideParty();
    this.clearMirrors();
    try { this.link && this.link.close(); } catch (e) { } try { this.ws && this.ws.close(); } catch (e) { }
    const g = this.g;
    if (was === 'connecting') { this.rej && this.rej(new Error(why)); return; }
    if (g.p2pGuest === this) { g.p2pGuest = null; g.worldMeta = null; g.startTitle(); g.ui.open(new ConfirmScreen(g, '离开了本地房间', why, '返回标题画面', () => g.ui.open(new TitleScreen(g)))); }
  }
  leave() {
    if (this.state === 'left') return;
    this.sendState(true);   // 最后一次把背包 / 坐标存回房主的世界
    // 明确告诉服务端「我主动走了」：房主会立刻把我的模型删掉，不再留一坨空气。
    if (this.ws && this.ws.readyState === 1) { try { this.ws.send(JSON.stringify({ t: 'leave' })); } catch (e) { } }
    this.state = 'left';
    clearTimeout(this.retryTimer); clearTimeout(this.lostTimer); clearTimeout(this.connectTimer);
    this._stopHeartbeat();
    qiumcHideParty();
    this.clearMirrors();
    setTimeout(() => { try { this.link && this.link.close(); } catch (e) { } try { this.ws && this.ws.close(); } catch (e) { } }, 300);
  }
  send(o) { return this.link && this.link.send(o); }
  // the host's world, as a world of this game: its store id makes the chunk reads go to the host
  async onWelcome(m) {
    const g = this.g, id = 'p2p~' + this.code;
    this.meta = {
      id, name: m.name + '（本地房间）', seed: String(m.seed), gen: m.gen || 2, mode: m.mode, flat: false, difficulty: m.difficulty, hardcore: m.hardcore, cheats: false,
      time: m.time, weather: m.weather, rainTarget: m.rain, spawn: m.spawn, tutorial: -1, dims: { overworld: { blockEntities: Object.fromEntries(this.wbes || []), mobs: [] } },
      player: m.saved || null, created: Date.now(), lastPlayed: Date.now(),
    };
    this.keys = new Set(this.wkeys || []);
    for (const [k, be] of this.wbes || []) this.beSnap.set(k, beJson(be));
    g.p2pGuest = this; this.state = 'joined';
    await g.loadWorld(id);
    // a first visit: next to the host
    if (!m.saved && m.near) { const p = g.player; p.pos = [m.near[0] + 3, m.near[1] + 0.5, m.near[2] + 3]; p.prev = [...p.pos]; p.spawn = m.spawn; }
    if (m.sponsor && m.sponsor.text) g.pendingPin = { text: String(m.sponsor.text).slice(0, 80), ms: clamp(+m.sponsor.seconds || 30, 0, 300) * 1000 };
    this.sendState(true);
    g.ui.message(`已进入 ${m.host} 的本地房间` + (m.players && m.players.length ? `（还有 ${m.players.join('、')}）` : ''), '#55FF55');
    this.res && this.res();
  }
  onMsg(m) {
    const g = this.g;
    if (m instanceof Uint8Array) {
      if (m[0] === 1) { const id = new DataView(m.buffer, m.byteOffset).getUint32(1), r = this.reqs.get(id); if (r) { this.reqs.delete(id); r(m.length > 5 ? p2pUnpackChunk(m.subarray(5)) : null); } }
      return;
    }
    switch (m.t) {
      case 'wkeys': (this.wkeys || (this.wkeys = [])).push(...m.list); break;
      case 'wbes': (this.wbes || (this.wbes = [])).push(...m.list); break;
      case 'welcome': this.onWelcome(m).catch((e) => this.lost('进入失败：' + e.message)); break;
      case 'B': {
        const w = g.world; if (!w || g.worldMeta !== this.meta) break;
        p2pBlocks.applying++;
        try {
          for (const [x, y, z, id, meta, wl] of m.list) {
            const k = ckey(x >> 4, z >> 4);
            this.keys.add(k); if (w.savedIndex) w.savedIndex.add(k);
            if (w.chunks.has(k)) { w.setBlock(x, y, z, id, meta, 3); if (wl !== undefined) w.setWaterlogged(x, y, z, !!wl); }
            else if (w.savedChunks) w.savedChunks.delete(k); // (read again from the host when it loads)
          }
        } finally { p2pBlocks.applying--; }
        break;
      }
      case 'be': if (beKey(m.k) && m.data) { const be = g.blockEntities.get(m.k); if (be) { for (const k in m.data) be[k] = m.data[k]; } else g.blockEntities.set(m.k, m.data); this.beSnap.set(m.k, beJson(g.blockEntities.get(m.k))); } break;
      case 'E': this.onEntities(m.list); break;
      case 'env': g.worldTime = m.time; g.weather = m.weather; g.rainTarget = m.rain; g.difficulty = m.difficulty; break;
      case 'hurt': {
        const p = g.player; if (!p || p.deathTime > 0) break;
        const from = m.from ? { pos: m.from, type: 'mob', name: m.name } : null;
        try { p.hurt(m.dmg, { type: m.kind === 'player' ? 'player' : m.kind || 'mob', attacker: from, entity: from }); } catch (e) { p.hurt(m.dmg, { type: 'generic' }); }
        break;
      }
      case 'give': { const st = fixSavedStack({ ...m.stack }); const left = g.player.inv.add(st); Sound.ev && Sound.ev('entity.item.pickup', null, 0.2, 1.5); if (left && left.count) this.send({ t: 'drop', stack: left, pos: g.player.pos.slice(0, 3) }); break; }
      case 'xp': g.addXp(m.n | 0); Sound.ev && Sound.ev('entity.experience_orb.pickup', null, 0.1, 1); break;
      case 'chat': g.ui.message(m.sys ? m.text : `<${m.name}> ${m.text}`, m.sys ? '#FFFF55' : '#FFFFFF'); break;
      case 'mark': Marks.add(String(m.name).slice(0, 16), (m.pos || []).map((v) => v | 0)); g.ui.message(`${m.name} 标记了一个位置`, '#FFD24A'); break;
      case 'kicked': this.lost(m.reason || '房主请你离开了房间'); break;
      case 'closed': this.lost('房主关闭了房间'); break;
    }
  }
  // the host's entities, as mirrors: made, moved, removed
  onEntities(list) {
    const g = this.g, seen = new Set();
    for (const r of list) {
      const [id, type, x, y, z, yaw, d] = r;
      seen.add(id);
      let e = this.mirrors.get(id);
      if (e && e.mirrorType !== type) { e.dead = true; e = null; }
      if (!e) {
        if (type === 'player') e = new NetPlayer(g, x, y, z, d.name);
        else if (type === 'item') { e = new ItemEntity(g, x, y, z, { id: d.id, count: d.n || 1 }, [0, 0, 0]); e.tick = netItemTick; e.pickup = 1e9; }
        else if (type === 'xp') { e = new ExperienceOrb(g, x, y, z, d.v || 1); e.tick = netItemTick; }
        else { try { e = createMob(g, type, x, y, z); } catch (err) { e = null; } if (!e) continue; }
        e.p2pMirror = true; e.p2pId = id; e.mirrorType = type; e.remote = true; e.alwaysTick = true; e.persistent = false;
        if (type !== 'item' && type !== 'xp') e.tick = netEntityTick;
        e.netPos = [x, y, z]; e.lerpN = 0; e.netYaw = e.yaw = e.bodyYaw = e.prevBodyYaw = yaw;
        // hitting a mirror hits the host's mob
        if (type !== 'item' && type !== 'xp') e.hurt = (dmg, src) => { if (type === 'player') return false; const p = g.player, k = [e.pos[0] - p.pos[0], e.pos[2] - p.pos[2]]; this.send({ t: 'hit', id, dmg, kb: k }); e.hurtTime = 10; return true; };
        g.entities.push(e); this.mirrors.set(id, e);
      }
      e.netPos = [x, y, z]; e.lerpN = 3; e.netYaw = yaw;
      if (type === 'player') { e.name = d.name; e.look = d.look; e.heldId = d.held; e.armorItems = (d.armor || []).map((i) => (i == null ? null : { id: i, count: 1 })); e.sneaking = d.sneak; if (d.swing && !(e.swingT > 0)) e.swingT = 6; e.netPitch = d.pitch; e.netHead = yaw; e.netSwim = d.swim; }
      else if (d && type !== 'item' && type !== 'xp') {
        e.netHead = yaw + (d.h || 0); e.netPitch = d.p; e.limbSwing = d.ls; e.limbAmt = d.la; e.prevLimb = d.ls;
        if (d.baby) e.baby = true; e.sheared = !!d.sh; e.woolColor = d.wc; if (d.sz !== undefined) e.size = d.sz; if (d.fuse !== undefined) e.fuse = d.fuse;
        if (d.ht > (e.hurtTime || 0)) e.hurtTime = d.ht; if (d.dt && !e.deathTime) e.deathTime = 1; if (d.sw) e.swingT = d.sw; e.heldId = d.held ?? null; if (d.name) e.customName = d.name;
      } else if (type === 'item' && e.stack && (e.stack.id !== d.id || e.stack.count !== d.n)) e.stack = { id: d.id, count: d.n, dmg: 0 };
    }
    for (const [id, e] of this.mirrors) if (!seen.has(id)) { if (!(e.deathTime > 0)) e.dead = true; this.mirrors.delete(id); }
  }
  // this player, ten times a second
  sendState(final) {
    const g = this.g, p = g.player; if (!p) return;
    this.send({ t: 'state', pos: p.pos.map((v) => +v.toFixed(2)), yaw: +p.yaw.toFixed(3), pitch: +p.pitch.toFixed(3), sneak: !!p.sneaking, swing: p.swingT > 0, held: p.inv.held ? p.inv.held.id : null,
      armor: p.inv.slots.slice(36, 40).map((s) => s && s.id), mode: g.mode, dead: p.deathTime > 0, flying: !!p.flying, swim: !!p.swimming, look: Skins.mine(g) });
    if (final || g.tickCount % 200 === 0) this.send({ t: 'pstate', data: { pos: [...p.pos], yaw: p.yaw, pitch: p.pitch, health: p.health, food: p.food, sat: p.saturation, xp: p.xp, inv: p.inv.slots, sel: p.inv.sel, flying: p.flying, effects: [] } });
  }
  // the guest's own tick: the player and the mirrors; the host simulates the world
  tick() {
    const g = this.g, p = g.player;
    this.sendState();
    for (const e of g.entities) if (!e.dead) g.tickEntity(e);
    g.entities = g.entities.filter((e) => !e.dead);
    g.guard('particles', () => g.particles.tick());
    if (g.dim === 'overworld' && g.weather > 0.2 && g.tickCount % 2 === 0) g.rainParticles();
    // items and orbs within reach: asked for (the host gives them if they are still there)
    for (const [id, e] of this.mirrors) {
      if (!(e instanceof ItemEntity || e instanceof ExperienceOrb) || p.deathTime > 0) continue;
      if (Math.hypot(e.pos[0] - p.pos[0], e.pos[1] + 0.25 - (p.pos[1] + 0.9), e.pos[2] - p.pos[2]) > 1.6) continue;
      const t = this.picks.get(id) || 0; if (performance.now() - t < 600) continue;
      this.picks.set(id, performance.now()); this.send({ t: 'pickup', id });
    }
    if (this.outBlocks.length) this.send({ t: 'b', list: this.outBlocks.splice(0) });
    // block entities this player changed (a chest it put things in): to the host
    if (g.tickCount % 10 === 0) for (const [k, be] of g.blockEntities) {
      if (!beKey(k)) continue;
      const j = beJson(be);
      if (this.beSnap.get(k) !== j) { this.beSnap.set(k, j); this.send({ t: 'be', k, data: JSON.parse(j) }); }
    }
  }
  // a chunk the host's world changed: read from the host
  requestChunk(cx, cz) {
    return new Promise((res) => {
      const id = this.nextReq++;
      this.reqs.set(id, res);
      if (!this.send({ t: 'chunk', id, cx, cz })) { this.reqs.delete(id); res(null); }
      setTimeout(() => { if (this.reqs.has(id)) { this.reqs.delete(id); res(null); } }, 20000);
    });
  }
}

// ---- the game around them ----
(() => {
  // the guest's world lives in the host: its store reads go there, nothing of it is saved here
  const isP2P = (id) => typeof id === 'string' && id.startsWith('p2p~');
  const gw = DB.getWorld.bind(DB), pw = DB.putWorld.bind(DB), pc = DB.putChunks.bind(DB), gc = DB.getChunk.bind(DB), ck = DB.chunkKeys.bind(DB);
  DB.getWorld = (id) => (isP2P(id) ? Promise.resolve(game.p2pGuest && game.p2pGuest.meta) : gw(id));
  DB.putWorld = (w) => (isP2P(w && w.id) ? Promise.resolve() : pw(w));
  DB.putChunks = (id, list) => (isP2P(id) ? Promise.resolve() : pc(id, list));
  DB.chunkKeys = (id) => { if (!isP2P(id)) return ck(id); const G = game.p2pGuest, out = new Set(); if (G && !id.includes('~nether') && !/~end$/.test(id.replace(/^p2p~/, ''))) for (const k of G.keys) out.add(k); return Promise.resolve(out); };
  DB.getChunk = (id, cx, cz) => (isP2P(id) ? (game.p2pGuest ? game.p2pGuest.requestChunk(cx, cz) : Promise.resolve(undefined)) : gc(id, cx, cz));
  // block changes: the host's go to the guests; the guest's to the host (unless they came from there)
  const sb = World.prototype.setBlock, sm = World.prototype.setMeta, swl = World.prototype.setWaterlogged;
  const relay = (w, x, y, z) => {
    const g = typeof game !== 'undefined' && game; if (!g || g.world !== w) return;
    const id = w.getBlock(x, y, z), meta = w.getMeta(x, y, z), wl = w.isWaterlogged(x, y, z) ? 1 : 0;
    if (g.p2pHost) g.p2pHost.onBlock(x, y, z, id, meta, wl);
    else if (g.p2pGuest && !p2pBlocks.applying && g.p2pGuest.state === 'joined') g.p2pGuest.outBlocks.push([x, y, z, id, meta, wl]);
  };
  World.prototype.setBlock = function (x, y, z, ...a) { const r = sb.call(this, x, y, z, ...a); if (r !== false) relay(this, x, y, z); return r; };
  World.prototype.setMeta = function (x, y, z, meta) { const before = this.getMeta(x, y, z); const r = sm.call(this, x, y, z, meta); if (before !== meta) relay(this, x, y, z); return r; };
  World.prototype.setWaterlogged = function (x, y, z, v) { const r = swl.call(this, x, y, z, v); relay(this, x, y, z); return r; };
  // a guest's dropped items land in the host's world (anyone may pick them up)
  const di = Game.prototype.dropItem;
  Game.prototype.dropItem = function (x, y, z, stack, vel) {
    if (this.p2pGuest && this.p2pGuest.state === 'joined' && stack && stack.count > 0) { this.p2pGuest.send({ t: 'drop', stack: { ...stack }, pos: [x, y, z], vel }); return null; }
    return di.call(this, x, y, z, stack, vel);
  };
  // the host's hostile mobs: each one's tick sees its nearest player as "the player" (who it chases, hits, and whose
  // distance keeps it from despawning)
  const te = Game.prototype.tickEntity;
  Game.prototype.tickEntity = function (e) {
    const H = this.p2pHost;
    if (!H || !H.peers.size || !(e instanceof Mob) || e instanceof GuestAvatar || !(e.T && e.T.hostile)) return te.call(this, e);
    let best = this.player, bd = e.distTo(this.player);
    for (const p of H.peers.values()) { const a = p.avatar; if (a && !a.dead && !a.deadGuest && !a.creative && !a.spectator) { const d = e.distTo(a); if (d < bd) { bd = d; best = a; } } }
    if (best === this.player) return te.call(this, e);
    const hp = this.player; this.player = best;
    try { return te.call(this, e); } finally { this.player = hp; }
  };
  // while a room is open nothing pauses the world (the others go on playing)
  const tick = Game.prototype.tick;
  Game.prototype.tick = function () {
    const sc = this.ui && this.ui.screen, hold = sc && sc.pauses && (this.p2pHost || this.p2pGuest);
    if (hold) sc.pausesWas = sc.pauses, sc.pauses = false;
    try { tick.call(this); } finally { if (hold) sc.pauses = sc.pausesWas; }
    if (this.p2pHost && this.state === 'play') this.guard('p2p host', () => this.p2pHost.tick());
    if (this.tickCount % 10 === 0) qiumcPartyHud(this);
  };
  // chat: a guest's goes to the host; the host's (not commands) to the guests
  const rc = runCommand;
  runCommand = function (g, text) {
    if (g.p2pGuest) { if (text.startsWith('/')) { g.ui.message('本地房间里客人不能用命令', '#FF5555'); return; } g.ui.message(`<${g.p2pGuest.name}> ${text}`); g.p2pGuest.send({ t: 'chat', text }); return; }
    if (g.p2pHost && !text.startsWith('/')) { const n = (Account.loggedIn && Account.name) || '房主'; g.ui.message(`<${n}> ${text}`); g.p2pHost.toAll({ t: 'chat', name: n, text }); return; }
    return rc(g, text);
  };
  // markers in a local room go through the host
  const mp = Marks.place;
  Marks.place = function (g) {
    if (g.p2pGuest || g.p2pHost) {
      const t = g.target, pos = t ? [...t.pos] : g.player.pos.map(Math.floor), me = g.p2pGuest ? g.p2pGuest.name : (Account.loggedIn && Account.name) || '房主';
      if (g.p2pGuest) g.p2pGuest.send({ t: 'mark', pos }); else g.p2pHost.toAll({ t: 'mark', name: me, pos });
      Marks.add(me, pos, '#55FF55'); return;
    }
    return mp.call(this, g);
  };
  // other dimensions: guests stay in the overworld, and the host stays with them
  const cd = Game.prototype.changeDimension;
  Game.prototype.changeDimension = function (...a) {
    if (this.p2pGuest) { this.ui.pinMessage('本地房间里客人暂时不能去其他维度', 3000, '#FF8080'); return; }
    if (this.p2pHost && this.p2pHost.peers.size) { this.ui.pinMessage('房间里有朋友时不能去其他维度（先关掉本地房间）', 3000, '#FF8080'); return; }
    return cd.apply(this, a);
  };
  // leaving: the host closes the room, a guest leaves it (its inventory stays with the host's world)
  // 回标题画面时 Game.tick 往往不再继续跑，房间名单浮层必须在这里立刻收掉，
  // 不能等到下一帧 qiumcPartyHud 才刷新（那样它会永远冻在主界面右上角）。
  const st = Game.prototype.startTitle;
  Game.prototype.startTitle = function (...a) { qiumcHideParty(); return st.apply(this, a); };
  const q = Game.prototype.quitToTitle;
  Game.prototype.quitToTitle = async function () {
    qiumcHideParty();
    if (this.p2pGuest) { const G = this.p2pGuest; G.leave(); this.p2pGuest = null; this.worldMeta = null; this.startTitle(); return; }
    if (this.p2pHost) this.p2pHost.close();
    return q.call(this);
  };
  // a guest's own tick (the world is the host's): in game.js tick, where the server branch is
  // saving a guest's world does nothing here (the host keeps it)
  const sw = Game.prototype.saveWorld;
  Game.prototype.saveWorld = async function (quiet) { if (this.p2pGuest) { this.p2pGuest.sendState(true); return; } return sw.call(this, quiet); };
})();

// ---------------------------------------------------------------------------
// 房间成员浮层：显示房间里有谁、各自方位与距离。
// 即使 3D 模型被地形挡住或视锥裁剪，也能一眼确认对方在房间里、往哪走能找到。
// ---------------------------------------------------------------------------
function qiumcHideParty() {
  const el = document.getElementById('party');
  if (!el) return;
  el.style.display = 'none';
  el.innerHTML = '';
  el.setAttribute('aria-hidden', 'true');
}
function qiumcPartyHud(g) {
  const el = document.getElementById('party');
  if (!el) return;
  const H = g.p2pHost, G = g.p2pGuest, S = g.serverLink, me = g.player;
  if ((!H && !G && !S) || !me || g.state !== 'play') { qiumcHideParty(); return; }
  const rows = [];
  const add = (name, pos) => {
    if (!name || !pos) return;
    const dx = pos[0] - me.pos[0], dz = pos[2] - me.pos[2];
    const d = Math.hypot(dx, dz);
    let dir = '就在身边';
    if (d > 3) {
      const ew = Math.abs(dx) > Math.abs(dz) ? (dx > 0 ? '东' : '西') : (dz > 0 ? '南' : '北');
      dir = ew + ' ' + Math.round(d) + ' 格';
    }
    rows.push('<div class="' + (d > 12 ? 'p far' : 'p') + '">● ' + String(name).slice(0, 16) + ' · ' + dir + '</div>');
  };
  if (S && S.state === 'joined') {
    for (const e of S.players.values()) if (!e.dead) add(e.name, e.pos);
  } else if (H) {
    for (const p of H.peers.values()) if (p.joined) add(p.name, p.avatar && p.avatar.pos);
  } else if (G) {
    for (const e of G.mirrors.values()) if (!e.dead && e.type === 'player') add(e.name, e.pos);
  }
  const label = S ? '服务器 · ' + ((S.server && S.server.name) || S.code) + '（' + (1 + rows.length) + ' 人）'
    : H ? '房间 · 房主（' + (1 + rows.length) + ' 人）' : '房间 · ' + (G.hostName || '房主') + '（' + (1 + rows.length) + ' 人）';
  el.innerHTML = '<b>' + label + '</b>' + (rows.length ? rows.join('') : '<div class="p">还没有其他人加入</div>');
  el.setAttribute('aria-hidden', 'false');
  el.style.display = 'block';
}

// ================================== the screens ==================================
// ITLZMC：邀请码与联机世界都由程序自动生成，玩家不用填任何东西。
function qiumcRandomCode(n = 8) {
  const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let s = ''; for (let i = 0; i < n; i++) s += A[(Math.random() * A.length) | 0];
  return s;
}
async function qiumcPrepareWorld(g) {
  // 标题画面只有全景背景，不能带房间：自动载入最近的世界（没有存档就建一个）。
  let loaded = false;
  try {
    const ws = await DB.listWorlds();
    const w = (ws || []).slice().sort((a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0))[0];
    if (w) { await g.loadWorld(w.id); loaded = true; }
  } catch (e) { }
  if (!loaded) await g.createWorld('联机世界', '', 'survival', false);
}
async function qiumcOpenLocalRoom(g, code, parent) {
  // 先连服务器，房间立刻登记可用；再准备世界，全程有明确进度界面，不会黑屏卡住。
  const h = new LocalHost(g, code);
  await h.open();
  g.p2pHost = h;
  if (g.state !== 'play') {
    g.ui.open(new LoadingScreen(g, '正在准备联机世界…'));
    try { await qiumcPrepareWorld(g); }
    catch (e) { g.ui.message('世界载入失败：' + e.message, '#FF8080'); }
    // 引擎加载完世界会自己 ui.close()；等它关完再摆邀请码界面，界面才不会被顶掉。
    for (let i = 0; i < 150 && g.state !== 'play'; i++) await new Promise((r) => setTimeout(r, 100));
    g.ui.close();
  }
  g.ui.hideInput();
  // 直接把邀请码摆出来，玩家一眼能看到，不用去暂停菜单找
  g.ui.open(new LocalRoomStatusScreen(g, parent || null));
  g.ui.message(`房间已开好：邀请码 ${code}（发给朋友，他们在「多人游戏」里输入）`, '#55FF55');
  if (typeof Telemetry !== 'undefined' && Telemetry.count) Telemetry.count('p2p_host');
  return h;
}

// 开本地房间: the warning, the device check, the invite code
class LocalRoomScreen extends FormScreen {
  constructor(game, parent) {
    super(game, '开本地房间', parent); this.pauses = false; this.titleY = 8; this.code = qiumcRandomCode(); this.busy = false;
    const fps = game.fps || 0, mem = navigator.deviceMemory || 8;
    this.weak = (fps && fps < 30) || mem <= 2 || TouchDevice.kind === 'phone';
  }
  layout() {
    const u = this.game.ui, cx = u.w / 2;
    this.fields = {};
    this.addField('code', cx - 100, u.h - 82, 200, '邀请码（6–12 位英文字母或数字，朋友输入它来加入）', 12, (v) => v.replace(/[^A-Za-z0-9]/g, '').slice(0, 12));
    this.widgets = [
      { x: cx - 100, y: u.h - 54, w: 98, h: 20, gold: true, label: () => (this.busy ? '正在开房间…' : '我知道了，开房间'), enabled: !this.busy, onClick: () => this.submit() },
      { x: cx + 2, y: u.h - 54, w: 98, h: 20, label: '随机邀请码', onClick: () => { const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; let s = ''; for (let i = 0; i < 8; i++) s += A[(Math.random() * A.length) | 0]; this.code = s; this.layout(); } },
      { x: cx - 100, y: u.h - 28, w: 200, h: 20, label: '返回', onClick: () => this.back() },
    ];
    this.focus('code');
  }
  async submit() {
    const g = this.game;
    if (!/^[A-Za-z0-9]{6,12}$/.test(this.code)) this.code = qiumcRandomCode();
    this.busy = true; this.say('正在开房间…'); this.layout();
    try { await qiumcOpenLocalRoom(g, this.code, this.parent); }
    catch (e) { this.busy = false; this.say(e.message, true); this.layout(); }
  }
  drawExtra(ui) {
    const c = ui.ctx, cx = ui.w / 2, w = Math.min(340, ui.w - 16), x = Math.floor(cx - w / 2);
    drawCard(c, x, 22, w, 92, true);
    const lines = [['本地房间会用你的设备运行整个世界：', '#FFD24A'], ['手机 / 电脑会更耗电、发热，人多时可能卡顿；你的网络不好时，其他人也会卡；', '#FFFFFF'],
      ['你关掉游戏、切到后台或者断网，房间里所有人都会被断开。', '#FF8080'], ['建议：用电脑 + 有线或稳定的 Wi-Fi。本地房间最多 4 人（含你）。', '#A0A0A0'],
      ['朋友在时你不能去下界 / 末地；朋友的背包会保存在你的存档里。', '#A0A0A0']];
    let y = 28;
    for (const [t, col] of lines) { let s = t; while (s.length) { let n = s.length; while (n > 1 && Font.width(s.slice(0, n)) > w - 12) n--; Font.draw(c, s.slice(0, n), x + 6, y, col); s = s.slice(n); y += 10; } }
    if (this.weak) Font.center(c, fitText(TouchDevice.kind === 'phone' ? '在手机上开房间不太推荐：发热和后台断开都很常见' : '你的设备现在帧率偏低，不太推荐开本地房间', ui.w - 8), cx, 118, '#FF8080');
    this.drawFields(ui);
  }
}
// 本地房间 (pause menu, hosting): the code, who is in, sending someone away, closing the room
class LocalRoomStatusScreen extends MenuScreen {
  constructor(game, parent) { super(game, '本地房间'); this.parent = parent; this.pauses = false; this.titleY = 10; this.note = ''; }
  get H() { return this.game.p2pHost; }
  layout() {
    const u = this.game.ui, cx = u.w / 2, H = this.H;
    this.widgets = [];
    if (H) {
      [...H.peers.values()].filter((p) => p.joined).forEach((p, i) => this.widgets.push({ x: cx + 80, y: 66 + i * 22, w: 60, h: 18, label: '请离开', onClick: () => { H.kick(p.id); setTimeout(() => this.layout(), 400); } }));
      this.widgets.push(
        { x: cx - 152, y: 30, w: 98, h: 20, gold: true, label: '复制邀请', onClick: async () => { this.note = (await copyText(`来我的 ITLZMC 本地房间玩：多人游戏 → 输入邀请码 ${H.code}`)) ? '已复制，发给朋友吧' : '复制失败：邀请码 ' + H.code; } },
        { x: cx - 50, y: 30, w: 98, h: 20, label: '复制邀请码', onClick: async () => { this.note = (await copyText(H.code)) ? '邀请码已复制' : '复制失败'; } },
        { x: cx + 52, y: 30, w: 100, h: 20, label: '关闭房间', onClick: () => { H.close(); this.game.ui.message('本地房间已关闭', '#AAAAAA'); this.game.ui.open(this.parent); } },
      );
    }
    this.widgets.push({ x: cx - 100, y: u.h - 28, w: 200, h: 20, label: '完成', onClick: () => this.game.ui.open(this.parent) });
  }
  drawExtra(ui) {
    const c = ui.ctx, cx = ui.w / 2, H = this.H;
    if (!H) { Font.center(c, '没有开本地房间', cx, 50, '#A0A0A0'); return; }
    const ps = [...H.peers.values()].filter((p) => p.joined);
    Font.draw(c, `邀请码 ${H.code}　·　${ps.length + 1} / ${P2P_MAX} 人`, cx - 152, 54, '#FFFF55');
    const rows = [{ name: ((Account.loggedIn && Account.name) || '你') + '（房主）' }, ...ps];
    rows.forEach((p, i) => { const y = 66 + i * 22; c.fillStyle = 'rgba(0,0,0,0.35)'; c.fillRect(cx - 152, y, 290, 18); Font.draw(c, p.name, cx - 148, y + 5, '#FFFFFF'); });
    if (!ps.length) Font.draw(c, '还没有人进来：把邀请码发给朋友，他们在「多人游戏」里输入', cx - 152, 66 + 26, '#A0A0A0');
    if (this.note) Font.center(c, this.note, cx, ui.h - 40, '#80FF80');
  }
  onEsc() { this.game.ui.open(this.parent); }
}
(() => {
  // the pause menu: open a local room (single player), or see it (hosting)
  const lay = PauseScreen.prototype.layout;
  PauseScreen.prototype.layout = function () {
    lay.call(this);
    const g = this.game;
    if (g.net || g.p2pGuest) return;
    const b = this.widgets.find((w) => typeof w.label === 'function' && String(w.label()).startsWith('模式：'));
    if (!b) return;
    // (the game-mode button gives up half of its width)
    b.w = 48;
    this.widgets.push({ x: b.x + 50, y: b.y, w: 48, h: 20, gold: !g.p2pHost, label: g.p2pHost ? '房间…' : '开房间', tip: g.p2pHost ? ['本地房间：邀请码、在场的人'] : ['开一个本地房间，朋友用邀请码加入你的世界（最多 4 人）'],
      onClick: () => onlineGate(g, () => g.ui.open(g.p2pHost ? new LocalRoomStatusScreen(g, this) : new LocalRoomScreen(g, this)), this) });
  };
  // joining by code: a local room when one is open under it, else a room on the service
  const sub = MultiplayerScreen.prototype.submit;
  MultiplayerScreen.prototype.submit = async function () {
    const code = String(this.code || '').replace(/[^A-Za-z0-9]/g, '');
    if (code.length >= 6 && RoomService.base()) {
      try { const r = await RoomService.api('/api/p2p/has?code=' + encodeURIComponent(code)); if (r.has) return joinLocalRoom(this.game, code, this); } catch (e) { }
    }
    return sub.call(this);
  };
  // (local room codes may be longer than the service's)
  const lay2 = MultiplayerScreen.prototype.layout;
  MultiplayerScreen.prototype.layout = function () { lay2.call(this); if (this.fields.code) this.fields.code.max = 12; if (this.fields.code) this.fields.code.filter = (v) => v.replace(/[^A-Za-z0-9]/g, '').slice(0, 12); };
})();
async function joinLocalRoom(g, code, parent) {
  const name = (Account.loggedIn && Account.name) || nameOnly(g.settings.netName || '') || ('Steve' + Math.floor(Math.random() * 900 + 100));
  g.ui.hideInput();
  g.ui.open(new LoadingScreen(g, '正在连接本地房间 ' + code + '…'));
  const G = new LocalGuest(g, code, name);
  try { await G.join(); }
  catch (e) { g.ui.open(new ConfirmScreen(g, '没能进入本地房间', e.message, '返回', () => g.ui.open(parent || new TitleScreen(g)))); }
}


// ---------------------------------------------------------------------------
// ITLZMC：多人游戏大厅的每个入口都通往本地房间（WebRTC），无需 Java 版服务端。
// 「开房间」由房主运行自己的世界；公开房间列表与邀请码加入都走同一套信令。
// ---------------------------------------------------------------------------
(() => {
  const lay = MultiplayerScreen.prototype.layout;
  MultiplayerScreen.prototype.layout = function () {
    lay.call(this);
    const g = this.game;
    const mk = this.widgets.find((w) => w.label === '创建房间');
    if (mk) {
      mk.label = '开房间';
      mk.tip = ['开一个本地房间，朋友用邀请码加入你的世界（最多 4 人）'];
      mk.onClick = async () => {
        const n = this.okName(); if (!n) return;
        g.ui.hideInput();
        const code = qiumcRandomCode();
        g.ui.open(new LoadingScreen(g, '正在准备联机房间…'));
        try { await qiumcOpenLocalRoom(g, code); }
        catch (e) { g.ui.open(new ConfirmScreen(g, '没能开房间', e.message, '返回', () => g.ui.open(new MultiplayerScreen(g, null)))); }
      };
    }
    const my = this.widgets.find((w) => w.label === '我的房间');
    if (my) my.tip = ['查看这台设备登记过的房间'];
  };
  MultiplayerScreen.prototype.join = async function (code) {
    try {
      const r = await RoomService.api('/api/p2p/has?code=' + encodeURIComponent(code));
      if (r.has) return joinLocalRoom(this.game, code, this);
      this.say('没有找到这个房间：请确认邀请码，或让朋友先点「开房间」', true);
    } catch (e) {
      this.say('房间服务暂时没连上，点「刷新列表」重试', true);
    }
  };
})();
