/**
 * Browser half: WPS Comate connection card inside DSH's plugin configuration.
 *
 * 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
 *   — 「客户端只注入两条线都提供的服务（`slots`/`locale`），settings 表面按能力
 *     软探测，每一条槽位各自独立 try/catch 注册，`inject` 座位与运行线不匹配时
 *     Cordis 的依赖门会让 apply 永不执行所以绝不能声明它」这套写法由该项目
 *     2.0.12 确立并验证。
 * 改动：槽位集合按本插件实际落点的两条线分别注册。
 *
 * ## 两条线的挂载点
 *
 * - **0.1.7**：插件管理页声明 `plugins.bundle.config`（按包名 keyed，渲染在
 *   该 bundle 自己的页面上）与 `plugins.row.config`（按 `<包名>#<rowId>` keyed，
 *   渲染在该行的配置页上）。0.1.5 的 `settings.plugin.item` 在 0.1.7 已从全树
 *   删除——它被上面这两个槽位与 `plugins.item` 取代。
 * - **0.1.5**：只有 `settings.plugin.item`（按 settings namespace keyed）。
 *
 * 一个构建同时服务两条线，靠的就是「每条槽位各自注册、各自失败」。
 *
 * @module dsh-connect-comate/client
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the OWNER of the 0.1.7 slot keys declares them by declaration
// merging, so the SlotMap only knows `plugins.*` when this package's types are
// in the program. It is not a runtime dependency: the Plugins page declares the
// slots itself, and a deployment without that page simply dispatches nothing.
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { COMATE_CLIENT_NAME, COMATE_ENTRY_ID, COMATE_SETTINGS_NS } from '../bridge.ts'
import { ComateCard } from './ComateCard.tsx'
import type { ComateCardInjected } from './ComateCard.tsx'
import { en, zh } from './locales.ts'
import type { ComateSettingsKey } from './locales.ts'
import { acquireComateSettingsForm } from './settings-scope.ts'

/** Browser-side plugin context this entry needs. */
export type ComateClientContext = Context & {
  slots: Context['slots']
  locale: Context['locale']
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Comate plugin card copy. */
    'settings.comate': ComateSettingsKey
  }
}

/** Stable browser-plugin name. */
export const name = COMATE_CLIENT_NAME

/**
 * Client services required by this contribution.
 *
 * Deliberately only the two services that exist on BOTH host lines. The settings
 * surface differs by line — 0.1.5 provides `settingsScope`, 0.1.7 replaces it
 * with `configForms` — and Cordis' dependency gate is hard: any `inject` entry
 * the running line does not provide keeps `apply` from ever running. Probing both
 * through `ctx.get()` is what lets one build serve both lines.
 */
export const inject = ['slots', 'locale']

/**
 * String-keyed seam for the 0.1.5-only `settings.plugin.item` slot.
 *
 * That key is absent from the 0.1.7 SlotMap, so a typed registration cannot name
 * it. Declaring it through a global `SlotMap` merge would be worse than this
 * seam: on a real 0.1.5 toolchain the key IS declared, and any shape mismatch
 * between the two declarations is a hard compile error there — the build would
 * be lying about the line it is not compiled against. The seam keeps the lie
 * inside one call site instead.
 */
interface LegacySlots {
  inject(slot: string, callback: () => () => void): void
  register(options: Record<string, unknown>, component: unknown): () => void
}

/** Register card copy and the Comate card under the plugin configuration surfaces. */
export function apply(ctx: ComateClientContext): void {
  try {
    const namespace = 'settings.comate'
    ctx.effect(() => ctx.locale.register(namespace, { zh, en }), 'dsh-connect-comate: settings copy')
    const t = ctx.locale.bind(namespace) as ComateCardInjected['t']
    const settingsScope = acquireComateSettingsForm(ctx)
    const injectFace = (): ComateCardInjected => ({ t, settingsScope })

    /**
     * Run one registration, isolating its failure.
     *
     * Slots are declared by different plugins and differ per line: a slot this
     * line does not declare throws. Registering them all inside one guard would
     * let the missing one take the working ones with it — which is precisely how
     * a two-line build breaks on the line it was not tested against.
     */
    const guarded = (label: string, register: () => void): void => {
      try {
        register()
      } catch (error: unknown) {
        console.error(
          `[dsh-connect-comate] card slot "${label}" failed to register (host provider unaffected):`,
          error,
        )
      }
    }

    // 0.1.7: the bundle's own configuration page, keyed by the package name.
    guarded('plugins.bundle.config', () => {
      ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
        name: 'plugins.bundle.config',
        key: COMATE_ENTRY_ID,
        priority: 30,
        inject: injectFace,
      }, ComateCard))
    })

    // 0.1.7: one row's configuration page, keyed by `<package name>#<row id>`.
    // The bundle's single row is declared by this package's own cordis patch, so
    // its row id is the package name.
    guarded('plugins.row.config', () => {
      ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
        name: 'plugins.row.config',
        key: `${COMATE_ENTRY_ID}#${COMATE_ENTRY_ID}`,
        priority: 30,
        inject: injectFace,
      }, ComateCard))
    })

    // 0.1.5 only: the configurable-plugins tab, keyed by the settings namespace
    // the card edits (the plugin registered that namespace itself on this line).
    guarded('settings.plugin.item', () => {
      const legacy = ctx.slots as unknown as LegacySlots
      legacy.inject('settings.plugin.item', () => legacy.register({
        name: 'settings.plugin.item',
        key: COMATE_SETTINGS_NS,
        priority: 30,
        inject: injectFace,
      }, ComateCard))
    })
  } catch (error: unknown) {
    // Degrade silently on the page: the host provider still serves models.
    console.error('[dsh-connect-comate] client card failed to load (host provider unaffected):', error)
  }
}
