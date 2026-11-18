# 跨端按键规范（手机端没有物理键盘）

> **一句话**：ITLZMC 会运行在手机 / 平板 / EXE / APK 上。**永远不要假设玩家有键盘**。
> 不要写 `window.addEventListener('keydown', ...)`、不要读 `e.code`、不要直接读 `g.keys`。
> 用 `P.addKey(...)` 声明按键，引擎会自动在**桌面转发物理键**、在**手机生成屏幕虚拟按钮**。

---

## 1. 为什么必须声明

用户做「按下波浪键 `~`（`Backquote`）触发连锁挖矿」这类插件时，如果直接监听键盘：

```js
// ❌ 错误：桌面能跑，手机上永远触发不了，因为手机没有这个物理键
window.addEventListener('keydown', function (e) {
  if (e.code === 'Backquote') veinMine();
});
```

而且这类写法在**服务端提交沙箱**里也没有真实的 `window`，很容易校验失败或静默失效。

**正确写法**：把按键交给引擎声明，插件只关心「按下之后做什么」。

```js
P.addKey('veinMine', {
  code: 'Backquote',          // 桌面端绑定这个物理键
  label: '连锁挖矿',           // 手机端虚拟按钮上显示的文字
  desc: '按住并挖掘，连锁破坏相邻同类方块',
  mode: 'hold',               // 'press' 按下瞬间触发一次 / 'hold' 按住期间保持状态
  onDown: function (ctx) { P.message('连锁挖矿：开'); },
  onUp:   function (ctx) { P.message('连锁挖矿：关'); },
});
```

引擎（`js/plugin-keys.js`）随后自动完成：

| 端 | 自动行为 |
| --- | --- |
| 桌面 / EXE | 监听 `keydown`/`keyup`，命中 `code` 就调 `onDown`/`onUp` |
| 手机 / 平板 / APK | 在游戏画面右侧生成一排虚拟按钮，标签就是 `label`；按下 = 同一个 `onDown`，松开 = `onUp` |
| 两端统一 | `P.isKeyDown('veinMine')` 返回是否按住；还会广播 `keyDown` / `keyUp` 事件 |

**插件一行都不用为手机单独写**。

---

## 2. `P.addKey` 完整签名

```js
P.addKey(id, {
  code,       // KeyboardEvent.code，桌面绑定的物理键（见第 3 节表）
  key,        // 可选，KeyboardEvent.key 字符；code 没给时用它反推
  label,      // 手机虚拟按钮文字（≤20 字，建议中文）
  desc,       // 按钮小字说明
  mode,       // 'press'（默认，按下触发一次） / 'hold'（按住保持状态）
  hold,       // true 等价于 mode:'hold'
  onDown,     // 按下回调，收到 ctx
  onUp,       // 松开回调，收到 ctx
  prevent,    // true 时桌面端 preventDefault（一般不用）
});
```

**兼容别名**（AI 写成下面这些也能接住，但推荐统一用 `P.addKey`）：

| 写法 | 等价 |
| --- | --- |
| `P.key(id, opts)` / `P.bindKey(id, opts)` | `P.addKey(id, opts)` |
| `P.addKey('veinMine', 'Backquote', fn)` | `code` + `onDown` 位置参数 |
| `P.addKey('Backquote', fn)` | 用 code 当 id |
| `P.onKey('Backquote', fn)` | 快捷声明：绑定物理键 + 回调 |
| `P.addKey({ id, code, label, onDown })` | 单对象形式 |

**回调 `ctx` 字段**：`id`、`code`、`key`、`game`、`player`、`world`、`event`、`source`（`'keyboard'` / `'virtual'`）、`say(text, color)`。

**读取按住状态**：

```js
if (P.isKeyDown('veinMine')) { /* 正在按住 */ }
```

**事件方式**（可多个插件共用同一个按键）：

```js
P.on('keyDown', function (c) { if (c.id === 'veinMine') P.message('开'); });
P.on('keyUp',   function (c) { if (c.id === 'veinMine') P.message('关'); });
```

---

## 3. 常用 `code` 对照表

`code` 必须是 `KeyboardEvent.code`，**不是** `e.key` 的字符。

