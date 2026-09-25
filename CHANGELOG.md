# Changelog

## 0.3.3-rc.1 (2026-09-25)

### Bug Fixes

- **图片外置（上传换 URL）：`mimo-v2.5` 发 base64 被网关拒。** 真机实测：`deepseek-v4.1-flash`、`MiniMax-M3`、`kimi-k3`、`glm-5.3-flash` 带图正常，`mimo-v2.5` 整轮失败，上游原文是 `请求参数值有误(unsupported message.content type=image)`（`PI_AI_ERROR`）。用插件自己的真实链路对 5 个模型 × 三种图片形状跑矩阵，定位到：mimo 的**多模态路由是通的**（日志里出现 `route=llm-multimodal-xiaomi-mimo-v2.5`），只是**不收 inline base64**——同一张图换成 URL 载荷就成功。既然桌面端对所有模型都先上传换预签名 URL，URL 才是这条链路的标准形状，base64 只是碰巧对 4 个模型可用。新增 `src/assets.ts`：

  - 复刻桌面端的 `assets/presign-upload` → ks3 PUT → `presign-download` 三步（同一套接口、同样只带 Cookie）；
  - 按**内容哈希**缓存（含下载 URL 到期时间）：同一张图在多轮里只上传一次，URL 临近过期只重签不重传；
  - **尽力而为**：无 Cookie / 网络失败 / 非零 code / 抛异常都退回 inline base64 继续发，请求不因此失败；上传器在 shim 里抛异常也只写 warn，不冒泡；
  - 归一化与外置**分两遍**且顺序固定（先同步归一化收成一种形状，再异步外置），因为「网关不认的形状」不该先花一次网络往返；
  - 无条件外置（不按模型名匹配），但保留降级——`mimo-v2.5` 修好，其余 4 个的降级路径不变。

### Tests

