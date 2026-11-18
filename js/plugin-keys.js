'use strict';
// ---------------------------------------------------------------------------
// ITLZMC 插件按键引擎 (plugin-keys.js)
//
// 解决的问题：插件用「按下波浪键触发连锁挖矿」这种物理键盘逻辑，手机端没有
// 物理键盘，按键就永远触发不了。本模块做三件事：
//
//   1. 声明式 API：P.addKey('veinMine', { code:'Backquote', label:'连锁挖矿',
//      onDown: fn }) —— 插件不必自己 addEventListener，桌面 / 手机统一托管。
//   2. 自动检测：插件即使写的是老写法（自己监听 keydown、判断 e.code、读
//      g.keys[...]），启动时也会静态扫描源码，把用到的按键全部登记下来。
//   3. 自动创建：登记到的按键在触屏设备上自动生成一排屏幕虚拟按钮；按下按钮
//      等价于按下那个物理键（回调 + g.keys + 合成 KeyboardEvent），老插件零改动
//      就能在手机上用。桌面上则由引擎统一转发物理键事件。
//
// 完全自包含、零依赖，加载顺序必须在 js/plugins.js 之前。
// ---------------------------------------------------------------------------
(function () {
  const QK = {};
  window.QIUMCKeys = QK;

  // ---- 中文按键名（与 controls.js 的风格一致，这里内置一份避免加载顺序依赖） ----
  const NAMES = {
    Backquote: '波浪键 `', Space: '空格', Tab: 'Tab', Enter: '回车', Escape: 'Esc',
    ShiftLeft: '左Shift', ShiftRight: '右Shift', ControlLeft: '左Ctrl', ControlRight: '右Ctrl',
    AltLeft: '左Alt', AltRight: '右Alt', BracketLeft: '[', BracketRight: ']',
    Semicolon: ';', Quote: "'", Backslash: '\\', IntlBackslash: '\\',
    Comma: ',', Period: '.', Slash: '/', Minus: '-', Equal: '=',
    ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
    Insert: 'Insert', Delete: 'Delete', Home: 'Home', End: 'End',
    PageUp: 'PageUp', PageDown: 'PageDown', CapsLock: 'CapsLock', ContextMenu: '菜单键',
  };
  function codeLabel(code) {
    if (!code) return '未指定';
    if (NAMES[code]) return NAMES[code];
    if (/^Key[A-Z]$/.test(code)) return code.slice(3);
    if (/^Digit\d$/.test(code)) return code.slice(5);
    if (/^F([1-9]|1[0-2])$/.test(code)) return code;
    if (/^Numpad/.test(code)) return '小键盘' + code.slice(6);
    if (/^Mouse[0-2]$/.test(code)) return '鼠标键' + (+code.slice(5) + 1);
    return code;
  }
  // code -> KeyboardEvent.key 的近似值（合成事件用）
  function keyFromCode(code) {
    if (!code) return '';
    if (code === 'Backquote') return '`';
    if (code === 'Space') return ' ';
    if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
    if (/^Digit\d$/.test(code)) return code.slice(5);
    return NAMES[code] && NAMES[code].length === 1 ? NAMES[code] : code;
  }
  // e.key 字符 -> code（自动检测时把 e.key === '~' 之类还原成物理 code）
  function codeFromKey(k) {
    if (!k) return '';
    if (k === '~' || k === '`') return 'Backquote';
    if (k === ' ') return 'Space';
    if (/^[a-zA-Z]$/.test(k)) return 'Key' + k.toUpperCase();
    if (/^[0-9]$/.test(k)) return 'Digit' + k;
    const map = { '[': 'BracketLeft', ']': 'BracketRight', ';': 'Semicolon', "'": 'Quote',
      '\\': 'Backslash', ',': 'Comma', '.': 'Period', '/': 'Slash', '-': 'Minus', '=': 'Equal',
      Enter: 'Enter', Escape: 'Escape', Tab: 'Tab', Backspace: 'Backspace' };
    if (map[k]) return map[k];
    if (/^F([1-9]|1[0-2])$/.test(k)) return k;
    if (/^Arrow/.test(k)) return k;
    return '';
  }
  const VALID_CODE = /^(?:Key[A-Z]|Digit\d|Numpad\d|F(?:[1-9]|1[0-2])|Backquote|Space|Tab|Enter|Escape|ShiftLeft|ShiftRight|ControlLeft|ControlRight|AltLeft|AltRight|BracketLeft|BracketRight|Semicolon|Quote|Backslash|IntlBackslash|Comma|Period|Slash|Minus|Equal|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Insert|Delete|Home|End|PageUp|PageDown|CapsLock|ContextMenu|Mouse[0-2])$/;

  // 原版已占用的按键：插件不该抢，自动检测时也不会平白生成重复按钮
  // （运行时若 controls.js 已加载，用它的真实默认值；否则用内置兜底）
  function vanillaCodes() {
    const out = new Set();
    try {
      if (typeof KEY_DEFAULT !== 'undefined') for (const k in KEY_DEFAULT) if (KEY_DEFAULT[k]) out.add(KEY_DEFAULT[k]);
    } catch (e) { }
    if (!out.size) for (const c of ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'ShiftLeft', 'ControlLeft',
      'KeyQ', 'KeyE', 'KeyF', 'KeyT', 'Slash', 'KeyL', 'KeyH', 'KeyV',
      'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9',
      'Mouse0', 'Mouse1', 'Mouse2', 'F1', 'F2', 'F3', 'F5', 'F11']) out.add(c);
    // 这些键会开菜单 / 打断游戏，虚拟按钮不合成事件
    for (const c of ['Escape', 'Tab', 'F1', 'F3', 'F5', 'F11']) out.add(c);
    return out;
  }

  // ---- 注册表 ----
  const BINDS = new Map();   // id -> bind
  const HELD = new Set();    // 当前按下的 bind id
  let panel = null, panelList = null, panelHead = null, collapsed = false, inited = false;

  function game() { return window.game || null; }
  function playable() {
    const g = game();
    return !!(g && g.state === 'play' && !(g.ui && g.ui.screen));
  }
  function currentPluginId() {
    try { return (window.ITLZMC && window.ITLZMC.Plugins && window.ITLZMC.Plugins._current && window.ITLZMC.Plugins._current.id) || ''; }
    catch (e) { return ''; }
  }

  // ---- 声明式注册：宽松签名，AI 怎么写都能接住 ----
  // P.addKey('veinMine', { code:'Backquote', label:'连锁挖矿', onDown: fn, onUp: fn, mode:'hold' })
  // P.addKey('veinMine', 'Backquote', fn)
  // P.addKey('Backquote', fn)  /  P.addKey({ id, code, onDown })
  // P.onKey('Backquote', fn)   /  P.bindKey(...)  /  P.key(...)
  function register(a, b, c) {
    let id = '', o = {};
    if (a && typeof a === 'object') { o = Object.assign({}, a); id = o.id || o.code || o.key || o.name || ''; }
    else if (typeof a === 'string' && b && typeof b === 'object') { id = a; o = Object.assign({}, b); }
    else if (typeof a === 'string' && typeof b === 'string') { id = a; o = { code: b }; if (typeof c === 'function') o.onDown = c; }
    else if (typeof a === 'string' && typeof b === 'function') { id = a; o = { onDown: b }; }
    else if (typeof a === 'string') { id = a; o = {}; }
    if (!id) return null;

    const keyChar = o.key || o.char || '';
    let code = o.code || o.default || o.keyCode || o.binding || '';
    if (!VALID_CODE.test(code)) {
      const guess = codeFromKey(code) || (VALID_CODE.test(id) ? id : '') || codeFromKey(keyChar);
      code = guess;
      if (code && !VALID_CODE.test(code)) code = '';
    }
    if (!code && keyChar) code = codeFromKey(keyChar);
    if (!code) code = VALID_CODE.test(id) ? id : '';

    const onDown = o.onDown || o.onPress || o.down || o.fn || o.handler || o.action ||
      (typeof o.press === 'function' ? o.press : null);
    const onUp = o.onUp || o.onRelease || o.up || (typeof o.release === 'function' ? o.release : null);
    const pid = o.pluginId || currentPluginId() || '';
    const bind = {
      id: String(id), code, key: keyChar || keyFromCode(code),
      label: String(o.label || o.name || o.title || codeLabel(code) || id).slice(0, 20),
      desc: String(o.desc || o.description || o.tip || '').slice(0, 80),
      mode: (o.mode === 'hold' || o.hold === true) ? 'hold' : 'press',
      onDown: typeof onDown === 'function' ? onDown : null,
      onUp: typeof onUp === 'function' ? onUp : null,
      pluginId: pid, implicit: !!o.implicit, prevent: !!o.prevent,
      vanilla: vanillaCodes().has(code),
    };
    if (!bind.code && !bind.onDown) return null;   // 既没有键也没有回调，不生成空按钮
    // 同一 id 重复声明（热重载 / 同一插件多次注册）覆盖而不是堆积
    BINDS.set(bind.id, bind);
    renderPanel();
    return bind.id;
  }

  // ---- 自动检测：静态扫描插件源码，把用到的物理键补齐 ----
  function stripComments(src) {
    return String(src || '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  }
  function scan(code, pluginId) {
    const clean = stripComments(code);
    const pid = pluginId || currentPluginId() || 'plugin';
    // 只有源码确实碰了键盘，才做自动登记，避免把配方字符串 'KeyA' 之类误判成按键
    const touchesKeyboard = /(?:addEventListener\s*\(\s*['"]key(?:down|up)|onkeydown\s*=|onkeyup\s*=|\.code\s*(?:===|==)|\.key\s*(?:===|==)|\bg\.keys\s*\[|keys\s*\[\s*['"])/.test(clean);
    if (!touchesKeyboard) return 0;

    const declared = new Set();
    for (const b of BINDS.values()) if (b.pluginId === pid && b.code) declared.add(b.code);

    const found = new Set();
    const add = (v) => { const c = codeFromKey(v) || (VALID_CODE.test(v) ? v : ''); if (c) found.add(c); };
    let m;
    // e.code === 'Backquote' / case 'KeyB' / g.keys['Backquote']
    const reCode = /['"]([A-Za-z][A-Za-z0-9]{1,15})['"]/g;
    while ((m = reCode.exec(clean))) {
      const v = m[1];
      if (VALID_CODE.test(v) || codeFromKey(v)) add(v);
    }
    // e.key === '~' / e.key == 'v'
    const reKey = /\.key\s*(?:===|==|!==|!=)\s*['"]([^'"]{1,12})['"]/g;
    while ((m = reKey.exec(clean))) add(m[1]);

    let n = 0;
    const vanilla = vanillaCodes();
    for (const c of found) {
      if (declared.has(c)) continue;
      // 原版键只在插件明确写了 .code/.key 比较时才登记（并标注冲突）
      if (vanilla.has(c) && !new RegExp('(?:\\.code|\\.key)\\s*(?:===|==)\\s*[\'\"]' + c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(clean)) continue;
      const id = 'auto:' + pid + ':' + c;
      if (BINDS.has(id)) continue;
      BINDS.set(id, {
        id, code: c, key: keyFromCode(c), label: codeLabel(c),
        desc: '自动检测到的按键 · 手机端已生成同名按钮', mode: 'press',
        onDown: null, onUp: null, pluginId: pid, implicit: true,
        prevent: false, vanilla: vanilla.has(c),
      });
      n++;
    }
    if (n) renderPanel();
    return n;
  }

  // ---- 触发 ----
  function emit(name, bind, extra) {
    try {
      const P = window.ITLZMC && window.ITLZMC.Plugins;
      if (P && typeof P.emit === 'function') P.emit(name, Object.assign({ id: bind.id, code: bind.code, key: bind.key }, extra || {}));
    } catch (e) { }
  }
  function ctxFor(bind, ev) {
    const g = game();
    return {
      id: bind.id, code: bind.code, key: bind.key,
      game: g, player: g && g.player, world: g && g.world,
      event: ev || null, source: ev && ev.__qiumcVirtual ? 'virtual' : 'keyboard',
      say: (t, col) => { try { g && g.ui && g.ui.message(String(t), col || '#86EFAC'); } catch (e) { } },
    };
  }
  function setGKeys(code, on) {
    const g = game();
    if (g && g.keys) { try { g.keys[code] = on; } catch (e) { } }
  }
  // 给老插件（自己 addEventListener('keydown')）合成一个真实的 KeyboardEvent
  function synth(type, bind) {
    if (bind.vanilla && ['Escape', 'Tab', 'F1', 'F3', 'F5', 'F11'].indexOf(bind.code) >= 0) return;
    try {
      const ev = new KeyboardEvent(type, {
        code: bind.code, key: bind.key || keyFromCode(bind.code),
        bubbles: true, cancelable: true, repeat: false,
      });
      Object.defineProperty(ev, '__qiumcVirtual', { value: true });
      window.dispatchEvent(ev);
    } catch (e) { }
  }
  function down(bind, ev) {
    if (!bind || HELD.has(bind.id)) return;
    HELD.add(bind.id);
    setGKeys(bind.code, true);
    const c = ctxFor(bind, ev);
    if (bind.onDown) { try { bind.onDown(c); } catch (e) { console.warn('[ITLZMC:key] ' + bind.id + ' onDown 出错：' + e); } }
    if (bind.implicit) synth('keydown', bind);
    emit('keyDown', bind, { source: c.source });
    highlight(bind.id, true);
  }
  function up(bind, ev) {
    if (!bind || !HELD.has(bind.id)) return;
    HELD.delete(bind.id);
    setGKeys(bind.code, false);
    const c = ctxFor(bind, ev);
    if (bind.onUp) { try { bind.onUp(c); } catch (e) { console.warn('[ITLZMC:key] ' + bind.id + ' onUp 出错：' + e); } }
    if (bind.implicit) synth('keyup', bind);
    emit('keyUp', bind, { source: c.source });
    highlight(bind.id, false);
  }
  function matches(b, ev) {
    return !!(b.code && ev.code === b.code) || !!(b.key && ev.key === b.key);
  }

  // 物理键：与 main.js 的 bindInput 并存，不抢原版绑定，只转发给插件
  window.addEventListener('keydown', (ev) => {
    if (ev.__qiumcVirtual || !playable()) return;
    if (document.activeElement && /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)) return;
    for (const b of BINDS.values()) {
      if (!matches(b, ev)) continue;
      down(b, ev);
      if (b.prevent && ev.cancelable) ev.preventDefault();
    }
  });
  window.addEventListener('keyup', (ev) => {
    if (ev.__qiumcVirtual) return;
    for (const b of BINDS.values()) if (matches(b, ev)) up(b, ev);
  });
  window.addEventListener('blur', () => { for (const b of BINDS.values()) up(b); });

  // ---- 手机端虚拟按钮面板 ----
  function isTouchDevice() {
    const g = game();
    try {
      if (typeof TouchDevice !== 'undefined' && TouchDevice.defaultOn) return true;
      if (typeof touchOn === 'function' && g && touchOn(g)) return true;
    } catch (e) { }
    return (navigator.maxTouchPoints > 0 || 'ontouchstart' in window) &&
      !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
  }
  const CSS = [
    '#itlzmc-keys{position:fixed;right:12px;top:104px;z-index:65;display:none;',
    'max-width:min(210px,34vw);padding:8px 9px 9px;border-radius:14px;',
    'background:rgba(8,18,34,.74);border:1px solid rgba(125,216,255,.24);',
    'box-shadow:0 8px 26px rgba(0,0,0,.4);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);',
    'color:#dbeafe;font:11px/1.5 system-ui,-apple-system,sans-serif;user-select:none;-webkit-user-select:none;touch-action:none}',
    '#itlzmc-keys .qk-h{display:flex;align-items:center;justify-content:space-between;gap:8px;',
    'color:#7dd3fc;font-size:11px;letter-spacing:.06em;margin-bottom:6px;cursor:pointer}',
    '#itlzmc-keys .qk-h span.i{color:#8fa8c8;font-size:10px}',
    '#itlzmc-keys .qk-t{padding:0 4px 6px;color:#8fa8c8;font-size:10px;line-height:1.4;white-space:normal}',
    '#itlzmc-keys .qk-l{display:flex;flex-direction:column;gap:5px}',
    '#itlzmc-keys.qk-fold .qk-l,#itlzmc-keys.qk-fold .qk-t{display:none}',
    '#itlzmc-keys button{display:block;width:100%;box-sizing:border-box;padding:7px 8px;border-radius:9px;',
    'border:1px solid rgba(125,216,255,.28);background:rgba(20,42,72,.78);color:#dbeafe;',
    'font:11px/1.35 system-ui,-apple-system,sans-serif;text-align:left;cursor:pointer;',
    'touch-action:none;outline:none;transition:background .08s,border-color .08s}',
    '#itlzmc-keys button b{display:block;font-weight:600;color:#e8f4ff}',
    '#itlzmc-keys button i{display:block;font-style:normal;font-size:9px;color:#8fa8c8;margin-top:1px}',
    '#itlzmc-keys button.qk-on{background:rgba(56,142,214,.72);border-color:#7dd3fc;color:#fff}',
    '#itlzmc-keys button.qk-warn{border-color:rgba(252,211,77,.5)}',
  ].join('');
  function ensurePanel() {
    if (panel || !document.body) return;
    try {
      const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
      panel = document.createElement('div'); panel.id = 'itlzmc-keys';
      panelHead = document.createElement('div'); panelHead.className = 'qk-h';
      panelHead.innerHTML = '<span>⌨ 插件按键</span><span class="i">收起</span>';
      panelHead.addEventListener('click', () => {
        collapsed = !collapsed;
        panel.classList.toggle('qk-fold', collapsed);
        panelHead.querySelector('.i').textContent = collapsed ? '展开' : '收起';
      });
      const tip = document.createElement('div'); tip.className = 'qk-t';
      tip.textContent = '手机没有物理键盘，这些按钮由插件自动生成，等价于按下对应按键。';
      panelList = document.createElement('div'); panelList.className = 'qk-l';
      panel.appendChild(panelHead); panel.appendChild(tip); panel.appendChild(panelList);
      document.body.appendChild(panel);
    } catch (e) { panel = null; }
  }
  function highlight(id, on) {
    if (!panelList) return;
    const b = panelList.querySelector('[data-kid="' + String(id).replace(/"/g, '\\"') + '"]');
    if (b) b.classList.toggle('qk-on', !!on);
  }
  function renderPanel() {
    ensurePanel();
    if (!panelList) return;
    const binds = [...BINDS.values()];
    panelList.innerHTML = '';
    for (const b of binds) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.setAttribute('data-kid', b.id);
      if (b.vanilla) btn.className = 'qk-warn';
      const nm = document.createElement('b'); nm.textContent = b.label;
      const sub = document.createElement('i');
      sub.textContent = (b.implicit ? '自动检测 · ' : '') + codeLabel(b.code) +
        (b.vanilla ? ' · 与原版按键共用' : '') + (b.mode === 'hold' ? ' · 按住' : '');
      btn.appendChild(nm); btn.appendChild(sub);
      const press = (ev) => {
        ev.preventDefault(); ev.stopPropagation();
        try { btn.setPointerCapture(ev.pointerId); } catch (e) { }
        down(b, ev); btn.classList.add('qk-on');
      };
      const release = (ev) => {
        ev.preventDefault(); ev.stopPropagation();
        up(b, ev); btn.classList.remove('qk-on');
      };
      btn.addEventListener('pointerdown', press);
      btn.addEventListener('pointerup', release);
      btn.addEventListener('pointercancel', release);
      btn.addEventListener('lostpointercapture', release);
      panelList.appendChild(btn);
    }
    if (panelHead) panelHead.firstChild.textContent = '⌨ 插件按键 · ' + binds.length;
    // 装上新插件 / 自动检测到新按键后立刻刷新可见性，不用等下一次轮询
    tickVisibility();
  }
  function tickVisibility() {
    ensurePanel();
    if (!panel) return;
    const show = isTouchDevice() && playable() && BINDS.size > 0;
    const want = show ? 'block' : 'none';
    if (panel.style.display !== want) panel.style.display = want;
  }
  setInterval(tickVisibility, 260);
  // 热重载 / 禁用插件时清掉它的按键
  QK.removePlugin = function (pid) {
    let changed = false;
    for (const [id, b] of BINDS) if (b.pluginId === pid) { BINDS.delete(id); HELD.delete(id); changed = true; }
    if (changed) renderPanel();
  };

  QK.register = register;
  QK.addKey = register;
  QK.key = register;
  QK.bindKey = register;
  QK.onKey = function (code, fn) {
    const o = (fn && typeof fn === 'object') ? Object.assign({}, fn) : { onDown: fn };
    o.code = o.code || code; o.id = o.id || ('key-' + code);
    return register(o);
  };
  QK.scan = scan;
  QK.list = function () { return [...BINDS.values()].map((b) => ({
    id: b.id, code: b.code, label: b.label, desc: b.desc, mode: b.mode,
    pluginId: b.pluginId, implicit: b.implicit, vanilla: b.vanilla, down: HELD.has(b.id),
  })); };
  QK.isDown = function (idOrCode) {
    if (HELD.has(idOrCode)) return true;
    for (const b of BINDS.values()) if (b.code === idOrCode && HELD.has(b.id)) return true;
    const g = game();
    return !!(g && g.keys && g.keys[idOrCode]);
  };
  QK.down = down; QK.up = up;
  QK.render = renderPanel;
  QK.tick = tickVisibility;
  QK.codeLabel = codeLabel;
  inited = true;
})();
