# dsh-connect-comate

把本机已登录的 **WPS Comate** 账号的模型接入 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness)，以 `comate` provider 的形式出现在 DSH 模型选择器里。复用 Comate 桌面端的登录态，**只读**其本地配置，不写回、不新建 OAuth 流程。

架构上是一个「反代」形态：DSH → 安全 loopback shim → 上游 `comate.wps.cn` 网关。

```text
DSH PiAiAdapter (provider "comate")
  -> 安全 loopback shim（随机端口 + 进程内随机 secret）
  -> ComateUpstreamClient
  -> https://comate.wps.cn/llmproxy/v1/user + /chat/completions (OpenAI 兼容, SSE)
  -> DSH 本地执行工具并回传结果
```

---

## 研究结论（2026-09 本机实测）

WPS Comate 桌面端登录后，会把模型接入配置写在：

| 文件 | 内容 |
| --- | --- |
| `~/.wpscomate/config.json` | `providers.official`：`baseUrl` / `apiKey` / `authHeader` / `headers.cookie` / `models[]` |
| `~/.wpscomate/agent/models.json` | 与 config.json 同构的副本（候选 fallback） |
| `~/.wpscomate/agent/auth/user_auth.json` | WPS 用户 token（v0.1 仅探测存在性，供后续做 token 刷新） |

上游协议（依据本地 config 与 Comate 桌面端 `sdk-v2-adapter` 日志确认）：

- 端点：`https://comate.wps.cn/llmproxy/v1/user/chat/completions`（`api = openai-completions`）
- 鉴权：`authHeader=true` → `Authorization: Bearer <apiKey>`，另带 `Cookie`
- 附加头：`X-Comate-Scene` / `X-Comate-Version` / `X-Request-Id` / `X-Session-Id`
- 返回：SSE 流式（`stream: true`）
- 模型目录：**完全从本地 `~/.wpscomate/config.json` 动态读取**，不写死任何模型；随账号、地区、Comate 版本变化自动更新（`llm_types` 数组里带 `llm-multimodal` 的模型支持图片输入，见「图片输入（多模态）」）

> ⚠️ **鉴权现状（重要）**：`~/.wpscomate/config.json` 里的 `apiKey` / `headers.cookie` 是**占位符**（cookie 字面值就是 `COOKIE`）。真实凭据由 Comate UI 每次任务通过本地 websocket 下发（`env.COOKIE` + `modelConfig.apiKey`），不落盘。因此 v0.1 需要**手动填写一次 wps_sid**（见下），或用 `WPS_COMATE_SID` 环境变量。

> 🔒 **落盘形态（0.4 起）**：填进设置文档的 `wpsSid` 由宿主**加密后**写入（`enc:v1:…`），不存明文；卡片里它是**密码框**——只显示圆点，复制/剪切/拖拽/右键都被拦掉。详见「`wps_sid` 的保存方式（0.4 起）」。

## 鉴权：手动填 wps_sid（v0.1 必需）

1. 浏览器打开 https://www.wps.cn/ 并登录；
2. F12 → Application/应用 → Cookies → `https://www.wps.cn` → 复制 `wps_sid` 的**值**（只复制值，不要带 `wps_sid=` 前缀）；
3. 打开 DSH 的 **插件（Plugins）页**，找到 `dsh-connect-comate` 这一项，进入它的配置页（0.1.7 上是 bundle/row 的配置页；0.1.5 上是「设置 → 插件」里的卡片），把值粘贴进 `wps_sid Cookie` 输入框后点保存——保存即生效，下一条对话就会使用，无需再重启。输入框是**密码型**（圆点显示、不可复制），保存后也不回显——这是有意的，这个值不该被看第二眼；页面下方的「启用的模型」可以勾选要在 DSH 模型列表里显示的模型（见下节）；
4. 也可以把值填进 **profile 覆盖层** `C:\Users\<你>\.dsh\profiles\web\cordis.patch.yml`（UI 卡片写入的设置与这里的配置会自动合并，UI 优先）：
   ```yaml
   - id: dsh-connect-comate
     config:
       wpsSid: 粘贴sid值      # 明文也收；卡片一打开就会就地升级成 enc:v1: 密文
   ```
   验证是否生效：`dsh --profile web --dump-config`，应看到 dsh-connect-comate 节点下带上 `config.wpsSid`。

## `wps_sid` 的保存方式（0.4 起）

这个值以前是以明文躺在 profile 的 `cordis.patch.yml` 里的，而那个文件会被同步、被备份、进仓库、被贴进 issue。现在它是一串密文：

