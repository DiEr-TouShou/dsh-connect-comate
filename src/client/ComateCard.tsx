/**
 * Comate connection card contributed to DSH's plugin configuration:
 * a wps_sid input, a cookie-only toggle, an output-token cap, a model-selection
 * list, and save/discard actions.
 *
 * 卡片外壳形态参考 dingminhua/dsh-connect-workbuddy（MIT）。
 *
 * ## 两处与 0.1.5 时期不同的读法
 *
 * - **活引用**：0.1.7 把 volatile 字段以 `{get(): T}` 交付，直接读会拿到对象。
 *   所有读都经 {@link readComateValue}。
 * - **模型目录来自只读路由**：目录是宿主从本机 Comate config 读出来的，不经过
 *   settings（0.1.7 的 settings 写入目标就是用户手写的 `cordis.patch.yml`）。
 *   路由不可用时卡片降级为「暂无目录」，模型服务不受影响。
 *
 * @module dsh-connect-comate/client/ComateCard
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { COMATE_CATALOG_PATH, COMATE_DEFAULT_MAX_TOKENS, type ComateCheckOutcome, type ComatePersistedModel } from '../bridge.ts'
import { parseMaxOutputTokens } from '../max-tokens.ts'
import { COMATE_PLUGIN_ICON } from './icon.ts'
import { COMATE_CARD_CSS } from './styles.ts'
import type { ComateSettingsKey } from './locales.ts'
import {
  comateSettingsWritable,
  readComateValue,
  refreshComateCatalog,
  testComateConnection,
  writeComateSettings,
  type ComateSettingsForm,
} from './settings-scope.ts'

/** Localized copy + settings form injected by the browser-plugin entry. */
export interface ComateCardInjected {
  t: (key: ComateSettingsKey, params?: Record<string, unknown>) => string
  /** Absent when neither settings service is available: the card renders read-only. */
  settingsScope?: ComateSettingsForm | undefined
}

/** Props delivered by the plugin configuration slots. */
export interface ComateCardProps extends Partial<ComateCardInjected> {
  /**
   * Owner view. 0.1.7's plugin-manager slots render this card as `page` only;
   * `summary` is the one-liner a list row shows, which needs no body.
   */
  view?: 'summary' | 'page' | undefined
}

/** Inject the shared card CSS once per module load. */
if (typeof document !== 'undefined') {
  const cssId = 'dsh-connect-comate/client.css'
  const existing = document.querySelector<HTMLStyleElement>(`style[data-plugin-css="${cssId}"]`)
  if (existing !== null) {
    existing.textContent = COMATE_CARD_CSS
  } else {
    const styleTag = document.createElement('style')
    styleTag.dataset.plugin = 'dsh-connect-comate'
    styleTag.dataset.pluginCss = cssId
    styleTag.textContent = COMATE_CARD_CSS
    document.head.appendChild(styleTag)
  }
}

/** One inline action result, shown next to the button that produced it. */
interface CardNote {
  tone: 'ok' | 'info' | 'error'
  text: string
}

/** Turn a probe outcome into the single line the card shows. */
function describeOutcome(
  outcome: ComateCheckOutcome,
  t: (key: ComateSettingsKey, params?: Record<string, unknown>) => string,
): CardNote {
  if (outcome.ok) {
    return { tone: 'ok', text: t('row.testOk', { model: outcome.model ?? '' }) }
  }
  // `reason` is set only when the probe never reached the network; those two
  // cases have actionable copy, unlike an upstream refusal.
  if (outcome.reason === 'no-credential') return { tone: 'error', text: t('row.testNoCredential') }
  if (outcome.reason === 'no-model') return { tone: 'error', text: t('row.testNoModel') }
  return {
    tone: 'error',
    text: t('row.testFail', {
      status: outcome.status ?? '-',
      kind: outcome.kind ?? 'unknown',
      message: outcome.message ?? '',
    }),
  }
}

