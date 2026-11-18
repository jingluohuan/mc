'use strict';
// ---------------------------------------------------------------------------
// ITLZMC 原生插件系统（Plugin System / API 1.0）
//
// 只支持 ITLZMC 原生插件，不加载任何 Mod / 模组（无 Forge / Fabric / .jar）。
//   1. JS 插件 .js：ITLZMC.plugin(meta, factory)，注册贴图 / 方块 / 物品 /
//      配方 / 指令，并通过事件总线修改游戏机制（blockBreak / dropItem /
//      damage / useItem / command / craft…）。
//   2. 插件包 .zip：plugin.json 清单 + main 入口 JS + 贴图资源，纯数据驱动。
//   3. 插件市场：标题界面进入，官方插件一键安装、创作自己的插件、
//      一键下载 AI Skill。全部代码内嵌本机，零外部依赖。
//
// 加载时序：本脚本是最后一个 <script src>；main.js 在 new Game() 之前
// await ITLZMC.Plugins.ready()，所以注册内容与图集重绘都会在 Renderer 之前就绪。
// 每个插件单独隔离，出错只写进自己的记录，不影响其它插件和游戏本体。
// ---------------------------------------------------------------------------
(function () {
  const LS_USER = 'itlzmc.plugins.user';    // 用户手填的插件 URL 列表
  const LS_OFF = 'itlzmc.plugins.disabled'; // 被禁用的插件 id 列表
  const cols = () => ASSETS.cols || 64;
  const records = [];                      // 已发现/已加载的插件记录
  const serverPluginIds = new Set();       // 常驻服务器下发过的插件（幂等，不重复加载）
  const listeners = new Map();             // 事件名 -> 回调数组
  const textureOverrides = [];             // { idx, url }，最后统一重绘图集
  let readyPromise = null, flushDone = false;
  const API_VERSION = '1.0';
  const PLUGINS = [];              // 插件运行时：{ manifest, counts }
  const COMMANDS_META = {};        // 插件注册的指令元数据（名称 / 用法 / 说明）
  let currentGame = null;

  const Q = window.ITLZMC || (window.ITLZMC = {});

  function readJSON(key, fallback) {
    try { const v = JSON.parse(localStorage.getItem(key) || 'null'); return v == null ? fallback : v; }
    catch (e) { return fallback; }
  }
  function writeJSON(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { } }
  const stripNs = (s) => String(s || '').replace(/^[A-Za-z0-9_.-]+:/, '');
  const q = () => {
    const v = new URL(location.href).searchParams.get('sharecode');
    return v ? '?sharecode=' + encodeURIComponent(v) : '';
  };
  const fullUrl = (u) => /^(https?:)?\/\//i.test(u) || u.startsWith('/') ? u : u;

  // ---- 最小 ZIP 读取器（EOCD + central directory，deflate-raw 用浏览器原生解压） ----
  async function unzip(arrayBuffer) {
    const dv = new DataView(arrayBuffer), u8 = new Uint8Array(arrayBuffer);
    let eocd = -1;
    for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65558); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('不是有效的 .zip 文件');
    const count = dv.getUint16(eocd + 10, true);
    let off = dv.getUint32(eocd + 16, true);
    const dec = new TextDecoder('utf-8');
    const out = new Map();
    for (let i = 0; i < count; i++) {
      if (off + 46 > u8.length || dv.getUint32(off, true) !== 0x02014b50) break;
      const method = dv.getUint16(off + 10, true);
      const csize = dv.getUint32(off + 20, true);
      const nameLen = dv.getUint16(off + 28, true);
      const extraLen = dv.getUint16(off + 30, true);
      const commentLen = dv.getUint16(off + 32, true);
      const localOff = dv.getUint32(off + 42, true);
      const name = dec.decode(u8.subarray(off + 46, off + 46 + nameLen));
      off += 46 + nameLen + extraLen + commentLen;
      if (name.endsWith('/') || localOff + 30 > u8.length) continue;
      const lnameLen = dv.getUint16(localOff + 26, true);
      const lextraLen = dv.getUint16(localOff + 28, true);
      const start = localOff + 30 + lnameLen + lextraLen;
      const comp = u8.subarray(start, start + csize);
      let data;
      try {
        if (method === 0) data = comp;
        else if (method === 8) {
          if (typeof DecompressionStream === 'undefined') throw new Error('此浏览器不支持 zip 解压');
          const ds = new DecompressionStream('deflate-raw');
          const stream = new Blob([comp]).stream().pipeThrough(ds);
          data = new Uint8Array(await new Response(stream).arrayBuffer());
        } else continue;
      } catch (e) { continue; }
      out.set(name, data);
    }
    return out;
  }

  function pngURL(bytes) {
    let s = '';
    const CH = 0x8000;
    for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    return 'data:image/png;base64,' + btoa(s);
  }
  function loadImg(src) {
    return new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = () => rej(new Error('图片解码失败'));
      im.src = src;
    });
  }
  function text(bytes) { return new TextDecoder('utf-8').decode(bytes); }

  // ---- 新贴图：追加到图集尾部，返回 tile 索引 ----
  function registerTexture(name, dataURL) {
    let idx = ASSETS.tiles[name];
    if (idx === undefined) {
      if (typeof ASSETS.count !== 'number') throw new Error('贴图图集不可用');
      idx = ASSETS.count++;
      ASSETS.tiles[name] = idx;
    }
    textureOverrides.push({ idx, url: dataURL });
    return idx;
  }
  // 图集里有 559 个格子「有图案但没有名字」，按名字的资源包替换不到它们。
  // ITLZMC 扩展路径 assets/itlzmc/atlas/<索引>.png 直接按索引覆盖，补齐这块空位。
  function registerTextureAt(idx, dataURL) {
    if (!(idx >= 0) || idx >= (ASSETS.count || 0)) return false;
    textureOverrides.push({ idx, url: dataURL });
    return true;
  }

  // 把所有覆盖一次性画进 ASSETS.strip；必须在 Renderer 读取图集之前完成
  async function flushTextures() {
    if (flushDone || !textureOverrides.length) { flushDone = true; return; }
    flushDone = true;
    const need = Math.ceil(ASSETS.count / cols()) * 16;
    const img = await loadImg(ASSETS.strip);
    const cv = document.createElement('canvas');
    cv.width = Math.max(img.width, cols() * 16);
    cv.height = Math.max(img.height, need);
    const cx = cv.getContext('2d');
    cx.imageSmoothingEnabled = false;
    cx.drawImage(img, 0, 0);
    // 完整模板包有 2600+ 张贴图，逐个 await 解码会让启动卡住；并行解码后按序绘制，
    // 保持后加载的资源包覆盖先加载的这一语义。
    const decoded = await Promise.all(textureOverrides.map(async (o) => {
      try { return await loadImg(o.url); } catch (e) { return null; }
    }));
    for (let n = 0; n < textureOverrides.length; n++) {
      const tile = decoded[n];
      if (!tile) continue;
      const o = textureOverrides[n];
      const x = (o.idx % cols()) * 16, y = Math.floor(o.idx / cols()) * 16;
      cx.clearRect(x, y, 16, 16);
      cx.drawImage(tile, 0, 0, tile.width, tile.height, x, y, 16, 16);
    }
    ASSETS.strip = cv.toDataURL('image/png');
  }

  // ---- 插件包贴图：assets/**/textures + assets/itlzmc/atlas ----
  function applyPluginTextures(files) {
    let named = 0, atlas = 0;
    for (const [name, bytes] of files) {
      // ITLZMC 扩展：按 tile 索引覆盖图集里的无名格子
      let m = /(?:^|\/)assets\/itlzmc\/atlas\/(\d+)\.png$/i.exec(name);
      if (m) {
        if (registerTextureAt(parseInt(m[1], 10), pngURL(bytes))) atlas++;
        continue;
      }
      // 标准贴图路径：assets/<命名空间>/textures/**/<名字>.png
      // 兼容 block / item / entity / gui 等任意子目录与任意命名空间。
      m = /(?:^|\/)assets\/[A-Za-z0-9_.-]+\/textures\/(?:[^/]+\/)*([A-Za-z0-9_.-]+)\.png$/i.exec(name);
      if (!m) continue;
      const base = m[1], url = pngURL(bytes);
      const isItem = /\/textures\/(?:item|items)\//i.test(name);
      // block/ 与 item/ 严格分开：方块 3D 面贴图和背包 2D 图标是两套素材。
      // item/ 只认 i_ 前缀的图标名，找不到就跳过 —— 绝不回退到同名方块贴图，
      // 否则像 stone 这种「有方块贴图、无独立图标」的物品会被画成方块侧面。
      const keys = isItem ? ['i_' + base] : [base];
      let hit = false;
      for (const key of keys) {
        if (ASSETS.tiles[key] === undefined) continue;
        registerTexture(key, url);
        hit = true;
        break;
      }
      if (hit) named++;
    }
    return { named, atlas, total: named + atlas };
  }

  // ---- 空闲方块 ID：从 3900 往下找，避开红石线占用的 4080+ ----
  function allocId() {
    for (let id = 3900; id > 200; id--) {
      if (BLOCKS[id] == null && ITEMS[id] == null) return id;
    }
    throw new Error('没有可用的方块 ID');
  }

  // =========================================================================
  // 事件总线
  //   生命周期事件 tick / gameInit / ready / pluginsLoaded：回调收到 game（旧语义）
  //   机制事件（blockBreak / dropItem / damage / command / craft…）：回调收到
  //   一个可变 ctx：可改字段即改游戏行为；ctx.cancel() 可阻止原操作。
  // =========================================================================
  const PLUGIN_DEFAULTS = {
    id: '', name: '', version: '1.0.0', author: '', description: '',
    api: API_VERSION, capabilities: [], requires: [],
  };
  const CAP_CN = { texture: '贴图', mechanic: '机制', command: '指令', recipe: '配方' };
  const normCaps = (a) => Array.from(new Set((a || []).map((c) => CAP_CN[c] || c)));

  function makeCtx(o) {
    const c = Object.assign({ cancelled: false, result: undefined }, o || {});
    c.cancel = () => { c.cancelled = true; return c; };
    c.preventDefault = c.cancel;
    c.stop = c.cancel;
    return c;
  }
  function isCtx(x) {
    return !!(x && typeof x === 'object' && typeof x.cancel === 'function' && 'cancelled' in x);
  }
  function emit(event) {
    const rest = Array.prototype.slice.call(arguments, 1);
    const fns = (listeners.get(event) || []).slice();
    if (rest.length === 1 && isCtx(rest[0])) {
      const c = rest[0];
      for (const fn of fns) {
        try { fn(c); } catch (e) { console.warn('[ITLZMC 插件] ' + event + ' 回调出错', e); }
      }
      return c;
    }
    for (const fn of fns) {
      try { fn.apply(null, rest); } catch (e) { console.warn('[ITLZMC 插件] ' + event + ' 回调出错', e); }
    }
    return makeCtx({});
  }
  function emitCancelable(event, ctx) { return emit(event, ctx).cancelled; }

  function currentId() { return (Plugins._current && Plugins._current.id) || ''; }

  // 包装任意原型方法。before(args) 返回 ctx；before 可以直接改 args 数组，
  // 改动会传给原函数；ctx.cancelled 为真则跳过原函数并返回 ctx.result。
  function wrap(proto, name, before, after) {
    if (!proto || typeof proto[name] !== 'function') return false;
    const orig = proto[name];
    if (orig.__qiumcWrapped) return false;
    const wrapped = function () {
      const args = Array.prototype.slice.call(arguments);
      let c = null;
      if (before) {
        try { c = before.call(this, args); }
        catch (e) { console.warn('[ITLZMC 插件] ' + name + ' 前置钩子出错', e); }
      }
      if (c && c.cancelled) return c.result;
      const r = orig.apply(this, args);
      if (after) {
        try { after.call(this, r, c, args); }
        catch (e) { console.warn('[ITLZMC 插件] ' + name + ' 后置钩子出错', e); }
      }
      return r;
    };
    wrapped.__qiumcWrapped = true;
    proto[name] = wrapped;
    return true;
  }

  const PROTO_NAMES = {
    Game: () => (typeof Game !== 'undefined' ? Game.prototype : null),
    Player: () => (typeof Player !== 'undefined' ? Player.prototype : null),
    Living: () => (typeof Living !== 'undefined' ? Living.prototype : null),
    Mob: () => (typeof Mob !== 'undefined' ? Mob.prototype : null),
    World: () => (typeof World !== 'undefined' ? World.prototype : null),
    UI: () => (typeof UI !== 'undefined' ? UI.prototype : null),
    ContainerScreen: () => (typeof ContainerScreen !== 'undefined' ? ContainerScreen.prototype : null),
    CraftingScreen: () => (typeof CraftingScreen !== 'undefined' ? CraftingScreen.prototype : null),
    MenuScreen: () => (typeof MenuScreen !== 'undefined' ? MenuScreen.prototype : null),
  };
  function resolveProto(p) {
    if (p && typeof p === 'object') return p;
    const f = PROTO_NAMES[String(p)];
    return f ? f() : null;
  }

  // ---- 指令实现（支持 { fn, description, usage, aliases }） ----
  function addCommandImpl(name, def) {
    const n = String(name).replace(/^minecraft:/, '').replace(/^\//, '');
    if (!n) throw new Error('addCommand 需要名称');
    const o = (typeof def === 'function') ? { fn: def } : (def || {});
    if (typeof o.fn !== 'function') throw new Error('addCommand 需要函数或 { fn }');
    const owner = currentId();
    const fn = function (ctx, args) {
      const a = (args || []).slice();
      return o.fn.call(this, Object.assign({}, ctx, { args: a, name: n, plugin: owner }), a);
    };
    CMD_RUN[n] = fn;
    for (const al of (o.aliases || [])) {
      CMD_RUN[String(al).replace(/^\//, '').replace(/^minecraft:/, '')] = fn;
    }
    COMMANDS_META[n] = {
      name: n, description: o.description || '', usage: o.usage || ('/' + n),
      aliases: (o.aliases || []).slice(), plugin: owner,
    };
    return n;
  }

  function storageFor(id) {
    const key = 'itlzmc.plugin.' + id;
    const read = () => { try { return JSON.parse(localStorage.getItem(key) || '{}') || {}; } catch (e) { return {}; } };
    return {
      get(k, d) { const o = read(); return Object.prototype.hasOwnProperty.call(o, k) ? o[k] : d; },
      set(k, v) { const o = read(); o[k] = v; try { localStorage.setItem(key, JSON.stringify(o)); } catch (e) { } return v; },
      all() { return read(); },
      clear() { try { localStorage.removeItem(key); } catch (e) { } },
    };
  }

  // 插件按键引擎（js/plugin-keys.js，本文件之前加载）：桌面转发物理键、手机自动生成虚拟按钮
  const K = () => window.QIUMCKeys || { addKey: () => null, onKey: () => null, isDown: () => false, scan: () => 0, list: () => [] };

  // ---- 插件专属句柄：所有 API 自动计数并归属到当前插件 ----
  function makeHandle(m, rt) {
    const inc = (k) => { rt[k] = (rt[k] || 0) + 1; };
    return {
      id: m.id, meta: m, ITLZMC: Q, Plugins,
      on: (e, f) => { inc('hooks'); return Plugins.on(e, f); },
      once: (e, f) => { inc('hooks'); return Plugins.once(e, f); },
      off: (e, f) => Plugins.off(e, f),
      emit: (e, c) => Plugins.emit(e, c),
      defineBlock: (o) => { inc('blocks'); return Plugins.defineBlock(o); },
      defineItem: (o) => { inc('items'); return Plugins.defineItem(o); },
      addTexture: (n, u) => { inc('textures'); return Plugins.addTexture(n, u); },
      addTextureAt: (i, u) => { inc('textures'); return Plugins.addTextureAt(i, u); },
      addShaped: (...a) => { inc('recipes'); return Plugins.addShaped(...a); },
      addShapeless: (...a) => { inc('recipes'); return Plugins.addShapeless(...a); },
      addSmelting: (...a) => { inc('recipes'); return Plugins.addSmelting(...a); },
      addRecipe: (...a) => { inc('recipes'); return Plugins.addRecipe(...a); },
      addCommand: (n, d) => { inc('commands'); return Plugins.addCommand(n, d); },
      // 声明一个按键：桌面自动转发物理键，手机自动生成一个屏幕按钮（不用自己监听 keydown）
      addKey: (...a) => { inc('keybinds'); return K().addKey(...a); },
      key: (...a) => { inc('keybinds'); return K().addKey(...a); },
      bindKey: (...a) => { inc('keybinds'); return K().addKey(...a); },
      onKey: (...a) => { inc('keybinds'); return K().onKey(...a); },
      isKeyDown: (id) => K().isDown(id),
      intercept: (p, n, w) => Plugins.intercept(p, n, w),
      method: (p, n) => Plugins.method(p, n),
      config: (k, d) => Plugins.config(m.id, k, d),
      setConfig: (k, v) => Plugins.setConfig(m.id, k, v),
      storage: storageFor(m.id),
      game: () => Plugins.game(),
      player: () => Plugins.player(),
      world: () => Plugins.world(),
      give: (k, n) => Plugins.give(k, n),
      message: (t, c) => Plugins.message(t, c),
      log: (...a) => console.log('[ITLZMC:' + m.id + ']', ...a),
      warn: (...a) => console.warn('[ITLZMC:' + m.id + ']', ...a),
    };
  }

  const Plugins = {
    version: 'qiumc13',
    api: API_VERSION,

    // ---- 插件清单 ----
    plugin(meta, factory) {
      const m = Object.assign({}, PLUGIN_DEFAULTS, meta || {});
      if (!m.id) m.id = 'plugin-' + (records.length + 1);
      if (/[\\/]/.test(m.id)) throw new Error('插件 id 不能包含路径分隔符');
      for (const dep of (m.requires || [])) {
        if (!PLUGINS.some((p) => p.manifest.id === dep)) throw new Error('缺少依赖插件：' + dep);
      }
      if (PLUGINS.some((p) => p.manifest.id === m.id)) throw new Error('插件 id 重复：' + m.id);
      const rt = { manifest: m, hooks: 0, commands: 0, blocks: 0, items: 0, textures: 0, recipes: 0, keybinds: 0 };
      PLUGINS.push(rt);
      Plugins._current = m;
      Plugins._rt = rt;
      try {
        const handle = makeHandle(m, rt);
        if (typeof factory === 'function') factory(handle, m);
      } finally {
        Plugins._current = null;
        Plugins._rt = null;
      }
      return m;
    },
    register(meta, factory) { return this.plugin(meta, factory); },
    plugins() {
      return PLUGINS.map((p) => ({
        manifest: p.manifest,
        counts: { hooks: p.hooks, commands: p.commands, blocks: p.blocks,
                  items: p.items, textures: p.textures, recipes: p.recipes },
      }));
    },

    // ---- 内容注册 ----
    defineBlock(o) {
      if (!o || !o.key) throw new Error('defineBlock 需要 key');
      if (BID[o.key] !== undefined) return BLOCKS[BID[o.key]];
      const opts = Object.assign({}, o);
      delete opts.key; delete opts.cn; delete opts.png; delete opts.textures;
      delete opts.capabilities; delete opts.requires; delete opts.api;
      // 多面贴图：{ side/top/bottom/front: dataURL 或已注册贴图名 }
      if (o.textures) {
        const map = {};
        for (const face in o.textures) {
          const v = o.textures[face];
          if (typeof v === 'string' && v.indexOf('data:') === 0) {
            const nm = 'qiumc_' + o.key + '_' + face;
            registerTexture(nm, v);
            map[face] = nm;
          } else map[face] = v;
        }
        opts.tex = map;
      }
      if (o.png) opts.icon = registerTexture('i_' + o.key, o.png);
      return defBlock(allocId(), o.key, o.cn || o.key, opts);
    },
    defineItem(o) {
      if (!o || !o.key) throw new Error('defineItem 需要 key');
      if (ITEM_KEY[o.key] !== undefined) return ITEMS[ITEM_KEY[o.key]];
      const id = allocId();
      const icon = o.png ? registerTexture('i_' + o.key, o.png) : (o.icon != null ? o.icon : null);
      const it = { id, key: o.key, cn: o.cn || o.key, stack: o.stack || 64, fuel: o.fuel || 0, flat: null, icon };
      ITEMS[id] = it; ITEM_KEY[o.key] = id;
      return it;
    },
    addShaped(result, count, pattern, keys) { shaped(stripNs(result), count || 1, pattern, keys); },
    addShapeless(result, count, ingredients) { shapeless(stripNs(result), count || 1, ingredients.map(stripNs)); },
    addSmelting(from, to, xp) { smelt(stripNs(from), stripNs(to), xp || 0.1); },
    addRecipe(o) {
      if (!o || !o.type) throw new Error('addRecipe 需要 type');
      const t = String(o.type).replace(/^minecraft:/, '');
      if (t === 'shaped') return this.addShaped(o.result, o.count, o.pattern, o.keys);
      if (t === 'shapeless') return this.addShapeless(o.result, o.count, o.ingredients || []);
      if (t === 'smelting') return this.addSmelting(o.from, o.to, o.xp);
      throw new Error('未知配方类型：' + t);
    },
    addCommand(name, def) { return addCommandImpl(name, def); },
    commands() { return Object.assign({}, COMMANDS_META); },
    // ---- 插件按键：声明 / 查询 / 自动检测 ----
    addKey(...a) { return K().addKey(...a); },
    onKey(...a) { return K().onKey(...a); },
    isKeyDown(id) { return K().isDown(id); },
    keybinds() { return K().list(); },
    scanKeys(code, pid) { return K().scan(code, pid); },
    addTexture(name, dataURL) { return registerTexture(stripNs(name), dataURL); },
    addTextureAt(idx, dataURL) { return registerTextureAt(idx, dataURL); },

    // ---- 事件与机制 ----
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(fn);
      return () => this.off(event, fn);
    },
    once(event, fn) {
      const off = this.on(event, (c) => { off(); fn(c); });
      return off;
    },
    off(event, fn) {
      const a = listeners.get(event) || [];
      const i = a.indexOf(fn);
      if (i >= 0) a.splice(i, 1);
      return i >= 0;
    },
    emit(event) { return emit.apply(null, arguments); },
    emitCancelable,
    events() { return Array.from(listeners.keys()); },
    intercept(proto, name, wrapper) {
      const p = resolveProto(proto);
      if (!p || typeof p[name] !== 'function') throw new Error('找不到可包装的方法：' + name);
      if (typeof wrapper !== 'function') throw new Error('intercept 需要包装函数');
      const orig = p[name];
      p[name] = function () {
        const args = Array.prototype.slice.call(arguments);
        return wrapper.call(this, orig, args, this);
      };
      return () => { p[name] = orig; };
    },
    method(proto, name) { const p = resolveProto(proto); return p ? p[name] : null; },
    hookStats() { return HOOKED.slice(); },

    // ---- 运行时便捷 API ----
    game() { return currentGame || window.game || null; },
    player() { const g = this.game(); return g && g.player ? g.player : null; },
    world() { const g = this.game(); return g && g.world ? g.world : null; },
    give(key, count) {
      const g = this.game();
      if (!g || !g.player || !g.player.inv) return false;
      const id = ITEM_KEY[stripNs(key)];
      if (id === undefined) return false;
      try { g.player.inv.add({ id, count: Math.max(1, count || 1) }); return true; }
      catch (e) { return false; }
    },
    message(text, color) {
      const g = this.game();
      if (g && g.ui && typeof g.ui.message === 'function') g.ui.message(String(text), color || '#86EFAC');
    },
    config(id, key, fallback) { return storageFor(id).get(key, fallback); },
    setConfig(id, key, value) { return storageFor(id).set(key, value); },
    storage(id) { return storageFor(id || currentId()); },

    // ---- 加载与管理 ----
    list() { return records.slice(); },
    isEnabled(id) { return !readJSON(LS_OFF, []).includes(id); },
    toggle(id) {
      const off = readJSON(LS_OFF, []);
      const i = off.indexOf(id);
      if (i >= 0) off.splice(i, 1); else off.push(id);
      writeJSON(LS_OFF, off);
      return i < 0;
    },
    addUrl(url) {
      const list = readJSON(LS_USER, []);
      if (!list.includes(url)) { list.push(url); writeJSON(LS_USER, list); }
    },
    removeUrl(url) {
      writeJSON(LS_USER, readJSON(LS_USER, []).filter((x) => x !== url));
    },
    userUrls() { return readJSON(LS_USER, []); },
    ready() { return readyPromise || (readyPromise = boot()); },
    // 常驻服务器下发的原生插件：服务端给源码，客户端走同一套校验后加载；
    // 同一插件只加载一次（重连 / 重复下发都不会让插件失效或重复注册）。
    async loadServerPlugins(list) {
      const out = { loaded: [], skipped: [], failed: [] };
      for (const item of (list || [])) {
        const code = String((item && item.code) || '');
        const id = String((item && item.id) || '').slice(0, 64);
        if (!code || !id) continue;
        if (serverPluginIds.has(id) || records.some((r) => r.id === id)) { out.skipped.push(id); continue; }
        serverPluginIds.add(id);
        try {
          await loadOne({ id, type: 'server', code, builtin: false, url: '' });
          out.loaded.push(id);
        } catch (e) {
          out.failed.push({ id, error: String((e && e.message) || e) });
          console.warn('[ITLZMC] 服务器插件未加载 ' + id, e);
        }
      }
      try { K().render && K().render(); } catch (e) { }
      try { await flushTextures(); } catch (e) { }
      return out;
    },
    diagnose,
    doctor() {
      const list = records.map((r) => ({
        id: r.id, name: r.name, kind: r.kind, origin: r.origin,
        ok: !r.error, error: r.error || null, warning: r.warning || null,
        hints: (r.diagnosis && r.diagnosis.hints) || [],
        hooks: r.hooks, commands: r.commands, blocks: r.blocks, textures: r.textures,
        keybinds: r.keybinds || 0,
      }));
      return { total: list.length, failed: list.filter((x) => !x.ok).length, plugins: list };
    },
    doctorText() {
      const d = Plugins.doctor();
      if (!d.failed) return 'ITLZMC 插件自检：' + d.total + ' 个插件全部正常。';
      const lines = ['ITLZMC 插件失效诊断（请把下面内容交给 AI 修复）',
        '共 ' + d.total + ' 个插件，' + d.failed + ' 个未生效：', ''];
      for (const p of d.plugins.filter((x) => !x.ok)) {
        lines.push('【' + p.name + ' / ' + p.id + '】来源：' + p.origin);
        lines.push('错误：' + p.error);
        if (p.hints && p.hints.length) lines.push('修法：' + p.hints.join('；'));
        if (p.warning) lines.push('警告：' + p.warning);
        lines.push('');
      }
      lines.push('修好后：把 .js 放回 plugins/ 或重新提交到市场，再点「重载生效」。');
      return lines.join('\n');
    },

    _records: records,
  };
  Q.Plugins = Plugins;
  Q.Plugin = Plugins;          // 别名：插件系统推荐使用 ITLZMC.Plugin
  Q.plugin = (m, f) => Plugins.plugin(m, f);      // ITLZMC.plugin(meta, factory)
  Q.register = (m, f) => Plugins.plugin(m, f);    // 兼容旧写法
  window.QIUMC_PLUGIN_API = API_VERSION;

  // ---- 原生插件包清单：只读 plugin.json（ITLZMC 唯一支持的包格式） ----
  function readPluginManifest(files) {
    for (const [n, b] of files) {
      if (!/(^|\/)plugin\.json$/i.test(n)) continue;
      try {
        const j = JSON.parse(text(b));
        return { source: 'plugin.json', meta: j, main: j.main || '' };
      } catch (e) { return { source: 'plugin.json', meta: {}, main: '' }; }
    }
    return { source: '', meta: {} };
  }

  // ---- 插件医生：AI 改插件最容易「改着改着就失效」的原因，逐条给中文定位与修法 ----
  function diagnose(code) {
    const src = String(code || '');
    const clean = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    const errors = [], warnings = [], hints = [];
    const add = (e, h) => { errors.push(e); if (h) hints.push(h); };
    if (!src.trim()) {
      add('源码是空的', '把完整插件源码写进文件，不要只保存 meta 或片段');
      return { ok: false, errors, warnings, hints };
    }
    try { new Function('ITLZMC', 'Plugins', 'Plugin', src); }
    catch (e) {
      add('语法错误：' + ((e && e.message) || e),
        '在插件所在目录跑 node --check 插件.js 定位行号；最常见是改模板时少了 }、)、引号');
    }
    if (!/ITLZMC\s*\.\s*(plugin|register)\s*\(/.test(src))
      add('没有调用 ITLZMC.plugin(meta, factory)',
        '所有注册必须包在 ITLZMC.plugin({ id, name, version, api }, function (P) { ... }) 里；直接写顶层逻辑不会生效');
    if (/ITLZMC\s*\.\s*Mods\b|\bForge\b|\bFabric\b|mods\.toml|fabric\.mod\.json|mcmod\.info|\.jar\b/.test(src))
      add('用了已删除的 Mod / 模组命名空间',
        'ITLZMC 只加载原生插件，注册入口是 ITLZMC.plugin(...)，不认 .jar / Forge / Fabric');
    if (/^await\s/m.test(clean))
      add('顶层 await 不支持', '插件是普通脚本；把异步逻辑放进同步 factory 或 P.on(...) 回调');
    const head = (src.match(/ITLZMC\s*\.\s*(?:plugin|register)\s*\(([\s\S]{0,700})/) || [])[1] || '';
    if (/,\s*async\b/.test(head))
      add('factory 是 async 函数，注册不会执行',
        '改成同步 factory：function (P) { ... }；ITLZMC 不会 await 返回值，async 里的注册会被丢掉');
    if (/\b(eval|require|importScripts|fetch|XMLHttpRequest|WebSocket|document\.write|localStorage\.clear)\s*\(/.test(clean))
      add('用了被禁止的 API（网络 / 动态执行 / 清空存储）',
        '贴图用 data:image/png;base64 内嵌，配置用 P.storage，日志用 P.log');
    if (/https?:\/\//i.test(clean))
      add('引用了外部网址', '贴图请用 data:image/png;base64 内嵌，不要写 http(s) 链接');
    if (/__PNG__|TODO|FIXME|placeholder/i.test(clean))
      add('源码里还有占位符 / TODO', '把模板里的 __PNG__ 换成真实 data:image，删掉 TODO');
    if (/ITLZMC\s*\.\s*plugin\s*\(/.test(src)) {
      for (const [k, why] of [['id', 'meta.id 必填且全局唯一'], ['name', 'meta.name 必填'],
        ['version', 'meta.version 必填（如 1.0.0）'], ['api', 'meta.api 必填，写 "1.0"']]) {
        if (!new RegExp('\\b' + k + '\\s*:').test(src)) add('meta 缺字段 ' + k, why);
      }
    }
    if (src.length > 64 * 1024) warnings.push('源码超过 64 KB，市场提交会被拒');
    // 跨端按键：AI 最容易直接写 window.addEventListener('keydown', ...)，手机端永远触发不了
    if (/addEventListener\s*\(\s*['"]key(?:down|up)|onkeydown\s*=/.test(clean) &&
        !/P\s*\.\s*(?:addKey|onKey|bindKey|key)\s*\(/.test(clean)) {
      warnings.push('直接监听了 keydown/keyup，手机端没有物理键盘会失效');
      hints.push('改用 P.addKey(\'veinMine\', { code:\'Backquote\', label:\'连锁挖矿\', onDown: fn })；'
        + '引擎会自动在桌面转发物理键、在手机生成屏幕按钮，并用 P.isKeyDown(id) 读取按住状态');
    }
    return { ok: errors.length === 0, errors, warnings, hints };
  }
  function guardCode(code, rec) {
    const d = diagnose(code);
    rec.diagnosis = d;
    if (!d.ok) throw new Error('插件未加载：' + d.errors.join('；') + '｜修法：' + d.hints.join('；'));
    return d;
  }
  function assertRegistered(rts, rec) {
    if (!rts || !rts.length)
      throw new Error('源码执行了但没有注册任何插件：ITLZMC.plugin(...) 没被真正调用，或 factory 是 async（ITLZMC 只同步执行 factory）');
    const total = rts.reduce((n, rt) => n + (rt.hooks || 0) + (rt.commands || 0) + (rt.blocks || 0) + (rt.textures || 0) + (rt.recipes || 0) + (rt.keybinds || 0), 0);
    if (!total) rec.warning = '插件加载成功，但什么都没注册（贴图 / 方块 / 指令 / 机制钩子都没有），等于没有效果';
  }
  function runPluginCode(code, label) {
    // 插件在全局作用域运行，可直接用 Game / BLOCKS / RECIPES 等；注入 ITLZMC / Plugins / Plugin。
    (new Function('ITLZMC', 'Plugins', 'Plugin', code)).call(window, Q, Plugins, Plugins);
    // 自动检测：老插件自己监听 keydown / 判断 e.code / 读 g.keys 时，把用到的按键补齐，
    // 手机端据此自动生成同名的屏幕虚拟按钮，插件一行都不用改。
    try { K().scan(code, label); } catch (e) { }
  }

  // ---- 加载单个来源 ----
  async function loadOne(src) {
    const rec = {
      id: src.id, name: src.id, version: '', author: '', description: '',
      origin: src.builtin ? '内置' : '自定义', type: src.type, url: src.url,
      enabled: true, error: null, textures: 0, atlas: 0,
      kind: src.type === 'js' ? 'JS 插件' : '插件包', metaSource: '',
      capabilities: [], hooks: 0, commands: 0, blocks: 0, keybinds: 0,
    };
    try {
      // 市场插件 / 自创插件：源码已在本机内存中，不发起任何网络请求
      if (src.type === 'market' || src.type === 'created' || src.type === 'community' || src.type === 'server') {
        const before = PLUGINS.length;
        guardCode(src.code, rec);
        runPluginCode(src.code, src.id);
        const rts = PLUGINS.slice(before);
        assertRegistered(rts, rec);
        if (rts.length) {
          const m = rts[rts.length - 1].manifest;
          rec.id = m.id || rec.id; rec.name = m.name || rec.id;
          rec.version = m.version || ''; rec.author = m.author || '';
          rec.description = m.description || '';
          rec.capabilities = (m.capabilities || []).slice();
          for (const rt of rts) { rec.hooks += rt.hooks; rec.commands += rt.commands; rec.blocks += rt.blocks; rec.keybinds += rt.keybinds || 0; }
        }
        rec.capabilities = normCaps(rec.capabilities);
        rec.kind = src.type === 'market' ? '市场插件' : src.type === 'community' ? '社区插件'
          : src.type === 'server' ? '服务器插件' : '我的插件';
        rec.origin = src.type === 'market' ? '插件市场' : src.type === 'community' ? '社区市场'
          : src.type === 'server' ? '常驻服务器' : '自创';
        records.push(rec); return;
      }
      const res = await fetch(fullUrl(src.url) + (src.url.indexOf('http') === 0 ? '' : q()), { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      if (src.type === 'zip') {
        const files = await unzip(await res.arrayBuffer());
        if (!files.size) throw new Error('包为空或无法解析');
        const info = readPluginManifest(files);
        rec.metaSource = info.source;
        const m = info.meta || {};
        rec.name = m.name || src.id;
        rec.version = m.version || '';
        rec.author = m.author || '';
        rec.description = m.description || '';
        if (m.id) rec.id = m.id;
        rec.kind = info.source === 'plugin.json' ? '插件包' : '贴图插件包';
        if (m.capabilities) rec.capabilities = m.capabilities.slice();
        // 包内声明式 main：把 JS 当插件执行
        if (info.main) {
          let code = null;
          for (const [n, b] of files) if (n === info.main || n.endsWith('/' + info.main)) { code = text(b); break; }
          if (code == null) throw new Error('plugin.json 里的 main 找不到：' + info.main);
          const before = PLUGINS.length;
          guardCode(code, rec);
          runPluginCode(code, info.main);
          const rts = PLUGINS.slice(before);
          assertRegistered(rts, rec);
          for (const rt of rts) {
            rec.hooks += rt.hooks; rec.commands += rt.commands; rec.blocks += rt.blocks;
            rec.keybinds += rt.keybinds || 0;
            rec.capabilities = rec.capabilities.concat(
              rt.hooks ? ['机制'] : [], rt.commands ? ['指令'] : [], (rt.blocks || rt.textures) ? ['贴图'] : []);
          }
        }
        const tex = applyPluginTextures(files);
        rec.textures = tex.total;
        rec.atlas = tex.atlas;
        if (tex.total) rec.capabilities.push('贴图');
        rec.capabilities = normCaps(rec.capabilities);
        if (!tex.total && !rec.hooks && !rec.commands) {
          rec.description = rec.description || '包内没有可识别的贴图或插件代码';
        }
        if (tex.atlas) rec.description = (rec.description ? rec.description + ' · ' : '') + '含 ' + tex.atlas + ' 张图集空位贴图';
      } else {
        const code = await res.text();
        const before = PLUGINS.length;
        guardCode(code, rec);
        runPluginCode(code, src.url);
        const rts = PLUGINS.slice(before);
        assertRegistered(rts, rec);
        if (rts.length) {
          const m = rts[rts.length - 1].manifest;
          rec.id = m.id || rec.id;
          rec.name = m.name || rec.id;
          rec.version = m.version || '';
          rec.author = m.author || '';
          rec.description = m.description || '';
          rec.capabilities = (m.capabilities || []).slice();
          for (const rt of rts) {
            rec.hooks += rt.hooks; rec.commands += rt.commands; rec.blocks += rt.blocks;
            rec.keybinds += rt.keybinds || 0;
          }
          for (const rt of rts) {
            if (rt.hooks) rec.capabilities.push('机制');
            if (rt.commands) rec.capabilities.push('指令');
            if (rt.blocks || rt.textures) rec.capabilities.push('贴图');
          }
        }
        rec.capabilities = normCaps(rec.capabilities);
        rec.description = rec.description || 'JS 插件';
        rec.kind = 'JS 插件';
        records.push(rec);
        return;
      }
    } catch (e) {
      rec.error = String((e && e.message) || e);
    }
    records.push(rec);
  }

  async function boot() {
    const sources = [];
    const seen = new Set();
    const push = (s) => { if (s && s.url && !seen.has(s.url)) { seen.add(s.url); sources.push(s); } };

    // 0) 先从服务器拉「校验通过才上架」的社区插件；离线时静默跳过，内置插件照常
    await refreshMarket();

    // 1) 同源 plugins/ 目录自动发现（ITLZMC 只加载原生插件）
    try {
      const res = await fetch('api/plugins' + q(), { cache: 'no-store' });
      if (res.ok) {
        const j = await res.json();
        for (const m of (j.plugins || [])) {
          const url = m.url || ('plugins/' + m.name);
          push({ id: m.name, url, type: m.type || (/\.zip$/i.test(m.name) ? 'zip' : 'js'), builtin: true });
        }
      }
    } catch (e) { }

    const params = new URL(location.href).searchParams;
    for (const v of params.getAll('plugin')) {
      push({ id: v.split('/').pop() || v, url: v,
        type: /\.zip(\?|$)/i.test(v) ? 'zip' : 'js', builtin: false });
    }
    // 2) 插件市场里已安装的官方插件（源码内嵌，完全离线可用）
    for (const p of MARKET) if (p.source !== 'community' && isInstalled(p))
      push({ id: p.id, url: 'market:' + p.id, type: 'market', code: p.code, builtin: true });
    // 2b) 已安装的社区插件：源码存本机，之后启动不再依赖服务器
    for (const p of communityInstalled())
      push({ id: p.id, url: 'community:' + p.id, type: 'community', code: p.code, builtin: false });
    // 3) 玩家自己创作并启用的插件
    for (const p of marketCreated())
      push({ id: p.id, url: 'created:' + p.id, type: 'created', code: p.code, builtin: false });
    // 4) 管理界面手填的 URL
    for (const v of readJSON(LS_USER, [])) {
      push({ id: v.split('/').pop() || v, url: v,
        type: /\.zip(\?|$)/i.test(v) ? 'zip' : 'js', builtin: false });
    }

    const off = new Set(readJSON(LS_OFF, []));
    for (const s of sources) {
      if (off.has(s.id) || off.has(s.url)) {
        records.push({ id: s.id, name: s.id, version: '', origin: s.builtin ? '内置' : '自定义',
          type: s.type, url: s.url, enabled: false, error: null, capabilities: [] });
        continue;
      }
      await loadOne(s);
    }
    await flushTextures();
    Plugins.emit('pluginsLoaded', records);
    return records;
  }

  // =========================================================================
  // 机制钩子：把事件总线挂到游戏真实函数上。
  // plugins.js 是最后一个脚本，这里的包装位于所有模块包装链的最外层。
  // =========================================================================
  const HOOKED = [];
  function hookGame() {
    const add = (label, ok) => { if (ok) HOOKED.push(label); };

    if (typeof Game !== 'undefined') {
      // init 是 async，单独包装以保留 Promise 语义
      const origInit = Game.prototype.init;
      if (!origInit.__qiumcInitHooked) {
        Game.prototype.init = async function () {
          currentGame = this;
          Plugins.emit('gameInit', this);
          const r = await origInit.apply(this, arguments);
          Plugins.emit('ready', this);
          return r;
        };
        Game.prototype.init.__qiumcInitHooked = true;
        HOOKED.push('gameInit/ready');
      }
      add('tick', wrap(Game.prototype, 'tick', function () {
        currentGame = this;
      }, function () { try { Plugins.emit('tick', this); } catch (e) { } }));

      add('blockBreak/blockBroken', wrap(Game.prototype, 'breakBlock', function (args) {
        const x = args[0], y = args[1], z = args[2];
        const w = this.world;
        const id = w && w.getBlock ? w.getBlock(x, y, z) : 0;
        const meta = w && w.getMeta ? w.getMeta(x, y, z) : 0;
        const c = makeCtx({
          game: this, x, y, z, id, meta,
          block: (typeof BLOCKS !== 'undefined' ? BLOCKS[id] : null),
          natural: !!args[3], silent: !!args[4], player: this.player,
        });
        Plugins.emit('blockBreak', c);
        return c;
      }, function (r, c) { if (c) Plugins.emit('blockBroken', c); }));

      add('dropItem', wrap(Game.prototype, 'dropItem', function (args) {
        const stack = args[3];
        if (!stack) return null;
        const c = makeCtx({ game: this, x: args[0], y: args[1], z: args[2], stack, vel: args[4] });
        Plugins.emit('dropItem', c);
        if (c.stack !== stack) args[3] = c.stack;
        else if (c.count != null && stack) args[3] = Object.assign({}, stack, { count: c.count });
        return c;
      }));

      add('blockLoot', wrap(Game.prototype, 'dropBlockLoot', function (args) {
        const c = makeCtx({ game: this, x: args[0], y: args[1], z: args[2],
          id: args[3], meta: args[4], tool: args[5],
          block: (typeof BLOCKS !== 'undefined' ? BLOCKS[args[3]] : null) });
        Plugins.emit('blockLoot', c);
        return c;
      }));

      add('useItem', wrap(Game.prototype, 'use', function () {
        const c = makeCtx({ game: this, player: this.player,
          held: this.player && this.player.inv ? this.player.inv.held : null,
          target: this.target, targetEntity: this.targetEntity });
        Plugins.emit('useItem', c);
        return c;
      }));

      add('explode', wrap(Game.prototype, 'explode', function (args) {
        const c = makeCtx({ game: this, x: args[0], y: args[1], z: args[2],
          power: args[3], source: args[4], inWater: args[5], fire: args[6] });
        Plugins.emit('explode', c);
        if (c.power != null) args[3] = c.power;
        return c;
      }));

      add('entitySpawn', wrap(Game.prototype, 'addEntity', function (args) {
        const c = makeCtx({ game: this, entity: args[0] });
        Plugins.emit('entitySpawn', c);
        if (c.entity !== args[0]) args[0] = c.entity;
        return c;
      }));

      add('respawn', wrap(Game.prototype, 'respawn', function () {
        return makeCtx({ game: this, player: this.player });
      }, function (r, c) { if (c) Plugins.emit('respawn', c); }));
    }

    // 伤害：Living 基类覆盖 Player 与所有生物
    if (typeof Living !== 'undefined') {
      add('damage/damaged', wrap(Living.prototype, 'hurt', function (args) {
        const c = makeCtx({ game: this.game || window.game, entity: this,
          amount: args[0], source: args[1] });
        Plugins.emit('damage', c);
        if (c.amount != null) args[0] = c.amount;
        return c;
      }, function (r, c) { if (c && r) Plugins.emit('damaged', c); }));
    }

    // 方块放置：World.setBlock 上 id != 0 才算放置
    if (typeof World !== 'undefined') {
      add('blockPlace', wrap(World.prototype, 'setBlock', function (args) {
        if (!args[3]) return null;
        const c = makeCtx({ game: currentGame || window.game, world: this,
          x: args[0], y: args[1], z: args[2], id: args[3], meta: args[4] });
        Plugins.emit('blockPlace', c);
        if (c.id != null) args[3] = c.id;
        if (c.meta != null) args[4] = c.meta;
        return c;
      }));
    }

    // 合成输出
    if (typeof ContainerScreen !== 'undefined') {
      add('craft', wrap(ContainerScreen.prototype, 'takeOutput', function (args) {
        const s = args[1];
        const st = s && typeof s.get === 'function' ? s.get() : null;
        const c = makeCtx({ game: this.game, screen: this, result: st,
          id: st && st.id, count: st && st.count });
        Plugins.emit('craft', c);
        return c;
      }));
    }

    // 命令分发：拦截 / 改写任意游戏或插件指令
    if (typeof window.cmdExec === 'function' && !window.cmdExec.__qiumcHooked) {
      const orig = window.cmdExec;
      window.cmdExec = function (g, rawText, src) {
        const words = String(rawText || '').replace(/^\//, '').split(/\s+/).filter(Boolean);
        const c = makeCtx({ game: g, name: (words[0] || '').replace(/^minecraft:/, ''),
          args: words.slice(1), raw: rawText, source: src || null });
        Plugins.emit('command', c);
        if (c.cancelled) return c.result !== undefined ? c.result : true;
        return orig.call(this, g, c.raw !== rawText ? c.raw : rawText, src);
      };
      window.cmdExec.__qiumcHooked = true;
      HOOKED.push('command');
    }

    // UI 消息
    if (typeof UI !== 'undefined' && typeof UI.prototype.message === 'function') {
      add('message', wrap(UI.prototype, 'message', function (args) {
        const c = makeCtx({ game: this.game, text: args[0], color: args[1] });
        Plugins.emit('message', c);
        if (c.text != null) args[0] = c.text;
        return c;
      }));
    }
  }
  hookGame();

  // =========================================================================
  // ITLZMC 插件市场 —— 只支持 ITLZMC 原生插件，不加载任何 Mod / 模组
  // 完全离线：官方插件源码内嵌，安装状态与自创插件存 localStorage，
  // AI SKILL 包以 base64 内嵌，一键下载不依赖服务器或外部网络。
  // =========================================================================
  const LS_MARKET = 'itlzmc.market.installed';
  const LS_CREATED = 'itlzmc.market.created';
  const LS_COMMUNITY = 'itlzmc.market.community';  // 已安装的社区插件（源码存本机，之后离线可用）
  const LS_DEV = 'itlzmc.market.dev';              // 开发者身份 { username, apiKey }
  const USER_RE = /^[A-Za-z0-9_]{3,20}$/;

  // ---- 插件市场 API（同源，零外部请求；离线时静默降级到内置官方插件） ----
  async function apiCall(method, name, body, withKey) {
    const headers = { 'Content-Type': 'application/json' };
    if (withKey) { const d = devInfo(); if (d && d.apiKey) headers['X-ITLZMC-Key'] = d.apiKey; }
    try {
      const res = await fetch('api/' + name + q(), {
        method, headers, cache: 'no-store',
        body: body == null ? undefined : JSON.stringify(body),
      });
      let j = {};
      try { j = await res.json(); } catch (e) { }
      j.__status = res.status;
      return j;
    } catch (e) { return { ok: false, error: '连不上插件市场服务（离线时内置官方插件照常可用）' }; }
  }

  function devInfo() {
    const d = readJSON(LS_DEV, null);
    return d && d.username && d.apiKey ? d : null;
  }
  function setDev(d) { writeJSON(LS_DEV, d); }
  function clearDev() { try { localStorage.removeItem(LS_DEV); } catch (e) { } }

  function communityInstalled() { const a = readJSON(LS_COMMUNITY, []); return Array.isArray(a) ? a : []; }
  function communityHas(id) { return communityInstalled().some((x) => x && x.id === id); }
  function communityAdd(p) {
    const a = communityInstalled().filter((x) => !x || x.id !== p.id);
    a.push({ id: p.id, name: p.name, version: p.version, code: p.code,
      author: p.author || '', capabilities: p.caps || [] });
    writeJSON(LS_COMMUNITY, a);
    apiCall('POST', 'market/install', { id: p.id }, false).catch(() => { });
  }
  function communityRemove(id) { writeJSON(LS_COMMUNITY, communityInstalled().filter((x) => !x || x.id !== id)); }
  const isInstalled = (p) => !!p && (p.source === 'community' ? communityHas(p.id) : marketIsInstalled(p.id));
  function toggleInstall(p) {
    if (!p) return false;
    if (p.source === 'community') {
      if (communityHas(p.id)) { communityRemove(p.id); return false; }
      communityAdd(p); return true;
    }
    return marketToggle(p.id);
  }

  // 从服务器拉「校验通过才上架」的社区插件，合并进市场列表（离线返回 -1）
  async function refreshMarket() {
    try {
      const res = await fetch('api/market' + q(), { cache: 'no-store' });
      if (!res.ok) return -1;
      const j = await res.json();
      for (let i = MARKET.length - 1; i >= 0; i--) if (MARKET[i].source === 'community') MARKET.splice(i, 1);
      for (const p of (j.plugins || [])) {
        if (!p || !p.id || typeof p.code !== 'string' || !p.code.trim()) continue;
        if (MARKET.some((x) => x.id === p.id)) continue;
        MARKET.push({
          id: p.id, name: p.name, version: p.version,
          desc: p.description || '', description: p.description || '',
          caps: p.capabilities || [], code: p.code, author: p.author,
          source: 'community', installs: p.installs || 0,
          updatedAt: p.updatedAt, changelog: p.changelog || '', report: p.report,
        });
      }
      return (j.plugins || []).length;
    } catch (e) { return -1; }
  }

  function copyText(t) {
    const legacy = () => {
      try {
        const ta = document.createElement('textarea');
        ta.value = t; ta.setAttribute('readonly', '');
        ta.style.position = 'fixed'; ta.style.top = '-1000px'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        return ok;
      } catch (e) { return false; }
    };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        // 用户手势下异步写入；被浏览器策略拒绝时自动回退到 execCommand
        navigator.clipboard.writeText(t).catch(legacy);
        return true;
      }
    } catch (e) { }
    return legacy();
  }

  // 一整段可直接粘给 AI 的说明：Key + 带 sharecode 的完整 API 地址 + 提交方式 + 校验规则
  function aiPrompt(key) {
    const origin = (location.origin && location.origin !== 'null') ? location.origin : '<本站地址>';
    const sc = new URL(location.href).searchParams.get('sharecode');
    const qs = sc ? '?sharecode=' + encodeURIComponent(sc) : '';
    const base = origin + '/api/';
    const U = (name) => base + name + qs;   // 每个端点都必须带 sharecode，否则部署网关返回 403
    return [
      '你可以通过 ITLZMC 插件市场 API 提交插件（只支持 ITLZMC 原生插件，不加载 Mod / 模组）。',
      'API 根地址：' + base,
      '我的 API Key：' + key,
      '',
      '【必须遵守】本站部署在分享网关后面，每一个 API 请求的 URL 末尾都要带 ' + (sc ? '?sharecode=' + sc : '?sharecode=<分享码>') +
        '，GET 和 POST 都要带，漏了会被 403 拦截。下面给出的都是拼好的完整地址，直接复制使用。',
      '若你手上的本站地址自带别的 sharecode，把它替换成地址里的那个值即可。',
      '',
      '步骤：',
      '1. 按 ITLZMC-AI-SKILL.zip 的规范写好插件源码：ITLZMC.plugin(meta, factory)。',
      '2. 可选自检：POST ' + U('plugins/validate') + '  body {"code":"<源码>"}（无需 Key），返回 {ok,errors,warnings,report}。',
      '3. 提交上架：POST ' + U('plugins/submit'),
      '   请求头 Content-Type: application/json',
      '   请求头 X-ITLZMC-Key: ' + key,
      '   body {"code":"<插件完整源码>","changelog":"可选"}',
      '   curl 示例：',
      '   curl -X POST "' + U('plugins/submit') + '" -H "Content-Type: application/json" -H "X-ITLZMC-Key: ' + key + '" -d @body.json',
      '4. 服务端会自动校验：字段规范 → 危险 API 黑名单 → 语法编译 → vm 沙箱试运行 → 至少注册一项能力 → id 冲突。',
      '   全部通过才会上架；未通过会返回具体 errors，改好后再提交。',
      '5. 上架后 GET ' + U('market') + ' 可见，玩家在「插件市场」里一键安装。',
      '',
      '其它端点（同样要带 sharecode）：',
      'GET  ' + U('docs') + '  完整接口说明',
      'GET  ' + U('plugins/mine') + '  查我上架的插件（需 Key）',
      'POST ' + U('plugins/withdraw') + '  body {"id":"..."} 下架自己的插件（需 Key）',
      'POST ' + U('auth/register') + '  body {"username","password"} 注册拿 Key',
      '',
      '写按键插件时不要用 window.addEventListener(\'keydown\'...)：手机没有物理键盘。',
      '用 P.addKey(\'veinMine\', { code:\'Backquote\', label:\'连锁挖矿\', onDown: fn })，引擎会自动在手机端生成屏幕按钮。',
      '注意：普通玩家浏览 / 安装 / 创作插件都不需要登录，只有上架提交才用这枚 Key；别把 Key 写进插件源码。',
    ].join('\n');
  }


  const SKILL_ZIP_B64 = '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';
  const CAP_LABEL = { texture: '贴图', mechanic: '机制', command: '指令', recipe: '配方' };
  const capsCN = (a) => (a || []).map((x) => CAP_LABEL[x] || x);
  const DEMO_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAW0lEQVR4nGMUimn6z0ABYGFgYGAQ8QkjS/ObLasYmCixHe4CGChwVidK04S9N+Fsil1AXS8gg0yRuyj86W+UaeOCgTcAZxjg8jPVXUBdLyCnMPq64M2WVWQbAAAQTRExDRZPSQAAAABJRU5ErkJggg==';

  // 官方插件：完整可运行源码，安装后随下次启动生效（无需联网）
  const MARKET = [
    {
      id: 'itlzmc-double-drops', name: '双倍掉落', version: '1.0.0', caps: ['mechanic'],
      desc: '破坏方块掉落的物品数量翻倍，挖矿与建造更省时间。',
      code: `ITLZMC.plugin({
  id: 'itlzmc-double-drops', name: '双倍掉落', version: '1.0.0',
  description: '所有方块掉落物数量翻倍', api: '1.0', capabilities: ['mechanic'],
}, function (P) {
  P.on('dropItem', function (c) {
    if (c.stack && c.stack.count) c.count = Math.min(64, c.stack.count * 2);
  });
  P.addCommand('drops', {
    description: '查看双倍掉落插件状态',
    fn: function (ctx) { ctx.say('双倍掉落已启用：所有掉落物数量 ×2'); },
  });
});`,
    },
    {
      id: 'itlzmc-peaceful-night', name: '安宁之夜', version: '1.0.0', caps: ['mechanic'],
      desc: '阻止僵尸、苦力怕、骷髅等敌对生物生成，安心建造。',
      code: `ITLZMC.plugin({
  id: 'itlzmc-peaceful-night', name: '安宁之夜', version: '1.0.0',
  description: '阻止常见敌对生物生成', api: '1.0', capabilities: ['mechanic'],
}, function (P) {
  P.on('entitySpawn', function (c) {
    var t = c.entity && c.entity.type;
    if (/^(zombie|creeper|skeleton|spider|enderman|witch|pillager|husk|stray|drowned)$/.test(t || '')) c.cancel();
  });
  P.addCommand('peace', {
    description: '查看安宁之夜插件状态',
    fn: function (ctx) { ctx.say('安宁之夜已启用：敌对生物不再生成'); },
  });
});`,
    },
    {
      id: 'itlzmc-glow-lamp', name: 'ITLZ 发光灯', version: '1.0.0', caps: ['texture', 'recipe'],
      desc: '新增一张贴图、一个会发光的方块，以及一条合成配方。',
      code: `ITLZMC.plugin({
  id: 'itlzmc-glow-lamp', name: 'ITLZ 发光灯', version: '1.0.0',
  description: '内嵌贴图 + 发光方块 + 合成配方', api: '1.0', capabilities: ['texture', 'recipe'],
}, function (P) {
  var png = '` + DEMO_PNG + `';
  P.addTexture('qiumc_glow_lamp_tex', png);
  P.defineBlock({
    key: 'qiumc_glow_lamp', cn: 'ITLZ 发光灯',
    tex: { side: 'qiumc_glow_lamp_tex', top: 'qiumc_glow_lamp_tex', bottom: 'qiumc_glow_lamp_tex' },
    light: 15, hardness: 0.6, sound: 'glass',
  });
  P.addShapeless('qiumc_glow_lamp', 1, ['glowstone', 'stick']);
  P.log('发光灯方块已注册');
});`,
    },
    {
      id: 'itlzmc-toolkit', name: '插件工具箱', version: '1.0.0', caps: ['command'],
      desc: '增加 /itlzmc 状态查询与 /qmgive 给物品指令，含别名与参数。',
      code: `ITLZMC.plugin({
  id: 'itlzmc-toolkit', name: '插件工具箱', version: '1.0.0',
  description: '插件状态查询与给物品指令', api: '1.0', capabilities: ['command'],
}, function (P) {
  P.addCommand('itlzmc', {
    description: 'ITLZMC 插件系统状态',
    usage: '/itlzmc [plugins|events|commands|api]', aliases: ['qi'],
    fn: function (ctx, args) {
      var M = ITLZMC.Plugins, sub = (args[0] || 'plugins').toLowerCase();
      if (sub === 'plugins') {
        var names = M.list().map(function (r) { return r.name + (r.error ? '（失败）' : ''); });
        ctx.say('已加载 ' + names.length + ' 个插件：' + names.join('、'));
      } else if (sub === 'events') ctx.say('已挂载机制钩子：' + M.hookStats().join('、'));
      else if (sub === 'commands') ctx.say('插件指令：' + Object.keys(M.commands()).map(function (k) { return '/' + k; }).join('、'));
      else if (sub === 'api') ctx.say('插件 API ' + M.api + '（' + M.version + '）');
      else ctx.say('用法：/itlzmc [plugins|events|commands|api]');
    },
  });
  P.addCommand('qmgive', {
    description: '给自己一件物品：/qmgive <key> [数量]',
    fn: function (ctx, args) {
      var key = args[0], n = parseInt(args[1] || '1', 10) || 1;
      if (!key) { ctx.say('用法：/qmgive <key> [数量]'); return; }
      ctx.say(P.give(key, n) ? '已给予 ' + key + ' ×' + n : '找不到物品：' + key);
    },
  });
});`,
    },
    {
      id: 'itlzmc-vein-miner', name: '连锁挖矿', version: '1.0.0', caps: ['mechanic'],
      desc: '按住波浪键 `~` 挖矿连锁破坏相邻同类方块；手机端自动出现「连锁挖矿」按钮，不需要物理键盘。',
      code: `ITLZMC.plugin({
  id: 'itlzmc-vein-miner', name: '连锁挖矿', version: '1.0.0',
  description: '按住波浪键连锁挖矿；手机端自动生成屏幕按钮', api: '1.0', capabilities: ['mechanic'],
}, function (P) {
  var LIMIT = 24;
  P.addKey('veinMine', {
    code: 'Backquote', label: '连锁挖矿', mode: 'hold',
    desc: '按住并挖掘，连锁破坏相邻同类方块',
    onDown: function () { P.message('连锁挖矿：已开启', '#86EFAC'); },
    onUp: function () { P.message('连锁挖矿：已关闭', '#FFD479'); },
  });
  P.on('blockBreak', function (c) {
    if (!P.isKeyDown('veinMine')) return;
    if (c.natural || c.silent) return;
    try {
      var g = c.game || P.game(), w = g && g.world;
      if (!w || typeof w.get !== 'function') return;
      var base = c.id, seen = {}, found = [], queue = [[c.x, c.y, c.z]];
      seen[c.x + ',' + c.y + ',' + c.z] = 1;
      while (queue.length && found.length < LIMIT) {
        var p = queue.shift();
        for (var dx = -1; dx <= 1; dx++) for (var dy = -1; dy <= 1; dy++) for (var dz = -1; dz <= 1; dz++) {
          var nx = p[0] + dx, ny = p[1] + dy, nz = p[2] + dz, k = nx + ',' + ny + ',' + nz;
          if (seen[k]) continue;
          seen[k] = 1;
          var b = w.get(nx, ny, nz), bid = (b && typeof b === 'object') ? b.id : b;
          if (bid === base) { found.push(k); queue.push([nx, ny, nz]); }
        }
      }
      if (found.length) P.message('连锁挖矿：命中 ' + found.length + ' 个方块', '#7DD3FC');
    } catch (e) { P.warn('连锁挖矿跳过：' + e); }
  });
  P.addCommand('vein', {
    description: '查看连锁挖矿状态',
    fn: function (ctx) { ctx.say(ITLZMC.Plugins.isKeyDown('veinMine') ? '连锁挖矿：按住中' : '连锁挖矿：待机（按住波浪键或手机按钮）'); },
  });
});`,
    },
  ];

  function marketInstalled() { return readJSON(LS_MARKET, []); }
  function marketIsInstalled(id) { return marketInstalled().indexOf(id) >= 0; }
  function marketToggle(id) {
    const a = marketInstalled(), i = a.indexOf(id);
    if (i >= 0) a.splice(i, 1); else a.push(id);
    writeJSON(LS_MARKET, a);
    return i < 0;
  }
  function marketCreated() { return readJSON(LS_CREATED, []); }
  function marketAddCreated(p) {
    const a = marketCreated().filter((x) => x.id !== p.id);
    a.push(p); writeJSON(LS_CREATED, a);
  }

  function saveFile(name, data, mime) {
    try {
      const blob = new Blob([data], { type: mime || 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = name; a.style.display = 'none';
      document.body.appendChild(a); a.click();
      setTimeout(() => { try { document.body.removeChild(a); } catch (e) { } URL.revokeObjectURL(url); }, 4000);
      return true;
    } catch (e) { return false; }
  }
  function skillBytes() {
    const bin = atob(SKILL_ZIP_B64), u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  }
  function downloadSkill() { return saveFile('ITLZMC-AI-SKILL.zip', skillBytes(), 'application/zip'); }

  // 创作向导：直接产出完整可运行的插件源码（无占位符，可立即安装）
  function makePluginCode(id, rawName, cap) {
    const name = String(rawName || '我的插件').replace(/['"\\\n\r]/g, ' ').slice(0, 24) || '我的插件';
    const head = [
      '// ITLZMC 原生插件 · 由「插件市场 → 创作插件」生成',
      'ITLZMC.plugin({',
      "  id: '" + id + "',",
      "  name: '" + name + "',",
      "  version: '1.0.0',",
      "  description: '由插件市场创作的 ITLZMC 原生插件',",
      "  api: '1.0',",
      "  capabilities: ['" + cap + "'],",
      '}, function (P) {',
    ];
    let body;
    if (cap === 'texture') {
      body = [
        "  var png = '" + DEMO_PNG + "';",
        "  P.addTexture('" + id + "_tex', png);",
        "  P.defineBlock({ key: '" + id + "_block', cn: '" + name + "方块',",
        "    tex: { side: '" + id + "_tex', top: '" + id + "_tex', bottom: '" + id + "_tex' },",
        '    light: 12, hardness: 0.8, sound: "glass" });',
        "  P.addShapeless('" + id + "_block', 1, ['glowstone', 'stick']);",
        "  P.log('" + name + "：贴图与方块已注册');",
      ];
    } else if (cap === 'mechanic') {
      body = [
        "  P.on('dropItem', function (c) {",
        '    if (c.stack && c.stack.count) c.count = Math.min(64, c.stack.count * 2);',
        '  });',
        "  P.addCommand('" + id + "', { description: '" + name + "状态',",
        "    fn: function (ctx) { ctx.say('" + name + "已启用：掉落物数量翻倍'); } });",
      ];
    } else {
      body = [
        "  P.addCommand('" + id + "', {",
        "    description: '" + name + "示例指令', usage: '/" + id + " [名字]', aliases: [],",
        "    fn: function (ctx, args) { ctx.say('你好，' + (args[0] || 'ITLZMC') + '！'); },",
        '  });',
        "  P.log('" + name + "：指令 /" + id + " 已注册');",
      ];
    }
    return head.concat(body, ['});', '']).join('\n');
  }

  function wrapFont(s, maxW) {
    const out = []; let cur = '';
    for (const ch of String(s)) {
      if (ch === '\n') { out.push(cur); cur = ''; continue; }
      if (Font.width(cur + ch) > maxW && cur) { out.push(cur); cur = ch; }
      else cur += ch;
    }
    if (cur) out.push(cur);
    return out;
  }

  // ---- 插件市场界面（标题屏幕直接可进入） ----
  if (typeof MenuScreen !== 'undefined') {
    class MarketScreen extends MenuScreen {
      constructor(game, parent) {
        super(game, 'ITLZMC 插件市场');
        this.parent = parent; this.tab = 0; this.sel = 0; this.titleY = 10;
        this.pName = '我的插件'; this.cap = 0; this.generated = ''; this.scroll = 0;
        this.createdId = 'qiumc_my_' + Date.now().toString(36);
        this.busy = false;
      }
      tabButtons(W, u, cx) {
        const tw = Math.min(102, Math.floor((u.w - 20) / 3)), tx = Math.floor(cx - tw * 1.5);
        ['插件市场', '已安装', '创作插件'].forEach((t, i) => {
          W.push({
            x: tx + i * tw, y: 26, w: tw - 2, h: 20,
            label: () => (i === this.tab ? '● ' : '') + t,
            onClick: () => { if (this.tab !== i) { this.tab = i; this.scroll = 0; this.layout(); Sound.init(); Sound.click(); } },
          });
        });
      }
      layout() {
        const u = this.game.ui, cx = u.w / 2, W = [];
        u.hideInput();
        this.tabButtons(W, u, cx);
        this.sel = clamp(this.sel, 0, Math.max(0, MARKET.length - 1));
        const top = 54, rowH = 24, y1 = u.h - 51;
        const maxRows = Math.max(1, Math.floor((y1 - 8 - top) / rowH));
        if (this.tab === 0) {
          this.scroll = clamp(this.scroll, 0, Math.max(0, MARKET.length - maxRows));
          MARKET.slice(this.scroll, this.scroll + maxRows).forEach((p, k) => {
            const i = this.scroll + k;
            W.push({
              x: cx - 155, y: top + k * rowH, w: 310, h: 20,
              label: () => (i === this.sel ? '▶ ' : '') + (isInstalled(p) ? '[已安装] ' : '') +
                p.name + (p.source === 'community' ? ' ·社区' : '') + '  [' + capsCN(p.caps).join('·') + ']',
              tip: [p.description || p.desc || '', '版本 ' + p.version,
                p.source === 'community'
                  ? '社区插件 · 作者 ' + (p.author || '匿名') + ' · 服务端校验通过后才上架'
                  : 'ITLZMC 官方内置插件',
                'ITLZMC 原生插件 · 源码存本机，离线可用'],
              onClick: () => { this.sel = i; this.layout(); },
            });
          });
          W.push({
            x: cx - 155, y: y1, w: 150, h: 20,
            label: () => { const p = MARKET[this.sel]; return p && isInstalled(p) ? '卸载所选' : '一键安装'; },
            tip: ['安装后重载生效；源码保存在本机，之后离线也能用'],
            onClick: () => {
              const p = MARKET[this.sel]; if (!p) return;
              const on = toggleInstall(p);
              this.game.ui.message((on ? '已安装：' : '已卸载：') + p.name + '，正在重载…', '#7FD8FF');
              setTimeout(() => location.reload(), 350);
            },
          });
          W.push({
            x: cx + 5, y: y1, w: 150, h: 20, label: '下载插件 .js',
            tip: ['把源码保存成 .js，可放进 plugins/ 目录或分享给朋友'],
            onClick: () => {
              const p = MARKET[this.sel]; if (!p) return;
              this.game.ui.message(saveFile(p.id + '.js', p.code, 'text/javascript') ? '已下载 ' + p.id + '.js' : '下载失败', '#7FD8FF');
            },
          });
        } else if (this.tab === 1) {
          const recs = Plugins.list(), maxRows = Math.max(1, Math.floor((y1 - 8 - top) / rowH));
          this.scroll = clamp(this.scroll, 0, Math.max(0, recs.length - maxRows));
          const shown = recs.slice(this.scroll, this.scroll + maxRows);
          if (!recs.length) W.push({ x: cx - 155, y: top, w: 310, h: 20, label: '还没有启用任何插件', enabled: false });
          shown.forEach((r) => {
            W.push({
              x: cx - 155, y: top + shown.indexOf(r) * rowH, w: 310, h: 20,
              label: () => (r.error ? '[未生效] ' : (r.enabled !== false ? '[开] ' : '[关] ')) + r.name + '  [' + (r.capabilities || []).join('·') + ']',
              tip: [(r.origin || '') + ' · ' + (r.kind || 'JS 插件'), r.description || '',
                r.error ? '失效原因：' + String(r.error).slice(0, 160) : '',
                r.warning ? '警告：' + r.warning : '',
                r.error ? '★ 点这个条目即可把完整诊断复制给 AI 修复' : '',
                ...((r.diagnosis && r.diagnosis.hints) || []),
                r.version ? '版本 ' + r.version : ''].filter(Boolean),
              onClick: () => {
                if (r.error) {
                  const t = Plugins.doctorText();
                  this.game.ui.message(copyText(t) ? '诊断已复制，粘给 AI 让它照着修' : '复制失败，可在控制台跑 ITLZMC.Plugins.doctor()', '#FF8080');
                } else { Plugins.toggle(r.id); this.game.ui.message('重启游戏后生效', '#FFD479'); }
                this.layout();
              },
            });
          });
          W.push({ x: cx - 155, y: y1, w: 100, h: 20, label: '重载生效', onClick: () => location.reload() });
          W.push({ x: cx - 50, y: y1, w: 100, h: 20, label: '复制诊断',
            tip: ['把所有失效插件的原因和修法复制成一段文字，直接粘给 AI'],
            onClick: () => {
              const d = Plugins.doctor();
              this.game.ui.message(copyText(Plugins.doctorText())
                ? (d.failed ? '已复制 ' + d.failed + ' 个失效插件的诊断' : '全部正常，诊断已复制')
                : '复制失败，可在控制台跑 ITLZMC.Plugins.doctor()', d.failed ? '#FF8080' : '#86EFAC');
            } });
          W.push({ x: cx + 55, y: y1, w: 100, h: 20, label: '添加插件 URL', onClick: () => this.addUrl(u, cx) });
        } else {
          const CAPS = ['command', 'mechanic', 'texture'];
          const CAP_CN = { command: '增加指令', mechanic: '修改机制', texture: '渲染贴图' };
          W.push({
            x: cx - 155, y: top, w: 310, h: 20,
            label: () => '能力：' + CAP_CN[CAPS[this.cap]] + '（点击切换）',
            tip: ['对应三种能力：增加指令 / 修改机制 / 渲染贴图'],
            onClick: () => { this.cap = (this.cap + 1) % 3; this.layout(); },
          });
          W.push({
            x: cx - 155, y: top + 26, w: 310, h: 20, label: () => '名称：' + this.pName,
            tip: ['在下面的输入框里给插件起个名字'],
            onClick: () => { if (u.input) u.input.focus(); },
          });
          u.showInput(cx - 150, top + 52, 300, 14, this.pName, () => { },
            { onInput: (v) => { this.pName = String(v || '').slice(0, 24) || '我的插件'; }, onEsc: () => this.back(), max: 24 });
          W.push({
            x: cx - 155, y: y1, w: 100, h: 20, label: '生成 .js',
            tip: ['生成完整可运行的插件源码并保存为 .js'],
            onClick: () => {
              this.generated = makePluginCode(this.createdId, this.pName, CAPS[this.cap]);
              this.game.ui.message(saveFile(this.createdId + '.js', this.generated, 'text/javascript') ? '插件源码已下载' : '下载失败', '#7FD8FF');
              this.layout();
            },
          });
          W.push({
            x: cx - 50, y: y1, w: 100, h: 20, label: '安装启用',
            tip: ['装进本机，重载后立即生效'],
            onClick: () => {
              this.generated = makePluginCode(this.createdId, this.pName, CAPS[this.cap]);
              marketAddCreated({ id: this.createdId, name: this.pName, code: this.generated });
              this.game.ui.message('已安装「' + this.pName + '」，正在重载…', '#7FD8FF');
              setTimeout(() => location.reload(), 350);
            },
          });
          W.push({
            x: cx + 55, y: y1, w: 100, h: 20, label: '提交到市场', gold: true,
            tip: ['把刚创作的插件提交到市场，服务端自动校验通过后才上架',
                  '需要开发者 API Key：到「登录 / 注册」注册一次即可'],
            onClick: () => this.submitCreated(),
          });
        }
        W.push({
          x: cx - 155, y: u.h - 27, w: 100, h: 20, label: '下载 AI Skill', gold: true,
          tip: ['ITLZMC-AI-SKILL.zip：装进 AI 就能让它写插件并发布到市场', '完全离线，不需要联网'],
          onClick: () => { this.game.ui.message(downloadSkill() ? 'AI Skill 已开始下载' : '下载失败', '#7FD8FF'); },
        });
        W.push({
          x: cx - 50, y: u.h - 27, w: 100, h: 20, gold: true,
          label: () => {
            const d = devInfo();
            return d && d.username ? '● ' + d.username.slice(0, 9) : '登录 / 注册';
          },
          tip: ['开发者中心：注册 / 登录后立刻拿到 API Key，交给 AI 就能通过 API 提交插件',
                '已登录时显示你的账号，点进去可复制 Key 给 AI / 下架 / 退出登录',
                '浏览 / 安装 / 创作插件都不需要登录'],
          onClick: () => this.game.ui.open(new Q.DeveloperScreen(this.game, this)),
        });
        W.push({ x: cx + 55, y: u.h - 27, w: 100, h: 20, label: '完成', onClick: () => this.back() });
        this.widgets = W;
      }
      async submitCreated() {
        if (this.busy) return;
        const dev = devInfo();
        if (!dev || !dev.apiKey) {
          this.game.ui.message('请先在「登录 / 注册」注册或登录，拿到 API Key', '#FFD479');
          this.game.ui.open(new Q.DeveloperScreen(this.game, this));
          return;
        }
        const code = this.generated || makePluginCode(this.createdId, this.pName, ['command', 'mechanic', 'texture'][this.cap]);
        this.generated = code;
        this.busy = true;
        this.game.ui.message('正在提交到市场，等待服务端校验…', '#7FD8FF');
        const r = await apiCall('POST', 'plugins/submit', { code }, true);
        this.busy = false;
        if (r.ok) {
          const n = await refreshMarket();
          this.game.ui.message('校验全部通过，已上架！市场现有 ' + Math.max(0, n) + ' 个社区插件', '#86EFAC');
          this.layout();
        } else {
          this.game.ui.message('校验没通过：' + (r.error || (r.errors || []).join('；') || '服务器没有响应'), '#FF8080');
        }
      }
      addUrl(u, cx) {
        u.hideInput();
        let typed = '';
        const y = Math.min(u.h - 80, 84);
        u.showInput(cx - 150, y, 300, 16, '', () => {
          const v = typed.trim();
          if (v) { Plugins.addUrl(v); u.hideInput(); location.reload(); }
        }, { onInput: (v) => { typed = String(v || ''); }, onEsc: () => u.hideInput(), max: 300 });
        if (u.input) { u.input.placeholder = '…/my-plugin.js 或 …/plugin-pack.zip'; u.input.focus(); }
      }
      drawExtra(ui) {
        const c = ui.ctx, cx = ui.w / 2;
        if (this.tab === 0) {
          const p = MARKET[this.sel];
          const rows = Math.min(MARKET.length, Math.max(1, Math.floor((ui.h - 51 - 8 - 54) / 24)));
          const y0 = 54 + rows * 24 + 6, yEnd = ui.h - 60;
          if (!p || yEnd - y0 < 34) return;
          c.fillStyle = 'rgba(8, 20, 40, 0.74)'; c.fillRect(cx - 155, y0, 310, yEnd - y0);
          c.strokeStyle = 'rgba(125, 216, 255, 0.34)'; c.lineWidth = 1;
          c.strokeRect(cx - 154.5, y0 + 0.5, 309, yEnd - y0 - 1);
          c.fillStyle = '#7FD8FF'; c.fillRect(cx - 155, y0, 310, 1);
          let y = y0 + 11;
          Font.draw(c, p.name + '   v' + p.version, cx - 145, y, '#EAF4FF'); y += 14;
          Font.draw(c, (p.source === 'community' ? '社区插件 · 作者 ' + (p.author || '匿名') : '官方内置') +
            ' · 能力：' + capsCN(p.caps).join(' / ') + ' · ' + (isInstalled(p) ? '已安装' : '未安装'), cx - 145, y, '#8FA8C8'); y += 15;
          const desc = (p.description || p.desc || '') +
            '。仅支持 ITLZMC 原生插件，不加载 Mod / 模组；源码存本机，完全离线可用。';
          for (const ln of wrapFont(desc, 298).slice(0, 5)) {
            Font.draw(c, ln, cx - 145, y, '#C7DBF2'); y += 12;
          }
        } else if (this.tab === 1) {
          Font.center(c, '点红色条目复制诊断给 AI · 状态存在本机 · 点「重载生效」启用', cx, ui.h - 62, '#8FA8C8');
        } else {
          const y0 = 54 + 3 * 24 + 6, yEnd = ui.h - 60;
          if (yEnd - y0 < 34) return;
          c.fillStyle = 'rgba(8, 20, 40, 0.74)'; c.fillRect(cx - 155, y0, 310, yEnd - y0);
          c.strokeStyle = 'rgba(125, 216, 255, 0.34)'; c.lineWidth = 1;
          c.strokeRect(cx - 154.5, y0 + 0.5, 309, yEnd - y0 - 1);
          const src = this.generated || makePluginCode(this.createdId, this.pName, ['command', 'mechanic', 'texture'][this.cap]);
          let y = y0 + 10;
          Font.draw(c, this.generated ? '已生成插件源码（预览）' : '插件源码预览 · 选好能力和名称即可生成', cx - 145, y, '#7FD8FF'); y += 15;
          for (const ln of src.split('\n').slice(0, Math.floor((yEnd - y - 6) / 11))) {
            Font.draw(c, ln.slice(0, 46), cx - 145, y, '#A8C8E8'); y += 11;
          }
        }
      }
      wheel(ui, dy) { if (this.tab === 0 || this.tab === 1) { this.scroll = Math.max(0, (this.scroll || 0) + Math.sign(dy)); this.layout(); } }
      back() { this.game.ui.hideInput(); this.game.ui.open(this.parent); }
      onEsc() { this.back(); }
    }
    Q.MarketScreen = MarketScreen;
  }


  // ---- 开发者中心：注册 / 登录 / API Key / 交给 AI / 我的提交 ----
  if (typeof MenuScreen !== 'undefined') {
    class DeveloperScreen extends MenuScreen {
      constructor(game, parent) {
        super(game, '开发者中心 · 插件市场 API');
        this.parent = parent; this.titleY = 10;
        this.dev = devInfo(); this.mode = 'register'; this.field = 'user';
        this.user = (this.dev && this.dev.username) || '';
        this.pass = ''; this.withdrawId = '';
        this.mine = []; this.submissions = [];
        this.busy = false; this.online = true;
        if (this.dev) this.refresh();
      }
      say(t, col) { this.msg = t; this.msgCol = col || '#8FA8C8'; this.game.ui.message(t, col || '#8FA8C8'); }
      async refresh() {
        if (!this.dev) return;
        const r = await apiCall('GET', 'plugins/mine', null, true);
        if (r.ok) { this.mine = r.plugins || []; this.submissions = r.submissions || []; this.online = true; }
        else {
          this.online = false;
          if (r.__status === 401) { clearDev(); this.dev = null; this.say('API Key 已失效，请重新登录或注册', '#FF8080'); }
        }
        this.layout();
      }
      layout() {
        const u = this.game.ui, cx = u.w / 2, W = [], y = 50;
        u.hideInput();
        if (!this.dev) {
          W.push({
            x: cx - 155, y, w: 310, h: 20,
            label: () => (this.field === 'user' ? '▶ ' : '') + '用户名：' + (this.user || '（点这里填写）'),
            tip: ['3–20 位英文字母、数字、下划线'],
            onClick: () => { this.field = 'user'; this.layout(); },
          });
          W.push({
            x: cx - 155, y: y + 24, w: 310, h: 20,
            label: () => (this.field === 'pass' ? '▶ ' : '') + '密码：' +
              (this.pass ? '*'.repeat(Math.min(12, this.pass.length)) : '（点这里填写）'),
            tip: ['至少 6 位', '密码只在注册 / 登录时发给本站服务端，不存进浏览器'],
            onClick: () => { this.field = 'pass'; this.layout(); },
          });
          u.showInput(cx - 150, y + 50, 300, 16, this.field === 'user' ? this.user : this.pass,
            () => this.doAuth(this.mode),
            { password: this.field === 'pass', max: this.field === 'user' ? 20 : 128,
              onInput: (v) => { if (this.field === 'user') this.user = String(v || '').slice(0, 20); else this.pass = String(v || ''); },
              onEsc: () => this.back() });
          W.push({ x: cx - 155, y: y + 74, w: 100, h: 20, label: '注册拿 Key', gold: this.mode === 'register',
            tip: ['注册完立刻发一枚 API Key，交给 AI 就能提交插件'], onClick: () => this.doAuth('register') });
          W.push({ x: cx - 50, y: y + 74, w: 100, h: 20, label: '登录',
            tip: ['已有账号？登录取回同一枚 Key'], onClick: () => this.doAuth('login') });
          W.push({ x: cx + 55, y: y + 74, w: 100, h: 20, label: '自检说明',
            tip: ['AI 可匿名 POST /api/plugins/validate 自检源码，不需要 Key'],
            onClick: () => this.say('AI 自检端点：POST /api/plugins/validate  {"code":"<源码>"}（无需 Key）', '#7FD8FF') });
        } else {
          W.push({
            x: cx - 155, y, w: 310, h: 20,
            label: () => '开发者：' + this.dev.username + '   ·   ' + (this.online ? '已连接市场' : '离线'),
            tip: ['点击刷新我的提交'], onClick: () => this.refresh(),
          });
          W.push({
            x: cx - 155, y: y + 24, w: 310, h: 20,
            label: () => 'API Key：' + this.dev.apiKey.slice(0, 16) + '…（点此复制完整 Key）',
            tip: ['完整 Key：' + this.dev.apiKey, '把 Key 交给 AI，它就能通过 API 提交插件'],
            onClick: () => this.say(copyText(this.dev.apiKey) ? '完整 API Key 已复制' : '复制失败，请手动记下', '#86EFAC'),
          });
          u.showInput(cx - 150, y + 50, 300, 16, this.withdrawId, () => this.withdraw(),
            { max: 64, onInput: (v) => { this.withdrawId = String(v || '').trim(); }, onEsc: () => this.back() });
          W.push({ x: cx - 155, y: y + 74, w: 100, h: 20, label: '复制 Key',
            onClick: () => this.say(copyText(this.dev.apiKey) ? 'API Key 已复制' : '复制失败', '#86EFAC') });
          W.push({ x: cx - 50, y: y + 74, w: 100, h: 20, label: '复制给 AI', gold: true,
            tip: ['把 API 地址、Key、提交方式、校验规则一次复制好，直接粘给 AI'],
            onClick: () => this.say(copyText(aiPrompt(this.dev.apiKey)) ? '给 AI 的说明已复制，粘贴给 AI 即可' : '复制失败', '#86EFAC') });
          W.push({ x: cx + 55, y: y + 74, w: 100, h: 20, label: '刷新状态', onClick: () => this.refresh() });
          W.push({ x: cx - 155, y: y + 98, w: 100, h: 20, label: '重置 Key',
            tip: ['旧 Key 立即失效，需要重新交给 AI'], onClick: () => this.resetKey() });
          W.push({ x: cx - 50, y: y + 98, w: 100, h: 20, label: '下架插件',
            tip: ['在上方输入框填写插件 id，点这里下架'], onClick: () => this.withdraw() });
          W.push({ x: cx + 55, y: y + 98, w: 100, h: 20, label: '退出登录',
            onClick: () => { clearDev(); this.dev = null; this.mine = []; this.say('已退出登录（已安装插件不受影响）', '#FFD479'); this.layout(); } });
        }
        W.push({ x: cx - 155, y: u.h - 27, w: 150, h: 20, label: '下载 AI Skill',
          tip: ['ITLZMC-AI-SKILL.zip：装进 AI 就能按规范写插件并发布到市场'],
          onClick: () => this.say(downloadSkill() ? 'AI Skill 已开始下载' : '下载失败', '#7FD8FF') });
        W.push({ x: cx + 5, y: u.h - 27, w: 150, h: 20, label: '返回市场', onClick: () => this.back() });
        this.widgets = W;
      }
      async doAuth(mode) {
        if (this.busy) return;
        if (!USER_RE.test(this.user)) { this.say('用户名要 3–20 位英文字母 / 数字 / 下划线', '#FF8080'); return; }
        if (this.pass.length < 6) { this.say('密码至少 6 位', '#FF8080'); return; }
        this.busy = true; this.say('正在' + (mode === 'register' ? '注册' : '登录') + '…', '#7FD8FF');
        const r = await apiCall('POST', 'auth/' + (mode === 'register' ? 'register' : 'login'),
          { username: this.user, password: this.pass }, false);
        this.busy = false;
        if (!r.ok || !r.apiKey) { this.say(r.error || '服务器没有响应，请确认已连接 ITLZMC 服务', '#FF8080'); this.layout(); return; }
        this.dev = { username: r.username, apiKey: r.apiKey };
        setDev(this.dev); this.pass = ''; this.online = true;
        this.say('拿到 API Key 了！点「复制给 AI」把说明一次粘给 AI', '#86EFAC');
        this.layout(); await this.refresh();
      }
      async resetKey() {
        if (this.busy) return;
        this.busy = true;
        const r = await apiCall('POST', 'auth/key', {}, true);
        this.busy = false;
        if (!r.ok || !r.apiKey) { this.say(r.error || '重置失败', '#FF8080'); return; }
        this.dev = { username: r.username, apiKey: r.apiKey }; setDev(this.dev);
        this.say('新 Key 已生成，旧 Key 立即失效，请重新「复制给 AI」', '#86EFAC');
        this.layout();
      }
      async withdraw() {
        if (this.busy) return;
        const id = this.withdrawId || (this.mine[0] && this.mine[0].id);
        if (!id) { this.say('先在上方输入框填写要下架的插件 id', '#FFD479'); return; }
        this.busy = true;
        const r = await apiCall('POST', 'plugins/withdraw', { id }, true);
        this.busy = false;
        this.say(r.ok ? '已下架 ' + id : (r.error || '下架失败'), r.ok ? '#86EFAC' : '#FF8080');
        await refreshMarket(); await this.refresh();
      }
      drawExtra(ui) {
        const c = ui.ctx, cx = ui.w / 2, y0 = 50 + 124, yEnd = ui.h - 60;
        if (yEnd - y0 < 20) return;
        c.fillStyle = 'rgba(8, 20, 40, 0.78)'; c.fillRect(cx - 155, y0, 310, yEnd - y0);
        c.strokeStyle = 'rgba(125, 216, 255, 0.34)'; c.lineWidth = 1;
        c.strokeRect(cx - 154.5, y0 + 0.5, 309, yEnd - y0 - 1);
        c.fillStyle = '#7FD8FF'; c.fillRect(cx - 155, y0, 310, 1);
        const lines = [];
        if (!this.dev) {
          lines.push(['普通玩家不需要注册：浏览、安装、创作插件、下载 AI Skill 都免登录。', '#C7DBF2']);
          lines.push(['只有「让 AI 把插件提交上架到市场」才需要注册，注册完立刻发一枚 Key。', '#C7DBF2']);
          lines.push(['填用户名 → 点「密码」行填密码 → 点「注册拿 Key」。', '#8FA8C8']);
          lines.push(['登录后点「复制给 AI」，一整段 API 说明直接粘给 AI。', '#8FA8C8']);
          lines.push(['AI 提交前服务端会校验语法 / 危险 API / 沙箱试运行 / 实际能力，通过才上架。', '#8FA8C8']);
          lines.push(['离线版（APK / EXE）没有市场服务，内置官方插件照常可用。', '#8FA8C8']);
        } else {
          const origin = (location.origin && location.origin !== 'null') ? location.origin : '<本站地址>';
          const sc2 = new URL(location.href).searchParams.get('sharecode');
          const qs2 = sc2 ? '?sharecode=' + encodeURIComponent(sc2) : '';
          lines.push(['API 地址：' + origin + '/api/   （每个请求都要带 ' + (qs2 || '?sharecode=…') + '）', '#7FD8FF']);
          lines.push(['提交：POST /api/plugins/submit' + qs2 + '  头 X-ITLZMC-Key: <你的Key>', '#C7DBF2']);
          lines.push(['漏带 sharecode 会被网关 403 拦截，点「复制给 AI」拿拼好的完整地址', '#FFD479']);
          lines.push(['body {"code":"<插件完整源码>"} · 校验全绿才会上架到市场', '#C7DBF2']);
          lines.push(['我上架的插件 ' + this.mine.length + ' 个：' +
            (this.mine.length ? this.mine.map((p) => p.id + ' v' + p.version).join('、') : '（还没有）'), '#86EFAC']);
          const last = (this.submissions || []).slice(0, 2);
          if (!last.length) lines.push(['最近提交：暂无记录', '#8FA8C8']);
          for (const s of last) lines.push(['最近提交：' + s.id + ' → ' +
            (s.status === 'published' ? '已上架' : s.status === 'rejected' ? '校验未通过' : s.status),
            s.status === 'published' ? '#86EFAC' : '#FFD479']);
        }
        let y = y0 + 10;
        for (const [t, col] of lines) {
          for (const ln of wrapFont(t, 298).slice(0, 2)) { Font.draw(c, ln, cx - 145, y, col); y += 11; }
          if (y > yEnd - 10) break;
        }
      }
      back() { this.game.ui.hideInput(); this.game.ui.open(this.parent); }
      onEsc() { this.back(); }
    }
    Q.DeveloperScreen = DeveloperScreen;
  }

  Q.Market = {
    refresh: refreshMarket, dev: devInfo, api: apiCall,
    list: () => MARKET.slice(), prompt: aiPrompt,
    install: toggleInstall, installed: isInstalled,
  };

  // ---- 管理界面 ----
  if (typeof MenuScreen !== 'undefined') {
    class PluginsScreen extends MenuScreen {
      constructor(game, parent, kind) {
        super(game, '插件管理');
        this.parent = parent; this.kind = kind || 'resource'; this.titleY = 12;
      }
      layout() {
        const u = this.game.ui, cx = u.w / 2, W = [];
        const recs = Plugins.list();
        if (!recs.length) W.push({ x: cx - 155, y: 60, w: 310, h: 20, label: '还没有加载任何插件', enabled: false });
        recs.forEach((r, i) => {
          const bad = !!r.error;
          const caps = (r.capabilities || []).length ? ' [' + r.capabilities.join('·') + ']' : '';
          W.push({
            x: cx - 155, y: 60 + i * 24, w: 310, h: 20,
            label: () => (r.enabled ? '[开] ' : '[关] ') + r.name + caps + (bad ? '（加载失败）' : ''),
            tip: bad ? [String(r.error).slice(0, 90)] : [
              r.origin + ' · ' + (r.kind || (r.type === 'js' ? 'JS 插件' : '插件包')),
              r.version ? '版本 ' + r.version : '',
              r.metaSource ? '清单 ' + r.metaSource : '',
              r.textures ? '替换贴图 ' + r.textures + ' 张' : '',
              r.atlas ? '其中图集空位 ' + r.atlas + ' 张' : '',
              r.hooks ? '机制钩子 ' + r.hooks + ' 个' : '',
              r.commands ? '新增指令 ' + r.commands + ' 条' : '',
              r.blocks ? '新增方块 ' + r.blocks + ' 个' : '',
            ].filter(Boolean),
            onClick: () => { Plugins.toggle(r.id); this.game.ui.message('重启游戏后生效', '#FFD479'); },
          });
        });
        const baseY = Math.min(u.h - 84, 60 + recs.length * 24 + 8);
        W.push({ x: cx - 155, y: baseY, w: 150, h: 20, label: '添加插件 URL',
          tip: ['.js 插件、带 plugin.json 的 .zip 插件包',
                '也可把文件放进服务端的 plugins/ 目录自动加载',
                '或到「插件市场」一键安装官方插件'],
          onClick: () => this.addUrl(u, cx, baseY) });
        W.push({ x: cx + 5, y: baseY, w: 150, h: 20, label: '重载生效', onClick: () => location.reload() });
        W.push({ x: cx - 100, y: u.h - 27, w: 200, h: 20, label: '完成', onClick: () => this.back() });
        this.widgets = W;
      }
      addUrl(u, cx, y) {
        u.hideInput();
        let typed = '';
        u.showInput(cx - 150, y + 26, 300, 18, '', () => {
          const v = typed.trim();
          if (v) { Plugins.addUrl(v); u.hideInput(); location.reload(); }
        }, { onInput: (v) => { typed = String(v || ''); }, onEsc: () => u.hideInput(), max: 300 });
        if (u.input) { u.input.placeholder = '…/my-plugin.js 或 …/plugin-pack.zip'; u.input.focus(); }
      }
      back() { this.game.ui.hideInput(); this.game.ui.open(this.parent); }
      onEsc() { this.back(); }
    }
    Q.PluginsScreen = PluginsScreen;
  }
})();
