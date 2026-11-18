# ITLZMC 原生插件包（.zip）规范

## 结论先说清楚

ITLZMC 只支持 **ITLZMC 原生插件包**，包内清单**只有 `plugin.json` 一种**。

**不认** `pack.mcmeta`、`META-INF/mods.toml`、`fabric.mod.json`、`mcmod.info`，**不加载** `.jar` 模组，也不解析 `data/**/recipes/*.json` 这类原版数据包配方——配方请用插件 API `P.addShaped` / `P.addShapeless` / `P.addSmelting` 注册。

用户拿一个 Forge / Fabric 模组或原版资源包过来时，正确做法是：**把想要的效果用 ITLZMC 原生插件重写**，贴图资源可以拆出来放进插件包。

## `plugin.json` 字段

与 `ITLZMC.plugin(meta, factory)` 的 `meta` 完全一致，额外多一个 `main`：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | string | 是 | 唯一标识，不能含 `/` 或 `\` |
| `name` | string | 是 | 显示名 |
| `version` | string | 是 | 语义版本 |
| `description` | string | 建议 | 插件市场 / 管理界面里显示 |
| `author` | string | 否 | 作者（写自己的名字） |
| `api` | string | 否 | 默认 `'1.0'` |
| `capabilities` | string[] | 建议 | `texture` / `mechanic` / `command` / `recipe` |
| `requires` | string[] | 否 | 依赖插件 id，必须先加载 |
| `main` | string | 否 | 包内 JS 入口，如 `main.js`；存在时按插件代码执行 |

**没有 `main` 也可以**：纯贴图插件包只覆盖图集，不执行任何代码。

## 包内目录

| 路径 | 作用 |
| --- | --- |
| `plugin.json` | 清单（唯一被识别的清单文件） |
| `main.js`（或 `main` 指定的路径） | 入口 JS，里面写 `ITLZMC.plugin(...)` |
| `assets/<命名空间>/textures/**/<名字>.png` | 覆盖 `ASSETS.tiles` 里同名的贴图 |
| `assets/<命名空间>/textures/item/<名字>.png` | **只**覆盖 `i_<名字>` 背包图标；找不到就跳过，不回退到方块贴图 |
| `assets/<命名空间>/textures/block/<名字>.png` | 覆盖方块 3D 面贴图 |
| `assets/itlzmc/atlas/<数字>.png` | ITLZMC 扩展：按图集索引直接覆盖（补齐「有图案但无名」的空位） |

命名空间任意（`minecraft`、`itlzmc`、自定义都行），子目录任意深度。`block/` 与 `item/` **严格分离**：同名时若互相回退，背包图标会被画成方块侧面。

## 最小插件包

```
plugin.json
main.js
assets/itlzmc/textures/block/my_block.png
```

`plugin.json`：

```json
{
  "id": "my-pack",
  "name": "我的插件包",
  "version": "1.0.0",
  "description": "一个带贴图的 ITLZMC 原生插件包",
  "api": "1.0",
  "capabilities": ["texture", "command"],
  "main": "main.js"
}
```

`main.js`：

```js
ITLZMC.plugin({
  id: 'my-pack-main', name: '插件包入口', version: '1.0.0',
  description: 'plugin.json 的 main 指定的代码', api: '1.0', capabilities: ['command'],
}, function (P) {
  P.addCommand('mypack', {
    description: '插件包自检',
    fn: function (ctx) { ctx.say('插件包已加载，插件数：' + ITLZMC.Plugins.list().length); },
  });
});
```

打包：`zip -r my-pack.zip plugin.json main.js assets`

## 加载方式

| 方式 | 用法 |
| --- | --- |
| 自动发现 | 把 `.zip` 放进 `<project>/plugins/` 根目录（`/api/plugins` 返回清单） |
| URL 参数 | `?plugin=plugins/examples/my-pack.zip`（可重复） |
| 游戏内 | 标题界面 →「插件市场」→「已安装」→ 添加插件 URL |
| 开关 | 市场里点条目切换，状态存 `localStorage: itlzmc.plugins.disabled` |

子目录（如 `plugins/store/`、`plugins/examples/`）**不会**被自动发现，避免示例污染默认游戏。

## 校验

```bash
python3.11 <skill-directory>/scripts/validate_plugin.py <project>/plugins/examples/my-pack.zip
```

会检查 zip 完整性、`plugin.json` 必填字段、`main` 指向的文件是否存在、包内 JS 语法。