| 想绑的键 | code | 备注 |
| --- | --- | --- |
| 波浪键 `~` / 反引号 `` ` `` | `Backquote` | 连锁挖矿常用，原版未占用，推荐 |
| 字母键 | `KeyB` `KeyG` `KeyR` `KeyC` … | `Key` + 大写字母（`KeyV` 是原版 AI 伙伴键，别用） |
| 数字键 | `Digit1` … `Digit9` `Digit0` | 注意 `1-9` 原版是快捷栏，会冲突 |
| 功能键 | `F6` `F7` `F8` `F9` `F10` `F12` | `F1`/`F3`/`F5`/`F11` 是原版界面键，别用 |
| 空格 | `Space` | 原版跳跃，**冲突** |
| Shift / Ctrl / Alt | `ShiftLeft` `ControlLeft` `AltLeft` | 原版疾跑 / 潜行，**冲突** |
| 方向键 | `ArrowUp` `ArrowDown` `ArrowLeft` `ArrowRight` | |
| 符号键 | `BracketLeft` `[` / `BracketRight` `]` / `Semicolon` `;` / `Quote` `'` / `Comma` `,` / `Period` `.` / `Slash` `/` / `Minus` `-` / `Equal` `=` | 原版基本未占用 |
| 鼠标 | `Mouse0` `Mouse1` `Mouse2` | 原版攻击 / 使用，**冲突** |

> **选键原则**：优先 `Backquote`、`KeyB`/`KeyG`/`KeyR`/`KeyC`、`F6`–`F10`、`F12`、`Digit0`、符号键。
> **原版已占用的键（不要用）**：`KeyW/A/S/D`（移动）、`Space`（跳）、`ShiftLeft`（潜行）、`ControlLeft`（疾跑）、
> `KeyQ`（丢弃）、`KeyE`（背包）、`KeyF`（副手）、`Digit1`–`Digit9`（快捷栏）、`KeyT`（聊天）、`Slash`（命令）、
> `KeyL`（进度）、`KeyH`（说明）、**`KeyV`（AI 伙伴）**、`F1/F2/F3/F5/F11`、`Mouse0/1/2`、`Escape`、`Tab`。
> 万一用了原版键，引擎仍会生成按钮，但会在按钮上标注「与原版按键共用」，桌面端也会触发原版动作——属于选键不当，请换键。

---

## 4. 完整示例：连锁挖矿（可直接提交）

见 `templates/keymap-plugin.js`。核心结构：

```js
ITLZMC.plugin({
  id: 'itlzmc-vein-miner',
  name: '连锁挖矿',
  version: '1.0.0',
  description: '按住波浪键挖矿连锁破坏相邻同类方块；手机端自动显示「连锁挖矿」按钮',
  api: '1.0',
  capabilities: ['mechanic'],
}, function (P) {
  var LIMIT = 24;

  P.addKey('veinMine', {
    code: 'Backquote', label: '连锁挖矿', mode: 'hold',
    desc: '按住并挖掘，连锁破坏相邻同类方块',
    onDown: function () { P.message('连锁挖矿：已开启'); },
    onUp:   function () { P.message('连锁挖矿：已关闭'); },
  });

  P.on('blockBreak', function (c) {
    if (!P.isKeyDown('veinMine')) return;
    if (c.natural || c.silent) return;
    try {
      var g = c.game || P.game(), w = g && g.world;
      if (!w || typeof w.get !== 'function') return;
      var base = c.id, found = [], seen = {};
      // 以 c.x / c.y / c.z 为中心广度搜索相邻同类方块（示例用 1 格半径）
      var queue = [[c.x, c.y, c.z]];
      while (queue.length && found.length < LIMIT) {
        var p = queue.shift(), k = p.join(',');
        if (seen[k]) continue; seen[k] = 1;
        for (var dx = -1; dx <= 1; dx++) for (var dy = -1; dy <= 1; dy++) for (var dz = -1; dz <= 1; dz++) {
          var nx = p[0] + dx, ny = p[1] + dy, nz = p[2] + dz;
          var b = w.get(nx, ny, nz);
          if (b === base || (b && b.id === base)) {
            var nk = nx + ',' + ny + ',' + nz;
            if (!seen[nk]) { found.push([nx, ny, nz]); queue.push([nx, ny, nz]); }
          }
        }
      }
      if (found.length) P.message('连锁挖矿：命中 ' + found.length + ' 个方块');
    } catch (e) { P.warn('连锁挖矿跳过：' + e); }
  });
});
```

> `blockBreak` 的 `ctx` 字段：`game, x, y, z, id, meta, block, natural, silent, player`（详见 `EVENTS.md`）。
> 触碰世界 API 的逻辑一律包 `try/catch`，单个插件出错不能影响游戏本体。

---

## 5. 自动检测（老插件零改动也能在手机用）

引擎在**每次加载插件后**会静态扫描源码。若插件写的是老写法：

```js
window.addEventListener('keydown', function (e) {
  if (e.code === 'Backquote' || e.key === '~') veinMine();
});
```

引擎会自动：

1. 从 `e.code === 'X'`、`e.key === '~'`、`g.keys['X']`、`case 'KeyB'` 里提取出 `Backquote`；
2. 登记一个隐式按键（标签 `波浪键 \``，小字「自动检测 · 手机端已生成同名按钮」）；
3. 在手机端生成按钮；按下按钮时**合成一个真实的 `KeyboardEvent`** 派发到 `window`，并设置 `g.keys[code]`。

