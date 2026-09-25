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

## 鉴权：手动填 wps_sid（v0.1 必需）

1. 浏览器打开 https://www.wps.cn/ 并登录；
2. F12 → Application/应用 → Cookies → `https://www.wps.cn` → 复制 `wps_sid` 的**值**（只复制值，不要带 `wps_sid=` 前缀）；
3. 打开 DSH 的 **插件（Plugins）页**，找到 `dsh-connect-comate` 这一项，进入它的配置页（0.1.7 上是 bundle/row 的配置页；0.1.5 上是「设置 → 插件」里的卡片），把值粘贴进 `wps_sid Cookie` 输入框后点保存——保存即生效，下一条对话就会使用，无需再重启；页面下方的「启用的模型」可以勾选要在 DSH 模型列表里显示的模型（见下节）；
4. 也可以把值填进 **profile 覆盖层** `C:\Users\<你>\.dsh\profiles\web\cordis.patch.yml`（UI 卡片写入的设置与这里的配置会自动合并，UI 优先）：
   ```yaml
   - id: dsh-connect-comate
     config:
       wpsSid: 粘贴sid值
   ```
   验证是否生效：`dsh --profile web --dump-config`，应看到 dsh-connect-comate 节点下带上 `config.wpsSid`。

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
- **「刷新模型列表」** 让宿主重读本机 Comate 配置（在桌面端刚登录/刚换账号时用，不必重启 DSH）；
- 模型目录由宿主只读路由 `GET /plugins/dsh-connect-comate/__catalog` 提供（响应含 `signedIn`、`providerRegistered`、`models`，**不含任何凭据**）。宿主不再把目录回写进设置：0.1.7 上设置写入的目标是用户手写的 `cordis.patch.yml`，宿主每次发现变化都去重写它会破坏该文件的注释与格式。

## 图片输入（多模态）

`llm_types` 里带 `llm-multimodal` 的模型会在 DSH 里拿到图片输入能力（本机 10 个模型里 5 个带这个标记）。整条链路的每个环节都有据可查：

| 环节 | 事实 | 依据 |
| --- | --- | --- |
| 能力判定 | config 的 `llm_types` 是 **JSON 数组**（`["llm-chat","llm-multimodal"]`）；也接受空格/逗号分隔的字符串，`multimodal: boolean` 优先 | `src/auth.ts` 的 `parseLlmTypes`；与桌面端 `isModelMultimodal` 同序 |
| DSH 侧编码 | pi-ai 把附件的 `{type:'image', data, mimeType}` 编成 `image_url: { url: 'data:image/png;base64,…' }` | `tests/multimodal.spec.ts` 捕获真实请求体 |
| 上游接受 | 网关接受**真 base64** 数据 URL，并正确识别图片内容 | 2026-09 本机直连 `llmproxy/v1/user/chat/completions`，96×96 纯色 PNG |
| 出站归一化 | 裸字符串 `image_url` / 假 base64 前缀 / svg 三种形状会被网关**静默**处理成空正文，插件在出站前修掉 | 同上，四种形状各发一次 |

插件**不做**图片上传。桌面端会把本地图片走 `assets/presign-upload` → ks3 PUT → `presign-download` 换成预签名 URL，但网关实测直接吃 base64，所以这一环对 DSH 是多余的复杂度；将来若网关改成只认 URL，再补它。

出站归一化（`src/multimodal.ts`）只做三件事，每件都把「静默失败」变成「能用的请求」：

1. 裸字符串 `image_url` → 对象形状（字符串形式会被无声丢弃，模型会答 `Unknown`）；
2. `data:image/*;base64,<http(s) URL>` 的假前缀 → 剥回真实 URL（与桌面端 `fake-base64-image-url.js` 同一正则思路）；
3. 网关不认的媒体类型（如 svg；桌面端支持集合是 png/jpeg/webp/gif/bmp/x-icon/avif）→ 换成一条 `[image omitted: …]` 文字说明，而不是留下一条空消息、让用户收到一个没有理由的空回答。

真的改动了图片时写一条 `warn` 日志（`seen=/repaired=/stripped=/dropped=`）——网关对这些形状都回 HTTP 200，日志是事后唯一能解释「那次空回答是怎么回事」的痕迹。

## 测试连接

