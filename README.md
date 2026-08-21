# 读取提示词

Edge 扩展：悬浮到任意图片上，旁边浮出面板，反推出可直接使用的生成提示词。

模型调用不走扩展直连，而是经过本机一个小桥接服务，桥接再去调**已用 ChatGPT 登录的 Codex CLI** ——
所以消耗的是你的订阅额度，不用另外买 API。

---

## 为什么是这个架构

想要的是"插件里 OAuth 登录 OpenAI，用我的订阅额度"。这条路官方走不通：

- **"Sign in with ChatGPT"**（2026-08-02 上线）是**纯身份层**，只回传 name / email / 头像，
  不授予第三方应用消耗你 Plus/Pro 额度的权限。
- **逆向 chatgpt.com 的 backend-api** 违反 ToS，且有 Cloudflare + PoW 校验，维护成本极高。

能达成同样效果的合法路径是：把鉴权入口从插件挪到本机。

```
Edge 扩展  →  127.0.0.1 桥接  →  codex CLI（已 ChatGPT 登录）  →  订阅额度
                    └──────────→  OpenAI API（填了 key 才启用）
```

两个后端共用同一套 SSE 契约，面板代码不区分后端。

---

## 装一次

**1. 起桥接**

双击 `bridge\start-bridge.cmd`（或 `node bridge\server.mjs`）。首次运行会生成 `bridge/config.json`
并在控制台打印一串 Token，拷下来。

**2. 装扩展**

Edge → `edge://extensions` → 打开左下角「开发人员模式」→「加载解压缩的扩展」→ 选 `extension\` 目录。

**3. 填 Token**

扩展图标右键 →「扩展选项」→ 把 Token 粘进去 → 点「测试连接」，应显示
`已连接 · codex / gpt-5.4-mini · ChatGPT 已登录` → 保存。

> 想再收紧一层：把选项页显示的扩展 ID 填进 `bridge/config.json` 的 `allowedExtensionIds`，重启桥接。

---

## 用

悬浮到图片上 400ms → **图片中心浮出 ⚡ 芯片** → 点击 → 面板出结果。

芯片钉在图片中心不动（跟随光标的版本试过，永远在指针前面跑，点不到）。
位置取的是**图片与视口的可见交集的中心**，不是几何中心——否则超长图的中心在屏幕外，芯片就够不着了；
滚动时会跟着可见区重新居中。面板则锚在图片旁边。

面板五个 Tab，各有独立复制按钮：

| Tab | 内容 |
|---|---|
| 主提示词 | 英文主提示词，可直接粘进任意生图工具 |
| 拆解 | 主体 / 风格 / 构图 / 光线 / 色彩 / 材质 / 镜头 |
| MJ | 主提示词 + 匹配实际画幅的 `--ar` 等参数 |
| SD | 正向 tag 串 + 负向词 |
| 中文 | 中文对照，方便判断反推准不准 |

面板可拖动、可钉住（钉住后点页面别处不会关）、ESC 关闭、跟随页面滚动。
点扩展图标看历史记录（最近 50 条，可搜索，点一条即复制）。

同一张图第二次悬浮直接命中缓存，瞬间出结果，不重复消耗额度。

---

## 后端选哪个

`bridge/config.json` 里的 `backend` 三个取值：`"auto"`（默认，填了 API key 就用 openai，否则 codex）、`"codex"`、`"openai"`。

**实测数据**（同一张图，本机）：

| 配置 | 耗时 | 流式 | 花钱 |
|---|---|---|---|
| codex 默认模型（skills 开） | 62–65s | 无 | 不额外花 |
| codex `gpt-5.6-luna` + 关 skills | 51s | 无 | 不额外花 |
| **codex `gpt-5.4-mini` + 关 skills（当前默认）** | **39–47s** | 无 | 不额外花 |
| openai API Key | 未实测（本机无 key） | 有 | 按量付费 |

两个绕不开的事实：

- **codex 的系统前置上下文压不到 17k tokens 以下**，`--disable skill_search` 之类也只能砍一点。
- **`codex exec --json` 不发 token 级增量**，只有 `thread.started / turn.started / item.completed / turn.completed`。
  所以 codex 后端没有打字效果，面板只能显示计时器。

想要秒级响应和流式，就在 `config.json` 填 `openai.apiKey`，`backend: "auto"` 会自动切过去。
若报 `model_not_found`，去 platform.openai.com/docs/models 查当前视觉模型名填进 `openai.model`。

---

## 目录

```
extension/          MV3 扩展，零构建，直接加载解压缩
  manifest.json
  background.js     编排：设置、缓存、SSE 消费、chrome 口味的 io
  acquire.js        取图阶梯（6 级降级），平台调用走 io 注入，可脱离扩展运行时测
  imaging.js        图像管线（降采样 / dpr 裁切 / 哈希），与扩展 API 解耦，可独立测
  content.js        悬浮探测 + Shadow DOM 面板
  options.html/js   设置
  popup.html/js     历史记录
