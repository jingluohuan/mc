'use strict';
// ---------------------------------------------------------------------------
// 离线版：账号系统已移除（无 B 站登录、无识别码、无房间服务）。
// 用一个「本地身份」代替：不需要登录，全部皮肤 / 披风 / 装饰默认解锁，
// 装扮改动保存到 localStorage，刷新后仍在。游戏只依赖这些同名接口。
// ---------------------------------------------------------------------------
const ACCOUNT_SETTINGS = ['fov', 'sens', 'volume', 'gamma', 'bobbing', 'advTooltips', 'keys', 'autoJump', 'invertY', 'subtitles', 'chatOpacity', 'tutorialOff', 'minimap', 'deathMarker', 'recipeHints', 'vibrate', 'quickChat'];
const SINGLE_OPEN = true;

const PROFILE_KEY = 'itlzmc.offline.profile';

function loadProfile() {
  try {
    const p = JSON.parse(localStorage.getItem(PROFILE_KEY) || '{}');
    return p && typeof p === 'object' ? p : {};
  } catch (e) { return {}; }
}

// 离线版把所有装扮视为已拥有：在线活动与解锁门槛全部消失。
function allOwned() {
  const out = [];
  try {
    if (typeof Cosmetics !== 'undefined' && Array.isArray(Cosmetics.LIST)) {
      for (const d of Cosmetics.LIST) if (d && d.id) out.push(d.id);
    }
  } catch (e) { }
  try {
    if (typeof Capes !== 'undefined' && Array.isArray(Capes.list)) {
      for (const c of Capes.list) if (c && c.ev && c.id) out.push('cape:' + c.id);
    }
  } catch (e) { }
  return out;
}

const Account = {
  loggedIn: true,          // 本地身份，不是「已登录 B 站」
  _name: null,
  // 玩家名可在「多人游戏」里改，同步到设置；本地房间 / 聊天 / 装扮预览共用。
  get name() {
    if (this._name) return this._name;
    let n = '';
    try { n = JSON.parse(localStorage.getItem('mcjs-settings') || '{}').netName || ''; } catch (e) { }
    if (!n) { try { n = (this._profile && this._profile.name) || ''; } catch (e) { } }
    if (!n) n = 'Steve' + Math.floor(Math.random() * 900 + 100);
    this._name = String(n).slice(0, 16);
    return this._name;
  },
  set name(v) { this._name = String(v || '').slice(0, 16) || 'Steve'; },
  token: null,
  unlocks: { triple: true, follow: true, online: true },
  _profile: loadProfile(),

  get data() {
    return Object.assign({}, this._profile, { owned: allOwned(), super: false });
  },
  set data(v) { if (v && typeof v === 'object') this._profile = Object.assign({}, v); },

  has() { return true; },
  allUnlocked() { return true; },
  loadGate() { return Promise.resolve({ requireAccount: false, follow: false, triple: false }); },
  checkUnlocks() { return Promise.resolve(); },
  update(patch) {
    try {
      Object.assign(this._profile, patch || {});
      localStorage.setItem(PROFILE_KEY, JSON.stringify(this._profile));
    } catch (e) { }
    return Promise.resolve(this.data);
  },
  api() { return Promise.resolve(null); },
};

for (const k of ['init', 'load', 'refresh', 'logout', 'sign', 'sync', 'save', 'me', 'status', 'check', 'resolve']) {
  if (!(k in Account)) Account[k] = () => Promise.resolve(null);
}

// ---- 界面绘制辅助（与平台无关，原样保留，供皮肤 / 装扮界面使用） ----------
function drawCard(c, x, y, w, h, gold) {
  c.fillStyle = 'rgba(0,0,0,0.55)'; c.fillRect(x, y, w, h);
  c.strokeStyle = gold ? '#E8B830' : '#555555'; c.lineWidth = 1; c.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  if (gold) { c.fillStyle = 'rgba(232,184,48,0.10)'; c.fillRect(x + 1, y + 1, w - 2, h - 2); }
}
const ICON_PIX = {
  like: ['..##....', '..##....', '.###....', '########', '#.######', '#.######', '#.#####.', '#.####..'],
  coin: ['..####..', '.#....#.', '#..##..#', '#.#..#.#', '#.#..#.#', '#..##..#', '.#....#.', '..####..'],
  star: ['...##...', '...##...', '########', '.######.', '..####..', '.##..##.', '.#....#.', '........'],
  follow: ['.##..##.', '########', '########', '########', '.######.', '..####..', '...##...', '........'],
  check: ['.......#', '......##', '.....##.', '#...##..', '##.##...', '.###....', '..#.....', '........'],
  lock: ['..####..', '.#....#.', '.#....#.', '########', '###..###', '###..###', '########', '########'],
};
function drawIcon(c, name, x, y, s, col) {
  const p = ICON_PIX[name]; if (!p) return;
  c.fillStyle = col;
  for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) if (p[j][i] === '#') c.fillRect(x + i * s, y + j * s, s, s);
}
function unlockCelebrate(g, got) { /* 离线版本来就已全解锁，不再弹庆祝动画 */ }
const UnlockSparks = {
  t0: 0, list: [], text: '',
  start() { },
  draw() { },   // ui.js 每帧会调用，保持为空操作
};

// ---- 游玩门槛：离线版一律直接放行，不再检查关注 / 互动 / 登录 --------------
function singleGate(g, then) { return then(); }
function onlineGate(g, then) { return then(); }
function offlineBack(g, parent) { g.ui.open(parent || new TitleScreen(g)); }

// ---- 平台界面的安全占位（入口已从菜单移除，仅防误触） ----------------------
class LoginScreen extends OfflineScreen {
  constructor(g) { super(g, '登录', '离线版无需登录，直接进入即可游玩。'); }
}
class CodeShowScreen extends OfflineScreen { constructor(g) { super(g, '识别码'); } }
class CodeLoginScreen extends OfflineScreen { constructor(g) { super(g, '识别码登录'); } }
class AccountScreen extends OfflineScreen { constructor(g) { super(g, '账号', '离线版没有在线账号。'); } }
class FrozenScreen extends OfflineScreen { constructor(g) { super(g, '账号'); } }
class AdminScreen extends OfflineScreen { constructor(g) { super(g, '管理'); } }
class UnlockScreen extends OfflineScreen { constructor(g) { super(g, '解锁', '离线版所有装扮已默认解锁。'); } }
class ToyDiagScreen extends OfflineScreen { constructor(g) { super(g, '平台诊断', '离线版不连接任何平台。'); } }
class FollowGateScreen extends OfflineScreen { constructor(g) { super(g, '装扮解锁', '所有装扮在离线版已全部解锁。'); } }