```yaml
config:
  wpsSid: enc:v1:<base64url(IV ‖ GCM tag ‖ 密文)>
```

解开的钥匙**不在同一棵目录树里**：密钥文件（默认 `~/.wpscomate/dsh-connect-comate/secret.key`；POSIX 上收紧到 0600，Windows 上靠用户目录的继承 ACL）里的 32 字节随机数当 HKDF-SHA256 的输入密钥材料，**本机指纹**（平台 / 架构 / 主机名 / 用户名）当 salt，派生出 AES-256-GCM 的 key。密文自带随机 IV 与认证标签，改一个字节就会解密失败（报 `auth-failed`——GCM 分不出「被篡改」和「钥匙不对」，这两件事共用同一个原因码）。

存储状态有四种，卡片的状态行会报出当前那一种是哪一种（`doctor` 报的是同一套名字，但它读的是 `WPS_COMATE_SID` 环境变量 —— 一个独立的 CLI 进程读不到 DSH 的 profile 设置文档，所以卡片存的那份要看卡片状态行）：

| `wpsSidStorage` | 含义 | 要做什么 |
| --- | --- | --- |
| `unset` | 没存过 | 按上面「手动填 wps_sid」填一次 |
| `plaintext` | 0.4 之前写的明文值，**仍然可用** | 打开卡片会自动升级；也可点状态行旁的「升级为密文」 |
| `sealed` | 密文，能解开 | 无需操作 |
| `unreadable` | 密文在，但这台机器 / 这个用户打不开 | 按 hint 指认的原因处理（密钥文件被删、被换、来自别的机器）：重新粘贴一次，或用 `WPS_COMATE_SECRET_KEY_FILE` 指向正确的密钥文件 |

```powershell
node lib\bin.js seal        # 读 stdin 或 WPS_COMATE_SID，打印密文（stdout 只有密文，可重定向）
node lib\bin.js doctor      # 看 wpsSidStorage / wpsSidProblem / wpsSidKeyFile（是路径，不是密钥）
```

两处入口分工不同：**卡片**的「立即加密」是就地升级设置文档里那份值（只有宿主读得到它），`seal` 子命令则是给你手改 `cordis.patch.yml` 时生成密文用的（读 stdin / 环境变量）。用环境变量可以完整跑一遍四种状态：

```powershell
$env:WPS_COMATE_SECRET_KEY_FILE = "$env:TEMP\probe.key"
$env:WPS_COMATE_SID = "V02example"
$sealed = node lib\bin.js seal                       # stdout 只有密文
node lib\bin.js doctor                               # storage=sealed
$env:WPS_COMATE_SID = $sealed
Rename-Item $env:WPS_COMATE_SECRET_KEY_FILE "$env:WPS_COMATE_SECRET_KEY_FILE.gone"
node lib\bin.js doctor                               # storage=unreadable, problem=key-missing
```

**这个加密防什么、不防什么**：它防「文件被搬走」——profile 被同步到另一台机器、备份被翻出来、仓库被 clone，密文都解不开。它**不防**「本机被攻破」：密钥文件就在同一个用户的 home 下，任何能以该用户身份执行代码的人都能解开。这是刻意的取舍——走 OS keychain 要引入原生依赖或平台 API，用主密码则要求每次无人值守运行前先解锁。同理，换机器 / 换用户名 / 换密钥文件之后旧密文就解不开了，这是设计行为，不是 bug。

`WPS_COMATE_SID` 环境变量的值**不会**被加密写回设置文档：那是一次性的 shell 覆盖，不是要求持久化的凭据。

> 若上游报 API 密钥无效，在卡片里勾选「只用 Cookie 鉴权」（cookieOnly）再保存。
> 命令行临时验证（不走 DSH 设置）：
> ```powershell
> $env:WPS_COMATE_SID = "粘贴sid值"
> node lib\bin.js check
> ```

## 模型勾选（隐藏不用的模型）

设置卡片的「启用的模型」列出本机 Comate config 发现的全部模型（含上下文大小、是否支持图片）：

- **勾选**才会注册进 DSH 模型列表，取消勾选的模型不显示，避免无用模型占列表；
- 提供「全选 / 全不选」快捷按钮；
- 语义与 workbuddy 一致：**全部勾选（或保存为空）= 显示全部模型**；保存过非空选择后，只显示勾选项；
- 选择随设置持久化（`enabledModelIds`），保存后无需重启即生效；
- **「输出 token 上限」**：正整数为每个回答的上限，`0` 表示不限制（由上游决定），默认 32000；
  保存后无需重启即生效。清空或填非整数时保存按钮会禁用并提示（不会把默认值偷偷写回去）；
