---
name: itlzmc-plugin-dev
description: ITLZMC 网页版 Minecraft 的原生插件开发技能。当用户要求「给 ITLZMC 写插件 / 开发插件 / 加个方块 / 加自定义贴图 / 加条指令 / 改掉落 / 改伤害 / 改游戏机制 / 做一个插件包 / 用插件市场」时使用。提供插件清单规范、JS API、机制事件总线、插件包规范、可复制模板、校验脚本与浏览器验收流程。关键词：ITLZMC 插件、plugin、贴图、指令、command、机制、hook、插件市场、AI Skill。
allowed-tools: Read, Write, Edit, Bash, Glob, Grep
version: "2.0.0"
---

# ITLZMC 原生插件开发 Skill

> `<skill-directory>` 指**本 Skill 所在目录**；`<project>` 指 ITLZMC 工程目录（默认 `/workspace/ITLZMC`）。

这个 Skill 让 AI 能为 ITLZMC 写出**真实可运行**的原生插件：注册贴图 / 方块 / 物品 / 配方、修改游戏机制、增加指令。

## 先读边界：ITLZMC 不支持 Mod / 模组

ITLZMC 只加载 **ITLZMC 原生插件**（`.js` 插件 + 带 `plugin.json` 的 `.zip` 插件包）。**没有** Forge / NeoForge / Fabric / `.jar` / 模组加载能力，也不解析 `pack.mcmeta` 或 `data/**/recipes/*.json` 这类原版数据包格式。

用户提到「兼容 Mod」「装 Forge 模组」「1.20.1 的 mod」时，要明确说明：**做不到加载模组，只能把想要的效果用 ITLZMC 原生插件等价重写**。不要含糊成「兼容 Mod」。

| 能做 | 不能做 |
| --- | --- |
| JS 插件注册方块 / 物品 / 贴图 / 配方 / 指令 | 运行 Java `.class`、Mixin、Forge / Fabric 逻辑 |
| 通过事件总线改掉落 / 伤害 / 破坏 / 指令 | 加载 `.jar` 模组、`mods.toml` / `fabric.mod.json` / `mcmod.info` |
| 插件包 `.zip`（`plugin.json` + `main` + 贴图资源） | 引入 npm 包、CDN 脚本、外部网络请求 |
| 游戏内「插件市场」一键安装、创作、下载 Skill | 账号 / 登录 / 云存档 / 第三方平台 SDK |

## 硬约束（违反即返工）

1. 插件必须是**完整可运行代码**，不许出现 `TODO`、`placeholder`、`// ...`、空函数体。
2. 全部本地同源，**禁止**任何外部 URL（`https://`、`http://`、`//cdn`、`fetch('http…')`）；贴图只能用 `data:image/png;base64,…` 或包内路径。
3. 不引入登录、账号、云存档、B站 / 第三方平台 SDK。
4. 品牌只用 `ITLZMC`，不要出现 `OpusMC`、原作者、来源或版权字样。
5. 每个插件都要有 `ITLZMC.plugin({ id, name, version, description, api, capabilities }, factory)` 清单。
6. 单个插件出错不得影响游戏本体——把有风险的逻辑放进 `try/catch`，或用事件钩子（钩子本身已被框架隔离）。
7. 改 `index.html` 里任何脚本版本号后，所有 `?v=qiumcN` 必须一起升（缓存穿透）。
8. 运行时命名空间是 **`ITLZMC.Plugins`**（`ITLZMC.plugin` 是注册入口），**没有** `ITLZMC.Mods`，也没有 `?mod=` 参数。
9. **禁止假设玩家有物理键盘**：不要写 `window.addEventListener('keydown', ...)`、不要读 `e.code` / `g.keys`。
   按键一律用 `P.addKey(id, { code, label, onDown, onUp, mode })` 声明——引擎会在桌面转发物理键、
   在**手机端自动生成屏幕虚拟按钮**。详见 `references/KEYS.md`。只读按住状态用 `P.isKeyDown(id)`。
10. **通过 API 提交插件时，每个请求 URL 都必须带 `?sharecode=<分享码>`**（GET / POST 都要带），
    漏了会被部署网关 403 拦截。完整地址见「插件市场 → 登录 → 复制给 AI」或 `references/MARKET-API.md`。

## 工作流（按顺序做，不要跳）

### 步骤 1 · 判断能力类型

