'use strict';
// ---------------------------------------------------------------------------
// Skins (game/ACCOUNT_PLAN.md「皮肤系统」): preset skins (skins_data.js, loaded when needed) and a premium player's
// skin looked up by name (the room service asks Mojang: skin, arm model AND the player's official cape). Classic (4 px) or slim
// (3 px) arms, the second layer, old 64 x 32 skins turned into 64 x 64 like vanilla; the first-person arm uses the
// skin too. In a room the web players tell each other what they wear (a 'look' message the room service passes on).
// Presets are free; a premium player's skin needs an unlock (Account.has('skin')); keeping a choice uses local storage.
// ---------------------------------------------------------------------------
const Skins = (() => {
  const canv = new Map();   // id -> 64 x 64 canvas
  const loading = new Map();
  let presetsP = null;
  function presets() {
    if (self.SKIN_PRESETS) return Promise.resolve(self.SKIN_PRESETS);
    if (!presetsP) presetsP = new Promise((res) => { const s = document.createElement('script'); s.src = 'js/skins_data.js'; s.onload = () => res(self.SKIN_PRESETS || []); s.onerror = () => res([]); document.head.appendChild(s); });
    return presetsP;
  }
  // an image -> a 64 x 64 skin canvas (vanilla SkinTextureDownloader.processLegacySkin for 64 x 32 ones)
  function normalize(img) {
    const cv = document.createElement('canvas'); cv.width = 64; cv.height = 64;
    // 这里要反复 getImageData：声明 willReadFrequently，避免浏览器每帧回读的性能警告
    const x = cv.getContext('2d', { willReadFrequently: true }); x.imageSmoothingEnabled = false;
    x.drawImage(img, 0, 0);
    if (img.height === 32) {
      const copy = (sx, sy, dx, dy, w, h) => { const d = x.getImageData(sx, sy, w, h), o = x.createImageData(w, h); for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) for (let k = 0; k < 4; k++) o.data[(j * w + i) * 4 + k] = d.data[(j * w + (w - 1 - i)) * 4 + k]; x.putImageData(o, sx + dx, sy + dy); };
      copy(4, 16, 16, 32, 4, 4); copy(8, 16, 16, 32, 4, 4); copy(0, 20, 24, 32, 4, 12); copy(4, 20, 16, 32, 4, 12); copy(8, 20, 8, 32, 4, 12); copy(12, 20, 16, 32, 4, 12);
      copy(44, 16, -8, 32, 4, 4); copy(48, 16, -8, 32, 4, 4); copy(40, 20, 0, 32, 4, 12); copy(44, 20, -8, 32, 4, 12); copy(48, 20, -16, 32, 4, 12); copy(52, 20, -8, 32, 4, 12);
    }
    // the base layer has no see-through pixels; a hat drawn fully opaque (old skins) is no hat at all
    const d = x.getImageData(0, 0, 64, 64), p = d.data, A = (i, j) => p[(j * 64 + i) * 4 + 3];
    const opaque = (x0, y0, x1, y1) => { for (let j = y0; j < y1; j++) for (let i = x0; i < x1; i++) p[(j * 64 + i) * 4 + 3] = 255; };
    opaque(0, 0, 32, 16); opaque(0, 16, 64, 32); opaque(16, 48, 48, 64);
    let full = true; for (let j = 0; j < 16 && full; j++) for (let i = 32; i < 64; i++) if (A(i, j) < 128) { full = false; break; }
    if (full) for (let j = 0; j < 16; j++) for (let i = 32; i < 64; i++) p[(j * 64 + i) * 4 + 3] = 0;
    x.putImageData(d, 0, 0);
    return cv;
  }
  const loadImg = (src) => new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(new Error('皮肤图片读不出来')); im.src = src; });
  // a skin's canvas: 'p:<preset id>' or 'm:<premium name>' (loaded once, then from memory)
  function load(id) {
    if (canv.has(id)) return Promise.resolve(canv.get(id));
    if (loading.has(id)) return loading.get(id);
    const p = (async () => {
      let src, slim = false;
      if (id.startsWith('p:')) { const s = (await presets()).find((q) => q.id === id.slice(2)); if (!s) throw new Error('没有这个皮肤'); src = s.png; slim = s.slim; }
      else if (id.startsWith('m:')) {
        let v = null; try { v = JSON.parse(localStorage.getItem('mcjs-skin-' + id.slice(2).toLowerCase()) || 'null'); } catch (e) { }
        if (!v || Date.now() - v.at > 86400e3) {
          try { v = await RoomService.api('/api/skin?name=' + encodeURIComponent(id.slice(2))); }
          catch (e) { throw new Error(/连不上|没有响应|没有回应/.test(e.message) ? '皮肤服务暂时不可用：请确认 ITLZMC 服务已启动（预设皮肤仍可正常使用）' : e.message); }
          v.at = Date.now();
          try { localStorage.setItem('mcjs-skin-' + id.slice(2).toLowerCase(), JSON.stringify(v)); } catch (e) { }
        }
        src = 'data:image/png;base64,' + v.png; slim = v.slim;
      } else throw new Error('皮肤编号不对');
      const cv = normalize(await loadImg(src)); cv.slim = slim;
      canv.set(id, cv);
      return cv;
    })();
    loading.set(id, p);
    p.catch(() => loading.delete(id));
    return p;
  }
  // a look ({skin: id, slim, cape}) -> what to draw; skins still loading show Steve meanwhile
  const keyOf = (id) => 'skin_' + id.replace(/[^A-Za-z0-9_:]/g, '_');
  function tex(r, id) {
    if (!id) return 'steve';
    const k = keyOf(id);
    if (r.entityTex[k]) return k;
    const cv = canv.get(id);
    if (cv) { r.entityTex[k] = r.tex2D(cv, false); return k; }
    load(id).catch(() => { });
    return 'steve';
  }
  // this player's look: the preview being chosen, else the local profile's (a premium skin once unlocked)
  let preview = null;
  function lookOf(g, e) {
    if (e === g.player) {
      if (preview) return preview;
      const s = Account.data && Account.data.skin;
      if (!s) return null;
      if (s.skin && s.skin.startsWith('m:') && !Account.has('skin')) return { skin: null, slim: false, cape: s.cape };
      return s;
    }
    return e.look || null;
  }
  function initModels(r) {
    if (r.models.steve_slim) return;
    const P = (parts) => { for (const p of parts) p.mesh = r.makeModelPart(p.boxes, 64, 64); return { parts }; };
    // slim arms (vanilla PlayerModel slim: 3 px wide, the pivot in the same place)
    r.models.steve_slim = P(r.models.steve.parts.map((p) => {
      if (p.name === 'rarm') return { name: 'rarm', pivot: [5.5, 22, 0], boxes: [[40, 16, -1.5, -10, -2, 3, 12, 4], [40, 32, -1.5, -10, -2, 3, 12, 4, 0.25]] };
      if (p.name === 'larm') return { name: 'larm', pivot: [-5.5, 22, 0], boxes: [[32, 48, -1.5, -10, -2, 3, 12, 4], [48, 48, -1.5, -10, -2, 3, 12, 4, 0.25]] };
      return { name: p.name, pivot: p.pivot, boxes: p.boxes, rotX: p.rotX, rotY: p.rotY, parent: p.parent };
    }));
    r.models.arm_slim = P([{ name: 'arm', pivot: [0, 0, 0], boxes: [[40, 16, -1.5, -10, -2, 3, 12, 4], [40, 32, -1.5, -10, -2, 3, 12, 4, 0.25]] }]);
    r.models.arm_left_slim = P([{ name: 'arm', pivot: [0, 0, 0], boxes: [[32, 48, -1.5, -10, -2, 3, 12, 4], [48, 48, -1.5, -10, -2, 3, 12, 4, 0.25]] }]);
  }
  // 正版玩家的官方披风：和皮肤共用一份 /api/skin 缓存，返回 data:image/png;base64,... 或 null。
  // 联机时只要 look.cape = 'c:<玩家名>'，其他客户端用它自己拉取同一张披风，不必在消息里塞图片。
  async function capeFor(name) {
    const key = 'mcjs-skin-' + String(name).toLowerCase();
    let v = null;
    try { v = JSON.parse(localStorage.getItem(key) || 'null'); } catch (e) { }
    if (!v || v.error || Date.now() - v.at > 86400e3) {
      try {
        v = await RoomService.api('/api/skin?name=' + encodeURIComponent(name));
        if (!v || v.error) return null;
        v.at = Date.now();
        try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) { }
      } catch (e) { return null; }
    }
    return v && v.cape ? 'data:image/png;base64,' + v.cape : null;
  }
  const api = {
    presets, load, normalize, capeFor,
    modelOf(g, e) { const l = lookOf(g, e); if (l && l.slim) { initModels(g.renderer); return 'steve_slim'; } return 'steve'; },
    texOf(g, e) { const l = lookOf(g, e); return tex(g.renderer, l && l.skin); },
    armOf(g, left) { const l = lookOf(g, g.player); if (l && l.slim) { initModels(g.renderer); return left ? 'arm_left_slim' : 'arm_slim'; } return left ? 'arm_left' : 'arm'; },
    setPreview(l) { preview = l; },
    preview() { return preview; },
    // what this player wears, for the others in a room (and the decorations it owns: cosmetics.js)
    mine(g) {
      const l = lookOf(g, g.player) || {};
      const id = Capes.of(g, g.player);
      // 本地上传的自定义披风把图片一起发给房间里的其他人；官方披风按玩家名各自去拉，不占消息体积
      const cd = (id && Capes.dataUrl) ? Capes.dataUrl(id) : null;
      return { skin: l.skin || null, slim: !!l.slim, cape: id, capeData: cd,
        ...(typeof Cosmetics !== 'undefined' ? Cosmetics.mine(g) : {}) };
    },
  };
  return api;
})();