- **每个模型可以单独设上限**：模型列表里每个模型右侧各有一个上限输入框，覆盖上面那个默认值。
  **留空 = 跟随默认值**（框里的灰字就是当前默认值），填 `0` = 这个模型不限制，两种语义互不等价；
  清空一个已设过的框就是撤销这条覆盖。整个设置只有一份 map（`maxOutputTokensByModel`），
  保存时按整张表重写，所以「删掉一条」不需要额外的复位按钮。填了非整数一样禁用保存并提示；
- **「刷新模型列表」** 让宿主重读本机 Comate 配置（在桌面端刚登录/刚换账号时用，不必重启 DSH）；
- 模型目录由宿主只读路由 `GET /plugins/dsh-connect-comate/__catalog` 提供（响应含 `signedIn`、`providerRegistered`、`models`，**不含任何凭据**）。宿主不再把目录回写进设置：0.1.7 上设置写入的目标是用户手写的 `cordis.patch.yml`，宿主每次发现变化都去重写它会破坏该文件的注释与格式。

## 图片输入（多模态）

`llm_types` 里带 `llm-multimodal` 的模型会在 DSH 里拿到图片输入能力（本机 10 个模型里 5 个带这个标记）。整条链路的每个环节都有据可查：

| 环节 | 事实 | 依据 |
| --- | --- | --- |
| 能力判定 | config 的 `llm_types` 是 **JSON 数组**（`["llm-chat","llm-multimodal"]`）；也接受空格/逗号分隔的字符串，`multimodal: boolean` 优先 | `src/auth.ts` 的 `parseLlmTypes`；与桌面端 `isModelMultimodal` 同序 |
| 宿主附件服务 | pi-ai 的 context builder **只能**通过宿主的 durable attachment service（`readImageRequest`）拿到图片字节；没接线时它回退到 text-only 分支，**任何带图片的请求整轮失败**（`UNSUPPORTED_CONTENT`），而纯文本请求照常——这正是 0.3.2 的机器现象 | `src/adapter.ts` 的 `resolveAttachments` / `resolveImageAccess`；与宿主自身 pi-ai provider 逐字同源（`resolveAttachments: () => ctx.get("attachments")`）；`tests/adapter-attachments.spec.ts` 以真 adapter + 真 shim 复现并修住 |
| DSH 侧编码 | pi-ai 把附件的 `{type:'image', data, mimeType}` 编成 `image_url: { url: 'data:image/png;base64,…' }` | `tests/multimodal.spec.ts` 捕获真实请求体 |
| 上游接受（分模型） | **不是所有模型都吃 base64**：本机 5 个多模态模型里 4 个接受 inline `data:` URL，`mimo-v2.5` 直接拒：`请求参数值有误(unsupported message.content type=image)`。同一张图改成预签名 URL 后 mimo 正常识别 | 2026-09-25 本机直连 `llmproxy/v1/user/chat/completions`，96×96 纯色 PNG，三种形状 × 5 模型矩阵（`tests/multimodal-live.spec.ts`） |
| 图片外置 | 出站前把 inline base64 换成预签名 URL：`assets/presign-upload` → ks3 PUT → `presign-download`（与桌面端同一套接口、同样只带 Cookie）。同一张图按内容哈希缓存，多轮里只传一次；TTL 临近到期只重签不重传 | `src/assets.ts`；`tests/assets.spec.ts`（请求形状、缓存、降级）、`tests/adapter-attachments.spec.ts`（接线） |
| 出站归一化 | 裸字符串 `image_url` / 假 base64 前缀 / svg 三种形状会被网关**静默**处理成空正文，插件在出站前修掉 | 同上，四种形状各发一次 |

插件**会把图片外置**（`src/assets.ts`）。桌面端就是这么做的：本地图片先走 `assets/presign-upload` → ks3 PUT → `presign-download` 换成预签名 URL 再发给模型。之前以为这一环对 DSH 是多余的（网关实测吃 base64），但那是**分模型**的——`mimo-v2.5` 只收 URL，发 base64 会被网关直接拒掉整轮。既然官方客户端对所有模型都发 URL，URL 才是这条链路的标准形状，base64 只是碰巧对 4 个模型可用。

所以外置是**无条件**的（不按模型名匹配，那太脆），但**尽力而为**：