| 用户想做的事 | 能力 | 主要 API |
| --- | --- | --- |
| 换个材质、加新方块贴图 | `texture` | `P.addTexture` / `P.addTextureAt` / `P.defineBlock` |
| 改掉落、改伤害、禁止破坏、拦截指令 | `mechanic` | `P.on('blockBreak'｜'dropItem'｜'damage'｜'command'｜…, fn)` |
| 加 `/命令` | `command` | `P.addCommand(name, { fn, description, usage, aliases })` |
| 加合成 / 熔炼 | `recipe` | `P.addShaped` / `P.addShapeless` / `P.addSmelting` |
| 按键触发（连锁挖矿、切换模式…） | `mechanic` | **`P.addKey` / `P.isKeyDown`**（必读 `references/KEYS.md`） |

### 步骤 2 · 读参考文档

```
Read <skill-directory>/references/API.md
Read <skill-directory>/references/EVENTS.md
Read <skill-directory>/references/PLUGIN-PACK.md   # 做 .zip 插件包时必读
Read <skill-directory>/references/KEYS.md          # 插件要用按键时必读（手机端没有物理键盘）
Read <skill-directory>/references/MARKET-API.md    # 要发布到插件市场时必读（API 地址必须带 sharecode）
```

### 步骤 3 · 复制模板，不要凭记忆手写

```
Read <skill-directory>/templates/hello-plugin.js      # 最小骨架
Read <skill-directory>/templates/texture-plugin.js    # 贴图 + 方块
Read <skill-directory>/templates/mechanic-plugin.js   # 机制钩子
Read <skill-directory>/templates/command-plugin.js    # 指令
Read <skill-directory>/templates/keymap-plugin.js      # 跨端按键（连锁挖矿，手机自动生成按钮）
```

用 `Read` 拿到模板内容后，以它为骨架写出新文件到 `<project>/plugins/<id>.js`（自动加载）或 `<project>/plugins/examples/<id>.js`（不自动加载，用 `?plugin=` 显式加载）。

**默认不要往 `plugins/` 根目录放演示插件**——那会改变所有玩家的游戏。示例一律放 `plugins/examples/`。

### 步骤 4 · 静态校验（必做）

```bash
python3.11 <skill-directory>/scripts/validate_plugin.py <project>/plugins/examples/<id>.js
```

校验项：JS 语法（`node --check`）、清单必填字段、`api` 版本、无外部 URL、无 placeholder、API 白名单、
**跨端按键写法**、插件包完整性。必须以 JSON 输出 `"ok": true` 才算通过；不通过就按 `errors` 逐条修。

插件失效定位（AI 改着改着就失效时先跑这个）：

```bash
python3.11 <skill-directory>/scripts/doctor.py <project>/plugins/examples/<id>.js
```

### 步骤 5 · 浏览器验收（必做，除非用户明确说「先不要测试」）

ITLZMC 需要 WebGL2，headless 环境必须走 Xvfb + Mesa：

```bash
cd <project> && PORT=8092 node server.js &
LIBGL_ALWAYS_SOFTWARE=1 xvfb-run -a -s "-screen 0 1280x800x24 +extension GLX +render -noreset" \
  python3.11 <skill-directory>/scripts/verify_plugin.py \
  --url http://127.0.0.1:8092/ --plugin plugins/examples/<id>.js
```

验收要点（缺一不可）：

- `ITLZMC.Plugins.ready()` 完成，`ITLZMC.Plugins.list()` 里该插件 `error` 为 `null`
- `capabilities` / `hooks` / `commands` / `blocks` 计数符合预期
- 进 `play` 后 **零 console error、零 404、零外部请求**
- 机制类插件必须实测钩子被触发（`P.storage` 计数或指令查询）
- 指令类插件必须实测 `/命令` 有返回
- 贴图类插件必须做**像素级**比对（`ASSETS.strip` 对应格子颜色变化），不能只看「没报错」

### 步骤 6 · 部署与交付

- 服务端静态托管 `<project>` 目录，插件改动**即时生效**，但 `server.js` 改动需要重启进程。
- 版本号升级时统一替换 `index.html` / `js/audio.js` / `README.md` 里的 `qiumcN`。
- 线上网关要求 `sharecode`：不只浏览器地址，**每一个 API 请求 URL 末尾都要带 `?sharecode=…`**
  （GET / POST 都一样，漏了 403）。用 `scripts/publish_plugin.py` 会自动拼好，别手写地址。
- 更新 `README.md`、`PROJECT_INFO.json`，重新打包 `ITLZMC-完整代码.zip`。
- **APK / EXE 只是加载线上地址的 WebView 壳，网页端插件不需要重编译**。

## 游戏内插件市场

标题界面 →「插件市场」即可进入（`js/plugins.js` 里的 `MarketScreen`），三个页签：

