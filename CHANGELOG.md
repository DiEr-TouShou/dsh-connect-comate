# Changelog

## 0.4.1-rc.1 (2026-09-25)

> 输出上限从「一个数管所有模型」变成**逐模型**：同一个路由上的模型各用各的上限。
> 向后兼容——`maxOutputTokensByModel` 缺省为空表，老配置与老卡片行为一字不变。
> 已打 tag `v0.4.1-rc.1`；安装：`github:DiEr-TouShou/dsh-connect-comate#v0.4.1-rc.1`。未上 npm。

### Features

- **每个模型可以单独设输出上限。** 卡片「启用的模型」里每个模型右侧多一个上限输入框。解析优先级四层：`WPS_COMATE_MAX_TOKENS`（env，最高，无头脚本与验收脚本靠它压过本机卡片）> `maxOutputTokensByModel[modelId]`（这个模型自己的条目）> `maxOutputTokens`（全局默认值）> 插件默认 32000。保存即生效，无需重启。

  **「留空」与「填 0」是两件事**，这是这一版最容易做错的地方：留空 = 这个模型**没有条目**、跟随全局默认值（框里的灰字就是当前那个数），填 `0` = 这个模型**不设上限**（出站不带 `max_tokens` 字段，交给上游）。所以撤销一条覆盖就是清空那个框，界面里不需要第二个「复位」控件。整张表按 `maxOutputTokensByModel` 一次性写回，空框不进表——设置文档里不会留下空串，`0` 也不会被当成假值吃掉。

- **逐模型解析真的落在 harness 唯一会读的那个字段上。** `configuredMaxTokens` 现在按模型给条目，模型描述符的 `maxTokens` 也按模型算（`resolveModel(modelId)` 那条路径），两者由**同一次**解析喂出来。不设上限的模型**整条缺席**而不是记成 `0`：这一层的 `0` 会被 harness 原样物化成 `max_tokens: 0`，而 pi-ai 在 `defaultMaxTokens` 上要的是正整数——缺席才是「这个模型不设上限」，并且只影响它自己，邻居的条目照旧。

- **一条坏条目不再毒化整张表。** `parseMaxTokensByModel` 逐条校验（非负安全整数），坏条目丢掉、其余照用——而不是整张表一起回落到默认值。`unusableModelTokens` 把「丢的是哪个模型、原值长什么样」交出去给宿主打日志：否则用户在卡片里只看到一个空框，和「从没设过」长得一模一样。解析只报**优先级最高**的那条坏值（env 坏就报 env），免得用户去改一条根本不起作用的条目。

### Bug Fixes

- **`verify:card` 的 jsdom 环境里 React 一直跑在「无 DOM」模式**（脚本自身的 bug，不影响插件产物）：react-dom 在**模块加载那一刻**就用 `window` / `document` 判断自己在不在浏览器里，而脚本是先 `require('react-dom')`、后铺全局。于是它挑了老 IE 那套 `change` / `propertychange` 监听而不是 `input`——`click()` 与勾选框照常能用（所以原有 17 条一直绿），但**往输入框里敲字没人接**。现在先建 JSDOM、先铺全局、再 require react-dom，`input` 事件按浏览器里的样子派发。这个 bug 只有在新断言要求「敲字」时才暴露：修复前 39 条里 10 条红，且全红在这一处。

### Tests