- 上传器在 shim 里、在归一化之后被调；只有真 base64 数据 URL 会被外置，已有的 http(s) URL 原样通过；
- 任何一步失败（无 Cookie、网络、非零 code、抛异常）都**退回 inline base64**继续发，请求不因此失败——4 个接受 base64 的模型不受影响，`mimo-v2.5` 退回修复前的行为；
- 上传器在 shim 里抛异常也只写一条 warn，不冒泡；
- 内容哈希缓存（含下载 URL 的到期时间）：同一张图在多轮里只上传一次，URL 临近过期时只重签不重传；
- 被替换/失败时写一条 `warn`（`externalized=` / `upload_failed=`），与归一化的计数同一条日志。

链路上**没有捷径**的一环是上面那行「宿主附件服务」：图片字节由宿主的附件服务持有，本插件只能请求它——所以装配漏了它，解析和出站形状修得再对也到不了网关。反过来说，缺了它时本插件现在会打一条**一次性** `warn`（「附件服务不可用；图片会失败，文本不受影响」），而不是只留用户看到的一句裸 `UNSUPPORTED_CONTENT`。

出站归一化（`src/multimodal.ts`）只做三件事，每件都把「静默失败」变成「能用的请求」：

1. 裸字符串 `image_url` → 对象形状（字符串形式会被无声丢弃，模型会答 `Unknown`）；
2. `data:image/*;base64,<http(s) URL>` 的假前缀 → 剥回真实 URL（与桌面端 `fake-base64-image-url.js` 同一正则思路）；
3. 网关不认的媒体类型（如 svg；桌面端支持集合是 png/jpeg/webp/gif/bmp/x-icon/avif）→ 换成一条 `[image omitted: …]` 文字说明，而不是留下一条空消息、让用户收到一个没有理由的空回答。

真的改动了图片时写一条 `warn` 日志（`seen=/repaired=/stripped=/dropped=/externalized=/upload_failed=`）——网关对这些形状都回 HTTP 200，日志是事后唯一能解释「那次空回答是怎么回事」的痕迹。

真机验收（默认跳过，需要登录态）：

```bash
# 源码树：两色图 + 断言两色都答出（只查「有正文」会放过「我读不到这张图」）
WPS_COMATE_LIVE=1 npx vitest run tests/multimodal-live.spec.ts

# 思考档位：开 off 后同一个请求形状真的带上 reasoning_effort=off 且思考归零；
# xhigh / max 上游接受；none 与 off 分道扬镳。另有一个原始证据采集器（表一/表二的出处）：
# WPS_COMATE_LIVE=1 npx vitest run tests/thinking-probe-live.spec.ts
WPS_COMATE_LIVE=1 npx vitest run tests/thinking-levels-live.spec.ts

# 安装产物：覆盖安装后跑这个。源码绿 ≠ 产物绿（0.3.2 就是这么翻车的）
WPS_COMATE_SID=<sid> pnpm run verify:installed

# 整条 HTTP 链路：真起 shim、真凭据、真上游。上面两个直接调函数，
# 验的是层内；这个验的是 DSH → pi-ai → shim(HTTP) → adapter → 上游 的接缝
COMATE_PKG_DIR=<插件安装目录> pnpm run verify:shim

# wps_sid 密文链路：直接 import 已构建的 lib/，用临时密钥文件跑完整状态矩阵
# （明文可读 / 往返逐字节一致 / 设置文档里没有明文 / 四种「解不开」的成因各自可分辨 /
#   doctor 只报路径不报密钥 / 升级路径的两条拒绝条件）。不碰真实凭据与真实密钥文件
pnpm run verify:sid-cipher

# 脱敏边界（四个用例）：起一个真 shim，喂它「上游错误正文里回显了凭据」的响应，断言出口
# 字节里一个字符都不剩，同时分类与原因还在；另有一条钉住反向要求——网关真实的
# `"code":"not_login"` 必须活着出来（脱敏不是把错误信息抹平）。**不需要登录态**
# （上游是本地桩）——脱敏是安全边界，不该只在有账号的机器上才被检查。
# 默认 import 已安装产物，同 verify:sid-cipher
pnpm run verify:redaction

# 卡片状态机：在 jsdom 里跑**真实构建产物** lib/client.js，按用户的操作序列断言 DOM：
# 模型勾选状态（打开 / 取消勾选 / 保存 / 退出 / 再进入）、每模型输出上限、模型别名、
# 思考档位勾选框。钉住的是「设置快照与模型目录两个异步源谁先到，草稿该怎么重新播种」——
# 这一层类型检查和纯函数单测都看不见（0.4.0-rc.2 就是这么漏的：一进来全不勾）。
# 需要 devDependencies 里的 jsdom + react-dom；若本仓库的 node_modules 承载不了它们
# （它可能是指向已安装 profile 的链接），用 DSH_COMATE_CARD_DEPS 指向别的目录。
# COMATE_PLUGIN_DIR=<插件安装目录> 则改为验安装产物（同 verify:sid-cipher）
pnpm run build && pnpm run verify:card
```