/** Render one inline action result, toned by outcome. */
function Note({ note }: { note: CardNote }) {
  const className = note.tone === 'ok'
    ? 'dsm-comate-saved'
    : note.tone === 'error'
      ? 'dsm-comate-error'
      : 'dsm-comate-info'
  return <p className={className}>{note.text}</p>
}

/** Narrow one entry of the catalog route's answer. */
function isPersistedModel(value: unknown): value is ComatePersistedModel {
  if (value === null || typeof value !== 'object') return false
  const model = value as Record<string, unknown>
  return typeof model.id === 'string'
    && typeof model.name === 'string'
    && typeof model.contextWindow === 'number'
    && typeof model.multimodal === 'boolean'
}

/** Render the Comate sign-in configuration as one card (or page body). */
export function ComateCard({ t, settingsScope, view }: ComateCardProps) {
  if (t === undefined) throw new Error('Comate plugin card requires its translation function')
  // A row/bundle configuration page IS the form: it opens expanded. The 0.1.5
  // list entry stays collapsed until the user asks for it.
  const [open, setOpen] = useState(view === 'page')
  const [revision, setRevision] = useState(0)
  const saved = useMemo(() => readComateValue(settingsScope), [settingsScope, revision])
  const savedSid = saved.wpsSid ?? ''
  const savedCookieOnly = saved.cookieOnly === true
  const savedConfigFile = saved.configFile ?? ''
  // An unset cap means the plugin default is in force; the input shows that
  // number rather than an empty box, because the field always has an effect.
  const savedMaxTokens = saved.maxOutputTokens ?? COMATE_DEFAULT_MAX_TOKENS
  const [catalog, setCatalog] = useState<ComatePersistedModel[]>([])
  const [catalogFailed, setCatalogFailed] = useState(false)
  const catalogIds = useMemo(() => catalog.map(model => model.id), [catalog])
  // An empty saved selection means "every model"; mirror that in the UI.
  const savedEnabledIds = useMemo(() => {
    const stored = new Set(saved.enabledModelIds ?? [])
    return stored.size === 0 ? new Set(catalogIds) : stored
  }, [saved.enabledModelIds, catalogIds])
  // The stored sid is NEVER seeded into the draft: once a value is saved the
  // input stays empty, so screenshots and shoulder-surfing cannot recover it.
  // `null` means "nothing typed — keep the saved value" (the status line's
  // saved length is the only trace the card keeps); a typed value replaces it
  // on save, and Clear stages an explicit empty write via `clearPending`.
  const [draftSid, setDraftSid] = useState<string | null>(null)
  const [clearPending, setClearPending] = useState(false)
  const [draftCookieOnly, setDraftCookieOnly] = useState(savedCookieOnly)
  const [draftEnabled, setDraftEnabled] = useState<Set<string>>(savedEnabledIds)
  // A text draft, not a number: the user must be able to clear the field and
  // retype without React fighting them for a value the parser would reject.
  const [draftMaxTokens, setDraftMaxTokens] = useState(String(savedMaxTokens))
  const [saving, setSaving] = useState(false)
  const [savedFlash, setSavedFlash] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshNote, setRefreshNote] = useState<CardNote | undefined>(undefined)
  const [testing, setTesting] = useState(false)
  const [testNote, setTestNote] = useState<CardNote | undefined>(undefined)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  useEffect(
    () => settingsScope?.subscribe(() => { setRevision(value => value + 1) }),
    [settingsScope],
  )

  /**
   * Read the directory from the host's read-only route.
   *
   * Failure is not an error state for the plugin: the route needs `webServer`,
   * and a deployment without one still serves models. The card simply has
   * nothing to list.
   */
  const loadCatalog = useCallback(async (): Promise<void> => {
    try {
      const response = await fetch(COMATE_CATALOG_PATH, {
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const body = await response.json() as { models?: unknown }
      const models = Array.isArray(body.models) ? body.models.filter(isPersistedModel) : []
      if (!mounted.current) return
      setCatalog(models)
      setCatalogFailed(false)
    } catch {
      if (!mounted.current) return
      setCatalog([])
      setCatalogFailed(true)
    }
  }, [])

  useEffect(() => { void loadCatalog() }, [loadCatalog])

  /**
   * Ask the host to re-read the local Comate config, then take its snapshot.
   *
   * The button exists because the host discovers models at startup and when
   * `configFile` changes: a model the user just signed into in the desktop
   * client would otherwise need a DSH restart to appear.
   */
  const onRefresh = async (): Promise<void> => {
    if (refreshing) return
    setRefreshing(true)
    setRefreshNote(undefined)
    try {
      const answer = await refreshComateCatalog()
      if (!mounted.current) return
      setCatalog([...answer.models])
      setCatalogFailed(false)
      setRefreshNote({
        tone: answer.signedIn ? 'ok' : 'info',
        text: answer.signedIn
          ? t('row.refreshed', { count: answer.models.length })
          : t('row.refreshSignedOut'),
      })
    } catch (cause: unknown) {
      if (mounted.current) {
        setRefreshNote({
          tone: 'error',
          text: t('row.refreshFailed', { message: cause instanceof Error ? cause.message : String(cause) }),
        })
      }
    } finally {
      if (mounted.current) setRefreshing(false)
    }
  }

  /**
   * Send one minimal request through the host, using the CURRENT DRAFT values.
   *
   * Testing the draft is the point: the sid can be verified before it is saved,
   * so a wrong paste never reaches the settings document. The host applies the
   * draft to that single request and persists nothing.
   */
  const onTest = async (): Promise<void> => {
    if (testing) return
    setTesting(true)
    setTestNote(undefined)
    try {
      // Only an explicit sid intent is sent: a typed replacement is probed,
      // while an empty draft falls back to the stored value on the host side
      // (an empty override reads as "absent" in the credential store).
      const outcome = await testComateConnection({
        ...(sidReplace ? { wpsSid: trimmedSid } : {}),
        cookieOnly: draftCookieOnly,
      })
      if (!mounted.current) return
      setTestNote(describeOutcome(outcome, t))
    } catch (cause: unknown) {
      if (mounted.current) {
        setTestNote({
          tone: 'error',
          text: t('row.testFail', {
            status: '-',
            kind: 'route',
            message: cause instanceof Error ? cause.message : String(cause),
          }),
        })
      }
    } finally {
      if (mounted.current) setTesting(false)
    }
  }

  // A committed `configFile` change makes the host re-read the Comate config, so
  // the directory can change with it. The first run is skipped: the mount effect
  // above already fetched.
  const prevConfigFile = useRef(savedConfigFile)
  useEffect(() => {
    if (prevConfigFile.current === savedConfigFile) return
    prevConfigFile.current = savedConfigFile
    void loadCatalog()
  }, [savedConfigFile, loadCatalog])

  // External changes (another surface, first load) re-seed an untouched draft.
  // The sid draft is deliberately excluded: it never mirrors the stored value,
  // so an external change has nothing to re-seed into it.
  const prevSavedCookieOnly = useRef(savedCookieOnly)
  const prevSavedEnabledKey = useRef('')
  const prevSavedMaxTokens = useRef(savedMaxTokens)
  useEffect(() => {
    if (prevSavedCookieOnly.current !== savedCookieOnly) {
      setDraftCookieOnly(current => (current === prevSavedCookieOnly.current ? savedCookieOnly : current))
      prevSavedCookieOnly.current = savedCookieOnly
    }
  }, [savedCookieOnly])
  // Same treatment as the cookie toggle: the cap is not a secret, so a draft the
  // user has not touched follows a value changed from another surface.
  useEffect(() => {
    if (prevSavedMaxTokens.current !== savedMaxTokens) {
      setDraftMaxTokens(current => (
        current === String(prevSavedMaxTokens.current) ? String(savedMaxTokens) : current
      ))
      prevSavedMaxTokens.current = savedMaxTokens
    }
  }, [savedMaxTokens])
  // The directory arrives asynchronously, so this key changes from the empty set
  // to "everything discovered" once the fetch lands — which re-seeds a draft the
  // user has not touched yet.
  const savedEnabledKey = [...savedEnabledIds].join('|')
  useEffect(() => {
    if (prevSavedEnabledKey.current !== savedEnabledKey) {
      setDraftEnabled(current => (
        [...current].join('|') === prevSavedEnabledKey.current ? new Set(savedEnabledIds) : current
      ))
      prevSavedEnabledKey.current = savedEnabledKey
    }
  }, [savedEnabledKey, savedEnabledIds])

  const writable = comateSettingsWritable(settingsScope)
  const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean =>
    a.size === b.size && [...a].every(id => b.has(id))
  const trimmedSid = (draftSid ?? '').trim()
  // The sid participates in "dirty" only on an explicit intent — a typed
  // replacement, or a staged clear. An emptied field keeps the stored value:
  // that is also what stops a save of the model checkboxes from silently
  // wiping the credential when the user typed and erased something.
  const sidReplace = draftSid !== null && trimmedSid.length > 0
  const sidDirty = clearPending || sidReplace
  // `undefined` means the box holds something that is not a cap at all: an empty
  // box, a fraction, a negative, a word. Save stays disabled on it rather than
  // silently writing the default behind the user's back.
  const draftMaxTokensValue = parseMaxOutputTokens(draftMaxTokens)
  const maxTokensInvalid = draftMaxTokensValue === undefined
  const maxTokensDirty = draftMaxTokens.trim() !== String(savedMaxTokens)
  const dirty = sidDirty
    || draftCookieOnly !== savedCookieOnly
    || maxTokensDirty
    || !sameSet(draftEnabled, savedEnabledIds)

  const toggleModel = (id: string): void => {
    setDraftEnabled(current => {
      const next = new Set(current)
      if (!next.delete(id)) next.add(id)
      return next
    })
  }

  const discard = (): void => {
    setDraftSid(null)
    setClearPending(false)
    setDraftCookieOnly(savedCookieOnly)
    setDraftEnabled(new Set(savedEnabledIds))
    setDraftMaxTokens(String(savedMaxTokens))
    setError(undefined)
  }

  const formatContext = (value: number): string => {
    if (value >= 1_000_000) return `${value / 1_000_000}M`
    if (value >= 1_000) return `${value / 1_000}K`
    return String(value)
  }

  const save = async (): Promise<void> => {
    if (settingsScope === undefined || saving) return
    setSaving(true)
    setError(undefined)
    try {
      // All-selected normalizes to an empty list, which the host reads as
      // "show every discovered model" and keeps the saved section compact.
      const allSelected = catalogIds.every(id => draftEnabled.has(id))
      const enabledModelIds = catalog.length === 0
        // No directory to compare against (signed out, or the route is gone):
        // keep what is stored rather than silently widening the selection to
        // "everything" behind the user's back.
        ? (saved.enabledModelIds ?? [])
        : (allSelected ? [] : catalogIds.filter(id => draftEnabled.has(id)))
      await writeComateSettings(settingsScope, {
        // Only an explicit intent writes the sid: a staged clear sends '',
        // a typed replacement sends the new value, an empty draft omits the
        // field entirely so the stored value survives untouched.
        ...(clearPending ? { wpsSid: '' } : sidReplace ? { wpsSid: trimmedSid } : {}),
        cookieOnly: draftCookieOnly,
        enabledModelIds,
        // Only a usable draft is written: an invalid box keeps Save disabled, so
        // this branch is about the untouched-but-unparsable edge (a value stored
        // by hand that this card cannot round-trip) rather than normal use.
        ...(draftMaxTokensValue === undefined ? {} : { maxOutputTokens: draftMaxTokensValue }),
      })
      if (!mounted.current) return
      setDraftSid(null)
      setClearPending(false)
      setSavedFlash(true)
      window.setTimeout(() => { if (mounted.current) setSavedFlash(false) }, 4000)
    } catch (cause: unknown) {
      if (mounted.current) {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    } finally {
      if (mounted.current) setSaving(false)
    }
  }

  const title = t('row.title')
  const sidConfigured = savedSid.length > 0

  return (
    <li className={`dsm-plugin-card${open ? ' dsm-plugin-card-open' : ''}`}>
      <button
        type="button"
        className="dsm-plugin-card-header"
        aria-expanded={open}
        aria-label={`${t(open ? 'row.collapse' : 'row.expand')}: ${title}`}
        onClick={() => { setOpen(!open) }}
      >
        <img className="dsm-plugin-card-icon" src={COMATE_PLUGIN_ICON} alt="" />
        <span className="dsm-plugin-card-head">
          <span className="dsm-plugin-card-title">{title}</span>
          <span className="dsm-plugin-card-description">{t('row.desc')}</span>
        </span>
        <span
          aria-hidden="true"
          className={`dsm-plugin-card-chevron${open ? ' dsm-plugin-card-chevron-open' : ''}`}
        />
      </button>
      <div className="dsm-plugin-card-body" hidden={!open}>
        {open
          ? <div className="dsm-comate">
              <div className="dsm-comate-status">
                <span
                  aria-hidden="true"
                  className={`dsm-comate-status-dot ${sidConfigured ? 'dsm-comate-status-ok' : 'dsm-comate-status-empty'}`}
                />
                <span>{sidConfigured
                  ? t('row.sidSet', { length: savedSid.length })
                  : t('row.sidUnset')}</span>
              </div>
              <div className="dsm-comate-field">
                <label className="dsm-comate-label" htmlFor="dsh-comate-wps-sid">{t('row.sidLabel')}</label>
                <div className="dsm-comate-sid-row">
                  <input
                    id="dsh-comate-wps-sid"
                    className="dsm-comate-input"
                    type="text"
                    autoComplete="new-password"
                    spellCheck={false}
                    placeholder={clearPending
                      ? t('row.sidClearPending')
                      : sidConfigured
                        ? t('row.sidPlaceholderSet')
                        : t('row.sidPlaceholder')}
                    value={draftSid ?? ''}
                    disabled={!writable || saving || clearPending}
                    onChange={event => { setDraftSid(event.currentTarget.value) }}
                  />
                  {/* Clearing is a staged intent like any other edit: it goes
                      through Save (and Discard can undo it) instead of writing
                      immediately from a click. */}
                  {sidConfigured && writable && !clearPending
                    ? (
                        <button
                          type="button"
                          className="dsm-btn dsm-btn-outline"
                          disabled={saving}
                          onClick={() => { setClearPending(true); setDraftSid(null) }}
                        >
                          {t('row.clear')}
                        </button>
                      )
                    : null}
                </div>
                <p className="dsm-comate-hint">{t('row.sidHint')}</p>
              </div>
              <label className="dsm-comate-check">
                <input
                  type="checkbox"
                  checked={draftCookieOnly}
                  disabled={!writable || saving}
                  onChange={event => { setDraftCookieOnly(event.currentTarget.checked) }}
                />
                <span>{t('row.cookieOnly')}</span>
              </label>
              <div className="dsm-comate-field">
                <label className="dsm-comate-label" htmlFor="dsh-comate-max-tokens">{t('row.maxTokensLabel')}</label>
                <div className="dsm-comate-number-row">
                  <input
                    id="dsh-comate-max-tokens"
                    className="dsm-comate-input dsm-comate-input-number"
                    type="number"
                    inputMode="numeric"
                    min={0}
                    step={1}
                    spellCheck={false}
                    placeholder={String(COMATE_DEFAULT_MAX_TOKENS)}
                    value={draftMaxTokens}
                    disabled={!writable || saving}
                    aria-invalid={maxTokensInvalid}
                    onChange={event => { setDraftMaxTokens(event.currentTarget.value) }}
                  />
                  <span className="dsm-comate-unit">{t('row.maxTokensUnit')}</span>
                </div>
                <p className={`dsm-comate-hint${maxTokensInvalid ? ' dsm-comate-hint-error' : ''}`}>
                  {maxTokensInvalid ? t('row.maxTokensInvalid') : t('row.maxTokensHint')}
                </p>
              </div>
              <section className="dsm-comate-models">
                <div className="dsm-comate-models-head">
                  <h3 className="dsm-comate-models-title">{t('row.modelsTitle')}</h3>
                  <div className="dsm-comate-models-tools">
                    <button
                      type="button"
                      className="dsm-btn dsm-btn-outline"
                      disabled={!writable || saving}
                      onClick={() => { setDraftEnabled(new Set(catalogIds)) }}
                    >
                      {t('row.selectAll')}
                    </button>
                    <button
                      type="button"
                      className="dsm-btn dsm-btn-outline"
                      disabled={!writable || saving}
                      onClick={() => { setDraftEnabled(new Set()) }}
                    >
                      {t('row.selectNone')}
                    </button>
                    {/* Reading the host's directory is not a settings write, so
                        this stays available even when the section is locked. */}
                    <button
                      type="button"
                      className="dsm-btn dsm-btn-outline"
                      disabled={refreshing}
                      onClick={() => { void onRefresh() }}
                    >
                      {refreshing ? t('row.refreshing') : t('row.refresh')}
                    </button>
                  </div>
                </div>
                {refreshNote === undefined ? null : <Note note={refreshNote} />}
                {catalog.length === 0
                  ? <p className="dsm-comate-hint">
                      {t(catalogFailed ? 'row.modelsUnavailable' : 'row.modelsEmpty')}
                    </p>
                  : <>
                      <p className="dsm-comate-hint">
                        {t('row.modelsSummary', { checked: draftEnabled.size, total: catalog.length })}
                        {' · '}
                        {t('row.modelsHint')}
                      </p>
                      <div className="dsm-comate-model-list">
                        {catalog.map(model => (
                          <div className="dsm-comate-model" key={model.id}>
                            <label className="dsm-comate-model-row" title={model.id}>
                              <input
                                type="checkbox"
                                checked={draftEnabled.has(model.id)}
                                disabled={!writable || saving}
                                onChange={() => { toggleModel(model.id) }}
                              />
                              <span className="dsm-comate-model-name">{model.name}</span>
                              {model.multimodal
                                ? <span className="dsm-comate-model-tag">{t('row.modelMultimodal')}</span>
                                : null}
                            </label>
                            <p className="dsm-comate-model-meta">
                              {formatContext(model.contextWindow)} context · {model.id}
                            </p>
                          </div>
                        ))}
                      </div>
                    </>}
              </section>
              <div className="dsm-comate-actions">
                {savedFlash ? <p className="dsm-comate-saved">{t('row.saved')}</p> : null}
                {error === undefined ? null : <p className="dsm-comate-error">{t('row.saveError', { message: error })}</p>}
                {/* Testing uses the DRAFT sid, so it works before anything is
                    saved — and it is a read-only probe, not a settings write,
                    which is why it ignores `writable`. */}
                <button
                  type="button"
                  className="dsm-btn dsm-btn-outline"
                  disabled={testing}
                  onClick={() => { void onTest() }}
                >
                  {testing ? t('row.testing') : t('row.test')}
                </button>
                <button
                  type="button"
                  className="dsm-btn dsm-btn-outline"
                  disabled={!dirty || saving}
                  onClick={discard}
                >
                  {t('row.discard')}
                </button>
                <button
                  type="button"
                  className="dsm-btn dsm-btn-primary"
                  disabled={!writable || !dirty || saving || maxTokensInvalid || (sidReplace && trimmedSid.startsWith('wps_sid='))}
                  onClick={() => { void save() }}
                >
                  {saving ? t('row.saving') : t('row.save')}
                </button>
              </div>
              {testNote === undefined ? null : <Note note={testNote} />}
            </div>
          : null}
      </div>
    </li>
  )
}
