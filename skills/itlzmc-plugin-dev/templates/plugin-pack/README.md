# 原生插件包模板

`make_pack.py` 直接从 ITLZMC 的 `js/assets.js` 导出一份**ITLZMC 原生插件包**模板：

```bash
python3.11 make_pack.py /workspace/ITLZMC/js/assets.js /workspace/mypack.zip
```

生成结构：

- `plugin.json`（ITLZMC 原生插件包清单，`capabilities: ["texture"]`）
- `README.txt`
- `assets/minecraft/textures/block/<name>.png`（所有命名贴图）
- `assets/itlzmc/atlas/<数字>.png`（图集空位贴图，按索引覆盖）

改完 PNG 重新打包，放进 `plugins/` 或用 `?plugin=<路径>` 加载即可；也可以在「插件市场 → 已安装」里添加 URL。

`item/` 与 `block/` 严格分离：`item/<name>.png` 只覆盖 `i_<name>` 图标。

> 这是 **ITLZMC 原生插件包**模板，不是原版资源包：清单只认 `plugin.json`，不写 `pack.mcmeta`，也不加载 `.jar` 模组。