`verify:shim` 默认只打 `mimo-v2.5`（修复前唯一失败的模型），要全矩阵就加
`COMATE_LIVE_MODELS=deepseek-v4.1-flash,MiniMax-M3,kimi-k3,glm-5.3-flash,mimo-v2.5`。
它还断言 shim 的图片计数是 `externalized=1 upload_failed=0`——出站是 URL 而不是 inline
base64，才是图片外置真正要钉住的东西。

三个都复刻真机出问题的那次请求形状（图片来自 `read_image` 工具结果、放在 tool 消息里），
对 5 个多模态模型各发一次，断言：模型答出图片的**两个颜色**、且出站载荷是上传后的 URL。
默认套件无网（`vitest run` 不依赖登录态）。

## 测试连接

卡片动作行的「测试连接」发**一次最小请求**（`max_tokens: 8`、`stream: true`、单条 `ping`）验证凭据，结果就地显示（成功并给出所用模型 / 失败并给出 HTTP 状态、错误分类与脱敏后的上游原文）。

> 已知局限（待修，见 `0.4.2` 之后的工作项）：这一步目前**只看 HTTP 状态码**——空正文的
> 200、或者流里带着 `error` 事件的 200，都会被报成「连接成功」。所以它现在回答的是
> 「凭据被接受了吗」，而不是「这个模型能出话」。

- 用的是**当前草稿**的 `wps_sid` 与 `cookieOnly`，所以**可以先测再存**——粘错值不会先写进设置文档；草稿只作用于那一次请求，不落盘。
- 与命令行 `dsh plugin exec dsh-connect-comate check` **共用同一份实现**（`src/check.ts`），两边不会给出不一致的结论。
- 探测用「启用中的第一个模型」（没有勾选任何模型时即目录第一个），也就是你实际会用到的那条路。

## 模型别名（显示名）

卡片「启用的模型」里每个模型右侧有一个别名输入框：空着就用上游发现的名字（框里的灰字就是那个名字），
填了就以你填的为准。清空那一格就是撤销别名。

**别名只改画什么，不改 id。** DSH 选择器画的是模型描述符的 `name`，而请求、设置文档、逐模型输出上限表
用的都是 id——所以别名只落在 `name` 上，id 一字不动：给模型改个名不会弄丢它的输出上限，
也不会让已保存的默认模型选择失效。

解析规则由 `src/model-alias.ts` 提供，浏览器半（卡片）与宿主半读的是**同一份代码**：键和值都 trim，
trim 后为空的键或值都不进表（空串不是「把名字改空」，而是「没有别名」）；值不是字符串的条目只丢自己，
其余照用，并在宿主日志里说明丢的是哪个模型（否则界面上只剩一个空框，和「从没设过」长得一样）。

## 思考等级（thinking level）

模型选择器里为 comate 模型提供思考等级。**基础四档 minimal / low / medium / high 一直都在**，
另外三档默认不出现，要你在卡片里手动勾选：

| 档位 | 勾选后发出的 `reasoning_effort` | 说明 |
| --- | --- | --- |
| Off | `off` | 真的关掉思考（本机 10 个模型里 7 个的 `reasoning_content` 归零） |
| Xhigh | `xhigh` | 上游接受，但**测不出**与 `high` 的区别 |
| Max | `max` | 同上 |

映射来自本机实测（2026-09-26，裸打上游、绕开适配器）：上游接受整条 OpenAI `reasoning_effort`
词汇表；不传参数时模型**默认就在思考**（基线每次都返回 `reasoning_content`）；`reasoning_effort`
的取值会原样发给上游。

> **关思考的取值是 `off`，不是 `none`。** OpenAI 词汇表里表示「关」的是 `none`，但在这个网关上
> `none` 会被接受（HTTP 200）却**一律被忽略**——10 个模型的 `reasoning_content` 全部停在基线长度
> （201–1665 字符，没有一个归零）。真正让它归零的是 `off`。两个例外：`glm-5.3` / `glm-5.3-flash`
> 收到 `off` 后思考反而更长（810→3059、660→1357），像是把不认识的取值当成了「放开想」；
> `kimi-k3` 的基线本身就是 0，它不能作为 `off` 生效的证据。

