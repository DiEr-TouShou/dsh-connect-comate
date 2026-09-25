/**
 * 卡片状态机验收：「启用的模型」的勾选状态（在 jsdom 里跑**真实构建产物** `lib/client.js`）。
 *
 * 为什么单开一个：卡片是跑在两个异步源上的状态机——设置快照（已保存的选择）和目录
 * 路由（要画的模型）。这两个源谁先到不确定，而「草稿什么时候该被重新播种、什么时候
 * 该保留用户手上的改动」是类型检查和纯函数单测都看不见的一层。0.4.0-rc.2 的漏就是
 * 这样：重新播种的 effect 把「用户碰过没有」的判断读进了 `setDraft*` 的**惰性
 * updater**，而它读的那个 ref 在同一次 effect 里已经被改写——判断永远答「碰过」，
 * 草稿永远不重新播种。于是目录比卡片挂载晚到、或存的是空数组这个「全部」哨兵时，
 * 界面上**一个勾都没有**。
 *
 * 所以这里加载宿主实际下发的那个文件，按用户的操作序列驱动它——打开、勾选、保存、
 * 退出、再进入——断言 DOM 上看到的东西。勾选状态是渲染结果，只有真渲染才看得见。
 *
 * 用法：
 *   pnpm run build && pnpm run verify:card
 *
 * 默认验本仓库的构建产物；`COMATE_PLUGIN_DIR` 可指到**安装产物**（与 `verify:sid-cipher`
 * 同一约定）——「源码绿 ≠ 产物绿」，而卡片这条尤其要看产物：宿主下发的就是那个文件。
 *
 * `jsdom` + `react-dom` 是 devDependencies，默认从本仓库的 `node_modules` 解析。若
 * 这棵树承载不了它们（仓库的 `node_modules` 是指向已安装 profile 的链接，普通
 * `pnpm install` 会重建那棵被链接的树），把 `DSH_COMATE_CARD_DEPS` 指向任何一个装好
 * 了它们的目录即可：
 *
 *   COMATE_PLUGIN_DIR=<插件安装目录> \
 *     DSH_COMATE_CARD_DEPS=/path/to/scratch pnpm run verify:card
 *
 * 退出码 0 = 全部通过。
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const pluginDir = process.env.COMATE_PLUGIN_DIR
const BUNDLE = pluginDir === undefined || pluginDir === ''
  ? new URL('../lib/client.js', import.meta.url)
  : pathToFileURL(join(pluginDir, 'lib', 'client.js'))
const require_ = createRequire(import.meta.url)

/** 解析 jsdom/react-dom：先 `DSH_COMATE_CARD_DEPS`（若给了），再本仓库的树。 */
function loadDomDeps() {
  const override = process.env.DSH_COMATE_CARD_DEPS
  const roots = override === undefined || override === ''
    ? [require_]
    : [createRequire(join(override, 'index.js')), require_]
  let lastError
  for (const requireFrom of roots) {
    try {
      return {
        JSDOM: requireFrom('jsdom').JSDOM,
        React: requireFrom('react'),
        ReactDOMClient: requireFrom('react-dom/client'),
        act: requireFrom('react-dom/test-utils').act,
        requireFrom,
      }
    } catch (error) {
      lastError = error
    }
  }
  console.error('需要 jsdom + react-dom（devDependencies）。')
  console.error('先跑 `pnpm install`，或用 DSH_COMATE_CARD_DEPS 指到装好了它们的目录。')
  console.error(`最后一次解析失败：${lastError instanceof Error ? lastError.message : String(lastError)}`)
  process.exit(2)
}

/** 断言计数与失败清单。 */
const failures = []
let checks = 0

/** 记一条期望；失败不中断，最后一起报。 */
function expectEqual(label, actual, expected) {
  checks += 1
  const pass = JSON.stringify(actual) === JSON.stringify(expected)
  if (!pass) failures.push(`${label}\n      期望 ${JSON.stringify(expected)}\n      实际 ${JSON.stringify(actual)}`)
  console.log(`   ${pass ? 'ok  ' : 'FAIL'} ${label}`)
}