- 测试 257 → 280 例。`max-tokens.spec.ts` 23 → 37：逐模型解析、坏条目只丢自己不丢别人、env 压过每模型条目、坏值报出模型名、`configuredMaxTokens` 按模型给条目、真 adapter 上两个模型各拿各的 `defaultMaxTokens`（含「不设上限的那个是 `undefined`」）。`settings-write.spec.ts` 31 → 40：整表写回、清空即删键、`0` 原样落盘、留空的模型不产生键。
- `verify:card` 17 → 39 条断言：新增七组——每模型一格的默认空态与占位符（占位符必须是当前全局默认值）、设一个模型的上限后保存/退出/再进入、`0` 原样落盘、清空即删覆盖、非法值禁用保存并提示、外部改动对「碰过 / 没碰过」两种草稿的分别处理、撤销修改把每模型草稿一起还原。
- 真机验收（`WPS_COMATE_LIVE=1`）：`max-tokens-live.spec.ts` 新增一条——同一个路由上两个模型，一个 `16` 一个不设上限，断言 harness 从 `resolveModel()` 读到的 `defaultMaxTokens` 一个是 `16`、另一个**是 `undefined`**，然后把这个值真发出去：被限的那个出站 body 里 `max_tokens: 16` 且上游真的截断（`reason = max-tokens`），不设上限的那个 body 里**没有** `max_tokens` 且真的数到了 100 以上——即「逐模型」在线上成立，而不是只有对象字段对。
- 产物验收：`verify:installed`（5 模型图片矩阵 5/5 OK）、`verify:shim`（真凭据、真网关、HTTP 全链路 1/1 PASS）都在这一版的构建产物上跑过。

### Packaging

- 版本 0.4.0 → 0.4.1-rc.1（功能上是小版本，但按你的要求走 rc 线）。

## 0.4.0 (2026-09-25)

> 从这一版起，凭据不再明文躺在 DSH profile 里。0.4.0 = 0.3.3 之后的**全部**改动：
> `0.3.4-rc.1`（输出 token 上限可配置）+ `0.4.0-rc.1` / `rc.2` / `rc.3`（凭据密文，以及两条真机修复）。
> 已打 tag `v0.4.0` 并推 origin；安装：`github:DiEr-TouShou/dsh-connect-comate#v0.4.0`。未上 npm。
> 每条改动的完整推理与验收记录在下面四条 rc 条目里，这里只列入口。

### Features

- **`wps_sid` 密文落盘（`enc:v1:`）** —— 信封 = `enc:v1:` + base64url(IV ‖ tag ‖ 密文)，AES-256-GCM；钥匙是 `~/.wpscomate/dsh-connect-comate/secret.key` 里的 32 字节随机数，经 HKDF-SHA256 用**本机指纹**（平台+架构+主机名+用户名）派生。所以「同步了 profile、没同步密钥」的结果是**读不出来并明确报错**，而不是静默用一个别人的凭据。0.4 之前的明文值继续可用，卡片打开时自动就地升级（**明文一次都不经过浏览器**）。细节与状态机（`unset` / `plaintext` / `sealed` / `unreadable`）见 `0.4.0-rc.1`。
- **卡片里的 `wps_sid` 变成密码框**：只显示圆点，复制/剪切/拖拽/右键四个事件全拦；没有「显示明文」开关。状态行能说出「密文在，但本机解不开」——这个判断浏览器做不了（密钥丢了之后的密文和健康的密文逐字节一样），由宿主的目录路由带出来。
- **输出 token 上限变成可配置的**（`0.3.4-rc.1`）：`WPS_COMATE_MAX_TOKENS` > 卡片设置 > 默认 32000，`0` 是一条独立语义（不发 `max_tokens` 字段，交给上游）。改完保存即生效。
- **CLI 新增 `seal` 子命令**；`doctor` 新增 `wpsSidStorage` / `wpsSidProblem` / `wpsSidKeyFile`（都是**路径**，永远不是密钥本身），并按状态给不同的修复 hint。

### Bug Fixes

- **坏掉的信封不再被当成明文 sid 用**（`0.4.0-rc.2`）：按**前缀**分流，`enc:v1:` 开头但载荷被改坏的值如实报 `malformed`——此前它会落进「明文」分支被当凭据发出去，用户看到的是一句莫名其妙的 401。同时拒绝把坏密文「升级」再加密一次（那等于把仅存的一份密文换成对垃圾的加密，把「可恢复」变成「永久损坏」）。
- **「启用的模型」不再一进来就全不勾**（`0.4.0-rc.3`）：重新播种草稿的 effect 把「用户碰过没有」的判断读进了 `setDraft*` 的**惰性 updater**，而它读的 ref 已被同一次 effect 改写——判断永远答「碰过」，草稿永远不重新播种。目录比卡片挂载晚到（冷启动即如此）或存的是 `[]`（「全部模型」哨兵）时，勾选一排全空，退出设置再进来还是空。同一处也压着上限输入框与 cookie 开关。

