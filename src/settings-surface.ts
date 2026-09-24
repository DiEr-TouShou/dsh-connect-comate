/**
 * Host-side settings assembly: bind this plugin's configuration section on
 * whichever DSH line is running.
 *
 * 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
 *   — 「0.1.5 的 `SettingsProvider.register/installSection` 在 0.1.7 整个消失、
 *     取而代之是 `SettingsForms.configure`，所以必须按能力探测而不是裸调用」
 *     这一结论由该项目 2.0.12 实测得出（裸调用会让 `apply()` 抛错、整个插件
 *     装配失败：provider 不注册、卡片不存在）。
 *
 * 单独成模块是为了让这段装配能用假 context 直接测：真实的 `apply()` 会起
 * loopback 监听并构造 pi-ai adapter，把它拖进单元测试只会让两条线的分支都测不到。
 *
 * @module dsh-connect-comate/settings-surface
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: declares the `settings` service seat on Context.
import type {} from '@deepseek-ai/dsh-settings'
// Type-only: brings in `Fiber.entry` and the `loader/volatile-update` event.
import type {} from '@deepseek-ai/cordis-plugin-loader'
import { COMATE_ENTRY_ID, COMATE_SETTINGS_NS, unwrapVolatileDeep } from './bridge.ts'

/**
 * One registered namespace's owner scope, as the 0.1.5 line hands it out.
 * Structural on purpose: see {@link ComateSettingsSurface}.
 */
interface ComateSettingsScope<T> {
  get(): T
  watch(callback: (next: T, prev: T) => void | Promise<void>): () => void
}

/**
 * The two settings service shapes this plugin has to serve.
 *
 * 0.1.5's `SettingsProvider` exposes `register(ns, schema, options)` and returns
 * an owner scope; 0.1.7 replaced the whole service with `SettingsForms`, whose
 * namespace IS the Loader entry id and whose only registration call is
 * `configure(presentation, owner)`. Neither method exists on the other line, and
 * the plugin must not fail to mount on either — so the surface is probed at
 * runtime through this structural type rather than typed against one line's
 * declarations (which would make the other line a compile error).
 */
export interface ComateSettingsSurface {
  /** 0.1.7 (`SettingsForms`): declare this entry's configuration page policy. */
  configure?: ((presentation: { auto?: boolean }, owner?: unknown) => () => void) | undefined
  /** 0.1.5 (`SettingsProvider`): register this plugin's own settings namespace. */
  register?: (
    (ns: string, schema: unknown, options?: { base?: unknown }) => ComateSettingsScope<unknown>
  ) | undefined
}

/** What the host keeps from the settings surface. */
export interface ComateSettingsBinding<T> {
  /**
   * Namespace this plugin's section is addressed by on the running line: the
   * Loader entry id on 0.1.7, the plugin-registered namespace on 0.1.5.
   */
  settingsNs: string
  /** Read the section's resolved values, free of live references. */
  current(): T
}

/**
 * Bind the configuration section, or report that this deployment offers neither
 * shape.
 *
 * @param ctx - the plugin's context.
 * @param schema - the plugin's Config schema (used only on the 0.1.5 line, where
 * the plugin owns the namespace; on 0.1.7 the Loader owns it).
 * @param base - the composition-layer config the Loader handed to `apply`.
 * @param onChange - invoked after every committed settings change.
 * @returns the binding, or `undefined` when the plugin must not register at all.
 */
export function bindComateSettings<T>(
  ctx: Context,
  schema: unknown,
  base: T,
  onChange: () => void,
): ComateSettingsBinding<T> | undefined {
  const settings = ctx.settings as unknown as ComateSettingsSurface

  const configure = settings.configure
  if (typeof configure === 'function') {
    // 0.1.7: the Loader entry IS the namespace, and the Loader owns the schema —
    // the plugin only declares page policy. `auto: false` because this plugin
    // ships its own card, and an auto-generated form would render `wpsSid` as a
    // plaintext text field.
    ctx.effect(
      () => configure.call(settings, { auto: false }, ctx.fiber),
      'dsh-connect-comate: settings page policy',
    )
    // Volatile fields arrive as live references; re-read them after every
    // committed write so a saved sid or model selection takes effect on the next
    // chat without a restart.
    ctx.on('loader/volatile-update', onChange)
    return {
      settingsNs: ctx.fiber.entry?.options.id ?? COMATE_ENTRY_ID,
      current: () => unwrapVolatileDeep(base),
    }
  }

  const register = settings.register
  if (typeof register !== 'function') {
    ctx.logger.error(
      'dsh-connect-comate: the settings service exposes neither configure (0.1.7) nor register (0.1.5);'
      + ' refusing to register the provider half-assembled',
    )
    return undefined
  }

  // 0.1.5: the plugin registers its own namespace and keeps the owner scope. The
  // composition layer handed to the service must be free of live references:
  // `installSection` validates and structuredClones the whole object, and a
  // single reference makes every field fail validation — which silently
  // unregisters the section and makes the card disappear.
  const scope = register.call(settings, COMATE_SETTINGS_NS, schema, { base: unwrapVolatileDeep(base) })
  const releaseWatch = scope.watch(onChange)
  ctx.effect(() => () => releaseWatch(), 'dsh-connect-comate: settings watch')
  return {
    settingsNs: COMATE_SETTINGS_NS,
    current: () => scope.get() as T,
  }
}
