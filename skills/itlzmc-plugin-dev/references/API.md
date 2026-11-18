# ITLZMC 插件 API 1.0 速查

入口：`ITLZMC.plugin(meta, factory)`，也可写 `ITLZMC.Plugins.register(meta, factory)`（别名）。
`factory(P, meta)` 里的 `P` 是**插件专属句柄**，所有注册自动计数并归属到该插件。

## 清单 `meta`

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | string | 是 | 唯一标识，不能含 `/` 或 `\`，如 `mymod-lamp` |
| `name` | string | 是 | 显示名 |
| `version` | string | 是 | 语义版本，如 `1.0.0` |
| `description` | string | 建议 | 管理界面里显示 |
| `author` | string | 否 | 作者（写自己的名字，不要写原作者） |
| `api` | string | 否 | 默认 `'1.0'` |
| `capabilities` | string[] | 建议 | `texture` / `mechanic` / `command` / `recipe` |
| `requires` | string[] | 否 | 依赖插件 id，必须先加载 |

`plugin.json`（放在 zip 里）用同样字段，额外支持 `main`：指向 zip 内的 JS 入口。

## 内容注册

| API | 说明 | 返回 |
| --- | --- | --- |
| `P.defineBlock(o)` | 注册方块并自动生成物品 | 方块对象 |
| `P.defineItem(o)` | 注册纯物品 | 物品对象 |
| `P.addTexture(name, dataURL)` | 注册贴图到图集尾部 | **索引数字** |
| `P.addTextureAt(idx, dataURL)` | 按索引覆盖图集空位 | boolean |
| `P.addShaped(result, count, pattern, keys)` | 有序合成 | — |
| `P.addShapeless(result, count, ingredients)` | 无序合成 | — |
| `P.addSmelting(from, to, xp)` | 熔炼 | — |
| `P.addRecipe({type, ...})` | 统一配方入口，`type` 为 `shaped`/`shapeless`/`smelting` | — |
| `P.addCommand(name, def)` | 注册指令 | 指令名 |

### `defineBlock(o)` 字段

```js
{
  key: 'mymod_lamp',          // 必填，唯一 key，会成为 BID.mymod_lamp
  cn: '我的灯',                // 中文显示名
  tex: { side, top, bottom, front, frontOn },  // 贴图「名字」或 dataURL 字符串
  textures: { side: 'data:image/png;base64,…', top: '…' },  // 自动注册并映射成 tex
  png: 'data:image/png;base64,…',  // 背包图标（自动注册 i_<key>）
  light: 15, hardness: 0.6, sound: 'glass',
  // 其余字段直接透传给 defBlock：solid/render/tool/level/drops/stack/fuel/…
}
```

**注意**：`tex` 收贴图**名字**（字符串），不是索引。`P.addTexture()` 返回的是索引，用于 `addTextureAt` 或调试。

### `defineItem(o)` 字段

`{ key, cn, png, icon, stack, fuel }`。

### `addCommand(name, def)`

`def` 可以是函数，或：
```js
{ fn(ctx, args), description, usage, aliases: ['alias1'] }
```
`fn` 里 `this` 是 game；`ctx` 是原版命令上下文（`ctx.say(text)` 回显、`ctx.g`、`ctx.pos`、`ctx.entity`），并附加 `ctx.args` / `ctx.name` / `ctx.plugin`。

## 事件与机制

| API | 说明 |
| --- | --- |
| `P.on(event, fn)` | 订阅，返回取消订阅函数 |
| `P.once(event, fn)` | 只触发一次 |
| `P.off(event, fn)` | 取消订阅 |
| `P.emit(event, ctx)` | 主动派发（一般不需要） |
| `P.intercept(proto, name, wrapper)` | 包装任意游戏原型方法，返回还原函数 |
| `P.method(proto, name)` | 取原型方法引用 |
| `ITLZMC.Plugins.events()` | 已订阅事件名 |
| `ITLZMC.Plugins.hookStats()` | 已挂载到游戏的机制钩子名 |
| `ITLZMC.Plugins.commands()` | 插件指令元数据表 |

`proto` 可传字符串：`'Game'`、`'Player'`、`'Living'`、`'Mob'`、`'World'`、`'UI'`、`'ContainerScreen'`、`'CraftingScreen'`、`'MenuScreen'`。

`intercept` 的 `wrapper(orig, args, self)`：
```js
P.intercept('Game', 'breakBlock', function (orig, args, self) {
  // 可直接改 args
  return orig.apply(self, args);
});
```

## 运行时便捷 API

| API | 说明 |
| --- | --- |
| `P.game()` / `P.player()` / `P.world()` | 取当前游戏 / 玩家 / 世界 |
| `P.give(key, count)` | 给玩家物品，返回 boolean |
| `P.message(text, color)` | HUD 提示 |
| `P.config(key, fallback)` / `P.setConfig(key, v)` | 插件私有 localStorage 配置 |
| `P.storage` | `{ get, set, all, clear }` |
| `P.log(...)` / `P.warn(...)` | 带插件前缀的控制台输出 |
| `ITLZMC.Plugins.list()` | 已加载来源记录（含 error / capabilities / hooks / commands / blocks） |
| `ITLZMC.Plugins.plugins()` | 插件清单与计数 |
| `ITLZMC.Plugins.toggle(id)` | 开关（重启生效） |
| `ITLZMC.Plugins.addUrl(url)` | 手动添加一个来源 |

## 加载方式

| 方式 | 用法 |
| --- | --- |
| 自动发现 | 把 `.js` / `.zip` 放进 `<project>/plugins/`（`/api/plugins` 返回清单） |
| URL 参数 | `?plugin=plugins/examples/xxx.js`（可重复） |
| 插件市场 | 标题界面 →「插件市场」→ 一键安装官方插件 / 创作插件 / 下载 AI Skill |
| 游戏内 | 选项 →「插件市场…」→「已安装」→ 添加 URL → 重载生效 |
| 开关 | 市场里点条目切换，状态存 `localStorage: itlzmc.plugins.disabled` |

加载时序：`plugins.js` 是最后一个脚本 → `main.js` 在 `new Game()` 之前 `await ITLZMC.Plugins.ready()` → 图集重绘完成后 Renderer 才读取 `ASSETS.strip`。