/** 假宿主目录路由答的模型清单（顺序即界面顺序）。 */
const CATALOG = [
  { id: '600085158/deepseek/deepseek-v4-flash//public', name: 'deepseek-v4-flash', multimodal: false, contextWindow: 1000000 },
  { id: '600085158/deepseek/deepseek-v4-pro//public', name: 'deepseek-v4-pro', multimodal: false, contextWindow: 1000000 },
  { id: '600085158/deepseek/deepseek-v4.1-flash//public', name: 'deepseek-v4.1-flash', multimodal: true, contextWindow: 1000000 },
  { id: '600085158/minimax/MiniMax-M3//public', name: 'MiniMax-M3', multimodal: true, contextWindow: 1000000 },
  { id: '600085158/moonshot/kimi-k3//public', name: 'kimi-k3', multimodal: true, contextWindow: 1000000 },
]
const IDS = CATALOG.map(model => model.id)
const KIMI = IDS[4]

let catalogAnswer = () => ({ ok: true, models: CATALOG })

// ---------------------------------------------------------------- jsdom + React
// `requireFrom` 与 DOM 依赖同源，这样 bundle 自己那句 `require('react')` 拿到的就是
// react-dom 渲染用的那一个 React 实例——两份 React 会让每个 hook 调用都失败。
const { JSDOM, React, ReactDOMClient, act, requireFrom } = loadDomDeps()

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'https://dsh.invalid/',
  pretendToBeVisual: true,
})
const { window } = dom
for (const key of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'location']) {
  try { globalThis[key] = window[key] } catch { /* 只读全局（navigator） */ }
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

globalThis.fetch = async (url) => {
  const href = String(url)
  if (href.includes('__catalog')) {
    const answer = catalogAnswer()
    if (!answer.ok) return { ok: false, status: 500, json: async () => ({}) }
    return { ok: true, status: 200, json: async () => ({ models: answer.models, sidStorage: 'sealed' }) }
  }
  if (href.includes('__seal')) return { ok: true, status: 200, json: async () => ({ sealed: 'enc:v1:x', length: 3 }) }
  if (href.includes('__refresh')) {
    const answer = catalogAnswer()
    return { ok: true, status: 200, json: async () => ({ signedIn: answer.ok, models: answer.models, sidStorage: 'sealed' }) }
  }
  if (href.includes('__check')) return { ok: true, status: 200, json: async () => ({ ok: true, model: IDS[0] }) }
  return { ok: false, status: 404, json: async () => ({}) }
}

// ------------------------------------------------------------- 加载构建产物
const source = readFileSync(BUNDLE, 'utf8')
if (!source.includes('__ModuleLoader__')) {
  console.error(`${BUNDLE.pathname} 不是浏览器产物，先跑 pnpm run build。`)
  process.exit(2)
}
let loaded
window.__ModuleLoader__ = { load: (entry) => { loaded = entry } }
await import(BUNDLE.href)
const { apply } = loaded.factory(requireFrom)

// ------------------------------------------------------- 假宿主：设置表单 + 挂载
/**
 * DSH 0.1.7 `ConfigFormController` 的替身，只保留卡片能观察到的那部分契约：
 * 快照异步才有答案、每次被接受的变化都通知订阅者、`set` 折进快照并答 `true`。
 */
function makeForm({ stored, readyDelay = 0 }) {
  const listeners = new Set()
  let snapshot = { status: 'loading', value: undefined, writable: true }
  const publish = () => { for (const listener of [...listeners]) listener() }
  const ready = () => { snapshot = { status: 'ready', value: { ...stored }, writable: true }; publish() }
  if (readyDelay === 0) ready()
  else setTimeout(ready, readyDelay)
  return {
    stored,
    /** 延迟作答的那一份现在作答（冷启动页面就是这样）。 */
    ready,
    /** 从「另一个界面」改一个值并通知。 */
    external(field, value) { stored[field] = value; ready() },
    form: {
      getSnapshot: () => snapshot,
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
      async set(field, value) { stored[field] = value; ready(); return true },
    },
  }
}

const disposeNothing = () => undefined
let lastRegistration

/** 走 bundle 自己的 apply() 注册卡片，和宿主一样。 */
function registerCard(form) {
  apply({
    effect: (fn) => { fn(); return disposeNothing },
    get: (service) => (service === 'configForms'
      ? {
          describe: () => ({ getSnapshot: () => ({ view: { namespaces: [{ ns: 'dsh-connect-comate' }] } }) }),
          get: () => form,
        }
      : undefined),
    locale: {
      register: () => {},
      bind: () => (key, params) => {
        const zh = {
          'row.modelsSummary': '已显示 {checked} / {total}',
          'row.modelsHint': '只有勾选的模型会出现在 DSH 模型列表里。',
          'row.modelsEmpty': '还没有模型目录',
          'row.modelsUnavailable': '取不到模型目录',
          'row.title': 'WPS Comate 连接',
          'row.sidLabel': 'sid',
          'row.sidHint': 'hint',
          'row.sidUnset': '未配置',
          'row.cookieOnly': 'cookieOnly',
          'row.maxTokensLabel': 'cap',
          'row.maxTokensUnit': 'tokens',
          'row.maxTokensHint': 'hint',
          'row.modelsTitle': '启用的模型',
          'row.selectAll': '全选',
          'row.selectNone': '全不选',
          'row.refresh': '刷新模型列表',
          'row.save': '保存',
          'row.discard': '撤销修改',
          'row.test': '测试连接',
          'row.clear': '清除已存的 sid',
          'row.expand': '展开',
          'row.collapse': '收起',
        }
        const text = zh[key] ?? key
        return params === undefined ? text : text.replace(/\{(\w+)\}/g, (_, name) => String(params[name]))
      },
    },
    slots: {
      inject: (slot, callback) => callback(),
      register: (options, component) => { lastRegistration = { options, component }; return disposeNothing },
    },
  })
  return lastRegistration.component
}

const tick = (ms = 10) => new Promise(resolve => setTimeout(resolve, ms))

/** 按 `plugins.bundle.config` 的方式挂载：view="page"。 */
async function open({ stored, readyDelay = 0, catalog = () => ({ ok: true, models: CATALOG }) }) {
  catalogAnswer = catalog
  const host = makeForm({ stored: { ...stored }, readyDelay })
  const component = registerCard(host.form)
  const container = window.document.createElement('div')
  window.document.getElementById('root').appendChild(container)
  const client = ReactDOMClient.createRoot(container)
  await act(async () => {
    client.render(React.createElement(component, { ...lastRegistration.options.inject(), view: 'page' }))
  })
  await act(async () => { await tick(readyDelay + 30) })
  return { container, host, client, component }
}

/** 用户看到的东西：按列表顺序的每个勾选框状态。 */
const checked = (container) =>
  [...container.querySelectorAll('.dsm-comate-model input[type=checkbox]')].map(input => input.checked)
const summary = (container) =>
  [...container.querySelectorAll('.dsm-comate-models .dsm-comate-hint')][0]?.textContent ?? ''
const boxes = (container) => [...container.querySelectorAll('.dsm-comate-model input[type=checkbox]')]
const buttonByText = (container, text) =>
  [...container.querySelectorAll('button')].find(button => button.textContent?.trim() === text)

const ALL_CHECKED = [true, true, true, true, true]
const ONLY_KIMI = [false, false, false, false, true]

console.log('\n1. 存的是 []（「全部模型」哨兵）时，必须每个都勾上')
{
  const { container } = await open({ stored: { wpsSid: 'enc:v1:x', cookieOnly: false, enabledModelIds: [], maxOutputTokens: 0 } })
  expectEqual('目录比快照晚到', checked(container), ALL_CHECKED)
  expectEqual('汇总行', summary(container), '已显示 5 / 5 · 只有勾选的模型会出现在 DSH 模型列表里。')
}

console.log('\n2. 存的是子集时，两个异步源谁先到都只勾那个子集')
{
  const ready = await open({ stored: { wpsSid: 'enc:v1:x', cookieOnly: false, enabledModelIds: [KIMI], maxOutputTokens: 0 } })
  expectEqual('快照挂载时就有答案', checked(ready.container), ONLY_KIMI)

  const late = await open({
    stored: { wpsSid: 'enc:v1:x', cookieOnly: false, enabledModelIds: [KIMI], maxOutputTokens: 0 },
    readyDelay: 40,
  })
  expectEqual('快照比目录晚到', checked(late.container), ONLY_KIMI)
}

console.log('\n3. 用户改选择、保存、退出、再进来')
{
  const first = await open({ stored: { wpsSid: 'enc:v1:x', cookieOnly: false, enabledModelIds: [], maxOutputTokens: 0 } })
  expectEqual('[] 哨兵进来时是全勾', checked(first.container), ALL_CHECKED)
  // 把前四个取消，只留 kimi-k3：在一个「本来显示全部」的目录里做一次显式选择。
  for (const index of [0, 1, 2, 3]) {
    await act(async () => { boxes(first.container)[index].click() })
  }
  expectEqual('取消前四个后的草稿', checked(first.container), ONLY_KIMI)
  await act(async () => { buttonByText(first.container, '保存').click() })
  await act(async () => { await tick(30) })
  expectEqual('存下去的值', first.host.stored.enabledModelIds, [KIMI])

  const second = await open({ stored: { ...first.host.stored } })
  expectEqual('再进来', checked(second.container), ONLY_KIMI)
  expectEqual('再进来的汇总行', summary(second.container), '已显示 1 / 5 · 只有勾选的模型会出现在 DSH 模型列表里。')

  // 全勾会归一化成 [] —— 宿主把它读作「全部模型」。
  await act(async () => { buttonByText(second.container, '全选').click() })
  await act(async () => { buttonByText(second.container, '保存').click() })
  await act(async () => { await tick(30) })
  expectEqual('全勾保存归一化成 []', second.host.stored.enabledModelIds, [])
  const third = await open({ stored: { ...second.host.stored } })
  expectEqual('归一化后再进来', checked(third.container), ALL_CHECKED)
}

console.log('\n4. 目录路由挂掉不能污染选择')
{
  const { container, host } = await open({
    stored: { wpsSid: 'enc:v1:x', cookieOnly: false, enabledModelIds: [KIMI], maxOutputTokens: 0 },
    catalog: () => ({ ok: false }),
  })
  expectEqual('路由不通时没有列表', checked(container), [])
  catalogAnswer = () => ({ ok: true, models: CATALOG })
  await act(async () => { buttonByText(container, '刷新模型列表').click() })
  await act(async () => { await tick(30) })
  expectEqual('刷新之后', checked(container), ONLY_KIMI)
  expectEqual('读失败不动已存的值', host.stored.enabledModelIds, [KIMI])
}

console.log('\n5. 外部改动只重新播种「没被碰过」的草稿')
{
  const { container, host } = await open({ stored: { wpsSid: 'enc:v1:x', cookieOnly: false, enabledModelIds: [KIMI], maxOutputTokens: 32000 } })
  await act(async () => { host.external('enabledModelIds', IDS.slice(0, 2)) })
  await act(async () => { await tick(10) })
  expectEqual('没碰过的草稿跟着变', checked(container), [true, true, false, false, false])
  await act(async () => { host.external('maxOutputTokens', 64000) })
  await act(async () => { await tick(10) })
  expectEqual('没碰过的上限草稿跟着变', container.querySelector('#dsh-comate-max-tokens').value, '64000')

  await act(async () => { boxes(container)[4].click() })
  await act(async () => { host.external('enabledModelIds', IDS) })
  await act(async () => { await tick(10) })
  expectEqual('碰过的草稿保留', checked(container), [true, true, false, false, true])
}

console.log(`\n${checks - failures.length}/${checks} 条断言通过`)
if (failures.length > 0) {
  console.error(`\n失败：\n   - ${failures.join('\n   - ')}\n`)
  process.exit(1)
}
console.log('卡片勾选状态机：OK\n')
