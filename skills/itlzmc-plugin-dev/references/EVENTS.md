# 机制事件总线（API 1.0）

## 两类回调签名（唯一容易踩的坑）

| 类别 | 事件 | 回调签名 |
| --- | --- | --- |
| **机制事件** | 下表全部 | `fn(ctx)`，`ctx` 是可变对象 |
| **生命周期事件** | `tick`、`ready`、`gameInit`、`pluginsLoaded` | `fn(game)`，**直接收到 game 对象** |

`ctx` 通用字段：`cancelled`、`cancel()`（等同 `preventDefault()` / `stop()`）、`result`。
`ctx.cancel()` 后框架跳过原操作并返回 `ctx.result`。**改字段即改游戏行为**（如 `c.amount = 0`）。

所有回调已被框架 `try/catch` 隔离，插件报错只写 console.warn，不会中断游戏。

## 事件表

| 事件 | 挂载函数 | ctx 字段 | 可改 / 可取消 |
| --- | --- | --- | --- |
| `blockBreak` | `Game.prototype.breakBlock`（前置） | `game,x,y,z,id,meta,block,natural,silent,player` | 可 `cancel()` 阻止破坏 |
| `blockBroken` | 同上（后置） | 同 `blockBreak` | 只读通知 |
| `blockPlace` | `World.prototype.setBlock`（`id != 0`） | `game,world,x,y,z,id,meta` | 可改 `id` / `meta`；可 `cancel()` |
| `dropItem` | `Game.prototype.dropItem` | `game,x,y,z,stack,vel` | 可改 `stack` / `count`；可 `cancel()` |
| `blockLoot` | `Game.prototype.dropBlockLoot` | `game,x,y,z,id,meta,tool,block` | 可 `cancel()` 取消整组掉落 |
| `damage` | `Living.prototype.hurt`（覆盖玩家与生物） | `game,entity,amount,source` | 可改 `amount`；可 `cancel()` |
| `damaged` | 同上（伤害生效后） | 同 `damage` | 只读通知 |
| `useItem` | `Game.prototype.use`（前置） | `game,player,held,target,targetEntity` | 可 `cancel()` |
| `entitySpawn` | `Game.prototype.addEntity` | `game,entity` | 可改 `entity`；可 `cancel()` |
| `explode` | `Game.prototype.explode` | `game,x,y,z,power,source,inWater,fire` | 可改 `power`；可 `cancel()` |
| `craft` | `ContainerScreen.prototype.takeOutput` | `game,screen,result,id,count` | 可 `cancel()` |
| `command` | `window.cmdExec`（所有原版与插件指令） | `game,name,args,raw,source` | 可改 `raw`；可 `cancel()` |
| `respawn` | `Game.prototype.respawn`（后置） | `game,player` | 只读通知 |
| `message` | `UI.prototype.message` | `game,text,color` | 可改 `text`；可 `cancel()` |
| `tick` | `Game.prototype.tick` | **回调收到 game** | 每 tick 触发 |
| `ready` | `Game.prototype.init` 之后 | **回调收到 game** | 世界已就绪 |
| `gameInit` | `Game.prototype.init` 之前 | **回调收到 game** | 可在此预注册 |
| `pluginsLoaded` | `ITLZMC.Plugins.ready()` 结束 | **回调收到 records 数组** | — |

## 示例

```js
// 阻止基岩被破坏
P.on('blockBreak', function (c) {
  if (c.id === BID.bedrock) c.cancel();
});

// 圆石掉落翻倍（改字段，不取消）
P.on('dropItem', function (c) {
  if (c.stack && c.stack.id === ITEM_KEY.cobblestone) {
    c.count = Math.min(64, (c.stack.count || 1) * 2);
  }
});

// 玩家免伤 + 拦截 /seed
P.on('damage', function (c) { if (c.entity === P.player()) c.amount = 0; });
P.on('command', function (c) {
  if (c.name === 'seed') { c.cancel(); c.result = true; }
});

// 生命周期：tick 收到 game
P.on('tick', function (g) { if (g.state === 'play') { /* 每 tick 逻辑 */ } });
```

## 注意事项

1. `blockPlace` 挂的是 `World.prototype.setBlock`，破坏方块（`id = 0`）**不会**触发。
2. `command` 的 `c.cancel()` 会吞掉指令；若想让游戏认为执行成功，设 `c.result = true`。
3. 机制钩子在 `plugins.js` 加载时一次性挂好，**插件晚加载也能订阅**——不要在插件里自己包装原型，除非用 `P.intercept`。
4. 高频事件（`tick`、`dropItem`）里别做重活或 `localStorage` 写入，按 tick 计数节流。
5. `craft` 的 `result` 可能为空（输出格没东西），回调里先判空。