> **勾了 Off 会连带改掉「provider default」的含义。** `dsh-llm-pi-ai` 会把 `off` 改写成「不传该选项」，
> 而选择器自带的「provider default」走的也是同一条不发参数的路。两个档位共享同一条出站形状，
> 所以要让 Off 是真的 Off，就只能给 `thinkingLevelMap` 的 `off` 键一个具名线值（`off: 'off'`），
> 「provider default」于是也跟着变成不思考。**这不是缺陷，是这条链路上「关闭」与「默认」不可兼得**——
> 不勾这一档时两个位置都不出现，一切照旧。（这也是三档默认全不勾的原因：它们是插件不能替你拍的板。）

> **Xhigh / Max 是「可选但未经证明」的档位。** 同一道题、每个档位跑两次：`high` 在 `deepseek-v4-pro`
> 上是 536 与 722，同档位两次之间差 186，比档位之间的差距还大——所以放它们出来是照明确要求提供的选项，
> 而不是默认值。


## 安装

前置：已安装并登录 WPS Comate 桌面客户端（插件复用其登录态，会读取 `~/.wpscomate/config.json`）。

**从 GitHub 安装（推荐）**：

```sh
dsh plugin --profile <web|desktop|dsh-tui> add github:DiEr-TouShou/dsh-connect-comate
```

要固定版本，可带 tag：`github:DiEr-TouShou/dsh-connect-comate#v0.4.1`（`lib/` 是构建产物、不入库，带 tag 也照常触发构建）。

仓库只提交源码（`lib/` 是构建产物，不入库），所以这一步会在克隆后自动执行 `prepare` → `tsdown`。
DSH 会把它作为**待批准的构建脚本**列出，在插件面板确认一次即可。

> 本仓库由 `bakasbk/dsh-connect-comate` 迁出，原仓库保留为 upstream。

**从本地路径安装（开发模式）**：

```sh
dsh plugin --profile <web|desktop|dsh-tui> add C:\path\to\dsh-connect-comate
```

本地路径安装时 `lib/` 必须已经构建好（`pnpm install && pnpm run build`）。

安装、更新或卸载 bundle 后，重启对应的 DSH 进程。

> 尚未发布到 npm。

## 命令行

```sh
dsh plugin --profile <web|desktop|dsh-tui> exec dsh-connect-comate check    # 发一个最小请求验证凭据（需先填 wpsSid）
dsh plugin --profile <web|desktop|dsh-tui> exec dsh-connect-comate status   # 登录状态与模型数
dsh plugin --profile <web|desktop|dsh-tui> exec dsh-connect-comate doctor   # 配置路径与解析诊断
dsh plugin --profile <web|desktop|dsh-tui> exec dsh-connect-comate logout   # v0.1 无自有副本，仅报告
```

`status` / `doctor` 支持 `--json` 输出机器可读格式。也可以在本地直接运行构建产物：

```sh
node lib/bin.js doctor
```

### 只读状态路由与动作路由

宿主暴露三条本机路由，便于在浏览器外确认「宿主那一半」到底装上了没有：

```sh
# 状态（只读）
curl http://127.0.0.1:<DSH web 端口>/plugins/dsh-connect-comate/__catalog
# {"signedIn":true,"providerRegistered":true,"models":[...],"sidStorage":"sealed"}
# sidStorage 是宿主对「存着的那份 wps_sid」的判定（unset/plaintext/sealed/unreadable）；
# 打不开时会多一个 sidProblem（如 key-missing）。没有凭据存储的部署两个字段都不出现。

# 刷新模型目录（重读本机 Comate 配置，不写任何文件）
curl -X POST -H 'content-type: application/json' \
  http://127.0.0.1:<DSH web 端口>/plugins/dsh-connect-comate/__refresh

# 测试连接（最小请求；可带未保存的草稿凭据，仅作用于这一次）
curl -X POST -H 'content-type: application/json' \
  -d '{"wpsSid":"粘贴sid值","cookieOnly":false}' \
  http://127.0.0.1:<DSH web 端口>/plugins/dsh-connect-comate/__check
# {"ok":true,"model":"41000207/deepseek/deepseek-v4-flash//public"}
```

- `providerRegistered` 为 `false` 而 `signedIn` 为 `true`，说明 loopback 监听起来了、但 `comate`
  provider 没能注册进 harness 注册表——此时 DSH 模型选择器里不会有任何 Comate 模型（宿主日志里会有
  `provider registration failed`）。
- 三条路由都只接受回环 Host + 回环 Origin；两条 POST 还要求 `content-type: application/json`
  （跨站表单发不出这个头，等于砍掉简单请求 CSRF）。响应**不含任何凭据**。

## 开发