### Tests

- 测试 **158 → 257 例**（17 个文件，另 2 例真机验收默认跳过）。四条 rc 各自的新增见下；主要几块：`catalog-route.spec.ts`（35）、`settings-write.spec.ts`（31）、`multimodal.spec.ts`（28）、`max-tokens.spec.ts`（23）、`auth-rest.spec.ts`（16）、`auth.spec.ts`（16）、`secret.spec.ts`（15）。
- 验收脚本四条：`verify:sid-cipher`（密文链路状态矩阵，不碰真实凭据）、`verify:card`（jsdom 里跑**真渲染产物**，钉卡片勾选状态机；在修复前的代码上 12/17 红）、`verify:installed`、`verify:shim`（真凭据、真上游、HTTP 全链路）。

### Packaging

- 版本 0.4.0（同日三条候选：rc.1 → rc.2 → rc.3）。
- devDependencies 增加 `jsdom` + `react-dom`（只给 `verify:card` 用；运行时不需要）。

## 0.4.0-rc.3 (2026-09-25)

### Fixes

- **「启用的模型」不再一进来就全不勾。** 卡片里三个「外部改动重新播种草稿」的 effect，把「用户碰过这个草稿没有」的判断写在了 `setDraft*` 的**惰性 updater** 里，而它读的那个 ref 就在同一次 effect 的下一行被改写——React 要到下一次渲染才跑那个 updater，那时 ref 已经是新值，判断永远答「碰过」，草稿永远不重新播种。后果最刺眼的一处正是模型勾选：目录路由比卡片挂载晚到（每次冷启动都是这样）或存的是 `[]` 这个「全部」哨兵时，`useState` 播种出来的空草稿**再也不会被填回去**，界面上一排空框——退出设置再进来，看到的还是空框。同一个 bug 也压着上限输入框与 cookie 开关：从另一个界面改了值，卡片里的草稿不会跟。现在三个 effect 都先把旧值取进局部变量、再写 ref，惰性 updater 只读那个局部变量。

  判定方式也一并换掉了：原来拿「把 id 拼成字符串」当草稿指纹，顺序一变就被判成「用户碰过」并永久冻结；现在按集合成员比较（`sameIdSet`），同一个集合换个顺序仍然算没碰过。

  这个 bug 是**渲染结果**层面的：类型检查看不到，纯函数单测也看不到（它测的是函数，而这里错的是 hook 之间的时序）。所以补的是下面那条真渲染验收。

### Tests

- 新增 `scripts/verify-card-selection.mjs`（`pnpm run verify:card`）：在 jsdom 里加载**宿主实际下发的** `lib/client.js`，按用户的操作序列驱动它——打开、取消勾选、保存、退出、再进入——断言 DOM 上的勾选状态与汇总行。17 条断言覆盖「目录晚于快照 / 快照晚于目录」两种到达顺序、`[]` 哨兵、全勾归一化成 `[]`、目录路由 500 后刷新、以及外部改动对「碰过 / 没碰过」草稿的两种处理。**在修复前的代码上跑，12 条失败**（含用户报的那条）；修复后 17 条全绿。
- devDependencies 增加 `jsdom` + `react-dom`（仅这条脚本用）。若本仓库的 `node_modules` 承载不了它们（它可能是指向已安装 profile 的链接，普通 `pnpm install` 会重建那棵被链接的树），用 `DSH_COMATE_CARD_DEPS` 指向别的目录即可。

## 0.4.0-rc.2 (2026-09-25)

### Fixes