| 页签 | 功能 |
| --- | --- |
| **插件市场** | 4 款官方插件，一键安装 / 卸载（状态存 `localStorage: itlzmc.market.installed`，重载即生效）；也能把源码下载成 `.js` |
| **已安装** | 查看 / 开关所有已加载插件（`ITLZMC.Plugins.list()`）、添加自定义插件 URL、重载生效 |
| **创作插件** | 选能力（增加指令 / 修改机制 / 渲染贴图）+ 填名称 → 生成**完整可运行**的插件源码 → 下载 `.js` 或直接「安装并启用」（存 `localStorage: itlzmc.market.created`） |

底部常驻 **「一键下载 AI Skill」**：把本 Skill 包（`ITLZMC-AI-SKILL.zip`）以 base64 内嵌在游戏里，点击直接下载，**完全离线**，不依赖服务器或外网。

官方插件源码与市场代码都在 `js/plugins.js`；`plugins/store/` 是同一批源码的独立文件，方便直接放进 `plugins/` 或分享。

底部还有 **「登录 / 注册」**（未登录时显示账号名）：普通玩家免登录，只有「让 AI 通过 API 提交插件上架」
才需要注册。注册完立刻发一枚 `qkey_…` API Key，点 **「复制给 AI」** 会把 **带 sharecode 的完整 API 地址**、
Key、提交方式、校验规则一次复制好，直接粘给 AI。

服务端流程：注册 → 拿 Key → AI 写插件 → `POST /api/plugins/validate?sharecode=…` 自检（无需 Key）→
`POST /api/plugins/submit?sharecode=…` 带 `X-ITLZMC-Key` 提交 → 服务端校验（字段 / 危险 API / 语法编译 /
vm 沙箱试运行 / 至少注册一项能力 / id 冲突）**全绿才上架** → `GET /api/market?sharecode=…` 可见。
`P.addKey(...)` 的按键声明会记进 `keybinds` 字段一起返回。详见 `references/MARKET-API.md`。

## 手机端按键（必看）

**痛点**：用户做了「按波浪键 `~`（`Backquote`）连锁挖矿」的插件，手机没有这个物理键，功能永远触发不了。
ITLZMC 的按键引擎（`js/plugin-keys.js`）把这件事全自动处理了：

| 插件写法 | 桌面 | 手机 |
| --- | --- | --- |
| `P.addKey('veinMine', { code:'Backquote', label:'连锁挖矿', mode:'hold', onDown: fn })` | 自动绑定物理键 | 自动生成「连锁挖矿」屏幕按钮 |
| `P.isKeyDown('veinMine')` | 返回按住状态 | 同样返回（按屏幕按钮也算） |
| 老写法：自己 `addEventListener('keydown')` 判断 `e.code` | 能跑 | **引擎自动检测源码里的按键码并生成按钮**，按下时合成 KeyboardEvent，零改动可用 |

最小可用骨架（完整版见 `templates/keymap-plugin.js`）：

```js
ITLZMC.plugin({
  id: 'itlzmc-vein-miner', name: '连锁挖矿', version: '1.0.0',
  description: '按住波浪键连锁挖矿；手机端自动显示按钮', api: '1.0', capabilities: ['mechanic'],
}, function (P) {
  P.addKey('veinMine', {
    code: 'Backquote', label: '连锁挖矿', mode: 'hold',
    desc: '按住并挖掘，连锁破坏相邻同类方块',
    onDown: function () { P.message('连锁挖矿：开'); },
    onUp:   function () { P.message('连锁挖矿：关'); },
  });
  P.on('blockBreak', function (c) {
    if (!P.isKeyDown('veinMine')) return;   // 没按住就完全不干预原版
    // …… 这里写连锁逻辑，触碰世界 API 一律 try/catch ……
    P.message('连锁挖矿触发');
  });
});
```

三条硬规矩：

1. **不要**自己监听 `keydown` / 读 `e.code` / 读 `g.keys`；自动检测只是给老插件兜底，新插件一律声明式。
2. 选 `code` 避开原版键（`KeyW/A/S/D`、`Space`、`KeyE`、`KeyQ`、`KeyT`、`Escape`、`F1/F3/F5/F11`）；
   推荐 `Backquote`、`KeyB`/`KeyG`/`KeyR`/`KeyC`、`F6`–`F10`、`F12`、符号键；
   避开原版占用的 `KeyV`（AI 伙伴）、`KeyH`、`KeyL`、`KeyW/A/S/D`、`Space`、`KeyE`、`KeyQ`、`KeyF`、`KeyT`、`Digit1`–`Digit9`。
3. `index.html` 里 `js/plugin-keys.js` **必须在 `js/plugins.js` 之前**加载，否则面板不出现。

完整字段表、code 对照、自动检测原理、常见错误见 `references/KEYS.md`。

## 三个常用配方（直接照抄改）

