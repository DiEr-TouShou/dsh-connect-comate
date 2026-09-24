# Changelog

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