// ---- in a room: tell the others what this player wears, and take theirs ----
(() => {
  // (hat, pet, pre: the decorations' names, cosmetics.js - the room service checked they are owned)
  const word = (v) => !v || /^[a-z]{3,16}$/.test(String(v));
  const capeData = (v) => !v || (typeof v === 'string' && /^data:image\/(png|jpeg);base64,/.test(v) && v.length <= 60000);
  const ok = (l) => l && typeof l === 'object' && (l.skin === null || /^(p:[a-z_]{3,20}|m:[A-Za-z0-9_]{3,16})$/.test(l.skin || '')) && (!l.cape || Capes.info(l.cape)) && capeData(l.capeData) && word(l.hat) && word(l.pet) && word(l.pre);
  const om = NetClient.prototype.onMessage;
  NetClient.prototype.onMessage = function (m) {
    if (m && m.t === 'look') {
      if (!ok(m.look)) return;
      const look = { skin: m.look.skin || null, slim: !!m.look.slim, cape: m.look.cape || null,
        capeData: m.look.capeData || null, hat: m.look.hat || null, pet: m.look.pet || null, pre: m.look.pre || null };
      (this.looks || (this.looks = new Map())).set(String(m.name), look);
      for (const e of this.g.entities) if (e.type === 'player' && e.name === m.name) e.look = look;
      // 自定义披风：图片随 look 一起到达，注册后下一帧就能画出来
      if (look.capeData && typeof Capes !== 'undefined' && Capes.registerPremium) Capes.registerPremium(look.cape, look.capeData, false);
      return;
    }
    const r = om.call(this, m);
    if (m && m.t === 'room') this.sendLook();
    return r;
  };
  NetClient.prototype.sendLook = function () { try { this.send({ t: 'look', look: Skins.mine(this.g) }); } catch (e) { } };
  // a player who appears gets the look already known for its name
  const dm = Game.prototype.drawMob;
  Game.prototype.drawMob = function (e, ip, a, env, l) {
    if (e.type === 'player' && e !== this.player && !e.look && this.net && this.net.looks) e.look = this.net.looks.get(e.name) || null;
    return dm.call(this, e, ip, a, env, l);
  };
})();

