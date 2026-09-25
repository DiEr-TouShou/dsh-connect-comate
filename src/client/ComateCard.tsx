/**
 * Comate connection card contributed to DSH's plugin configuration:
 * a wps_sid input, a cookie-only toggle, a default output-token cap, a
 * model-selection list with a per-model cap box on every row, and save/discard
 * actions.
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
import {
  COMATE_CATALOG_PATH,
  COMATE_DEFAULT_MAX_TOKENS,
  isSealedComateSecret,
  type ComateCheckOutcome,
  type ComatePersistedModel,
  type ComateSidStorage,
} from '../bridge.ts'
import { parseMaxOutputTokens } from '../max-tokens.ts'
import { COMATE_PLUGIN_ICON } from './icon.ts'
import { COMATE_CARD_CSS } from './styles.ts'
import type { ComateSettingsKey } from './locales.ts'
import {
  comateSettingsWritable,
  readComateValue,
  refreshComateCatalog,
  sealComateSid,
  sealStoredComateSid,
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

/**
 * Refuse every clipboard route out of the sid field.
 *
 * `type="password"` only controls how the value is PAINTED. Chrome happens to
 * block script-driven copies from a password field, but that is a browser
 * behaviour rather than a contract, and the user asked for the field not to be
 * copyable at all — so copy, cut, drag and the context menu are cancelled here
 * instead of being relied upon. Pasting is untouched: the whole point of the
 * field is that a value goes in.
 */
function blockClipboard(event: { preventDefault(): void }): void {
  event.preventDefault()
}

/** One message from an unknown thrown value. */
function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/** Narrow the host's `sidStorage` field; anything else means "no verdict". */
function toSidStorage(value: unknown): ComateSidStorage | undefined {
  return value === 'unset' || value === 'plaintext' || value === 'sealed' || value === 'unreadable'
    ? value
    : undefined
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

/** Set equality over model ids: a draft only re-seeds while it still matches. */
function sameIdSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every(id => right.has(id))
}

/**
 * One model's cap box, as typed: a string, never a number.
 *
 * A text draft is what lets the user clear the box and retype without React
 * fighting them for a value the parser would reject (same reason as the global
 * cap field).
 */
type CapDrafts = Readonly<Record<string, string>>

/**
 * Read the per-model boxes: the caps they would save, plus the ids that hold
 * something unusable.
 *
 * An EMPTY box means "no override" and is dropped rather than defaulted: that
 * is what makes "follow the global cap" expressible, and what lets the user undo
 * an override by clearing the box.
 */
function parseCapDrafts(drafts: CapDrafts): { caps: Record<string, number>; invalid: string[] } {
  const caps: Record<string, number> = {}
  const invalid: string[] = []
  for (const [id, text] of Object.entries(drafts)) {
    if (text.trim() === '') continue
    const value = parseMaxOutputTokens(text)
    if (value === undefined) invalid.push(id)
    else caps[id] = value
  }
  return { caps, invalid }
}

/**
 * A fingerprint of a cap map that ignores key order.
 *
 * Used for the two questions the card asks about a map: "has the user touched
 * this draft?" and "is there anything to save?". A JSON dump would answer
 * neither — the same map rebuilt in another order would read as a change.
 */
function capKey(caps: Readonly<Record<string, number>>): string {
  return Object.keys(caps).sort().map(id => `${id}=${String(caps[id])}`).join('\n')
}

