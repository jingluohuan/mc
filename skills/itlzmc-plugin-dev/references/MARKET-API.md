# 发布到 ITLZMC 插件市场（开发者 API）

> 给 AI 用：注册拿 API Key → 写插件 → **带 sharecode** 提交 → 服务端校验通过才上架。
> 普通玩家浏览 / 安装 / 创作插件**不需要登录**，只有「让 AI 把插件提交上架」才要 Key。

---

## 0. 最重要：每个请求都必须带 `sharecode`

本站部署在分享网关后面。**每一个 API 请求的 URL 末尾都要带 `?sharecode=<分享码>`，
GET 和 POST 都要带，漏了会被网关 403 拦截**（浏览器里因为有会话 cookie 不会暴露这个问题，
但 AI 用 `curl` / Python / 脚本提交时一定会遇到）。

```
线上地址：https://a23dc3393acb531d3.app.workbuddy.host/?sharecode=4AK3QS2M26
分享码：  4AK3QS2M26
```

所以完整地址长这样（**照抄，别自己拼掉参数**）：

```
GET  https://a23dc3393acb531d3.app.workbuddy.host/api/docs?sharecode=4AK3QS2M26
GET  https://a23dc3393acb531d3.app.workbuddy.host/api/market?sharecode=4AK3QS2M26
POST https://a23dc3393acb531d3.app.workbuddy.host/api/plugins/submit?sharecode=4AK3QS2M26
```

- 若用户给的本站地址里 sharecode 不同，**用那个值**，不要写死。
- 游戏内「插件市场 → 登录 / 注册 → 复制给 AI」会输出**已拼好 sharecode 的完整地址**，直接粘给 AI 最省事。
- `GET /api/docs?sharecode=...` 返回的 `full_urls` 字段也是拼好的完整地址，机器可读。

---

## 1. 端点一览（路径相对于 `/api/`，实际请求请加上 `?sharecode=`）

| 方法 | 路径 | 需要 Key | 说明 |
| --- | --- | --- | --- |
| GET | `docs` | 否 | 机器可读完整接口说明（含 `full_urls`、`curl_submit`） |
| POST | `auth/register` | 否 | `{"username","password"}` → 返回 `apiKey` |
| POST | `auth/login` | 否 | `{"username","password"}` → 取回同一枚 Key |
| GET | `auth/me` | 是 | 账号信息 + 近期提交记录 |
| POST | `auth/key` | 是（或用户名+密码） | 重置 Key，旧 Key 立即失效 |
| GET | `market` | 否 | 已上架插件列表（含 `code` 源码、`keybinds` 按键声明） |
| POST | `market/install` | 否 | `{"id"}`，安装计数 +1 |
| POST | `plugins/validate` | 否 | `{"code":"<完整源码>"}` → 只校验不入库 |
| POST | `plugins/submit` | **是** | `{"code","id?","changelog?"}` → 校验全绿才上架 |
| GET | `plugins/mine` | 是 | 我上架的插件 + 近期提交记录 |
| POST | `plugins/withdraw` | 是 | `{"id"}` 下架自己的插件 |

**鉴权**：请求头 `X-ITLZMC-Key: <key>`（也支持 `Authorization: Bearer <key>` 或 `?key=`）。
Key 形如 `qkey_…`。**不要把 Key 写进插件源码**。

---

## 2. 完整流程

### 步骤 1 · 注册拿 Key（只需一次）

```bash
curl -X POST "https://a23dc3393acb531d3.app.workbuddy.host/api/auth/register?sharecode=4AK3QS2M26" \
  -H "Content-Type: application/json" \
  -d '{"username":"mydev","password":"secret123"}'
```

返回 `{"ok":true,"username":"mydev","apiKey":"qkey_…"}`。

### 步骤 2 · 写插件

按 `SKILL.md` 的规范写 `ITLZMC.plugin(meta, factory)`。**按键插件必读 `references/KEYS.md`**：
用 `P.addKey(...)` 声明按键，手机端会自动生成屏幕按钮，不要直接监听 `keydown`。

### 步骤 3 · 可选自检（不需要 Key）

```bash
curl -X POST "https://a23dc3393acb531d3.app.workbuddy.host/api/plugins/validate?sharecode=4AK3QS2M26" \
  -H "Content-Type: application/json" \
  -d @body.json          # body.json = {"code": "<插件完整源码>"}
```