### A. 加一个带贴图的发光方块

见 `templates/texture-plugin.js`。要点：

```js
var idx = P.addTexture('myplugin_lamp', 'data:image/png;base64,…');   // 返回图集索引
P.defineBlock({ key:'myplugin_lamp', cn:'我的灯',
  tex:{ side:'myplugin_lamp', top:'myplugin_lamp', bottom:'myplugin_lamp' },
  light:15, hardness:0.6 });                                          // tex 传的是贴图「名字」
P.addShapeless('myplugin_lamp', 1, ['glowstone','stick']);
```

`P.addTexture` 返回**索引**，`defineBlock` 的 `tex` 收**名字**（框架会 `T(name)` 查索引），别混用。

### B. 改机制（以「圆石掉落翻倍」为例）

见 `templates/mechanic-plugin.js`。机制事件回调收到**可变 ctx**：

```js
P.on('dropItem', function (c) {
  if (c.stack && c.stack.id === ITEM_KEY.cobblestone) c.count = Math.min(64, c.stack.count * 2);
});
P.on('blockBreak', function (c) { if (c.id === BID.bedrock) c.cancel(); });  // 阻止原操作
```

生命周期事件（`tick` / `ready` / `gameInit`）的回调**直接收到 game 对象**，不是 ctx——这是唯一例外，见 `EVENTS.md`。

### C. 加指令

见 `templates/command-plugin.js`。

```js
P.addCommand('mycmd', {
  description:'说明', usage:'/mycmd <参数>', aliases:['mc'],
  fn: function (ctx, args) { ctx.say('你好 ' + (args[0] || 'ITLZMC')); },
});
```

`ctx.say()` 是游戏内回显；`P.give(key, n)` 给物品；`P.message(text)` 弹 HUD 提示。

## 常见错误

| 现象 | 原因 / 处理 |
| --- | --- |
| `MeshBuffer is not defined` | 某个游戏脚本没加载成功，框架有冷启动自愈（最多重载 2 次）；别自己改 `main.js` |
| 贴图没变 | `tex` 传成数字索引了，或贴图路径不在 `assets/<ns>/textures/**/`；`item/` 与 `block/` 严格分离 |
| 插件不加载 | 文件放在 `plugins/examples/` 不会自动发现；用 `?plugin=路径` 或移到 `plugins/` 根目录 |
| `缺少依赖插件` | 清单 `requires` 里的 id 必须先加载；目录按文件名排序，注意前缀 |
| `/命令` 无反应 | 未开作弊时原版会拦，插件命令走 `CMD_RUN`，用 `ctx.say` 回显；检查 `ITLZMC.Plugins.commands()` |
| `ITLZMC.Plugins is not defined` | 用了已删除的 `ITLZMC.Mods`；运行时命名空间只有 `ITLZMC.Plugins` |
| 线上还是旧代码 | 版本号没升，CDN / 手机拿了旧缓存；统一升 `qiumcN` |
| 手机端按键没反应 / 没有按钮 | 插件直接监听了 `keydown`；改用 `P.addKey`，确认 `js/plugin-keys.js` 在 `plugins.js` 之前加载 |
| API 提交返回 `403`（不是 JSON） | 请求 URL 漏了 `?sharecode=`；用 `publish_plugin.py` 或「复制给 AI」拿拼好的完整地址 |
| 插件改着改着就失效 | 先跑 `python3.11 scripts/doctor.py <插件.js>`，按中文提示逐条修（最常见是 async factory / 少了 `ITLZMC.plugin` / 占位符没删） |
| 校验模板报 `含占位符/TODO` | 模板里的 `__PNG__` 是待替换标记；校验的是你写出的**新插件文件**，不要校验模板本身 |

## 验收清单（交付前逐条打勾）

- [ ] `validate_plugin.py` 通过（`"ok": true`）
- [ ] `node --check` 通过
- [ ] 浏览器实测：插件 `error: null`、能力计数正确、进 `play` 零报错
- [ ] 至少一条能力做了效果级验证（像素 / 计数 / 指令返回值），不是「没报错」而已
- [ ] 有按键的插件：用 `P.addKey` 声明、在**手机 / 触屏**下确认虚拟按钮出现且能触发（`ITLZMC.Plugins.keybinds()` 有记录）
- [ ] 走 API 发布时：每个请求 URL 都带了 `?sharecode=`，`GET /api/market` 能看到新插件
- [ ] 默认游戏未被污染（示例在 `plugins/examples/`）
- [ ] 全文无 `ITLZMC.Mods` / `?mod=` / `.jar` / Forge / Fabric 等模组残留
- [ ] 文档与 `PROJECT_INFO.json` 已更新，zip 已重打包