- **坏掉的信封不再被当成明文 sid 用。** rc.1 用严格信封判定来分流，于是 `enc:v1:` 开头、载荷却被改坏的值落进了「明文」分支——插件会把它当作凭据发给上游，用户看到的是一个**莫名其妙的 401**，而不是「你的设置值坏了」。现在按**前缀**分流：没有前缀才是 0.4 之前的明文（那些值都以 `V02…` 开头，不可能撞上前缀），有前缀就交给 `openSecret` 如实报 `malformed`。
- **坏掉的密文拒绝被「升级」。** 明文升级路径原本只看严格信封判定，于是被改坏的密文会被当成明文**再加密一次**——那等于把仅存的一份密文换成对垃圾的加密，把「可恢复」变成「永久损坏」。现在只要带前缀就拒绝，并明确提示「重新粘贴 sid，不要再加密」。

两条都是**安装产物验收脚本**（新增 `scripts/verify-sid-cipher.mjs`）先报出来的，源码树的单测当时是全绿的——因为它测的是函数，而这两处是「同一个函数在边界输入下走了哪条分支」。

### Notes

- `auth-failed` 的含义补一句：GCM 认证失败**分不出**「载荷被篡改」和「钥匙不对」（AEAD 的固有性质），所以这两种情况共用同一个原因码；`malformed` 只表示字符串结构本身不成立（前缀/编码/长度）。

### Tests

- 测试 255 → 257 例：新增两条 `auth-rest.spec.ts`（坏信封报 `malformed` 且不吐出 sid、坏信封拒绝 `sealStored`）。
- 新增 `scripts/verify-sid-cipher.mjs`（`pnpm run verify:sid-cipher`）：直接 import 已构建的 `lib/`，用临时密钥文件跑完整链路——明文可读、往返逐字节一致、设置文档里没有明文、两次加密密文不同、四种「解不开」的成因各自可分辨、`doctor` 只报路径不报密钥、升级路径的两条拒绝条件。**全程不碰真实凭据与真实密钥文件。**

## 0.4.0-rc.1 (2026-09-25)

### Features

- **`wps_sid` 不再以明文落盘，改为密文保存（`enc:v1:`）。** 之前这个凭据是以明文躺在 DSH profile 的 `cordis.patch.yml` 里的——那个文件会被同步、备份、进仓库、贴进 issue。现在它是一串密文，解开的钥匙在**另一个目录树**：密钥文件（默认 `~/.wpscomate/dsh-connect-comate/secret.key`，POSIX 0600）里的 32 字节随机数当 HKDF-SHA256 的 IKM，**本机指纹**（平台 + 架构 + 主机名 + 用户名）当 salt，派生出 AES-256-GCM 的 key，密文里带随机 IV 与认证标签。所以「同步了 profile、没同步密钥」的结果是**读不出来并明确报错**，而不是静默用一个别人的凭据。

  实现落在 `src/secret.ts`（新）：`sealSecret` / `openSecret`，信封格式 `enc:v1:` + base64url(IV ‖ tag ‖ 密文)；结构性错误（前缀/编码/长度不成立）报 `malformed`，密钥文件缺失或不可用报 `key-missing` / `key-unreadable`，GCM 认证失败报 `auth-failed`（AEAD 分不出「载荷被篡改」和「钥匙不对」，两者共用这个码）——**分开**的理由：前者是「值坏了」，后者是「值好好的但你打不开」，用户要做的事完全不同。密钥文件首次使用时原子创建（`wx` + 临时文件重命名），文件权限按 POSIX 收紧到 0600。

  `src/auth.ts` 的存储层相应分成四种状态而不是一个布尔：`unset` / `plaintext`（0.4 之前写的值，仍可读）/ `sealed` / `unreadable`。`plaintext` 是**升级路径**：旧值继续能用，卡片打开时自动就地升级；`unreadable` 是必须显式告诉用户的失败——把这两者都塌缩成「已设置」，就是「密钥文件坏了」变成「莫名其妙的 401」的原因。