返回 `{ok, errors, warnings, report}`。`report.keybinds` 是服务端识别到的按键声明。

### 步骤 4 · 提交上架

```bash
curl -X POST "https://a23dc3393acb531d3.app.workbuddy.host/api/plugins/submit?sharecode=4AK3QS2M26" \
  -H "Content-Type: application/json" \
  -H "X-ITLZMC-Key: qkey_你的Key" \
  -d @body.json
```

成功返回 `{ok:true, plugin:{...}}`；失败返回 `422 {ok:false, errors, warnings, report}`，
按 `errors` 改完再提交。**只有全部校验通过才会写入市场**。

### 更省事：用发布脚本

```bash
python3.11 scripts/publish_plugin.py register --user mydev --pass secret123
python3.11 scripts/publish_plugin.py validate my-plugin.js
python3.11 scripts/publish_plugin.py submit   my-plugin.js
python3.11 scripts/publish_plugin.py mine
```

脚本**自动给每个 URL 拼 sharecode**，Key 存在 `~/.qiumc_market_key`；
`--base` / `--share` 可覆盖默认地址与分享码。

---

## 3. 服务端校验规则（全绿才上架）

1. 源码非空且 ≤ 64 KB，必须调用 `ITLZMC.plugin(...)`。
2. 无顶层 `await`、factory 不能是 `async`（同步执行，异步注册会被丢掉）。
3. 拒绝已删除的 Mod 命名空间（`ITLZMC.Mods` / `Forge` / `Fabric` / `.jar`）。
4. 危险 API 黑名单：`eval` / `fetch` / `XMLHttpRequest` / `WebSocket` / `require` /
   `process` / `globalThis` / `localStorage` / `document.cookie` / `innerHTML` /
   页面跳转 / 死循环 / **任何 http(s) 外链**。
5. JavaScript 语法编译通过。
6. 在 `vm` 沙箱里真正执行一遍 factory（1 秒超时、禁动态代码生成、无网络无存储），抛异常即拒。
7. 元数据以源码里 `ITLZMC.plugin` 的声明为准，不能伪造；`id` / `name` / `version` 合规。
8. **必须实际注册至少一项能力**：指令 / 机制钩子 / 贴图 / 方块 / 物品 / 配方 / **按键声明 `P.addKey`**。
9. `id` 不能与官方内置插件或他人已上架插件冲突。

**只警告不拒绝**的情况：

- `capabilities` 声明与实际注册对不上。
- 直接监听了 `keydown`/`keyup` 却没用 `P.addKey` → 提示「手机端会失效，改成声明式」。
- 没声明 `capabilities`（市场里不显示能力标签）。

---

## 4. 失败原因速查

| 返回 | 原因 | 处理 |
| --- | --- | --- |
| `403`（网关 HTML，不是 JSON） | **URL 漏了 `?sharecode=`** | 每个请求都补上分享码 |
| `401 API Key 无效或缺失` | 没带 `X-ITLZMC-Key`，或 Key 被重置了 | 重新登录取回 Key |
| `422 插件在沙箱里执行出错：window/document is not defined` | 插件在 factory 里直接用 DOM | 沙箱已有最小 `window`/`document` stub；仍建议改用 `P.addKey` / `P.on` 而不是自己操作 DOM |
| `422 实际能力` | 插件什么都没注册 | 至少加一条 `P.addCommand` / `P.on` / `P.addKey` |
| `422 异步 factory` | factory 写成 `async function` | 改成同步 `function (P) { ... }` |
| `422 id 一致 / id 规范` | 提交的 `id` 与源码 `meta.id` 不符，或格式不对 | 统一成 `^[a-z][a-z0-9_-]{2,47}$` |
| `422 安全检查` | 源码含外链 / `fetch` / `localStorage` | 贴图用 `data:image/png;base64` 内嵌，配置用 `P.storage` |
| `200` 但市场里看不到 | 提交到了别的 base / sharecode | 确认 `GET /api/market?sharecode=...` 与提交用的是同一地址 |

---

## 5. 按键插件特别提示

带 `P.addKey(...)` 的插件提交后：

- `GET /api/market` 里该插件会带 `keybinds: [{id, code, label}]`；
- 玩家安装后，桌面自动绑定物理键，手机自动出现屏幕按钮；
- 老写法（自己监听 `keydown`）也会被客户端**自动检测**并生成按钮，但服务端会给 warning，
  新插件请一律用 `P.addKey`。详见 `references/KEYS.md`。
