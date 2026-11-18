'use strict';
// ---------------------------------------------------------------------------
// ITLZMC 常驻服务器（客户端）
//  · 服务端是玩家状态 / 方块 / 箱子 / 聊天 / 世界时钟的唯一权威，任何人退出都不影响其他人
//  · 服务器长期运行、房主退出不停服；世界按种子确定性生成，服务器下发的变更补齐差异
//  · 服务器启用的原生插件在进入时自动下发加载
// ---------------------------------------------------------------------------
(function () {
  const Q = window.ITLZMC || (window.ITLZMC = {});
  const srvApplying = { n: 0 };
  const srvKey = (x, z) => ckey(x >> 4, z >> 4);

  // -------------------------------------------------------------------------
  // REST 封装（复用 RoomService.url，自动带上部署平台的 sharecode）
  // -------------------------------------------------------------------------
  const ServerService = {
    async call(path, body) {
      let r;
      try { r = await fetch(RoomService.url(path), body ? { method: 'POST', body: JSON.stringify(body) } : {}); }
      catch (e) { throw new Error('连不上服务器，请确认服务已启动'); }
      const j = await r.json().catch(() => ({ ok: false, error: '服务器没有正确回应' }));
      if (!r.ok || (j && j.error)) throw new Error((j && j.error) || ('HTTP ' + r.status));
      return j;
    },
    list() { return this.call('/api/servers'); },
    get(code) { return this.call('/api/servers/' + encodeURIComponent(String(code).toUpperCase())); },
    create(b) { return this.call('/api/servers', Object.assign({ ownerKey: RoomService.key() }, b)); },
    manage(code, b) { return this.call('/api/servers/' + code + '/manage', Object.assign({ ownerKey: RoomService.key() }, b)); },
    remove(code) { return this.call('/api/servers/' + code + '/delete', { ownerKey: RoomService.key() }); },
    catalog() { return this.call('/api/server-plugins'); },
    link(code) { return RoomService.link(code); },
  };

  function myName(g) {
    const raw = (typeof Account !== 'undefined' && Account.name) || (g.settings && g.settings.netName) || ('Steve' + Math.floor(Math.random() * 900 + 100));
    return String(raw).replace(/[^\w\u4e00-\u9fa5]/g, '').slice(0, 20) || 'Player';
  }
  function safeLook(g) { try { return Skins.mine(g); } catch (e) { return null; } }

  // -------------------------------------------------------------------------
  // 服务器连接：一条 WebSocket，服务端负责把所有人串起来
  // -------------------------------------------------------------------------
  class ServerLink {
    constructor(g, code, name) {
      this.g = g; this.code = code; this.name = name;
      this.ws = null; this.id = null; this.server = null;
      this.players = new Map();       // id -> NetPlayer
      this.pending = new Map();       // 还没加载到的区块里的方块变更
      this.outBlocks = [];
      this.beSnap = new Map();
      this.state = 'connecting'; this.stopped = false; this.everJoined = false;
      this.retry = 0; this.retryTimer = null; this.hb = null;
      this._res = null; this._rej = null;
    }
    url() {
      const sc = new URLSearchParams(location.search).get('sharecode');
      return RoomService.base().replace(/^http/, 'ws') + '/srv' + (sc ? '?sharecode=' + encodeURIComponent(sc) : '');
    }
    connect() {
      return new Promise((res, rej) => { this._res = res; this._rej = rej; this._open(); });
    }
    _open() {
      if (this.stopped) return;
      const ws = this.ws = new WebSocket(this.url());
      ws.onopen = () => {
        this.retry = 0;
        this._send({ t: 'join', code: this.code, name: this.name, look: safeLook(this.g) });
        this._heartbeat();
      };
      ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch (err) { return; } this.onMsg(m); };
      ws.onerror = () => { };
      ws.onclose = () => {
        clearInterval(this.hb); this.hb = null;
        if (this.stopped || this.state === 'left') return;
        if (this.state === 'connecting' && !this.everJoined) { this._fail('连不上常驻服务器'); return; }
        this.state = 'reconnecting';
        this.g.ui && this.g.ui.message('正在重新连接服务器…', '#FFCC66');
        clearTimeout(this.retryTimer);
        const d = [700, 1500, 3000, 5000, 8000][Math.min(this.retry++, 4)];
        this.retryTimer = setTimeout(() => this._open(), d);
      };
    }
    _heartbeat() {
      clearInterval(this.hb);
      this.hb = setInterval(() => { if (this.ws && this.ws.readyState === 1) this._send({ t: 'ping' }); }, 20000);
    }
    _fail(reason) {
      if (this._rej) { this._rej(new Error(reason)); this._rej = null; this._res = null; }
      this.leave();
    }
    _send(o) { if (this.ws && this.ws.readyState === 1) { try { this.ws.send(JSON.stringify(o)); } catch (e) { } } }
    send(o) { if (this.state === 'joined') this._send(o); }

    onMsg(m) {
      const g = this.g;
      switch (m.t) {
        case 'pong': return;
        case 'error':
          if (!this.everJoined) this._fail(m.reason || '服务器拒绝了连接');
          else g.ui && g.ui.message(m.reason || '服务器出错了', '#FF8080');
          return;
        case 'kicked':
          g.ui && g.ui.message(m.reason || '你被请出了服务器', '#FF8080');
          g.quitToTitle && g.quitToTitle();
          return;
        case 'joined': return this.onJoined(m);
        case 'peer': return this.makePlayer(m.id, m.name, m.pos, m.look, true);
        case 'state': {
          const e = this.players.get(m.id);
          if (!e) return;
          if (Array.isArray(m.pos)) { e.netPos = m.pos.slice(0, 3); e.lerpN = 2; }
          e.netYaw = e.netHead = m.yaw || 0; e.netPitch = m.pitch || 0;
          e.sneaking = !!m.sneak; e.netSwim = !!m.swim;
          if (m.swing && !(e.swingT > 0)) e.swingT = 6;
          e.heldId = m.held ?? null;
          e.armorItems = (m.armor || []).map((i) => (i == null ? null : { id: i, count: 1 }));
          if (m.look) e.look = m.look;
          if (m.name) e.name = m.name;
          return;
        }
        case 'gone': {
          const e = this.players.get(m.id);
          if (e) { e.dead = true; const i = g.entities.indexOf(e); if (i >= 0) g.entities.splice(i, 1); this.players.delete(m.id); }
          g.ui && g.ui.message((m.name || '有玩家') + ' 离开了服务器', '#FFFF55');
          return;
        }
        case 'blocks': this.applyBlocks(m.list || []); return;
        case 'be':
          if (m.data && typeof m.data === 'object') {
            const be = g.blockEntities.get(m.k);
            if (be) Object.assign(be, m.data); else g.blockEntities.set(m.k, m.data);
            this.beSnap.set(m.k, JSON.stringify(g.blockEntities.get(m.k)));
          }
          return;
        case 'chat':
          g.ui && g.ui.message(m.sys ? m.text : '<' + (m.name || '?') + '> ' + m.text, m.sys ? '#FFFF55' : '#FFFFFF');
          return;
        case 'env':
          if (typeof m.time === 'number') g.worldTime = m.time;
          if (typeof m.weather === 'number') { g.weather = m.weather; g.rainTarget = m.rain || 0; }
          return;
        case 'plugins': this.loadPlugins(m.plugins); return;
      }
    }

    onJoined(m) {
      const g = this.g;
      const first = !this.everJoined;
      this.everJoined = true; this.state = 'joined';
      this.id = m.id; this.server = m.server || { name: this.code };
      g.serverLink = this;
      clearTimeout(this.retryTimer);
      if (first) {
        // 世界已经在 joinServer() 里按同一个种子载入，这里把服务器上保存的变更补上。
        this.applyBlocks(m.blocks || []);
        for (const [k, data] of (m.bes || [])) {
          if (data && typeof data === 'object') { g.blockEntities.set(k, data); this.beSnap.set(k, JSON.stringify(data)); }
        }
        if (m.env) { g.worldTime = m.env.time || 1000; g.weather = m.env.weather || 0; g.rainTarget = m.env.rain || 0; }
        if (m.saved && m.saved.pos && g.player) {
          try {
            const d = m.saved;
            g.player.pos = [...d.pos]; g.player.prev = [...d.pos];
            g.player.yaw = d.yaw || 0; g.player.pitch = d.pitch || 0;
            if (d.health > 0) g.player.health = d.health;
            if (Array.isArray(d.inv)) { g.player.inv.slots = d.inv.map((s) => (s ? fixSavedStack({ ...s }) : null)); while (g.player.inv.slots.length < 41) g.player.inv.slots.push(null); }
            g.player.inv.sel = d.sel || 0;
          } catch (e) { }
        }
        for (const c of (m.chat || [])) g.ui && g.ui.message('<系统> ' + (c.name || '') + ': ' + c.text, '#A0A0A0');
        g.ui && g.ui.message('已进入常驻服务器 · ' + (this.server.name || this.code), '#55FF55');
      } else {
        for (const e of this.players.values()) { e.dead = true; const i = g.entities.indexOf(e); if (i >= 0) g.entities.splice(i, 1); }
        this.players.clear();
        this.applyBlocks(m.blocks || []);
        g.ui && g.ui.message('已重新连上服务器', '#55FF55');
      }
      for (const p of (m.peers || [])) this.makePlayer(p.id, p.name, p.pos, p.look, false);
      this.loadPlugins(m.plugins);
      this.sendState(true);
      if (first && this._res) { const r = this._res; this._res = null; this._rej = null; r(true); }
    }

    loadPlugins(list) {
      if (!list || !list.length || !Q.Plugins || typeof Q.Plugins.loadServerPlugins !== 'function') return;
      Q.Plugins.loadServerPlugins(list).then((r) => {
        if (r && r.loaded && r.loaded.length) this.g.ui && this.g.ui.message('已加载服务器插件：' + r.loaded.join('、'), '#86EFAC');
      }).catch(() => { });
    }

    makePlayer(id, name, pos, look, announce) {
      if (this.players.has(id)) return this.players.get(id);
      const g = this.g;
      const base = g.player ? g.player.pos : [0, 80, 0];
      const p = Array.isArray(pos) && pos.length === 3 ? pos : [base[0] + 3, base[1], base[2] + 3];
      let e;
      try { e = new NetPlayer(g, p[0], p[1], p[2], name || 'Player'); } catch (err) { return null; }
      e.p2pMirror = true; e.p2pId = id; e.mirrorType = 'player'; e.remote = true;
      e.alwaysTick = true; e.persistent = false;
      e.tick = netEntityTick;
      e.netPos = [...p]; e.lerpN = 0; e.netYaw = e.yaw = e.bodyYaw = e.prevBodyYaw = 0;
      e.netPitch = 0; e.netHead = 0; e.netSwim = false;
      e.look = look || null; e.name = name || 'Player';
      e.hurt = () => false;
      g.entities.push(e);
      this.players.set(id, e);
      if (announce) g.ui && g.ui.message((name || '有玩家') + ' 加入了服务器', '#FFFF55');
      return e;
    }

    applyBlocks(list) {
      const g = this.g, w = g.world;
      if (!w) return;
      for (const b of list) {
        if (!Array.isArray(b) || b.length < 4) continue;
        const [x, y, z, id, meta, wl] = b;
        if (![x, y, z, id].every((v) => Number.isFinite(+v))) continue;
        const k = [Math.round(x), Math.round(y), Math.round(z)].join(',');
        this.pending.set(k, [Math.round(x), Math.round(y), Math.round(z), Math.round(id), Math.round(meta || 0), wl ? 1 : 0]);
      }
      this.flushBlocks();
    }
    flushBlocks() {
      const g = this.g, w = g.world;
      if (!w || srvApplying.n > 0 || !this.pending.size) return;
      srvApplying.n++;
      try {
        for (const [k, b] of [...this.pending]) {
          const [x, y, z, id, meta, wl] = b;
          if (!w.chunks.has(srvKey(x, z))) continue;   // 区块还没生成，等玩家走过去再补
          this.pending.delete(k);
          try {
            w.setBlock(x, y, z, id, meta, 3);
            if (w.setWaterlogged) w.setWaterlogged(x, y, z, !!wl);
            if (w.savedIndex) w.savedIndex.add(srvKey(x, z));
          } catch (e) { }
        }
      } finally { srvApplying.n--; }
      if (this.pending.size > 60000) {
        const keys = [...this.pending.keys()].slice(0, this.pending.size - 60000);
        for (const k of keys) this.pending.delete(k);
      }
    }

    sendState(final) {
      const g = this.g, p = g.player;
      if (!p || this.state !== 'joined') return;
      this._send({ t: 'state', pos: p.pos.map((v) => +v.toFixed(2)), yaw: +p.yaw.toFixed(3), pitch: +p.pitch.toFixed(3),
        sneak: !!p.sneaking, swing: p.swingT > 0, held: p.inv.held ? p.inv.held.id : null,
        armor: p.inv.slots.slice(36, 40).map((s) => (s && s.id)), look: safeLook(g), mode: g.mode, swim: !!p.swimming });
      if (final || g.tickCount % 200 === 0) {
        this._send({ t: 'pstate', data: { pos: [...p.pos], yaw: p.yaw, pitch: p.pitch, health: p.health,
          food: p.food, sat: p.saturation, xp: p.xp || 0,
          inv: p.inv.slots.map((s) => (s ? { id: s.id, count: s.count, dmg: s.dmg || 0 } : null)), sel: p.inv.sel } });
      }
    }

    tick() {
      const g = this.g;
      if (this.state !== 'joined') return;
      this.flushBlocks();
      if (g.tickCount % 5 === 0) this.sendState(false);
      if (this.outBlocks.length) {
        const list = this.outBlocks.splice(0, 512);
        this._send({ t: 'blocks', list });
        for (const b of list) this.pending.set([b[0], b[1], b[2]].join(','), b);
      }
      if (g.tickCount % 10 === 0 && g.blockEntities) {
        for (const [k, be] of g.blockEntities) {
          if (!/^-?\d+,-?\d+,-?\d+$/.test(k)) continue;
          let j = '';
          try { j = JSON.stringify(be, (key, v) => (key === 'open' || key === 'lid' || key === 'viewers' ? undefined : v)); } catch (e) { continue; }
          if (this.beSnap.get(k) !== j) { this.beSnap.set(k, j); this._send({ t: 'be', k, data: JSON.parse(j) }); }
        }
      }
      for (const e of this.players.values()) if (!e.dead) { try { g.tickEntity(e); } catch (err) { } }
      for (const [id, e] of this.players) if (e.dead) this.players.delete(id);
    }

    leave() {
      if (this.stopped) return;
      this.stopped = true; this.state = 'left';
      clearTimeout(this.retryTimer); clearInterval(this.hb); this.hb = null;
      if (this.ws && this.ws.readyState === 1) { try { this.ws.send(JSON.stringify({ t: 'leave' })); } catch (e) { } }
      try { if (this.ws) this.ws.close(); } catch (e) { }
      const g = this.g;
      for (const e of this.players.values()) { e.dead = true; const i = g.entities.indexOf(e); if (i >= 0) g.entities.splice(i, 1); }
      this.players.clear();
      if (g.serverLink === this) g.serverLink = null;
      qiumcHideParty();
    }
  }

  // -------------------------------------------------------------------------
  // 准备世界：每个服务器一个固定本地存档，种子与服务器一致 → 地形确定性
  // -------------------------------------------------------------------------
  async function prepareWorld(g, s) {
    const id = 'srv~' + s.code;
    let meta = null;
    try { meta = await DB.getWorld(id); } catch (e) { }
    if (!meta) {
      meta = {
        id, name: '服务器 · ' + (s.name || s.code), seed: Number(s.seed) || 1, gen: 2,
        mode: s.gamemode === 'creative' ? 'creative' : 'survival', flat: false,
        created: Date.now(), lastPlayed: Date.now(), time: 1000, player: null,
        hardcore: false, difficulty: 2, cheats: false, structures: true, bonus: false,
      };
      await DB.putWorld(meta);
    }
    await g.loadWorld(id);
  }

  async function joinServer(g, code, parent) {
    const name = myName(g);
    g.settings.netName = name;
    try { g.saveSettings(); } catch (e) { }
    g.ui.open(new LoadingScreen(g, '正在连接常驻服务器 ' + code + '…'));
    try {
      const info = await ServerService.get(code);
      const s = (info && info.server) || { code, name: code, seed: 1, gamemode: 'survival' };
      if (g.serverLink) g.serverLink.leave();
      if (g.p2pHost) g.p2pHost.close();
      if (g.p2pGuest) g.p2pGuest.leave();
      await prepareWorld(g, s);
      const L = new ServerLink(g, code, name);
      await L.connect();
      return L;
    } catch (e) {
      if (g.serverLink) { g.serverLink.leave(); g.serverLink = null; }
      g.ui.open(new ConfirmScreen(g, '进不去服务器', e.message || String(e), '返回', () => g.ui.open(parent || new TitleScreen(g))));
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // 界面
  // -------------------------------------------------------------------------
  class ServerListScreen extends FormScreen {
    constructor(game, parent) {
      super(game, '常驻服务器', parent);
      this.name = myName(game);
      this.code = '';
      this.list = []; this.page = 0; this.loading = true;
      this.load();
    }
    async load() {
      this.loading = true;
      try { const r = await ServerService.list(); this.list = (r.servers || []).filter((s) => s.public !== false); }
      catch (e) { this.list = []; this.say('服务器列表暂时没读到，点「刷新」重试', true); }
      this.loading = false;
      if (this.game.ui.screen === this) this.layout();
    }
    rows() { return Math.max(2, Math.floor((this.game.ui.h - 82 - 62) / 24)); }
    layout() {
      const u = this.game.ui, cx = u.w / 2, n = this.rows(), list = this.list || [];
      this.fields = {};
      this.addField('name', cx - 152, 42, 148, '你的名字', 20, (v) => v.replace(/[^\w\u4e00-\u9fa5]/g, '').slice(0, 20));
      this.addField('code', cx + 4, 42, 98, '邀请码', 8, (v) => v.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8));
      const pages = Math.max(1, Math.ceil(list.length / n));
      this.page = clamp(this.page, 0, pages - 1);
      this.widgets = [
        { x: cx + 106, y: 42, w: 46, h: 20, label: '加入', onClick: () => this.submit() },
        { x: cx + 106, y: 66, w: 22, h: 14, label: '<', enabled: this.page > 0, onClick: () => { this.page--; this.layout(); } },
        { x: cx + 130, y: 66, w: 22, h: 14, label: '>', enabled: this.page < pages - 1, onClick: () => { this.page++; this.layout(); } },
      ];
      list.slice(this.page * n, this.page * n + n).forEach((s, i) => {
        const full = s.players >= s.max;
        this.widgets.push({
          x: cx + 106, y: 84 + i * 24, w: 46, h: 20, gold: s.kind === 'server',
          label: full ? '已满' : '进入', enabled: !full && !s.paused,
          tip: [s.name, '房主 ' + s.owner + ' · ' + s.players + '/' + s.max + ' 人 · ' + (GM_CN[s.gamemode] || '生存'),
            s.motd || '', s.paused ? '管理员暂时暂停了这个服务器' : '长期运行，房主退出也照常在'],
          onClick: () => this.join(s.code),
        });
      });
      this.widgets.push(
        { x: cx - 152, y: u.h - 52, w: 98, h: 20, label: '创建服务器', onClick: () => this.go(CreateServerScreen) },
        { x: cx - 50, y: u.h - 52, w: 98, h: 20, label: '我的服务器', onClick: () => this.go(MyServersScreen) },
        { x: cx + 52, y: u.h - 52, w: 100, h: 20, label: this.loading ? '正在刷新…' : '刷新列表', onClick: () => { this.list = []; this.layout(); this.load(); } },
        { x: cx - 50, y: u.h - 28, w: 98, h: 20, label: '返回', onClick: () => this.back() },
      );
      if (this.field) this.focus(this.field);
    }
    okName() {
      const n = myName(this.game);
      this.game.settings.netName = n;
      try { this.game.saveSettings(); } catch (e) { }
      return n;
    }
    go(Cls) { this.okName(); this.game.ui.hideInput(); this.game.ui.open(new Cls(this.game, this)); }
    submit() {
      const c = codeOnly(this.code || '');
      if (c.length < 4) { this.say('输入邀请码（6 位）', true); this.focus('code'); return; }
      this.join(c);
    }
    join(code) {
      this.okName();
      this.game.ui.hideInput();
      joinServer(this.game, code, this);
    }
    drawExtra(ui) {
      const c = ui.ctx, cx = ui.w / 2;
      Font.center(c, '长期运行的服务器 · 任何人都能加入 · 房主退出不停服', cx, 76, '#7FD8FF');
      if (!this.list || !this.list.length) Font.center(c, '还没有服务器，点「创建服务器」开一个', cx, 110, '#8FA8C8');
      else {
        const n = this.rows();
        this.list.slice(this.page * n, this.page * n + n).forEach((s, i) => {
          const y = 84 + i * 24;
          Font.draw(c, fitText((s.paused ? '[暂停] ' : '[长期] ') + s.name, 200), cx - 152, y + 5, '#E0E0E0');
          Font.draw(c, s.players + '/' + s.max + ' 人 · ' + (s.pluginCount ? s.pluginCount + ' 插件' : '无插件'), cx - 152, y + 15, '#8FA8C8');
        });
      }
      if (this.note) Font.center(c, this.note, cx, ui.h - 74, this.noteColor);
    }
  }

  class CreateServerScreen extends FormScreen {
    constructor(game, parent) {
      super(game, '创建常驻服务器', parent);
      this.sname = '我的 ITLZMC 服务器';
      this.seed = '';
      this.motd = '欢迎来到 ITLZMC 常驻服务器';
      this.max = 10; this.gm = 0;
      this.busy = false;
      this.layout();
    }
    layout() {
      const u = this.game.ui, cx = u.w / 2;
      this.fields = {};
      this.addField('sname', cx - 152, 42, 200, '服务器名称', 40, (v) => v.slice(0, 40));
      this.addField('seed', cx - 152, 88, 96, '种子（留空随机）', 20, (v) => v.replace(/[^0-9-]/g, '').slice(0, 20));
      this.addField('motd', cx + 52, 88, 100, '公告', 40, (v) => v.slice(0, 40));
      this.widgets = [
        { x: cx - 50, y: 42, w: 100, h: 20, label: () => '人数：' + this.max,
          tip: ['服务器最多同时在线多少人（2–32）'],
          onClick: () => { const a = [4, 6, 8, 10, 16, 24, 32]; this.max = a[(a.indexOf(this.max) + 1) % a.length]; this.layout(); } },
        { x: cx - 152, y: 134, w: 98, h: 20, label: () => '模式：' + (GM_CN[['survival', 'creative', 'adventure'][this.gm]] || '生存'),
          onClick: () => { this.gm = (this.gm + 1) % 3; this.layout(); } },
        { x: cx - 50, y: 134, w: 98, h: 20, label: '选择启用插件', gold: true,
          tip: ['服务器可以加载原生插件，成员进入时自动同步'],
          onClick: () => this.game.ui.open(new ServerPluginPickScreen(this.game, this)) },
        { x: cx + 52, y: 134, w: 100, h: 20, label: this.busy ? '正在创建…' : '创建并进入', enabled: !this.busy, gold: true,
          onClick: () => this.submit() },
        { x: cx - 50, y: u.h - 30, w: 98, h: 20, label: '返回', onClick: () => this.back() },
      ];
      if (this.field) this.focus(this.field);
    }
    async submit() {
      if (this.busy) return;
      this.busy = true; this.say('正在创建常驻服务器…'); this.layout();
      try {
        const r = await ServerService.create({
          name: this.sname.trim() || '我的 ITLZMC 服务器', owner: myName(this.game),
          seed: this.seed ? Number(this.seed) : undefined, max: this.max,
          gamemode: ['survival', 'creative', 'adventure'][this.gm],
          motd: this.motd, plugins: this.plugins || [],
        });
        this.game.ui.hideInput();
        this.game.ui.message('服务器已创建：' + r.code + '（长期运行，退出游戏也不会关）', '#86EFAC');
        await joinServer(this.game, r.code, this.parent);
      } catch (e) {
        this.busy = false; this.say(e.message || '创建失败', true); this.layout();
      }
    }
    drawExtra(ui) {
      const c = ui.ctx, cx = ui.w / 2;
      Font.center(c, '创建后即使你退出，服务器也会一直运行', cx, 168, '#7FD8FF');
      Font.center(c, '世界保存在服务器上，任何人都能用邀请码加入', cx, 182, '#8FA8C8');
      if (this.plugins && this.plugins.length) Font.center(c, '已选插件：' + this.plugins.join('、'), cx, 198, '#86EFAC');
      if (this.note) Font.center(c, this.note, cx, 216, this.noteColor);
    }
  }

  class ServerPluginPickScreen extends MenuScreen {
    constructor(game, parent) { super(game, '服务器插件'); this.parent = parent; this.cat = []; this.sel = new Set((parent && parent.plugins) || []); this.busy = true; this.load(); }
    async load() {
      try { const r = await ServerService.catalog(); this.cat = r.plugins || []; }
      catch (e) { this.cat = []; }
      this.busy = false; this.layout();
    }
    layout() {
      const u = this.game.ui, cx = u.w / 2;
      this.widgets = [];
      const top = 44, rowH = 24, maxRows = Math.max(2, Math.floor((u.h - 110) / rowH));
      const pages = Math.max(1, Math.ceil(this.cat.length / maxRows));
      this.page = clamp(this.page || 0, 0, pages - 1);
      this.cat.slice(this.page * maxRows, this.page * maxRows + maxRows).forEach((p, i) => {
        this.widgets.push({ x: cx - 152, y: top + i * rowH, w: 304, h: 20,
          label: () => (this.sel.has(p.id) ? '[启用] ' : '[  ] ') + p.name + ' · ' + p.id,
          tip: [p.description, '来源：' + p.source + ' · ' + p.version],
          onClick: () => { if (this.sel.has(p.id)) this.sel.delete(p.id); else this.sel.add(p.id); this.layout(); } });
      });
      this.widgets.push(
        { x: cx - 152, y: u.h - 52, w: 98, h: 20, label: '保存选择', gold: true, onClick: () => { if (this.parent) this.parent.plugins = [...this.sel]; this.game.ui.open(this.parent || new TitleScreen(this.game)); } },
        { x: cx - 50, y: u.h - 52, w: 98, h: 20, label: '<', enabled: this.page > 0, onClick: () => { this.page--; this.layout(); } },
        { x: cx + 52, y: u.h - 52, w: 100, h: 20, label: '>', enabled: this.page < pages - 1, onClick: () => { this.page++; this.layout(); } },
        { x: cx - 152, y: u.h - 28, w: 98, h: 20, label: '返回', onClick: () => this.game.ui.open(this.parent || new TitleScreen(this.game)) },
      );
    }
    drawExtra(ui) { const c = ui.ctx, cx = ui.w / 2; Font.center(c, this.busy ? '正在读取插件目录…' : '点插件名切换启用状态', cx, 30, '#8FA8C8'); }
  }

  class MyServersScreen extends MenuScreen {
    constructor(game, parent) { super(game, '我的服务器'); this.parent = parent; this.mine = []; this.load(); }
    async load() {
      try {
        const r = await ServerService.list();
        // ownerKey 只在服务端用于鉴权，列表里用创建者名字 + 本机记录判断
        const mine = JSON.parse(localStorage.getItem('itlzmc.myServers') || '[]');
        this.mine = (r.servers || []).filter((s) => mine.includes(s.code));
      } catch (e) { this.mine = []; }
      this.layout();
    }
    layout() {
      const u = this.game.ui, cx = u.w / 2;
      this.widgets = [];
      this.mine.forEach((s, i) => {
        this.widgets.push({ x: cx - 152, y: 44 + i * 24, w: 200, h: 20, label: fitText(s.name + ' · ' + s.code, 190),
          tip: [s.motd || '', s.players + '/' + s.max + ' 人'], onClick: () => this.game.ui.open(new ServerManageScreen(this.game, this, s)) });
      });
      if (!this.mine.length) this.widgets.push({ x: cx - 152, y: 44, w: 304, h: 20, label: '还没有创建过服务器', enabled: false });
      this.widgets.push(
        { x: cx - 152, y: u.h - 52, w: 98, h: 20, label: '创建服务器', onClick: () => this.game.ui.open(new CreateServerScreen(this.game, this.parent)) },
        { x: cx + 52, y: u.h - 52, w: 100, h: 20, label: '返回', onClick: () => this.game.ui.open(this.parent || new TitleScreen(this.game)) },
      );
    }
  }

  class ServerManageScreen extends FormScreen {
    constructor(game, parent, s) {
      super(game, '管理 · ' + s.code, parent);
      this.s = s; this.motd = s.motd || ''; this.sname = s.name || '';
      this.plugins = (s.pluginIds || []).slice(); this.cat = [];
      this.load();
    }
    async load() { try { const r = await ServerService.catalog(); this.cat = r.plugins || []; } catch (e) { } this.layout(); }
    layout() {
      const u = this.game.ui, cx = u.w / 2;
      this.fields = {};
      this.addField('sname', cx - 152, 42, 148, '名称', 40, (v) => v.slice(0, 40));
      this.addField('motd', cx + 4, 42, 148, '公告', 60, (v) => v.slice(0, 60));
      this.widgets = [
        { x: cx - 152, y: 88, w: 98, h: 20, label: '保存设置', gold: true, onClick: () => this.save() },
        { x: cx - 50, y: 88, w: 98, h: 20, label: () => this.s.paused ? '恢复运行' : '暂停服务器',
          onClick: () => this.save({ paused: !this.s.paused }) },
        { x: cx + 52, y: 88, w: 100, h: 20, label: '复制邀请链接', onClick: () => {
          const t = ServerService.link(this.s.code);
          this.game.ui.message(copyText(t) ? '邀请链接已复制，发给朋友就能加入' : '复制失败，邀请码是 ' + this.s.code, '#86EFAC');
        } },
        { x: cx - 152, y: 112, w: 98, h: 20, label: '插件开关', onClick: () => this.game.ui.open(new ServerPluginPickScreen(this.game, this)) },
        { x: cx + 52, y: 112, w: 100, h: 20, label: '删除服务器', onClick: () => this.remove() },
        { x: cx - 152, y: u.h - 28, w: 98, h: 20, label: '返回', onClick: () => this.back() },
      ];
      if (this.field) this.focus(this.field);
    }
    async save(extra) {
      try {
        const r = await ServerService.manage(this.s.code, Object.assign({ name: this.sname, motd: this.motd, plugins: this.plugins }, extra || {}));
        this.s = Object.assign(this.s, r.server || {});
        this.say('设置已保存');
      } catch (e) { this.say(e.message || '保存失败（只有创建者或管理员能改）', true); }
      this.layout();
    }
    async remove() {
      try { await ServerService.remove(this.s.code); this.game.ui.message('服务器已删除', '#FF8080'); this.back(); }
      catch (e) { this.say(e.message || '删除失败', true); this.layout(); }
    }
    drawExtra(ui) {
      const c = ui.ctx, cx = ui.w / 2;
      Font.center(c, this.s.name + ' · ' + this.s.code + ' · ' + this.s.players + '/' + this.s.max + ' 人', cx, 146, '#7FD8FF');
      Font.center(c, '种子 ' + this.s.seed + ' · 长期运行 · 房主退出不停服', cx, 160, '#8FA8C8');
      Font.center(c, '已启用插件：' + (this.plugins.length ? this.plugins.join('、') : '无'), cx, 176, '#86EFAC');
      if (this.note) Font.center(c, this.note, cx, 196, this.noteColor);
    }
  }

  // -------------------------------------------------------------------------
  // 引擎挂钩
  // -------------------------------------------------------------------------
  // 方块变更上报（链式包住 p2p.js 已挂过的 setBlock）
  const sb = World.prototype.setBlock;
  World.prototype.setBlock = function (x, y, z, ...a) {
    const r = sb.call(this, x, y, z, ...a);
    if (r !== false && !srvApplying.n) {
      const g = window.game;
      if (g && g.serverLink && g.serverLink.state === 'joined' && g.world === this) {
        try {
          const id = this.getBlock(x, y, z), meta = this.getMeta(x, y, z), wl = this.isWaterlogged(x, y, z) ? 1 : 0;
          g.serverLink.outBlocks.push([x, y, z, id, meta, wl]);
        } catch (e) { }
      }
    }
    return r;
  };

  const tick0 = Game.prototype.tick;
  Game.prototype.tick = function () {
    tick0.call(this);
    if (this.serverLink && this.state === 'play') { try { this.serverLink.tick(); } catch (e) { } }
  };

  const qt0 = Game.prototype.quitToTitle;
  Game.prototype.quitToTitle = async function () {
    if (this.serverLink) { this.serverLink.leave(); this.serverLink = null; }
    qiumcHideParty();
    return qt0.call(this);
  };

  const rc0 = runCommand;
  runCommand = function (g, text) {
    if (g.serverLink && g.serverLink.state === 'joined') {
      if (text.startsWith('/')) { g.ui.message('服务器里暂不能使用命令', '#FF5555'); return; }
      g.ui.message('<' + g.serverLink.name + '> ' + text);
      g.serverLink.send({ t: 'chat', text });
      return;
    }
    return rc0(g, text);
  };

  // 大厅里点「进入」：先判断是不是常驻服务器，是就走服务器流程，否则沿用原来的本地房间流程
  const join0 = MultiplayerScreen.prototype.join;
  MultiplayerScreen.prototype.join = async function (code) {
    try {
      const r = await ServerService.get(code);
      if (r && r.ok && r.server) {
        this.okName && this.okName();
        this.game.ui.hideInput();
        return joinServer(this.game, code, this);
      }
    } catch (e) { /* 不是常驻服务器，走原来的流程 */ }
    return join0.call(this, code);
  };

  // 记住本机创建过的服务器
  const create0 = ServerService.create;
  ServerService.create = async function (b) {
    const r = await create0.call(this, b);
    try {
      const arr = JSON.parse(localStorage.getItem('itlzmc.myServers') || '[]');
      if (r && r.code && !arr.includes(r.code)) { arr.push(r.code); localStorage.setItem('itlzmc.myServers', JSON.stringify(arr.slice(-50))); }
    } catch (e) { }
    return r;
  };

  Q.ServerService = ServerService;
  Q.ServerLink = ServerLink;
  Q.ServerListScreen = ServerListScreen;
  Q.CreateServerScreen = CreateServerScreen;
  Q.ServerManageScreen = ServerManageScreen;
  Q.joinServer = joinServer;
  window.QIUMCServers = Q;
})();