/** Seed the text boxes from a stored map (0 is a real value: "unlimited"). */
function textCapDrafts(caps: Readonly<Record<string, number>>): Record<string, string> {
  const drafts: Record<string, string> = {}
  for (const [id, value] of Object.entries(caps)) drafts[id] = String(value)
  return drafts
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
  // What the stored string LOOKS like, which is all the browser can know by
  // itself: the sealed envelope is a prefix, and anything without it is a value
  // an older version wrote in the clear. `unreadable` is deliberately not in this
  // set — a sealed value whose key file is gone is byte-identical to a healthy
  // one, so only the host can tell those two apart (see `hostSid` below).
  const sidShape: 'unset' | 'plaintext' | 'sealed' = savedSid === ''
    ? 'unset'
    : isSealedComateSecret(savedSid) ? 'sealed' : 'plaintext'
  const savedCookieOnly = saved.cookieOnly === true
  const savedConfigFile = saved.configFile ?? ''
  // An unset cap means the plugin default is in force; the input shows that
  // number rather than an empty box, because the field always has an effect.
  const savedMaxTokens = saved.maxOutputTokens ?? COMATE_DEFAULT_MAX_TOKENS
  // The per-model overrides, as stored. Absent/empty means "every model follows
  // the default above" — the normal case, and the reason a fresh card shows an
  // empty box on every row.
  const savedModelCaps = useMemo(() => saved.maxOutputTokensByModel ?? {}, [saved.maxOutputTokensByModel])
  const savedModelCapsKey = useMemo(() => capKey(savedModelCaps), [savedModelCaps])
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
  // Per-model cap boxes, keyed by model id, holding the raw text: an empty box
  // means "follow the default cap" and is never written as an override.
  const [draftModelCaps, setDraftModelCaps] = useState<Record<string, string>>(
    () => textCapDrafts(savedModelCaps),
  )
  const [saving, setSaving] = useState(false)
  const [savedFlash, setSavedFlash] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshNote, setRefreshNote] = useState<CardNote | undefined>(undefined)
  const [testing, setTesting] = useState(false)
  const [testNote, setTestNote] = useState<CardNote | undefined>(undefined)
  const [migrating, setMigrating] = useState(false)
  const [sidNote, setSidNote] = useState<CardNote | undefined>(undefined)
  // The host's own verdict on the stored sid, which is the only way to learn
  // that a sealed value cannot be opened on this machine. Absent until the
  // catalog route answers — and absent forever in a deployment without one, in
  // which case the shape heuristic stands in and nothing is claimed beyond it.
  const [hostSid, setHostSid] = useState<{ storage: ComateSidStorage; problem?: string } | undefined>(undefined)
  // The host wins when it has spoken; otherwise the stored string's shape. A
  // plaintext value is never mis-reported as sealed by either source, which is
  // the one direction that would hide a credential left in the clear.
  const sidStorage: ComateSidStorage = hostSid?.storage ?? sidShape
  const mounted = useRef(true)
  // One automatic upgrade attempt per mount: a failure is reported and the user
  // gets an explicit 「立即加密」 button, rather than the card retrying a host call
  // on every render while a save is in flight.
  const migrateStarted = useRef(false)

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
      const body = await response.json() as { models?: unknown; sidStorage?: unknown; sidProblem?: unknown }
      const models = Array.isArray(body.models) ? body.models.filter(isPersistedModel) : []
      if (!mounted.current) return
      setCatalog(models)
      setCatalogFailed(false)
      // The verdict is kept separate from the model list: an unknown or missing
      // field leaves the previous one in place rather than downgrading a known
      // state to a guess.
      const storage = toSidStorage(body.sidStorage)
      if (storage !== undefined) {
        setHostSid(typeof body.sidProblem === 'string' && body.sidProblem !== ''
          ? { storage, problem: body.sidProblem }
          : { storage })
      }
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
  //
  // Each effect copies the previous value into a local BEFORE writing its ref,
  // and only that local is read inside the `setDraft*` updater. The updater is
  // lazy — it runs during a later render — so reading `ref.current` inside it
  // would see the value the effect itself just wrote: the "has the user touched
  // this?" test would always answer "yes" and the draft would never re-seed.
  // That is precisely how the model list ended up with every box unchecked: the
  // saved selection arrives (or the directory does) after the card mounts, the
  // draft is still the empty seed, and the re-seed never fired.
  const prevSavedCookieOnly = useRef(savedCookieOnly)
  const prevSavedMaxTokens = useRef(savedMaxTokens)
  const prevSavedModelCaps = useRef<string | undefined>(undefined)
  const prevSavedEnabled = useRef<ReadonlySet<string> | undefined>(undefined)
  useEffect(() => {
    const previous = prevSavedCookieOnly.current
    if (previous === savedCookieOnly) return
    prevSavedCookieOnly.current = savedCookieOnly
    setDraftCookieOnly(current => (current === previous ? savedCookieOnly : current))
  }, [savedCookieOnly])
  // Same treatment as the cookie toggle: the cap is not a secret, so a draft the
  // user has not touched follows a value changed from another surface.
  useEffect(() => {
    const previous = prevSavedMaxTokens.current
    if (previous === savedMaxTokens) return
    prevSavedMaxTokens.current = savedMaxTokens
    setDraftMaxTokens(current => (current === String(previous) ? String(savedMaxTokens) : current))
  }, [savedMaxTokens])
  // The per-model map, by the same rule: a draft the user has not touched follows
  // a map changed from another surface (another card, or a hand-edited
  // cordis.patch.yml), while a touched one is left alone. `undefined` means
  // "nothing observed yet" — the draft was seeded from that very value by
  // `useState`, so there is nothing to re-seed on the first run.
  useEffect(() => {
    const previous = prevSavedModelCaps.current
    prevSavedModelCaps.current = savedModelCapsKey
    if (previous === undefined || previous === savedModelCapsKey) return
    setDraftModelCaps(current => (capKey(parseCapDrafts(current).caps) === previous
      ? textCapDrafts(savedModelCaps)
      : current))
  }, [savedModelCapsKey, savedModelCaps])
  // The directory arrives asynchronously, so the saved set moves from the empty
  // set to "everything discovered" once the fetch lands — which re-seeds a draft
  // the user has not touched yet. `undefined` means "nothing observed yet": the
  // draft was seeded from that very value by `useState`, so there is nothing to
  // re-seed on the first run.
  //
  // The comparison is over membership, not over a joined key: a draft holding
  // the same ids in another order is still untouched, and a joined string would
  // call it touched and freeze it forever.
  useEffect(() => {
    const previous = prevSavedEnabled.current
    prevSavedEnabled.current = savedEnabledIds
    if (previous === undefined || sameIdSet(previous, savedEnabledIds)) return
    setDraftEnabled(current => (sameIdSet(current, previous) ? new Set(savedEnabledIds) : current))
  }, [savedEnabledIds])

  const writable = comateSettingsWritable(settingsScope)
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
  // The per-model boxes: `invalid` holds the ids whose text is not a cap at all,
  // and `caps` is what Save would write.
  const capDrafts = parseCapDrafts(draftModelCaps)
  const modelCapsInvalid = capDrafts.invalid.length > 0
  const modelCapsDirty = capKey(capDrafts.caps) !== savedModelCapsKey
  const dirty = sidDirty
    || draftCookieOnly !== savedCookieOnly
    || maxTokensDirty
    || modelCapsDirty
    || !sameIdSet(draftEnabled, savedEnabledIds)

  /**
   * Upgrade a plaintext stored sid to encrypted storage.
   *
   * The plaintext never enters the browser: the host seals the value it already
   * holds (`fromStored`) and only the ciphertext comes back, which the card then
   * writes through the ordinary settings path.
   *
   * This runs once automatically when the card opens on a plaintext value — the
   * point of the change is that no plaintext credential stays behind, and a user
   * who never opens the card would otherwise keep one forever. A failure is
   * reported rather than retried in a loop; the button beside the status line
   * retries on demand.
   */
  const migratePlaintext = useCallback(async (): Promise<void> => {
    if (settingsScope === undefined) return
    setMigrating(true)
    setSidNote(undefined)
    try {
      const answer = await sealStoredComateSid()
      await writeComateSettings(settingsScope, { wpsSid: answer.sealed })
      if (!mounted.current) return
      setSidNote({ tone: 'ok', text: t('row.sidMigrated', { length: answer.length }) })
    } catch (cause: unknown) {
      if (!mounted.current) return
      setSidNote({ tone: 'error', text: t('row.sidMigrateFailed', { message: messageOf(cause) }) })
    } finally {
      if (mounted.current) setMigrating(false)
    }
  }, [settingsScope, t])

  useEffect(() => {
    // Skipped while the user is mid-edit: a typed replacement (or a staged clear)
    // wins, and saving it seals it anyway.
    if (sidStorage !== 'plaintext' || !writable || saving || migrating) return
    if (draftSid !== null || clearPending || migrateStarted.current) return
    migrateStarted.current = true
    void migratePlaintext()
  }, [sidStorage, writable, saving, migrating, draftSid, clearPending, migratePlaintext])

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
    setDraftModelCaps(textCapDrafts(savedModelCaps))
    setError(undefined)
    setSidNote(undefined)
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
    setSidNote(undefined)
    try {
      // A typed sid is sealed BEFORE anything is written: the settings document
      // must never receive a plaintext credential. A failed seal aborts the whole
      // save rather than writing the other fields — a save that "succeeded" while
      // the sid silently stayed behind is worse than a visible failure.
      let sealedSid: string | undefined
      let sealedLength: number | undefined
      if (sidReplace) {
        try {
          const answer = await sealComateSid(trimmedSid)
          sealedSid = answer.sealed
          sealedLength = answer.length
        } catch (cause: unknown) {
          if (mounted.current) setError(t('row.sidSealFailed', { message: messageOf(cause) }))
          return
        }
      }
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
        // a typed replacement sends its SEALED form, an empty draft omits the
        // field entirely so the stored value survives untouched.
        ...(clearPending ? { wpsSid: '' } : sidReplace ? { wpsSid: sealedSid } : {}),
        cookieOnly: draftCookieOnly,
        enabledModelIds,
        // Only a usable draft is written: an invalid box keeps Save disabled, so
        // this branch is about the untouched-but-unparsable edge (a value stored
        // by hand that this card cannot round-trip) rather than normal use.
        ...(draftMaxTokensValue === undefined ? {} : { maxOutputTokens: draftMaxTokensValue }),
        // The per-model map is written only when it CHANGED: unlike the fields
        // above it has a compact "nothing to say" spelling (an empty map), and a
        // save that only moved a checkbox should not rewrite it. When it did
        // change the WHOLE map goes out — that is how a cleared box removes its
        // key from the document.
        ...(modelCapsDirty ? { maxOutputTokensByModel: capDrafts.caps } : {}),
      })
      if (!mounted.current) return
      setDraftSid(null)
      setClearPending(false)
      setSavedFlash(true)
      // Record the verdict this save just established, rather than waiting for
      // the next catalog read: the host sealed this very value, so the key file
      // demonstrably works on this machine, and a staged clear leaves nothing to
      // open. Without this the status line would keep showing the state from
      // before the save until the card is reopened.
      if (clearPending) setHostSid({ storage: 'unset' })
      else if (sealedSid !== undefined) setHostSid({ storage: 'sealed' })
      // The plaintext length is the one property of the credential this UI ever
      // showed, and after sealing it can no longer be read off the stored value.
      if (sealedLength !== undefined) {
        setSidNote({ tone: 'ok', text: t('row.sidSavedSealed', { length: sealedLength }) })
      }
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
  const sidConfigured = sidStorage !== 'unset'
  // "Leave empty to keep the current value" is only true when the stored value is
  // one this machine can still use or upgrade. For an unreadable one the honest
  // prompt is to paste again, so it gets the plain placeholder.
  const sidKeepsStored = sidStorage === 'sealed' || sidStorage === 'plaintext'
  // `unreadable` is a WARNING, not a configured state the user can rely on: the
  // credential is present but unusable on this machine, and the failure would
  // otherwise surface much later as an unexplained 401 from the upstream.
  const sidStatusText = sidStorage === 'sealed'
    ? t('row.sidSet')
    : sidStorage === 'plaintext'
      ? t('row.sidSetPlain')
      : sidStorage === 'unreadable'
        ? t('row.sidUnreadable')
        : t('row.sidUnset')
  const sidStatusTone = sidStorage === 'sealed'
    ? 'ok'
    : sidStorage === 'unset' ? 'empty' : 'warn'

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
                  className={`dsm-comate-status-dot ${sidStatusTone === 'ok' ? 'dsm-comate-status-ok' : 'dsm-comate-status-empty'}`}
                />
                <span className={sidStatusTone === 'warn' ? 'dsm-comate-status-warn' : undefined}>
                  {sidStatusText}
                </span>
                {/* The reason comes from the host and is never invented here: an
                    empty box beside the warning would be worse than the warning
                    alone. */}
                {sidStorage === 'unreadable' && hostSid?.problem !== undefined
                  ? (
                      <span className="dsm-comate-status-warn">
                        {t('row.sidUnreadableWhy', { reason: hostSid.problem })}
                      </span>
                    )
                  : null}
                {/* The retry path for a failed automatic upgrade. Shown only while
                    a plaintext value is still stored, so the state is never a
                    dead end the user cannot act on. */}
                {sidStorage === 'plaintext' && writable
                  ? (
                      <button
                        type="button"
                        className="dsm-btn dsm-btn-outline"
                        disabled={saving || migrating}
                        onClick={() => {
                          migrateStarted.current = true
                          void migratePlaintext()
                        }}
                      >
                        {migrating ? t('row.sidMigrating') : t('row.sidMigrate')}
                      </button>
                    )
                  : null}
              </div>
              <div className="dsm-comate-field">
                <label className="dsm-comate-label" htmlFor="dsh-comate-wps-sid">{t('row.sidLabel')}</label>
                <div className="dsm-comate-sid-row">
                  <input
                    id="dsh-comate-wps-sid"
                    className="dsm-comate-input dsm-comate-input-secret"
                    // Password type: the value is painted as dots and never as
                    // text — not even while focused, and with no reveal toggle.
                    type="password"
                    // `new-password` (rather than `off`) is what actually stops
                    // the browser's password manager from offering to save it,
                    // and stops autofill from painting a stored credential into
                    // a field the user may then mistake for the current one.
                    autoComplete="new-password"
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    aria-describedby="dsh-comate-wps-sid-hint"
                    // The browser lets a password field be copied even though it
                    // cannot be read; these four events close that door.
                    onCopy={blockClipboard}
                    onCut={blockClipboard}
                    onDragStart={blockClipboard}
                    onContextMenu={blockClipboard}
                    placeholder={clearPending
                      ? t('row.sidClearPending')
                      : sidKeepsStored
                        ? t('row.sidPlaceholderSet')
                        : t('row.sidPlaceholder')}
                    value={draftSid ?? ''}
                    disabled={!writable || saving || clearPending || migrating}
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
                <p className="dsm-comate-hint" id="dsh-comate-wps-sid-hint">{t('row.sidHint')}</p>
                {sidNote === undefined ? null : <Note note={sidNote} />}
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
                            <div className="dsm-comate-model-main">
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
                              {/* One cap box per model. Empty = follow the default
                                  above (the placeholder shows that number), so an
                                  override can be undone by clearing the box —
                                  there is no separate "reset" control to hunt for. */}
                              <div className="dsm-comate-model-cap">
                                <input
                                  className="dsm-comate-input dsm-comate-input-number"
                                  type="number"
                                  inputMode="numeric"
                                  min={0}
                                  step={1}
                                  spellCheck={false}
                                  aria-label={t('row.modelCapAria', { model: model.name, global: savedMaxTokens })}
                                  title={t('row.modelCapTitle')}
                                  placeholder={String(savedMaxTokens)}
                                  value={draftModelCaps[model.id] ?? ''}
                                  disabled={!writable || saving}
                                  aria-invalid={capDrafts.invalid.includes(model.id)}
                                  onChange={event => {
                                    const text = event.currentTarget.value
                                    setDraftModelCaps(current => ({ ...current, [model.id]: text }))
                                  }}
                                />
                                <span className="dsm-comate-unit">{t('row.maxTokensUnit')}</span>
                              </div>
                            </div>
                            <p className="dsm-comate-model-meta">
                              {formatContext(model.contextWindow)} context · {model.id}
                            </p>
                          </div>
                        ))}
                      </div>
                      <p className={`dsm-comate-hint${modelCapsInvalid ? ' dsm-comate-hint-error' : ''}`}>
                        {modelCapsInvalid
                          ? t('row.modelCapInvalid')
                          : t('row.modelCapHint', { global: savedMaxTokens })}
                      </p>
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
                  disabled={!writable || !dirty || saving || maxTokensInvalid || modelCapsInvalid
                    || (sidReplace && trimmedSid.startsWith('wps_sid='))}
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
