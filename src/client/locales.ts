/**
 * Plugin-card copy registered under the settings.comate locale namespace.
 * 结构参考 dingminhua/dsh-connect-workbuddy（MIT），文案按 Comate 改写。
 *
 * @module dsh-connect-comate/client/locales
 */

export const en = {
  'row.title': 'WPS Comate connection (dsh-connect-comate)',
  'row.desc': 'Use the models of the locally signed-in WPS Comate account in DSH. Paste the wps_sid cookie from www.wps.cn below.',
  'row.expand': 'Expand',
  'row.collapse': 'Collapse',
  'row.sidLabel': 'wps_sid cookie',
  'row.sidPlaceholder': 'Paste the wps_sid value (without the "wps_sid=" prefix)',
  'row.sidHint': 'How to get it: sign in at https://www.wps.cn → F12 → Application → Cookies → copy the value of wps_sid.',
  'row.sidSet': 'Configured ({length} chars)',
  'row.sidUnset': 'Not configured — llmproxy answers 401 without it',
  'row.cookieOnly': 'Cookie-only auth (do not send Authorization; enable only if the upstream rejects the key)',
  'row.save': 'Save',
  'row.saving': 'Saving…',
  'row.saved': 'Saved. Restart is not required; the next chat uses it.',
  'row.discard': 'Discard',
  'row.saveError': 'Save failed: {message}',
  'row.clear': 'Clear',
  'row.modelsTitle': 'Enabled models',
  'row.modelsHint': 'Only checked models appear in the DSH model list; leaving all checked (or saving none) shows every model.',
  'row.modelsSummary': '{checked} / {total} shown',
  'row.selectAll': 'Check all',
  'row.selectNone': 'Uncheck all',
  'row.modelMultimodal': 'Image',
  'row.modelsEmpty': 'No model directory yet. Sign the WPS Comate desktop client in and restart DSH.',
  'row.modelsUnavailable': 'The model directory is unavailable: this deployment serves no host web route. Model serving is unaffected — reopen DSH with the web UI, or run `dsh plugin exec dsh-connect-comate status`.',
} as const

export const zh = {
  'row.title': 'WPS Comate 连接（dsh-connect-comate）',
  'row.desc': '在 DSH 中直接使用本机 WPS Comate 账号的模型。把 www.wps.cn 的 wps_sid Cookie 填到下面即可。',
  'row.expand': '展开',
  'row.collapse': '收起',
  'row.sidLabel': 'wps_sid Cookie',
  'row.sidPlaceholder': '粘贴 wps_sid 的值（不带 "wps_sid=" 前缀）',
  'row.sidHint': '获取方式：登录 https://www.wps.cn → F12 → Application（应用）→ Cookies → 复制 wps_sid 的值。',
  'row.sidSet': '已配置（{length} 个字符）',
  'row.sidUnset': '未配置——不填的话上游会返回 401',
  'row.cookieOnly': '只用 Cookie 鉴权（不发送 Authorization；仅在上游报密钥无效时开启）',
  'row.save': '保存',
  'row.saving': '保存中…',
  'row.saved': '已保存，无需重启，下一条对话即生效。',
  'row.discard': '撤销修改',
  'row.saveError': '保存失败：{message}',
  'row.clear': '清空',
  'row.modelsTitle': '启用的模型',
  'row.modelsHint': '只有勾选的模型会出现在 DSH 模型列表里；全部勾选（或一个都不保存）时显示全部模型。',
  'row.modelsSummary': '已显示 {checked} / {total}',
  'row.selectAll': '全选',
  'row.selectNone': '全不选',
  'row.modelMultimodal': '图片',
  'row.modelsEmpty': '还没有模型目录：请先登录 WPS Comate 桌面端并重启 DSH。',
  'row.modelsUnavailable': '取不到模型目录：当前部署没有宿主 Web 路由。模型服务不受影响——请在带 Web UI 的 DSH 里重新打开，或运行 `dsh plugin exec dsh-connect-comate status` 查看。',
} as const

export type ComateSettingsKey = keyof typeof en