- 测试 158 → 185 例（+1 例真机验收，默认跳过）。新增 `tests/assets.spec.ts`（16 例：三步请求形状、Cookie、缓存命中、临近到期重签、失败降级、非零 code、抛异常）与 `tests/multimodal-live.spec.ts`（`WPS_COMATE_LIVE=1` 门控的 5 模型真机矩阵）；`tests/adapter-attachments.spec.ts` 与 `tests/multimodal.spec.ts` 补外置接线与计数（含「上传器抛异常请求照发」）。
- 新增 `scripts/verify-installed.mjs`（`pnpm run verify:installed`）：直接 import **已构建的 lib/** 跑同一个矩阵——源码绿 ≠ 产物绿（0.3.2 就是这么翻车的）。
- 新增 `scripts/verify-shim-live.mjs`（`pnpm run verify:shim`）：**真的把 shim 起在 127.0.0.1 上**、用真凭据打一次 HTTP（DSH → pi-ai → shim → adapter → 上游的接缝，前两个脚本直接调函数、验不到这层），并断言 shim 的计数是 `externalized=1 upload_failed=0`。对安装产物跑：5/5。
- **验收断言自身修正**：第一版只断言「有正文」，结果安装产物矩阵里 MiniMax 回了「I attempted to read the image file …, but …」也被判通过。改用**左红右蓝两色图**、要求两色都答出：取不到图的模型会明确失败，而不是留下一条看似正常的话。
- 真机验收（2026-09-25）：源码树与安装产物各跑一次，均 5/5（两色都答对，出站载荷均为 `url`、`ext=1 fail=0`）。针对性对照：同一张两色图，MiniMax 在 URL 与 base64 下都答对；`mimo-v2.5` 在 URL 下答对、在 base64 下报 `unsupported message.content type=image`。

### Packaging

- 版本 0.3.3 → **0.3.3-rc.1**（0.3.3 从未发布，只在本机覆盖过；这条线按 RC 计。注：按 semver，`0.3.3-rc.1` 的排序低于 `0.3.3`，发布时若仍要 0.3.3 作正式版，这就是它的最后一个预发布）。

## 0.3.3 (2026-09-25)

> 未发布：只在本机 desktop profile 覆盖安装过（版本号分开是为了区分机器上装的是哪一份）。

### Bug Fixes

- **图片输入真的通了：0.3.2 只修了编码，没修装配。** 真机报 `pi-ai image input requires the durable attachment service` / `UNSUPPORTED_CONTENT`，**任何带图片的请求整轮失败**，纯文本照常。根因在 `createComateAdapter` 构造 `PiAiAdapter` 时漏了两个钩子：pi-ai 的 context builder 只能通过**宿主的 durable attachment service**（`readImageRequest`）拿到图片字节，没有它就走 text-only 回退分支并抛错。0.3.2 修的是「`llm_types` 数组解析」和「出站线形状」——两者都是真的、也都必要，但都在这条钩子的**下游**，所以单测全绿、真机仍然不能用。现在按宿主自己的 pi-ai provider 接上同一对：

  - `resolveAttachments: () => ctx.get('attachments')`——**惰性解析**（提供它的插件可能比本插件后挂载），缺失时打一条一次性 warn 说明「图片会失败、文本不受影响」，而不是让用户只看到一句裸的 `UNSUPPORTED_CONTENT`。
  - `resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(attachments, hostPath => ctx.get('fs')?.processPathFromHostPath(hostPath), ref)`——图片旁边那行只读路径句柄，映射到当前工具执行世界。
  - 顺带接上 `onReplayDegrade`：助手历史里出现无法表达的内容时，日志里留下「哪条路由、为什么」。
  - 类型上 `ComateAttachmentService` 从 `PiAiAdapterOptions['resolveAttachments']` **推导**，不 import 宿主的 `@deepseek-ai/dsh-attachment`：该包不在本插件依赖里（宿主自带），推导在有它的地方精确、没有它的地方退化成 `any`，不会变成一个错的形状。

### Tests

- 测试 155 → 158 例。新增 `adapter-attachments.spec.ts`：真 `PiAiAdapter` + 真 shim（真 HTTP 回环）+ 桩附件服务，只替换字节来源。三例分别钉住——**不接钩子要能一字不差复现真机报错**（控制组）、接上钩子后图片按对象形式 base64 送到转发层（断言 base64 等于宿主存的字节，且 pi-ai 插的只读路径句柄来自 `resolveImageAccess`）、正常路径零改动因此不写 warn。

### Packaging

- 版本提到 0.3.3（0.3.2 的安装产物带上述缺陷，版本号分开以便区分机器上装的是哪一份）。

## 0.3.2 (2026-09-25)

### Bug Fixes

- **图片输入真的能用了（多模态链路补齐）。** 0.3.x 之前，真机上 `llm_types` 是 **JSON 数组**（`["llm-chat", "llm-multimodal"]`），而 `parseComateModel` 只认空格分隔的字符串，于是 `llmTypes` 恒为 `undefined`——本机 10 个模型里 5 个带多模态标记的模型在 DSH 里**全部失去图片输入能力**。测试数据当时用的是字符串，所以 128 例全绿而真机功能缺失。现在数组/字符串两种形状都收，并支持 `multimodal: boolean` 覆盖字段（与桌面端 `isModelMultimodal` 同序）。

### Features

- **出站图片线形状修正（`src/multimodal.ts`）。** 本机直连 `llmproxy/v1/user/chat/completions` 实测四种形状，每种都只看模型是否答对颜色：

  | 发送形状 | 实测结果 |
  | --- | --- |
  | `image_url: { url: 'data:image/png;base64,<真 base64>' }` | HTTP 200，答对颜色，响应 id 前缀 `llm-multimodal-` |
  | `image_url: '<data URL 字符串>'`（裸字符串） | HTTP 200，答 `Unknown` —— 图片被静默丢弃 |
  | `data:image/png;base64,https://…`（假 base64 前缀套 URL） | HTTP 200，**正文为空** —— 静默失败 |
  | `data:image/svg+xml;base64,…` | HTTP 200，**正文为空** —— 静默失败 |

  结论：**真 base64 直接被网关接受**，所以插件不需要复刻桌面端的图片上传链（`assets/presign-upload` → ks3 PUT → `presign-download`）——补它是没有证据支撑的复杂度。shim 只做三件把静默失败变成可用请求的事：裸字符串归一成对象形状、假 base64 前缀剥回真实 URL、网关不认的媒体类型（如 svg）换成 `[image omitted: …]` 文字说明（直接丢会得到空正文，用户看到的是一个没有理由的空回答）。改动发生时写一条 `warn` 日志（`seen=/repaired=/stripped=/dropped=`，四个计数全量打印；只在**真的剥掉或丢掉**了图片时才触发——正常路径上 DSH 发的已经是对象形状，归一化零改动）。

  归一化挂在 `prepareChatBody` 上（新增可选的统计参数，纯诊断，不传则行为完全不变），所以命令行、卡片、shim 三条路共用同一份实现。

- **端到端复验（走插件自己的代码路径，不只 curl）。** 上一节的表是裸 HTTP 探针得出的；补全后用 `ComateCredentialStore` → `prepareChatBody` → `ComateUpstreamClient` 这条真实链路复跑：真 96×96 红色 PNG 走**裸字符串**写法发出（`stats={seen:1,repaired:1,stripped:0,dropped:0}`，即归一化确实动手了），模型答 `red`。

- **网关的图片错误形状已确认不静默。** 无效图片时网关回的是 **HTTP 200 + SSE `data: {"error":{...}}`**（原文 `模型参数有误(image data 0 failed: …)`），不是非 2xx。这条形状经实测会浮上来：pi-ai 用 openai SDK 读流，SDK 见到带 `error` 字段的分片就 `throw APIError`，pi-ai 转成 `error` 事件并**保留网关原文**。所以这一处**不需要**在 shim 里加拦截——实测结论直接否掉了一个看起来该写的补丁。

### Tests

- 测试 128 → 155 例。新增 `multimodal.spec.ts`（20 例）把上面那张表逐行钉死，并捕获 **pi-ai 真实请求体**断言编码形状：DSH 侧发出的是对象形式真 base64、本插件的归一化在正常路径上是零改动、描述符不给 `image` 时 pi-ai 会直接丢掉图片（这就是 `llmTypes` 解析错误的代价）。该文件另有一例钉住**外部契约**：`200 + SSE error` 必须变成 pi-ai 的 `error` 事件且保留网关原文（openai SDK 若改掉 `data.error` 的处理，这一例会先红，而不是等用户报「图片发了没反应」）。`auth.spec.ts` 新增数组形状回归、字符串兼容、`multimodal` 布尔覆盖；`upstream.spec.ts` 新增出站归一化与统计计数。

### Packaging

- 版本提到 0.3.2。

## 0.3.1 (2026-09-25)

### Bug Fixes

- **卡片不再回显已保存的 `wps_sid`。** 此前保存后重开卡片，已存的 sid 会明文回填进输入框（`type="text"`），截图与旁观即可直接读走凭据。现在输入框**永不从已存值播种**：已配置时占位符显示「已保存——留空保持现有值不变」，状态行的「已配置（N 个字符）」是卡片保留的唯一痕迹（只泄露长度，是刻意的诊断信息）。配套语义变化：

  - **「留空 = 保持不变」。** `writeComateSettings` 改为部分补丁语义：省略 `wpsSid` 时既不写、也不回读校验。这同时堵掉一个旧隐患——以前顺手保存模型勾选会把空字符串写进凭据字段；现在只有真的输入了新值才会写入，清空输入框再保存也不会丢凭据。
  - **新增「清除已存的 sid」按钮。** 清空是一个显式的暂存意图，走保存流程、可「撤销修改」反悔，不是点击即写。
  - **「测试连接」的回退语义。** 输入框为空时回退测已存凭据（宿主 `ComateCredentialStore` 对空覆盖值本就按「无覆盖」处理）；输入新值仍是先测再存。
  - **边界说明。** 本次关掉的是「可见泄露」（截图/旁观/录屏）；已存的 sid 仍在 settings 镜像内存与 `cordis.patch.yml` 落盘文件里——前者需宿主框架支持按字段脱敏才能根除，后者是 0.1.7 写入门的落盘目标，均为设计使然，未在本次处理。

### Tests

- 测试 125 → 128 例。`settings-write.spec.ts` 新增：补丁省略 sid 时不写、不触碰、不误报 `not-persisted`；显式空串清除只写 `wpsSid` 一个字段；未触碰字段不报 `not-persisted`。

### Packaging

- 版本提到 0.3.1（0.3.0 只发布在 GitHub、未上 npm；npm 首发将直接是 0.3.1）。
- `pnpm-workspace.yaml` 记录 `allowBuilds`：`@google/genai` / `protobufjs`（均为 pi-ai 的传递依赖）的安装脚本显式跳过——pnpm 此前每次 install 都会弹待决策提示。

## 0.3.0 (2026-09-24)

### Features

- **卡片新增「刷新模型列表」。** 宿主此前只在启动时、以及 `configFile` 变化时才重新发现模型，于是「在 Comate 桌面端刚登录/刚换账号」必须重启 DSH 才能看到新目录。新增动作路由 `POST /plugins/dsh-connect-comate/__refresh`：重读本机 Comate 配置、刷新内存快照并返回与 `__catalog` 同形状的结果。按钮放在「启用的模型」标题行的工具区，带进行中状态；未登录时给出明确提示而不是静默无变化。它**不写任何文件**——落盘仍然只发生在用户真的点保存时。

- **卡片新增「测试连接」。** 新增动作路由 `POST /plugins/dsh-connect-comate/__check`：发一次最小请求（`max_tokens: 8`、`stream: true`、单条 `ping`），把结果（成功 / HTTP 状态 / 错误分类 / 脱敏后的上游原文）回报给卡片。两处关键设计：

  - **可以测未保存的草稿 sid。** 请求体可带 `wpsSid` / `cookieOnly`，由 `ComateCredentialStore.current(override)` 只作用于那一次读取——草稿**不落盘**，也不写进 store 实例字段（否则两个并发探测会互相污染，而且「按一下测试」会悄悄改变插件实际使用的东西）。这样首次配置就能「先测再存」，不用先存一个可能错的 sid。
  - **命令行与卡片共用一份实现。** 最小请求从 `src/bin.ts` 抽到 `src/check.ts`，`dsh plugin exec dsh-connect-comate check` 与卡片按钮走同一份代码：两处各写一遍的话，「卡片测通、命令行测不通」会变成无法复现的玄学问题。

- **开放思考等级（thinking level）。** 适配器此前在 `toPiModel` 里写死 `reasoning: false`，而 `dsh-llm-pi-ai` 的 `reasoningInfo()` 在 `!model.reasoning` 时返回空对象——所以模型选择器**根本不渲染 effort 菜单**。现在声明 `reasoning: true` + `thinkingLevelMap` + `compat: { supportsReasoningEffort: true, thinkingFormat: 'openai' }`，选择器出现思考等级菜单。

  映射**全部来自本机实测**（2026-09，`llmproxy/v1/user/chat/completions`），不是猜的：

  | 结论 | 证据 |
  | --- | --- |
  | 整条 OpenAI `reasoning_effort` 词汇表都被接受 | `off` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max` 全部 HTTP 200，无一 400 |
  | 不传参数时模型**默认就在思考** | 基线每次都返回 `reasoning_content` |
  | `reasoning_effort: 'off'` 真的能关掉思考 | `reasoning_content` 归零，5 个模型（deepseek-v4-flash/-pro、MiniMax-M3、mimo-v2.5、mimo-v2.5-pro）一致 |
  | 桌面端自己发的就是 `reasoning_effort: "high"` | `~/.wpscomate/agent/logs/app.log` 的 `[cloud][chat]` 请求体 |

  提供 **minimal / low / medium / high** 四档，`xhigh` / `max` 钉 `null`（上游接受但本机无法验证它们与 `high` 的语义差别，不做没人量过的承诺）。

  - **`off` 不提供——这是一个刻意的诚实取舍。** `dsh-llm-pi-ai` 的 `profileOptions()` 会把 `off` 改写成「不传该选项」（`reasoning === 'off' ? undefined : reasoning`，`lib/index.js:1671`，输入来自 `:1847` 的 `resolveReasoningLevel(model, options.reasoningEffort ?? profile.reasoning)`）。也就是说 `off` 永远到不了 pi-ai，`thinkingLevelMap.off` 不会被查；请求不带任何 reasoning 参数，上游保持思考开启，而选择器却显示「off」。那是**对着行为撒谎**，所以 `off` 钉 `null` 不出现，真正的「不发送参数」由选择器自带的「provider default」承担。

### Tests

- 测试 77 → 125 例（11 个文件）。新增：
  - `check.spec.ts`——最小请求逐字断言（`max_tokens: 8` / `stream: true` / 单条 ping）、成功与各类失败的映射、流被释放、`safeMessage` 对 JWT / `token=` / `wps_sid=` 的脱敏与 500 字截断。
  - `client-actions.spec.ts`——两个动作的 fetch 形状（method / headers / `credentials: same-origin` / body）、路由拒绝时抛错、**探测失败时 resolve 而不是 reject**、body 可 `structuredClone`。
  - `thinking.spec.ts`——直接对**真实模型描述符**断言（不是复制一份）：`getSupportedThinkingLevels()` 恰好是 minimal/low/medium/high、不含 off/xhigh/max、未支持等级会被 clamp；并用 stub fetch 驱动 pi-ai 的 `openAICompletionsApi` 断言**线上真实字段**：选 high 带 `reasoning_effort: "high"`、选 low/minimal 逐字发送、provider default **完全不带**该字段。
  - `catalog-route.spec.ts` 扩到 23 例——三个路由的方法/回环/JSON content-type 守卫、`__refresh` 恰好调用一次且快照在刷新**之后**读取、`__check` 透传草稿字段并丢弃类型不对的字段、坏 JSON 返回 400 而非 500、响应体不含凭据。
  - `auth.spec.ts`——草稿覆盖只作用于那一次读取、空白 sid 视为未提供、`cookieOnly` 同样一次性、不干扰 setter 写入的已保存值。

### Packaging

- 版本提到 0.3.0（0.2.0 已发布）。

## 0.2.0 (2026-09-24)

### Features

- **支持 DSH 0.1.7 线，且同一个构建同时服务 0.1.5 与 0.1.7。** 这不是「多支持一个版本」的可选增强——**在 0.1.7 上插件此前根本装配不起来**：宿主侧 `apply()` 抛错、浏览器侧卡片压根不存在。参考实现与判定方法沿用 `dingminhua/dsh-connect-workbuddy@2.0.12`（MIT，Copyright (c) 2026 LaoDing）合并社区 PR #14 后确立的双线写法。

  - **根因一：settings 服务换型，`register` 消失。** 0.1.5 的 `SettingsProvider` 同时提供 `register(ns, schema, options) → SettingsScope`（`get`/`watch`/`update`）与 `installSection(owner, ns, schema, entry, hooks)`；0.1.7 换成 `SettingsForms`，**这两个方法都不存在**，取而代之的是 `configure({auto}, owner)` 加一套以 **profile 插件 entry id 为 ns** 的 `describe`/`update`/`replace`/`mutate`。而插件此前无保护地裸调用 `ctx.settings.register(...)`——`inject = ['llm','settings']` 两个服务在 0.1.7 上都存在，所以 `apply()` 会一路执行到那一行并抛 `ctx.settings.register is not a function`，**整个插件装配失败**：provider 不注册，卡片与配置页同样不存在。现在按能力探测：有 `configure` 走 0.1.7 形态，否则回落 `register`，两者都没有则记 error 后明确放弃装配（不半装配）。

  - **根因二：命名空间语义变了。** 0.1.5 的 ns 是插件自注册的 `'comate'`；0.1.7 的 `SettingsNamespace` 就是 **profile 插件 entry id**（`SettingsForms.write` 里按 `row.options.id === ns` 查表）。因此 `registerConfigurableProviders` 的 `settingsNs` 改为 `ctx.fiber.entry?.options.id ?? 'dsh-connect-comate'`（照 `dsh-llm-deepseek` 的写法），不再传死 `'comate'`。

  - **根因三：可写字段必须显式声明 volatile。** 0.1.7 的写入门先要 `volatileForm(schema)` 非空（否则 `Plugin entry "<ns>" has no volatile fields`），再要求每条写入路径 `isVolatilePath` 为真。新增 `asVolatile()`：运行时探测 `schema.volatile()`，**有则调用、无则原样返回同一个 schema 对象**。刻意不手写 `meta.volatile = true`——那会绕过 schemastery 自身的 `validateVolatileSchema` 校验，产出一个它自己都不认的 schema。

  - **根因四：0.1.7 以「活引用」交付 volatile 字段。** volatile 字段在 `apply()` 里是冻结的 `{get(): T}`，浏览器侧 settings 镜像同样如此（`dsh-client-connection` 的 `createVolatile`）。不解包时 `config.wpsSid`、`value.enabledModelIds` 会静默变成对象或 `undefined`。新增 `unwrapVolatile()` / `unwrapVolatileDeep()` 并铺到所有读取路径；交给 settings 服务的对象必须先深度解包——0.1.5 的 `installSection` 会 validate 并 `structuredClone` 整个 config，漏一处就逐字段抛错、命名空间注册不上、设置区静默消失。

  - **根因五：客户端服务与槽位都换了。** 0.1.5 提供 `ctx.settingsScope`，0.1.7 换成 `configForms`（全树 grep `settingsScope` 零命中）；0.1.5 的 `settings.plugin.item`（keyed，key = ns）在 0.1.7 **已从全树删除**，取而代之是插件管理器的 `plugins.bundle.config`（key = 包名）与 `plugins.row.config`（key = `<包名>#<rowId>`），owner props 是 `{view: 'summary' | 'page', form?}`。客户端 `inject` 收敛为 `['slots','locale']`（两条线都提供的服务），settings 表面改由 `ctx.get()` 软探测——Cordis 的依赖门是硬门，任何一个 inject 座位在运行线上不存在，`apply` 就永远不会执行。三个槽位**各自独立 try/catch**：一个槽位在某条线上不存在时，不能把另一条线的注册一起带走。

  - **根因六：折叠箭头是 value import，两线图标名不重叠**（`IconChevronDownOutline14` vs `IconChevronDownOutlineRegular`），在 0.1.7 上会渲染 `h(undefined)`。改为纯 CSS 箭头，去掉对 primitives 图标的静态依赖。

  - **运行期 schemastery 版本必须自己钉住。** 插件从自身解析路径取 schemastery（dev 目录里是 3.18.2，没有 `volatile()`），而宿主是 3.18.4。新增 `dependencies: { "@deepseek-ai/schemastery": "3.18.4" }`，并在 `pnpm-workspace.yaml` 里 override，让开发环境与用户环境解析到同一版本；`tests/runtime-deps.spec.ts` 把「本插件解析到的 schemastery 必须有 `volatile()`」钉成断言，避免这条防线再被「装到的版本恰好很旧」顺带覆盖。

  - **开发树必须与宿主同版本，否则测的不是同一份行为。** 0.1.7 线的每个包都把自己的兄弟包声明成**精确** peer（`@deepseek-ai/dsh-attachment` 就是 `0.1.7-rc.1`），而 pnpm 从 v8 起默认不安装缺失的 peer，旧 lockfile 里残留的 `0.1.5-rc.3` 又会「满足」宽范围声明——结果是直接依赖升到了 0.1.7、被依赖者仍解析到 0.1.5 线，`dsh-llm-pi-ai` 会在 0.1.7 宿主里跑 0.1.5 的 `requestImageDimensions` / `credentialRef` 等实现。新增 `pnpm-workspace.yaml` 的 `autoInstallPeers: true`，并重建 lockfile 让整棵树收敛到 0.1.7-rc.1（`cordis` 同步提到 `4.0.4`）。验证方式：从 `.pnpm` 里的**真路径**（Node 加载模块时实际使用的那条路径，不是 `node_modules/<pkg>` 这个软链）解析 `dsh-llm-pi-ai` 的每一个 peer，必须全部是 `0.1.7-rc.1`。

### Bug Fixes

- **宿主不再把模型目录写回 settings。** 0.1.5 上 `scope.update({lastCatalog})` 写的是设置文档；0.1.7 上同一个写入的目标是**用户手写的 `cordis.patch.yml`**——宿主每次发现目录变化都去重写它，会破坏该文件的注释与格式。改为新增只读路由 `GET /plugins/dsh-connect-comate/__catalog`（Host 与 Origin 双重回环校验，响应为 `{signedIn, providerRegistered, models}`，**绝不回传 wps_sid**），由卡片按需读取；`ctx.webServer` 缺失时卡片降级为「目录为空 + 明确提示」，模型服务不受影响（目录本来就直接来自本地 Comate config）。

  - `providerRegistered` 是刻意加的：provider 注册发生在 loopback 监听就绪**之后**，若那一步失败，`apply()` 早已返回、卡片照常渲染，只有一行日志记录「一个模型都选不了」。把这个状态放进响应，半装配就从静默失败变成可观测事实（顺带：由于注册失败会 `return` 而跳过 `rediscover()`，路由报告非空 `models` 本身就证明了 provider 那半确实注册成功）。

  - 路由的 disposer 挂在**注入出来的子 fiber** 上，而不是插件自己的 context：路由模式是装配级契约，同 `(kind, path)` 重复注册会抛错，而 profile 的 patch 是 live 重载的——一个没释放的旧路由会让下一次 `apply()` 直接失败。

- **设置写入改为「写入后回读校验」，失败时明确报错。** 0.1.7 的 `ConfigForm.set()` 返回 `Promise<boolean>`：`false` 表示 Host 拒绝或跳过，**resolve 也不代表值已落盘**（`cordis.patch.yml` 靠「写临时文件 + rename 覆盖」替换，Windows 上杀软、同步盘或编辑器会短暂锁住它；重试耗尽后失败以「不成功的响应」回到客户端，而 scope 的 `mutate()` 对此只是重新加载 Host 状态然后正常返回）。卡片此前只看 promise 是否 resolve，于是会**看起来保存成功、随后静默复原**。新增 `writeComateSettings()`：`set()` 返回 `false` 直接抛 `refused`；写入后把值读回，读不回即抛 `not-persisted` 并指出字段。

- **设置页面的通用表单被关掉（`configure({auto: false})`）。** 插件自带卡片，若同时让框架为该命名空间再生成一个通用表单，`wps_sid` 会被当普通字符串明文渲染成文本框。照 `dsh-llm-deepseek` 的做法显式声明 `auto: false`。

### Tests

- 新增 5 个 spec：
  - `runtime-deps.spec.ts`——本插件解析到的 schemastery 必须有 `volatile()`（0.1.7 写入门的先决条件）。
  - `bridge.spec.ts`——`asVolatile()` 两条分支各自被确定性断言；`unwrapVolatile()` / `unwrapVolatileDeep()` 递归剥净（含嵌套与数组）且不就地改写调用方对象。
  - `settings-compat.spec.ts`——**两种 settings 形态各一例**：0.1.7 形态（有 `configure`、无 `register`/`installSection`）下必须装配成功、`configure({auto:false})` 被调用、`registerAdapter` 与 `registerConfigurableProviders` 均注册且 `settingsNs` 取真实 entry id；0.1.5 形态（有 `register`、无 `configure`）下必须继续走 `register`，且传给它的 `base` 里不含任何活引用；两种方法都没有时必须不抛错且不注册。
  - `settings-write.spec.ts`——`set()` resolve `false` 抛 `refused`；回读不符抛 `not-persisted`；活引用形状（`{get()}`）下能正确读回，且写入 payload 里不出现函数。
  - `catalog-route.spec.ts`——非 GET 返回 405；非回环 Origin/Host 返回 403；回环请求返回 200 且 body 只含 `{signedIn, providerRegistered, models}`（断言不含 `wpsSid`）。

  > 为什么「两种形态各一例」是必须的：只测一条线的套件在另一条线坏掉时不会变红——这正是双线改造最容易穿过评审与 CI 的地方。

### Docs

- 本条目记录 0.1.7 的六处差异（settings 换型、ns 语义、volatile 声明、活引用、客户端服务与槽位、图标名）与其判定方式，供后续 DSH 升级时对照。

### Packaging

- **发布到 GitHub 仓库**（<https://github.com/bakasbk/dsh-connect-comate>）：`package.json` 补 `repository` / `homepage` / `bugs`。
- **新增 `prepare` 脚本**，使 `dsh plugin add github:bakasbk/dsh-connect-comate` 在克隆后能自动构建出 `lib/`（仓库只提交源码，`lib/` 仍被 `.gitignore` 忽略）。DSH 会把这次构建列为待批准脚本，装的人确认一次即可；本地 `pnpm install` 之后也会跟一次构建。
- **新增 `THIRD_PARTY_NOTICES.md`**：收录 `dingminhua/dsh-connect-workbuddy`（MIT, Copyright (c) 2026 LaoDing）与 `corrinehu/dsh-workbuddy-connect`（MIT, Copyright (c) 2026 Corrine Hu）的许可原文与版权声明。此前 `LICENSE` 里只有一段致谢摘要——MIT 要求随分发保留上游的版权声明与许可原文，摘要不能替代。