所以老插件**不用改一行**就能在手机上触发。但是：

- 自动检测只认**明确的 code 比较**；动态拼出来的键名（`KEYS[mode]`）认不出来。
- 服务端 `/api/plugins/validate` 会对这类写法返回 `warnings`，不是拒绝。
- **新插件一律用 `P.addKey`**，自动检测只是兜底，不是推荐写法。

---

## 6. 手机端按钮长什么样

- 位置：画面**右侧中上部**（避开联机成员列表与原有触屏控件）。
- 样式：暗色半透明玻璃面板，标题「⌨ 插件按键 · N」，可点标题**收起 / 展开**。
- 每个按钮两行：主文字 `label`，小字 `code` + 「自动检测」/「按住」/「与原版按键共用」标记。
- **只在触屏设备 + 进入游戏 + 没有打开菜单时显示**；桌面不会多出这一排。
- 没有声明任何按键时面板完全不出现。

---

## 7. 常见错误

| 现象 | 原因 / 处理 |
| --- | --- |
| 手机上按键完全没反应 | 直接监听了 `keydown`；改用 `P.addKey`，或确认自动检测有没有扫到（控制台 `ITLZMC.Plugins.keybinds()`） |
| 手机上按钮出现了但没效果 | 老插件判断的是 `e.key` 而非 `e.code`，且写法太动态；改成 `P.addKey` + `P.isKeyDown` |
| 桌面按物理键触发了两次 | 插件既 `P.addKey` 又自己监听 `keydown`；删掉自己的监听 |
| 提交时服务端报 warning | 源码里有 `addEventListener('keydown')` 却没 `P.addKey`；按提示改成声明式 |
| 按钮和原版功能冲突（按了开背包） | 选了 `KeyE` / `Space` / `KeyV` 等原版键，换 `Backquote` / `KeyB` / `F6` |
| 按住状态一直是 false | 用 `mode:'press'` 却想持续生效；改 `mode:'hold'`，并用 `P.isKeyDown(id)` 读取 |
| 控制台出现 `QIUMCKeys is not defined` | 忘了在 `index.html` 里于 `js/plugins.js` **之前**加载 `js/plugin-keys.js` |

---

## 8. 给已有插件补按键（以「波浪连锁挖矿 wave-chain」为例）

市场里的 `wave-chain`（作者 JGhuihui）是 **破坏方块自动起波 / 可选潜行触发**，源码里没有绑定任何键盘按键，
因此它本来就不依赖物理键盘，手机端装了就能用，**不存在「手机没有波浪键」的阻塞**。

如果确实想改成「**按住某个键才连锁**」，不用重写触发逻辑，只要在 `ITLZMC.plugin(...)` 的 factory 里加两处：

**① 开头声明按键**

```js
P.addKey('veinMine', {
  code: 'Backquote', label: '连锁挖矿', mode: 'hold',
  desc: '按住才连锁挖矿；手机端自动出现同名按钮',
});
```

**② 起波入口加一行判断**（在 `startWave` / `blockBroken` 回调最前面）

```js
if (!P.isKeyDown('veinMine')) return;   // 没按住就完全不干预原版
```

改完重新提交（**请求 URL 要带 `?sharecode=`**，见 `MARKET-API.md`），引擎会自动：

- 桌面：把 `Backquote` 物理键映射成「按住状态」；
- 手机：生成「连锁挖矿」屏幕按钮，按住时 `P.isKeyDown('veinMine')` 为 `true`；
- `GET /api/market` 里该插件会带 `keybinds: [{id:'veinMine',code:'Backquote',label:'连锁挖矿'}]`。

不想改插件的话，直接装市场里官方内置的 **「连锁挖矿」** 示例即可，效果一样，
源码在 `plugins/store/itlzmc-vein-miner.js`。

> 同理，任何「按下 X 键触发 Y」的插件都按这两处改：声明 + `P.isKeyDown` 判断。
> **不要**自己写 `window.addEventListener('keydown', ...)` —— 那样手机端永远触发不了。

---

## 9. 调试命令（浏览器控制台）

```js
ITLZMC.Plugins.keybinds()          // 所有已登记按键（含自动检测的）
ITLZMC.Plugins.isKeyDown('veinMine') // 当前是否按住
QIUMCKeys.list()                  // 同上，含 down / implicit / vanilla 标记
QIUMCKeys.render()                // 手动重绘手机虚拟按钮面板
ITLZMC.Plugins.doctor()            // 插件医生，含每个插件的 keybinds 数量
```