// ---- 皮肤和装饰: a turning 3D preview, the skins, the capes, the hats, pets and name prefixes (cosmetics.js);
// locked ones say how to get them ----
class WardrobeScreen extends FormScreen {
  constructor(game, parent) {
    super(game, '皮肤和装饰', parent); this.titleY = 8;
    const s = (Account.data && Account.data.skin) || {};
    this.look = { skin: s.skin || null, slim: !!s.slim, cape: s.cape || null, hat: s.hat || null, pet: s.pet || null, pre: s.pre || null };
    this.tab = 'skin'; this.page = 0; this.mojang = s.skin && s.skin.startsWith('m:') ? s.skin.slice(2) : ''; this.list = [];
    this.yaw = 0.5; this.drag = null; this.busy = false;
    Skins.presets().then((l) => { this.list = l; for (const p of l) Skins.load('p:' + p.id).catch(() => { }); if (this.game.ui.screen === this) this.layout(); });
    Account.loadGate();
  }
  get dirty() {
    const s = (Account.data && Account.data.skin) || {};
    return (s.skin || null) !== this.look.skin || !!s.slim !== this.look.slim || ['cape', 'hat', 'pet', 'pre'].some((k) => (s[k] || null) !== (this.look[k] || null));
  }
  // a sign-in reward not owned yet: to the sign-in card (checkin.js), else a line saying how
  toCheckin(id) {
    if (this.giftOf(id) && typeof NewsBoard !== 'undefined') { NewsBoard.open(this.game, this, false); return; }
    if (typeof CheckinScreen !== 'undefined' && typeof Checkin !== 'undefined' && Checkin.shown()) this.game.ui.open(new CheckinScreen(this.game, this));
    else this.say('签到活动奖励：活动期间每天登录签到，累计签到就能领');
  }
  // how a locked sign-in reward is got: its day in the event's rewards as last read (checkin.js keeps it, also
  // across reloads; the server may change the order, so never hardcoded), else just that it's a reward
  // an announcement's gift (news.js): the published announcement that gives it
  giftOf(id) { return !!id && typeof NewsBoard !== 'undefined' && (NewsBoard.list || []).some((x) => x.gift === id && !x.draft); }
  evHow(id) {
    if (this.giftOf(id)) return ['公告里的礼物', '点一下去领取'];
    const st = typeof Checkin !== 'undefined' && Checkin.st, R = st && st.event && Array.isArray(st.event.rewards) ? st.event.rewards : [];
    const i = R.indexOf(id);
    return [i >= 0 ? '签到第 ' + (i + 1) + ' 天' : '签到活动奖励', ...(typeof Checkin !== 'undefined' && Checkin.shown() ? ['点一下去签到'] : [])];
  }
  pv() { const u = this.game.ui; return { x: Math.max(8, Math.floor(u.w / 2 - 190)), y: 26, w: 110, h: 170 }; }
  layout() {
    const u = this.game.ui, g = this.game, P = this.pv(), x0 = P.x + P.w + 10, W = Math.min(270, u.w - x0 - 8);
    this.fields = {}; this.widgets = [];
    const TABS = [['skin', '皮肤'], ['cape', '披风'], ['hat', '帽子'], ['pet', '宠物'], ['pre', '前缀']], tw = W / TABS.length;
    TABS.forEach(([k, cn], i) => this.widgets.push({ x: Math.round(x0 + i * tw), y: 24, w: Math.round(x0 + (i + 1) * tw) - Math.round(x0 + i * tw) - 2, h: 18, label: cn,
      color: this.tab === k ? '#FFFF55' : undefined, onClick: () => { this.tab = k; this.page = 0; this.layout(); } }));
    const cell = 30, cols = Math.max(3, Math.floor(W / cell)), y0 = 48;
    if (this.tab === 'skin') {
      const items = [{ id: null, name: '默认（史蒂夫）' }, ...this.list.filter((p) => p.own)];
      items.forEach((p, i) => {
        const cx = x0 + (i % cols) * cell, cy = y0 + Math.floor(i / cols) * (cell + 2);
        this.widgets.push({ x: cx, y: cy, w: cell - 2, h: cell - 2, label: '', skinIcon: p.id, sel: (p.id ? 'p:' + p.id : null) === this.look.skin, tip: [p.name + (p.id ? (p.slim ? '（纤细）' : '（经典）') : '')],
          onClick: () => { this.look.skin = p.id ? 'p:' + p.id : null; this.look.slim = !!p.slim; this.layout(); } });
      });
      const yy = y0 + Math.ceil(items.length / cols) * (cell + 2) + 6;
      this.widgets.push({ x: x0, y: yy, w: W, h: 18, label: () => '手臂：' + (this.look.slim ? '纤细（3 像素，Alex）' : '经典（4 像素，Steve）'), onClick: () => { this.look.slim = !this.look.slim; } });
      if (Account.has('skin')) {
        this.addField('mojang', x0, yy + 36, W - 54, '正版玩家的皮肤（输入玩家名）', 16, nameOnly);
        this.widgets.push({ x: x0 + W - 50, y: yy + 36, w: 50, h: 20, label: () => (this.busy ? '…' : '使用'), enabled: !this.busy, onClick: () => this.useMojang() });
      } else this.widgets.push({ x: x0, y: yy + 26, w: W, h: 20, gold: true, label: '离线版已解锁全部皮肤', onClick: () => g.ui.open(new UnlockScreen(g, this)) });
    } else if (this.tab === 'cape') {
      const items = [{ id: null, name: '不穿披风' }, ...Capes.list.filter((c) => !c.admin || Capes.unlocked(c.id))];
      items.forEach((c, i) => {
        const cx = x0 + (i % cols) * cell, cy = y0 + Math.floor(i / cols) * (cell + 12);
        const locked = c.id && !Capes.unlocked(c.id);
        // (event capes: owned once claimed, not unlocked by platform actions)
        const how = c.ev ? this.evHow('cape:' + c.id) : ['离线版已默认解锁'];
        this.widgets.push({ x: cx, y: cy, w: cell - 2, h: cell + 8, label: '', capeIcon: c.id, locked, sel: c.id === this.look.cape,
          tip: [c.name + (c.anim ? '（动态）' : ''), ...(locked ? how : [])],
          onClick: () => { if (locked && c.ev) this.toCheckin('cape:' + c.id); else if (locked) g.ui.open(new UnlockScreen(g, this, '离线版已默认解锁全部披风')); else { this.look.cape = c.id; this.layout(); } } });
      });
      // 同步披风：正版玩家官方披风 / 本地 PNG，保存后联机自动同步
      const cy = y0 + Math.ceil(items.length / cols) * (cell + 12) + 4;
      this.addField('mojang', x0, cy + 26, W - 54, '正版玩家的官方披风（输入玩家名）', 16, nameOnly);
      this.widgets.push({ x: x0 + W - 50, y: cy + 26, w: 50, h: 20, label: () => (this.busy ? '…' : '同步'), enabled: !this.busy, onClick: () => this.useMojangCape() });
      this.widgets.push({ x: x0, y: cy + 50, w: W, h: 20, label: '上传本地 PNG 当披风（联机也会同步）', onClick: () => this.uploadCape() });
      if (typeof this.look.cape === 'string' && this.look.cape.indexOf('c:') === 0)
        this.widgets.push({ x: x0, y: cy + 72, w: W, h: 20, label: () => '当前：已同步披风 ' + this.look.cape.slice(2) + '（点此取消）', onClick: () => { this.look.cape = null; this.layout(); } });
    } else {
      // hats, pets, name prefixes (cosmetics.js): 'none' first, then each with its icon; all sign-in rewards for now
      const k = this.tab, C = typeof Cosmetics !== 'undefined' ? Cosmetics : null;
      const items = [{ id: null, name: { hat: '不戴帽子', pet: '不带宠物', pre: '不用前缀' }[k] }, ...(C ? C.LIST.filter((d) => d.kind === k) : [])];
      items.forEach((d, i) => {
        const cx = x0 + (i % cols) * cell, cy = y0 + Math.floor(i / cols) * (cell + 2);
        const v = d.id ? d.id.split(':')[1] : null, locked = !!d.id && !C.has(d.id);
        this.widgets.push({ x: cx, y: cy, w: cell - 2, h: cell - 2, label: '', cosIcon: d.id, locked, sel: v === (this.look[k] || null),
          tip: [d.name, ...(locked ? this.evHow(d.id) : [])],
          onClick: () => { if (locked) this.toCheckin(d.id); else { this.look[k] = v; this.layout(); } } });
      });
    }
    this.widgets.push(
      { x: P.x, y: u.h - 28, w: 110, h: 20, label: () => (this.busy ? '正在保存…' : this.dirty ? '保存' : '已保存'), gold: this.dirty, enabled: !this.busy && this.dirty, onClick: () => this.saveLook() },
      { x: P.x + 116, y: u.h - 28, w: 110, h: 20, label: '返回', onClick: () => this.back() },
    );
  }
  async useMojang() {
    const n = nameOnly(this.mojang || '');
    if (n.length < 3) { this.say('输入正版玩家名（3–16 个英文字母、数字或下划线）', true); return; }
    this.busy = true; this.say('正在查找 ' + n + ' 的皮肤和披风…'); this.layout();
    try {
      const cv = await Skins.load('m:' + n);
      this.look.skin = 'm:' + n; this.look.slim = !!cv.slim;
      let tail = '（这位玩家没有官方披风，可到披风页签自己选或上传 PNG）';
      try {
        const src = await Skins.capeFor(n);
        if (src && await Capes.registerPremium('c:' + n, src, false)) { this.look.cape = 'c:' + n; tail = '，并同步了官方披风'; }
      } catch (e) { tail = '（披风暂时没取到，皮肤已同步）'; }
      this.say('找到了：' + n + (cv.slim ? '（纤细手臂）' : '（经典手臂）') + tail);
    } catch (e) { this.say(e.message, true); }
    this.busy = false; this.layout();
  }
  // 披风页签：只同步官方披风，不动皮肤
  async useMojangCape() {
    const n = nameOnly(this.mojang || '');
    if (n.length < 3) { this.say('先填正版玩家名（3–16 个英文字母、数字或下划线）', true); return; }
    this.busy = true; this.say('正在查找 ' + n + ' 的官方披风…'); this.layout();
    try {
      const src = await Skins.capeFor(n);
      if (!src) this.say('这位玩家没有官方披风（可以上传本地 PNG 当披风）', true);
      else if (await Capes.registerPremium('c:' + n, src, false)) { this.look.cape = 'c:' + n; this.say('已同步 ' + n + ' 的官方披风，保存后在联机里也能被看到'); }
      else this.say('披风图片读不出来，换一位玩家试试', true);
    } catch (e) { this.say(e.message, true); }
    this.busy = false; this.layout();
  }
  // 本地 PNG 披风：缩到 64 x 32 的 vanilla cape layout，存本机，并随 look 同步给房间里的其他人
  uploadCape() {
    let el = document.getElementById('itlzmc-cape-file');
    if (!el) {
      el = document.createElement('input'); el.type = 'file'; el.id = 'itlzmc-cape-file';
      el.accept = 'image/png,image/*'; el.style.display = 'none'; document.body.appendChild(el);
    }
    el.value = '';
    el.onchange = () => {
      const f = el.files && el.files[0]; if (!f) return;
      const fr = new FileReader();
      fr.onload = async () => {
        const id = 'c:u' + Math.random().toString(36).slice(2, 6);
        const src = String(fr.result);
        if (await Capes.registerPremium(id, src, true)) {
          this.look.cape = id; Capes.saveCustom(id, src);
          this.say('已启用自定义披风，保存后联机会自动同步给房间里的其他人');
        } else this.say('图片读不出来，请用 PNG', true);
        this.layout();
      };
      fr.readAsDataURL(f);
    };
    el.click();
  }
  async saveLook() {
    if (!Account.loggedIn) { this.game.ui.open(new LoginScreen(this.game, () => this.game.ui.open(this))); return; }
    this.busy = true; this.layout();
    try { await Account.update({ skin: { ...this.look } }); this.say('已保存'); if (this.game.net) this.game.net.sendLook(); }
    catch (e) { this.say(e.message, true); }
    this.busy = false; this.layout();
  }
  back() { Skins.setPreview(null); super.back(); }
  mouseDown(ui, mx, my, b) { const P = this.pv(); if (mx >= P.x && mx < P.x + P.w && my >= P.y && my < P.y + P.h) { this.drag = { x: mx, yaw: this.yaw }; return; } super.mouseDown(ui, mx, my, b); }
  mouseMove(ui, mx, my) { if (this.drag && ui.mouse.down) this.yaw = this.drag.yaw + (mx - this.drag.x) * 0.03; else super.mouseMove(ui, mx, my); }
  mouseUp(ui) { this.drag = null; super.mouseUp(ui); }
  draw(ui) {
    // the widgets with pictures (skins' faces, capes) are drawn here; the rest as usual
    // (the tooltips last, over the pictures: FormScreen.draw puts them right after the buttons)
    const pics = this.widgets.filter((w) => w.skinIcon !== undefined || w.capeIcon !== undefined || w.cosIcon !== undefined);
    const tips = this.widgets.filter((w) => w.tip);
    for (const w of tips) { w.tip0 = w.tip; w.tip = null; }
    try { super.draw(ui); } finally { for (const w of tips) { w.tip = w.tip0; delete w.tip0; } }
    const c = ui.ctx;
    for (const w of pics) {
      c.strokeStyle = w.sel ? '#FFFFFF' : '#555555'; c.lineWidth = 1; c.strokeRect(w.x + 0.5, w.y + 0.5, w.w - 1, w.h - 1);
      if (w.skinIcon !== undefined) {
        const img = w.skinIcon ? this.faceOf('p:' + w.skinIcon) : this.game.renderer.images.steve;
        if (img) { c.drawImage(img, 8, 8, 8, 8, w.x + 4, w.y + 4, w.w - 8, w.h - 8); c.drawImage(img, 40, 8, 8, 8, w.x + 3, w.y + 3, w.w - 6, w.h - 6); }
      } else if (w.capeIcon) { Capes.drawFlat(c, w.capeIcon, w.x + 4, w.y + 3, 2, w.locked); if (w.locked) drawIcon(c, 'lock', w.x + w.w - 11, w.y + w.h - 11, 1, '#FFD24A'); }
      else if (w.cosIcon) { Cosmetics.drawIcon(c, w.cosIcon, w.x + 2, w.y + 2, w.w - 4, w.locked); if (w.locked) drawIcon(c, 'lock', w.x + w.w - 11, w.y + w.h - 11, 1, '#FFD24A'); }
      else Font.center(c, '无', w.x + w.w / 2, w.y + w.h / 2 - 4, '#A0A0A0');
    }
    for (const w of tips) if (ui.hit(w)) ui.tooltip(w.tip.map((t) => ({ text: t })), ui.mouse.x, ui.mouse.y);
  }
  faceOf(id) { const s = this.faceCache || (this.faceCache = new Map()); if (s.has(id)) return s.get(id); Skins.load(id).then((cv) => s.set(id, cv)).catch(() => { }); return null; }
  drawExtra(ui) {
    const c = ui.ctx, P = this.pv(), g = this.game;
    drawCard(c, P.x - 2, P.y - 2, P.w + 4, P.h + 4, false);
    // the turning preview (it turns by itself unless dragged)
    if (!this.drag) this.yaw += 0.01;
    Skins.setPreview(this.look);
    const cv = g.renderer.playerPreview(g, ui, P.x, P.y, P.w, P.h, { yaw: this.yaw });
    Skins.setPreview(null);
    if (cv) { c.imageSmoothingEnabled = false; c.drawImage(cv, P.x, P.y, P.w, P.h); }
    // (on the prefix page: the name as others will see it)
    if (this.tab === 'pre' && typeof Cosmetics !== 'undefined') Font.center(c, fitText(Cosmetics.preChar(this.look.pre) + ((Account.loggedIn && Account.name) || '玩家'), P.w - 4), P.x + P.w / 2, P.y + 4, '#FFFFFF');
    Font.center(c, '拖动可以转动', P.x + P.w / 2, P.y + P.h + 4, '#808080');
    this.drawFields(ui);
    if (!Account.loggedIn) Font.center(c, fitText('登录后才能保存（换设备、联机时别人也能看到）', ui.w - 8), ui.w / 2, ui.h - 42, '#FFD24A');
  }
}
