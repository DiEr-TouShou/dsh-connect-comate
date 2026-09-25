/**
 * WPS Comate model catalog: a mutable list fed from the desktop client's own
 * config (`~/.wpscomate/config.json` → `providers.official.models`).
 *
 * 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
 *   — 「运行时目录由一处持有、adapter 与 shim 的 /v1/models 共享」的做法
 *     沿用自该项目。
 *
 * 与 WorkBuddy 不同，Comate 的模型目录就在本地 config 里（无远端目录
 * 接口需要轮询），因此不做静态 fallback：config 缺失时目录为空，
 * provider 注册但不暴露模型，doctor 会给出明确提示。
 *
 * @module dsh-connect-comate/catalog
 */

import type { ComateModel } from './auth.ts'

/**
 * Derive the runtime catalog from the discovered directory plus the user's
 * explicit enabled-id selection (参考 dsh-connect-workbuddy 的 deriveCatalog，
 * MIT)：空选择回退为整个目录，保证从未配置过的插件仍然暴露全部模型；一旦
 * 用户保存过显式勾选，运行时只暴露勾选项，未勾选的不进入模型列表。
 */
export function selectComateModels(
  models: readonly ComateModel[],
  enabled: ReadonlySet<string>,
): ComateModel[] {
  if (enabled.size === 0) return models.map(model => ({ ...model }))
  return models.filter(model => enabled.has(model.id)).map(model => ({ ...model }))
}

/** Mutable catalog shared by the shim's `/v1/models` and the adapter. */
export class ComateCatalog {
  private models: readonly ComateModel[] = []

  /** Current entries; empty until the config has been read once. */
  current(): readonly ComateModel[] {
    return this.models
  }

  /** Replace the list; callers invalidate their adapter snapshot after this. */
  set(models: readonly ComateModel[]): void {
    this.models = models.map(model => ({ ...model }))
  }
}
