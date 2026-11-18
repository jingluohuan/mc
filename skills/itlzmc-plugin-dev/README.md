# ITLZMC 插件开发 SKILL（给 AI 用）

这是一个标准 CodeBuddy Skill 包。AI 加载后能按规范为 ITLZMC 写出**原生插件**并自行校验、验收。

ITLZMC **不支持 Mod / 模组**（无 Forge / Fabric / `.jar`）；游戏标题界面的「插件市场」可一键安装官方插件、创作插件、一键下载本 Skill 包。

## 安装

```bash
bash <本目录>/scripts/install.sh
# 或手工复制整个目录到 ~/.codebuddy/skills/itlzmc-plugin-dev/
```

安装后在对话里说「给 ITLZMC 写个插件」即可触发；也可以直接用 `Skill` 工具加载 `itlzmc-plugin-dev`。

## 目录

| 文件 | 用途 |
| --- | --- |
| `SKILL.md` | 工作流、硬约束、三个配方、验收清单 |
| `references/API.md` | 完整 JS API 速查 |
| `references/EVENTS.md` | 机制事件表与 ctx 字段 |
| `references/PLUGIN-PACK.md` | ITLZMC 原生插件包（.zip）规范 |
| `references/KEYS.md` | **跨端按键规范**：`P.addKey` 声明、手机端自动虚拟按钮、自动检测、连锁挖矿示例 |
| `references/MARKET-API.md` | **发布到插件市场**：注册拿 Key、校验规则、**每个 API 地址必须带 sharecode** |
| `templates/*.js` | 五类可直接复制的插件骨架（含 `keymap-plugin.js` 连锁挖矿） |
| `templates/plugin-pack/make_pack.py` | 从图集导出原生插件包模板 |
| `scripts/validate_plugin.py` | 静态校验（语法 / 清单 / 安全 / 跨端按键 / 包完整性） |
| `scripts/doctor.py` | 插件医生：AI 改插件改到失效时，输出中文定位与修法 |
| `scripts/publish_plugin.py` | 发布 CLI：register / validate / submit / mine，**自动给每个 URL 拼 sharecode** |
| `scripts/verify_plugin.py` | Playwright 浏览器验收 |
| `scripts/install.sh` | 安装到 `~/.codebuddy/skills/` |

## 快速自检

```bash
python3.11 <本目录>/scripts/validate_plugin.py /workspace/ITLZMC/plugins/examples/itlzmc-demo-texture.js
python3.11 <本目录>/scripts/doctor.py        /workspace/ITLZMC/plugins/examples/itlzmc-demo-texture.js
# 发布（每个请求自动带 sharecode=4AK3QS2M26，可用 --share 覆盖）
python3.11 <本目录>/scripts/publish_plugin.py submit /path/to/my-plugin.js
```

随 `ITLZMC-AI-SKILL.zip` 单独分发，也包含在项目源码包里。