```sh
pnpm install     # 装完后会自动跑一次构建（package.json 的 prepare 脚本，供 git 安装使用）
pnpm run check   # typecheck + test + build
```

本地改码后重启 DSH 进程生效。环境变量：

| 变量 | 作用 |
| --- | --- |
| `WPS_COMATE_CONFIG_FILE` | 显式指定 config 文件路径 |
| `WPS_COMATE_HOME` | 显式指定 Comate 家目录（默认 `~/.wpscomate`） |
| `WPS_COMATE_SID` | 手动提供 wps_sid 值（与 DSH 设置里的 `wpsSid` 等效，命令行验证用） |
| `WPS_COMATE_MAX_TOKENS` | 覆盖输出 token 上限（正整数；`0` = 不限制）。存在即优先于 `maxOutputTokensByModel` 与 `maxOutputTokens`，无头脚本用 |
| `WPS_COMATE_SECRET_KEY_FILE` | 显式指定密钥文件路径（默认 `$WPS_COMATE_HOME/dsh-connect-comate/secret.key`）。profile 从别处搬来、或想共用同一把钥匙时用 |

插件 Config（通过 profile 覆盖层 `profiles/<profile>/cordis.patch.yml` 的 `config:` 传入）：

| 设置 | 作用 |
| --- | --- |
| `wpsSid` | 手动填写的 wps_sid（www.wps.cn cookies 取值，不带前缀）。**密文保存**：明文只在卡片里输入的那一刻存在，宿主写入前会加密成 `enc:v1:…`；手写明文也兼容（卡片一打开就升级） |
| `cookieOnly` | 只发 Cookie 鉴权（上游报 API 密钥无效时开启） |
| `enabledModelIds` | 勾选启用的模型 id 列表；空 = 全部显示（一般用卡片勾选，不用手填） |
| `maxOutputTokens` | 输出 token 上限的**默认值**（所有模型共用，正整数）；`0` = 不限制，交给上游。缺省用插件默认 32000 |
| `maxOutputTokensByModel` | 按模型 id 覆盖上限的 map（`{"<model id>": 8192}`）；`0` = 该模型不限制；**没有这个键的模型跟随 `maxOutputTokens`**。卡片里的每模型输入框写的就是它，手填也可用 |
| `lastCatalog` | **已弃用**：宿主不再回写目录，卡片改从只读路由读取；保留字段只为让旧配置仍能通过校验 |
| `configFile` | 显式指定 config.json 路径 |

> `wpsSid` / `cookieOnly` / `enabledModelIds` / `maxOutputTokens` / `maxOutputTokensByModel` 五个字段在 0.1.7 线上必须由 schema 声明为 volatile，
> 否则设置写入会被直接拒绝（`Plugin entry "…" has no volatile fields`）。字段值在 0.1.7 上以
> `{get(): T}` 活引用交付，所有读路径都经 `unwrapVolatile()` / `unwrapVolatileDeep()`。

### 两条 DSH 线

同一个构建同时服务 0.1.5 与 0.1.7，靠运行时能力探测（而不是假设）：

| 关注点 | 0.1.5 线 | 0.1.7 线 |
| --- | --- | --- |
| 设置命名空间 | 插件自注册的 `comate` | profile 插件 entry id（`dsh-connect-comate`） |
| 宿主注册 | `settings.register(ns, schema, { base })` | `settings.configure({ auto: false }, fiber)` |
| 配置值 | 普通值 | volatile 字段是 `{get(): T}` 活引用 |
| 客户端服务 | `ctx.settingsScope` | `ctx.configForms` |
| 卡片槽位 | `settings.plugin.item` | `plugins.bundle.config` / `plugins.row.config` |

## 实机验证清单

1. `node lib/bin.js doctor` —— 应显示 `valid=true` 且列出 baseUrl 与 8 个模型；`Manual wps_sid` 应为 `unset`（未填时），`wpsSidStorage` 同步为 `unset`。
2. 填入 wpsSid 后 `node lib/bin.js check`（或 `dsh plugin exec ... check`）—— 输出 `OK` 表示上游接受凭据。
3. 密文链路自查（两条独立的通道，各自都能单独跑）：
   - **卡片通道**：在卡片里保存一次 wps_sid → 状态行应显示「已配置（密文保存）」；直接看 profile 的 `cordis.patch.yml`，`wpsSid` 应是一串 `enc:v1:…` 而**不是** `V02…` 开头的明文。把密钥文件改名后重开卡片，状态行应变成「本机解不开」并带出 `key-missing` 原因（宿主把这份判定随目录路由一起下发，浏览器自己看不出差别）。
   - **CLI 通道**：按上面「保存方式」一节的环境变量脚本走一遍 `seal` → `doctor`（`sealed`）→ 移走密钥文件 → `doctor`（`unreadable` + `key-missing`）。注意 `doctor` 读的是 `WPS_COMATE_SID`，看不到卡片存的那份值——这不是缺陷，是独立进程读不到 DSH 设置文档。