- **卡片里的 `wps_sid` 变成密码框：只显示圆点，且不可复制。** `type="password"` 只决定怎么画，浏览器照样允许复制、剪切、拖拽，所以 `onCopy` / `onCut` / `onDragStart` / `onContextMenu` 四个事件都被拦掉（`blockClipboard`）。`autoComplete="new-password"`（不是 `off`）才是真正让密码管理器不再提示保存、也不把已存的凭据自动填进来的写法。没有「显示明文」开关——这个值本来就不该被看第二眼。

- **明文自动升级，且明文不进浏览器。** 卡片打开时若发现存的是明文，会走新增的宿主路由 `POST /plugins/dsh-connect-comate/__seal`（`{ fromStored: true }`）：**宿主把它自己手上已有的值加密**，只把密文回给卡片，卡片再通过普通的设置写入路径存下去。所以升级过程中明文一次都没有经过浏览器。失败会显示原因，并在状态行旁留一个可重试的按钮，而不是循环重试。

- **卡片状态行能说出「密文在，但本机解不开」。** 这个判断浏览器做不了——密钥文件丢了之后的密文和健康的密文**逐字节一样**，光看字符串只能得出「已加密」。所以宿主的目录路由（`GET …/__catalog`）多带两个字段：`sidStorage`（四种状态之一）和 `sidProblem`（打不开的原因）。卡片优先信宿主，宿主没发话（老宿主、无 web 路由）才退回看字符串前缀——而这个方向的误差只会是「把密文说成未配置」，永远不会把明文说成密文。`unreadable` 在界面上是**警告**而不是「已配置」：凭据在，但用不了，不报的话用户第一次看到的就是上游莫名其妙的 401。

- **CLI 加了 `seal` 子命令**，以及 `doctor` 的新字段 `wpsSidStorage` / `wpsSidProblem` / `wpsSidKeyFile`（是**路径**，永远不是密钥本身）。`doctor` 按状态给不同的 hint：明文→怎么升级；打不开→密钥文件在哪、用 `WPS_COMATE_SECRET_KEY_FILE` 指到正确的那个。

### Notes

- 加密是**对「文件被搬走」的防护，不是对「本机被攻破」的防护**：密钥文件就在同一个用户的 home 下，任何能以该用户身份执行代码的人都能解开。这是刻意的取舍——用 OS keychain 要引入原生依赖或平台 API，用主密码则要求每次无人值守运行前先解锁。README 里写明了这个边界，免得把它当成比实际更强的保证。
- 换机器 / 换用户名 / 换密钥文件后，已存的值解不开（`auth-failed`）。重新粘贴一次即可；旧密文不会被覆盖成垃圾，`doctor` 会指认是哪个密钥文件对不上。
- 环境变量 `WPS_COMATE_SID` 的值**不参与**升级：那是一次性的 shell 覆盖，不是用户要求持久化的凭据，把它加密写回设置文档等于擅自落盘。`sealStored` 在这种情况下明确拒绝。

### Tests

- 测试 214 → 255 例。新增 `tests/secret.spec.ts`（15 例）：信封往返、密文里不含明文、同一明文两次加密的密文不同（IV 随机）、**逐字节篡改载荷必然被 GCM 拒绝**（不是「解出来是乱码」而是抛错）、结构坏 vs 环境坏的分流、密钥文件权限与原子创建、指纹变化导致 `auth-failed`。
- 新增 `tests/auth-rest.spec.ts`（14 例）：四种存储状态、明文兼容读、密封值往返进 cookie、**换了密钥文件后仍然返回配置里的 cookie 而不是整体失败**、密钥文件被删报 `key-missing` 且不会被重新创建、`sealStored` 的拒绝条件（已密封 / 只有 env）、密钥文件优先级（显式 > env > Comate home 默认）、`doctor` 各状态的 hint 与 `wpsSidProblem`。
- `tests/catalog-route.spec.ts` 补 `__seal` 路由与存储状态下发（35 例）：成功只回密文、失败 500 而**不落明文**、失败信息里的 token-like 片段仍被 `safeMessage` 脱敏；以及目录路由带上 `sidStorage`/`sidProblem`（无 verdict 时字段**缺席**而非 `undefined`、没有凭据存储的部署两个字段都不出现、探测抛错时目录照常返回、refresh 路由共用同一个快照构造器）。