bridge/             零依赖 Node（只用 node: 内置模块）
  server.mjs        SSE + 鉴权 + single-flight + 并发闸
  backends/codex.mjs
  backends/openai.mjs
  prompt.schema.json  强制模型输出的 JSON 结构
  prompt.txt          反推指令模板（想调质量改这个）
  config.json         首次运行生成
dev/harness.html    UI 验收台，stub 掉 chrome.*，不属于扩展
```

---

## 取图阶梯

网页上的图有一半拿不到干净字节，所以按序降级：

1. `data:` — content script 直接给
2. `blob:` — 必须在页面上下文 fetch（blob URL 绑 origin，SW 取不到）
3. `canvas.toDataURL()` — 没被污染就直接用
4. **SW fetch**（`credentials: 'include'`）— host_permissions 给了跨域豁免，能拿下要 cookie 的防盗链图床
5. 回头让页面用 canvas 画一次 — SW fetch 失败时
6. **`captureVisibleTab` + 按元素 rect 裁切** — 兜住 canvas 污染、CSS 背景图、精灵图

取到后统一归一化成 ≤1024px JPEG q0.85（593KB 的图会压到 112KB，耗时也从 46.9s 降到 39.4s），
铺白底避免透明区变黑，SHA-256 内容哈希作缓存 key。

几个刻意的取舍：

- **不按 `image/*` 白名单拦响应**——不少 CDN 把图发成 `application/octet-stream`。只拦空响应和
  `text/*`（图片链接返回 HTML 错误页的情况），剩下的交给 `createImageBitmap` 抛。
- **截屏前先让 content script 藏起自己的 UI**，等一帧再截，截完恢复。顺序有测试守着。
- **子框架里第 6 步直接拒绝**（跨域 iframe 拿不到自己在顶层视口的偏移），明确报错而不是裁错位置。
- 出错信息里带完整的"尝试路径"，一眼能看出卡在第几级，例如
  `sw-fetch → sw-fetch失败:HTTP 403 → page-canvas → page-canvas失败:画布被污染 → capture`。

### 视频

悬浮到 `<video>` 上抓的是**当前播放帧**，不是封面图。逐级退让：

```
当前帧 → (黑帧) poster 封面 → (无 poster) 截屏裁切 → (截屏也黑) 报 DRM
```

黑帧检测是必须的：DRM 视频不会抛异常，它安安静静画出一张全黑图——不拦住就会白跑 40 秒
换回一堆胡话。但**黑帧不等于 DRM**（画面还没绘制、标签页在后台都会黑），所以不在第一步判死，
一路退到截屏也黑了才下结论。反过来，非视频来源的纯色图照常放行——有人可能就是想反推一张纯色图。

帧的时间点会带进提示词（`a still frame captured from a playing video at 3:42`），
免得模型把运动模糊当成刻意的风格选择。

> 已知没法在本地验收台验证的一环：无头/不合成帧的环境里 `drawImage(video)` 一律返回全黑
> （和 rAF 不回调同一个根因），所以"抓到真实画面帧"这条主路径只能在真 Edge 里测。

---

## 安全

桥接只绑 `127.0.0.1`，且有两道闸：

- **Token**：`Authorization: Bearer`，timing-safe 比较
- **Origin**：任何 `http(s)://` 来源一律 403，只放行 `chrome-extension://`

第二道是关键——浏览器不允许页面伪造或省略 Origin（`no-cors` 模式也会带），
所以它挡住了"你访问的任意网页里的 JS 偷偷 POST 到 127.0.0.1 白嫖你的订阅额度"。

已验证：无 token → 401，错 token → 401，`Origin: https://evil.com` → 403，预检同样 403。

---

## 验收台

`dev/harness.html` 是脱离扩展运行时跑 UI 和取图逻辑的地方。起服务：

```bash
python -m http.server 8713 --directory E:/读取提示词
```

开 `http://localhost:8713/dev/harness.html`。它 stub 掉 `chrome.*`，并做两处测试侧劫持
（只在验收台里，扩展本体不受影响）：

- 强制 `attachShadow` 开成 `open`，这样才能断言 closed shadow DOM 里的 UI
- `?syncraf` 把 rAF 打成同步，用来验滚动跟随那条链——无头/不合成帧的环境里 rAF 永远不回调

页面上半部分是 UI 用例（含贴右边缘、宽扁图、CSS 背景、canvas、32px 小图标），
下半部分是取图分类用例。跨域用例走 `127.0.0.1:8713` —— 与页面的 `localhost:8713` 不同源，
且 `python -m http.server` 不发 CORS 头，能造出真实的污染画布。

`acquire.js` 和 `imaging.js` 可以直接 `import()` 进任意页面用桩测：

```js
const { acquireImage } = await import('/extension/acquire.js');
await acquireImage(req, { fetchUrl, askPage, captureTab });   // 三个平台调用全可替换
```

---

## 排错

**先点扩展图标**——popup 顶部的诊断条会直接告诉你卡在哪一环：脚本没注入 / 站点被排除 /
触发方式全关 / 这页没有够大的图 / Token 没配 / 连不上桥接。

| 现象 | 处理 |
|---|---|
| **悬浮完全没反应** | 九成是这页在装扩展**之前**就打开了 —— 按 `F5` 刷新。改完代码在 `edge://extensions` 点重新加载后同理，所有旧标签页都得刷新 |
| 悬浮在 `edge://` 等页面没反应 | 浏览器不允许扩展注入这类页面，正常现象 |
| 面板显示"连不上本地桥接服务" | 桥接没在跑，双击 `bridge\start-bridge.cmd` |
| "Token 不对" | 选项页 Token 和 `bridge/config.json` 对不上 |
| "桥接拒绝了这个来源" | `allowedExtensionIds` 里没有当前扩展 ID |
| 测试连接显示 "⚠ codex 未登录" | 跑 `codex login status`，失效就重新登录 |
| 某张图一直取不到 | 看错误里的"尝试路径"，能看出卡在阶梯第几级 |
| 悬浮没反应 | 图片小于 96px 会被忽略（选项页可调）；检查站点黑名单 |

---

## 已知限制

- **codex 后端 40 秒起步**，且没有流式。这是模型侧的地板，不是实现问题。
- 订阅额度受 ChatGPT 套餐速率限制，密集使用会撞 5h/周限流 —— 所以默认点击触发而非悬浮自动触发。
- 跨域 iframe 内的图片无法使用截屏兜底。
- 个人自用。走的是官方一方 CLI、你自己的账号，不绕过任何保护机制，但仍受 ChatGPT 使用条款约束，别拿去分发或共享额度。