4. 安装到 DSH 并重启后，模型选择器应出现 `WPS Comate` provider 与模型列表。
5. 新两项能力（都在卡片里，保存即生效、无需重启；但**首次装完要重启 DSH**）：
   - **模型别名**：在「启用的模型」里给某个模型填个别名 → 保存 → 选择器里画的就是你填的名字，
     但该模型已设的输出上限与默认模型选择**不受影响**（别名只改画什么，不改 id）。
   - **思考档位**：勾上「Off / Xhigh / Max」→ 保存 → 选择器里多出这三档。选 **Off** 后问一道
     需要推理的题，回答里不应再有思考过程（`reasoning_content` 归零）；⚠️ 注意勾上 Off 之后，
     选择器自带的「provider default」也会变成不思考（两者共享同一条不发参数的出站形状）。
     **两个例外**：`glm-5.3` / `glm-5.3-flash` 即使选 Off 也会继续思考（实测收到 `off` 后思考
     反而更长），不是插件没生效。
6. 首次真实对话（会消耗账号额度）：选一个模型发起对话。若失败，看错误：
   - 401 `not_login` → 重新复制 wps_sid（www.wps.cn 的 cookie），确认不带前缀；
   - 仍 401 且提示密钥无效 → 开启 `cookieOnly`；
   - 400 → model id 可能需要用短名（桌面端实际请求用 `flash` 等短名，见 `~/.wpscomate/agent/logs/sidecar.log`）。

## 安全与合规

- shim 只监听 `127.0.0.1`，随机端口 + 进程内随机 secret（常量时间比对）；真实 apiKey/cookie 不交给 pi-ai 层。
- **越过边界的第三方文本先脱敏**：上游错误正文、凭据解析异常、handler 内部异常，都在
  `writeOpenAIError` 这**唯一出口**过一遍 `safeMessage`（规则在零依赖的 `src/redact.ts`，
  与卡片共用一份）。上游回显了 `Cookie`、Bearer 或 JWT，都不会再流进下游的错误 JSON。
  脱敏先于截断——先截再抹会把跨在截断点上的令牌切掉一半，而半个真凭据也是凭据。
  规则会误伤时宁可误伤（错误信息少一个词，总比漏一个凭据好），但也有两处刻意的例外：
  `code` 保留**标识符形状**的值——`12153` 与 `not_login`（网关真实的两种形状），
  都是用户排查时要搜、插件自己也用来分类的标记；凭据形状的值照旧全抹
  （`-` `.` `+` `/` `=` 都不在允许集里），所以 `code` 不会变成藏凭据的后门。
  裸 `key: value` 只在值像凭据时才抹（否则 `the secret: the key file` 这种句子会被吃掉）。
- 只驱动**使用者自己**的 WPS Comate 账号在本机调用；桌面端文件永不被写入。
- 依赖 Comate 客户端接口（非官方开放 API），Comate 更新后插件可能需要随之调整。
- 使用需遵守 WPS 的服务条款；账号被限制、额度变动等风险由使用者自行承担。本项目仅供个人学习与研究使用。

## 致谢

本项目借鉴并参照了以下 MIT 项目的设计与实现思路，关键模块独立编写并标注来源：

- [dingminhua/dsh-connect-workbuddy](https://github.com/dingminhua/dsh-connect-workbuddy)（MIT，Copyright (c) 2026 LaoDing）—— 连接内核（loopback shim 加固、pi-ai provider 装配、凭据只读发现、CLI 诊断结构），以及让 DSH 0.1.7 线可用的全部判定结论（settings 换型、volatile 声明、活引用、客户端服务与槽位变更）
- [corrinehu/dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect)（MIT，Copyright (c) 2026 Corrine Hu）—— 经上项目转引的原始可行方案
- 上游协议形态参照 [Sliverkiss/workbuddy2api](https://github.com/Sliverkiss/workbuddy2api)（MIT）的思想

两个上游项目的 MIT 许可原文与版权声明收录在 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## License

[MIT](LICENSE)。本插件与金山办公（WPS）、DeepSeek 均无关联，未获其授权或认可；文中名称仅用于描述兼容关系，商标归各自所有。