## 0.3.4-rc.1 (2026-09-25)

### Features

- **输出 token 上限变成可配置的**（之前是写死的 32000，且**根本没发到上游**）。卡片新增「输出 token 上限」输入框：正整数为每个回答的上限，`0` 表示不限制（交给上游），留空/非法值则禁用保存并提示——不会把默认值偷偷写回去。改完保存即生效，无需重启。

  实现落在 `src/max-tokens.ts`（新）：解析与优先级（`WPS_COMATE_MAX_TOKENS` > 设置里的 `maxOutputTokens` > 默认 32000），非法值当作「没写」并留痕供调用方打日志；`0` 是一条独立的语义（不是「空」）。宿主侧把结果接到 `RouteCatalog.configuredMaxTokens`，即 harness 真正会读、并物化成请求 `max_tokens` 的那条缝；同时在 pi-ai 的 compat 里**显式声明 `maxTokensField: 'max_tokens'`**。

  为什么之前那个 32000 不起作用（已核过代码）：pi-ai 只在 per-call `options.maxTokens` 存在时才写该字段，而该值来自 harness 的 `defaultMaxTokens` ← `configuredMaxTokens`，此前传的是**空 Map**；描述符上的 `maxTokens` 只被当作思考预算的 ceiling。所以旧状态的 32000 只影响 UI 容量页占位与压缩预留，请求里连字段都没有。

### Tests

- 测试 185 → 214 例（+1 例真机验收，默认跳过）。新增 `tests/max-tokens.spec.ts`（23 例）：解析规则（含 `0` vs 空串、负数/小数/超界/非数字、env 覆盖与留痕）与**接线**——刻意用真的 `PiAiAdapter` 走 `resolveModel()` 断言 `defaultMaxTokens`，因为那是 harness 唯一会读的字段名，断言我们自己的中间对象证明不了任何事。`tests/settings-write.spec.ts` 补 6 例：上限的写入顺序、显式 `0` 不被当作清空、静默回退会被 `not-persisted` 抓住、未改动的字段不被重置、以及坏值不会被送进 schema。
- 新增 `tests/max-tokens-live.spec.ts`（`WPS_COMATE_LIVE=1` 门控）：真适配器 → 真 shim（HTTP 回环）→ 真网关，只包一层上游客户端以读取转出去的 body。断言 `max_tokens` 这个**字段名**（声明错了的表现是「请求成功、上限无效」，纯单测看不出来）、上游真的截断（`finish.reason.kind === 'max-tokens'`）、以及 `0` 时字段根本不出现且同一题面能真的数到 100 以上。
- 真机验收（2026-09-25，`WPS_COMATE_LIVE=1 npx vitest run tests/max-tokens-live.spec.ts`）：**PASS**。`max_tokens: 16` 出现在出站 body、无 `max_completion_tokens`、`reason=max-tokens`；`0` 时 body 里无该字段、`reason=stop`、正文数过 100。

### Docs

- README：卡片说明补「输出 token 上限」；环境变量表补 `WPS_COMATE_MAX_TOKENS`；Config 表补 `maxOutputTokens`；volatile 字段清单从三个改成四个。

## 0.3.3-rc.2 (2026-09-25)

> 相对 0.3.3-rc.1 **无代码改动**，只改仓库元数据。`v0.3.3-rc.1` 已经推送到公开仓库，选择不去改写已发布的 tag，另起一个号。

### Chores

- **仓库迁到 `DiEr-TouShou/dsh-connect-comate`**（原 `bakasbk/dsh-connect-comate` 保留为 `upstream` remote）。`package.json` 的 `repository` / `homepage` / `bugs` 与 `README.md` 的安装命令同步改指新仓库；CHANGELOG 中的历史条目按原样保留（它们记录的是当时的事实）。
- README 安装段补一句：可用 `#v0.3.3-rc.2` 固定版本安装。

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