卡片动作行的「测试连接」发**一次最小请求**（`max_tokens: 8`、`stream: true`、单条 `ping`）验证凭据，结果就地显示（成功并给出所用模型 / 失败并给出 HTTP 状态、错误分类与脱敏后的上游原文）。

- 用的是**当前草稿**的 `wps_sid` 与 `cookieOnly`，所以**可以先测再存**——粘错值不会先写进设置文档；草稿只作用于那一次请求，不落盘。
- 与命令行 `dsh plugin exec dsh-connect-comate check` **共用同一份实现**（`src/check.ts`），两边不会给出不一致的结论。
- 探测用「启用中的第一个模型」（没有勾选任何模型时即目录第一个），也就是你实际会用到的那条路。

## 思考等级（thinking level）

模型选择器里为 comate 模型提供思考等级：**minimal / low / medium / high**，以及选择器自带的「provider default」。

映射来自本机实测（2026-09）：上游接受整条 OpenAI `reasoning_effort` 词汇表；不传参数时模型**默认就在思考**（基线每次都返回 `reasoning_content`）；`reasoning_effort` 的取值会原样发给上游。

> **「关闭思考」当前做不到，因此没有提供这个选项。** `dsh-llm-pi-ai` 会把 `off` 改写成「不传该选项」（`profileOptions()`：`reasoning === 'off' ? undefined : reasoning`），所以 `off` 永远到不了 pi-ai——请求不带参数、上游保持思考开启，而选择器却显示「off」。与其给一个名不副实的开关，不如让「provider default」如实表达「不发送参数」。（实测 `reasoning_effort: 'off'` 本身确实能让 `reasoning_content` 归零，是这个中间层拦住了它。）


## 安装

前置：已安装并登录 WPS Comate 桌面客户端（插件复用其登录态，会读取 `~/.wpscomate/config.json`）。

**从 GitHub 安装（推荐）**：

```sh
dsh plugin --profile <web|desktop|dsh-tui> add github:bakasbk/dsh-connect-comate
```

仓库只提交源码（`lib/` 是构建产物，不入库），所以这一步会在克隆后自动执行 `prepare` → `tsdown`。
DSH 会把它作为**待批准的构建脚本**列出，在插件面板确认一次即可。

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
# {"signedIn":true,"providerRegistered":true,"models":[...]}

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

插件 Config（通过 profile 覆盖层 `profiles/<profile>/cordis.patch.yml` 的 `config:` 传入）：

| 设置 | 作用 |
| --- | --- |
| `wpsSid` | 手动填写的 wps_sid（www.wps.cn cookies 取值，不带前缀） |
| `cookieOnly` | 只发 Cookie 鉴权（上游报 API 密钥无效时开启） |
| `enabledModelIds` | 勾选启用的模型 id 列表；空 = 全部显示（一般用卡片勾选，不用手填） |
| `lastCatalog` | **已弃用**：宿主不再回写目录，卡片改从只读路由读取；保留字段只为让旧配置仍能通过校验 |
| `configFile` | 显式指定 config.json 路径 |

> `wpsSid` / `cookieOnly` / `enabledModelIds` 三个字段在 0.1.7 线上必须由 schema 声明为 volatile，
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

1. `node lib/bin.js doctor` —— 应显示 `valid=true` 且列出 baseUrl 与 8 个模型；`Manual wps_sid` 应为 `unset`（未填时）。
2. 填入 wpsSid 后 `node lib/bin.js check`（或 `dsh plugin exec ... check`）—— 输出 `OK` 表示上游接受凭据。
3. 安装到 DSH 并重启后，模型选择器应出现 `WPS Comate` provider 与模型列表。
4. 首次真实对话（会消耗账号额度）：选一个模型发起对话。若失败，看错误：
   - 401 `not_login` → 重新复制 wps_sid（www.wps.cn 的 cookie），确认不带前缀；
   - 仍 401 且提示密钥无效 → 开启 `cookieOnly`；
   - 400 → model id 可能需要用短名（桌面端实际请求用 `flash` 等短名，见 `~/.wpscomate/agent/logs/sidecar.log`）。

## 安全与合规

- shim 只监听 `127.0.0.1`，随机端口 + 进程内随机 secret（常量时间比对）；真实 apiKey/cookie 不交给 pi-ai 层。
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
