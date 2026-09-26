import { A as isSealed, B as COMATE_EXTRA_THINKING_LEVELS, C as defaultConfigCandidates, D as COMATE_SECRET_DIRNAME, E as parseComateModel, F as COMATE_CATALOG_PATH, G as COMATE_THINKING_LEVEL_WIRE, H as COMATE_SEALED_PREFIX, I as COMATE_CHECK_PATH, J as unwrapVolatile, K as asVolatile, L as COMATE_CLIENT_NAME, M as openSecret, N as sealSecret, O as COMATE_SECRET_KEY_ENV, P as COMATE_BASE_THINKING_LEVELS, R as COMATE_DEFAULT_MAX_TOKENS, S as defaultComateHome, T as parseComateConfig, U as COMATE_SEAL_PATH, V as COMATE_REFRESH_PATH, W as COMATE_SETTINGS_NS, Y as unwrapVolatileDeep, _ as COMATE_DEFAULT_CONTEXT_WINDOW, a as comateCheckBody, b as COMATE_SID_ENV, c as classifyUpstreamError, d as emptyUploadStats, f as normalizeChatImages, g as COMATE_CONFIG_ENV, h as safeMessage, i as COMATE_CHECK_TIMEOUT_MS, j as machineFingerprint, k as COMATE_SECRET_KEY_FILENAME, l as prepareChatBody, m as uploadChatImages, n as COMATE_CHECK_MAX_TOKENS, o as runComateCheck, p as sanitizeImageSource, q as isSealedComateSecret, r as COMATE_CHECK_READ_LIMIT, s as ComateUpstreamClient, t as COMATE_CONNECT_VERSION, u as emptyImageStats, v as COMATE_HOME_ENV, w as defaultSecretKeyFile, x as ComateCredentialStore, z as COMATE_ENTRY_ID } from "./version-BJtfo7Fd.js";
import z from "@deepseek-ai/schemastery";
import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { resolveImageAttachmentAccess, resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { Readable } from "node:stream";
//#region src/max-tokens.ts
/**
* Output-token cap resolution for the `comate` route.
*
* 背景（0.3.3 之前的实际情况，已核过代码）：
*
*   `adapter.ts` 把模型描述符的 `maxTokens` 写死成 `COMATE_DEFAULT_MAX_TOKENS`
*   （32000）。那个值**不构成请求上限**——`dsh-llm-pi-ai` 的 profile 文档原话是
*   "This sizes the model; it never becomes a per-request cap on its own"
*   （`lib/types/config.d.ts`，`defaultMaxTokens` 条目），真正把上限落到请求上的
*   是 harness 的 `resolveCallWithInfo`：
*
*     config.maxTokens === undefined && info.defaultMaxTokens !== undefined
*       ? { ...config, maxTokens: info.defaultMaxTokens } : config
*
*   而 `info.defaultMaxTokens` 只由 profile 的 `configuredMaxTokens`（按模型 id）
*   供给——本插件的那个 Map 一直是**空的**。于是：32000 只出现在「模型容量」的
*   描述里，出站请求里根本没有 `max_tokens` 字段，上游用自己默认的上限。
*
* 本模块把那个值变成「一处可配置、且真的生效」的东西：
*
*   解析出的上限 → profile 的 `configuredMaxTokens` → harness 物化进
*   `config.maxTokens` → pi-ai 写 `max_tokens` → 网关执行。
*
* 优先级：`WPS_COMATE_MAX_TOKENS`（env）> 每模型条目 `maxOutputTokensByModel[id]`
* > 全局字段 `maxOutputTokens` > 32000 默认。
* env 优先于卡片，是**故意**的：无头/脚本场景（`scripts/verify-*.mjs`、CI）必须
* 能压过本机卡片里存的值，否则一个已保存的 32000 会让脚本里的覆盖静默失效。
*
* ## 每模型一层（0.4.1-rc.1）
*
* 同一个网关上的模型上下文窗口并不一样，一个统一的 32000 对窗口小的模型是浪费、
* 对窗口大的模型是浪费余地——而真正按模型算的那个值只能由用户定。所以全局字段
* 降级成「默认值」，`maxOutputTokensByModel` 里的条目按模型 id 覆盖它：
* **缺席 = 跟随全局**，`0` = 这个模型不设上限（与全局 `0` 同义，但只作用于这一个）。
* 一层一层的写法让「改默认值」仍然是一次改动，不必逐个模型重填。
*
* 取值语义：**正整数 = 上限，0 = 不设上限**。0 之所以有意义，是因为上游认它——
* 真机实测（2026-09，本机）：`max_tokens: 0` 与不传该字段的表现一致（完整输出、
* `finish_reason=stop`），而 `max_tokens: 16` 会 `finish_reason=length`。
*
* @module dsh-connect-comate/max-tokens
*/
/**
* Env var forcing the output cap, whatever the saved card value says.
*
* 正整数 = 上限，`0` = 不设上限；空值/非法值会被忽略并记在
* {@link ComateMaxTokensResolution.ignored} 里（不抛错：一个打错的 env 不该让
* 插件装配失败）。
*/
const COMATE_MAX_TOKENS_ENV = "WPS_COMATE_MAX_TOKENS";
/**
* The value that means "no cap at all".
*
* 不是「上限为 0」：上游把它当作「没给这个字段」，harness 那边则表现为
* **不物化** `config.maxTokens`（见 {@link comateConfiguredMaxTokens}）。
*/
const COMATE_UNLIMITED_MAX_TOKENS = 0;
/**
* Read one candidate value: positive integer = cap, `0` = unlimited, anything
* else = unusable.
*
* Strings are accepted because the env layer always delivers one; numbers come
* from the settings schema. Blank strings are "absent", NOT zero — `Number('')`
* is 0, which would silently turn an empty env var into "unlimited".
*
* @param value - a raw candidate (number, string, or anything else).
* @returns the cap, or undefined when the value is not usable.
*/
function parseMaxOutputTokens(value) {
	const text = typeof value === "string" ? value.trim() : void 0;
	if (text !== void 0 && text === "") return void 0;
	const numeric = typeof value === "number" ? value : text !== void 0 ? Number(text) : void 0;
	if (numeric === void 0 || !Number.isSafeInteger(numeric) || numeric < 0) return void 0;
	return numeric;
}
/**
* Normalize the per-model override map (`maxOutputTokensByModel`).
*
* Tolerates anything a hand-edited `cordis.patch.yml` can contain: a non-object
* reads as "no overrides", a blank key is dropped, and an entry whose value is
* not a usable cap is **left out of the map** (a per-model entry is one model's
* setting, so a broken one must not poison the others).
*
* Dropping is not the same as hiding: {@link unusableModelTokens} returns the
* same entries this function refused, so the caller can say so out loud.
*
* @param value - the raw settings field (`maxOutputTokensByModel`).
* @returns the usable overrides, keyed by model id (value 0 = unlimited).
*/
function parseMaxTokensByModel(value) {
	const entries = /* @__PURE__ */ new Map();
	for (const [id, raw] of modelCapEntries(value)) {
		const cap = parseMaxOutputTokens(raw);
		if (cap !== void 0) entries.set(id, cap);
	}
	return entries;
}
/**
* The entries {@link parseMaxTokensByModel} had to drop.
*
* @param value - the raw settings field (`maxOutputTokensByModel`).
* @returns one record per unusable entry, in the map's own order.
*/
function unusableModelTokens(value) {
	const refused = [];
	for (const [id, raw] of modelCapEntries(value)) if (parseMaxOutputTokens(raw) === void 0) refused.push({
		modelId: id,
		raw
	});
	return refused;
}
/**
* Iterate the field's own key/value pairs, skipping what is not a map at all.
*
* A blank key is skipped rather than kept: it names no model, so no request
* could ever match it.
*/
function* modelCapEntries(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return;
	for (const [id, raw] of Object.entries(value)) {
		if (id.trim() === "") continue;
		yield [id, raw];
	}
}
/**
* The raw entry for one model, or `undefined` when the field has none.
*
* Read through {@link modelCapEntries} rather than by index so a field that is
* not a map at all (a string, an array) answers "no entry" instead of throwing
* or matching a character index.
*/
function rawModelCap(value, modelId) {
	for (const [id, raw] of modelCapEntries(value)) if (id === modelId) return raw;
}
/**
* Resolve the effective output cap for one model.
*
* Layers, highest first: env → the model's own entry → the global field →
* {@link COMATE_DEFAULT_MAX_TOKENS}. The per-model layer sits above the global
* one so a model can be pinned without disturbing the rest, and below the env
* var so headless runs keep their absolute override.
*
* @param query - the model id, the override map, the global value, and the env.
* @returns the cap (0 = unlimited) and the layer that decided it.
*/
function resolveComateMaxTokens(query = {}) {
	const env = query.env ?? process.env;
	const fromEnv = parseMaxOutputTokens(env[COMATE_MAX_TOKENS_ENV]);
	if (fromEnv !== void 0) return {
		value: fromEnv,
		source: "env"
	};
	const envIgnored = ignoredEnv(env);
	if (query.modelId !== void 0) {
		const raw = rawModelCap(query.byModel, query.modelId);
		if (raw !== void 0) {
			const cap = parseMaxOutputTokens(raw);
			if (cap !== void 0) return {
				value: cap,
				source: "model",
				...envIgnored
			};
			return {
				...globalOr(query.configValue, envIgnored),
				ignored: envIgnored.ignored ?? {
					layer: "model",
					raw,
					modelId: query.modelId
				}
			};
		}
	}
	return globalOr(query.configValue, envIgnored);
}
/** The two global layers: the settings field, then the plugin default. */
function globalOr(configValue, extra) {
	const fromConfig = parseMaxOutputTokens(configValue);
	if (fromConfig !== void 0) return {
		value: fromConfig,
		source: "config",
		...extra
	};
	return {
		value: COMATE_DEFAULT_MAX_TOKENS,
		source: "default",
		...extra
	};
}
/**
* Resolve the effective output cap, ignoring any per-model override.
*
* Kept as the global-field entry point (the card's default, `bin` diagnostics,
* the cap-override warning): it answers "what does the shared setting say".
*
* @param configValue - the settings field's value (`maxOutputTokens`).
* @param env - environment to read {@link COMATE_MAX_TOKENS_ENV} from.
* @returns the cap (0 = unlimited) and the layer that decided it.
*/
function resolveMaxOutputTokens(configValue, env = process.env) {
	return resolveComateMaxTokens({
		configValue,
		env
	});
}
/**
* Report an env value that was set but unusable, so the fall-through to the
* card's value is visible rather than silent.
*
* A blank value is NOT reported: `parseMaxOutputTokens` reads it as "absent", so
* `WPS_COMATE_MAX_TOKENS=` (an empty assignment, or a CI variable expanded to
* nothing) is a normal "not set" rather than a mistake worth a warning.
*/
function ignoredEnv(env) {
	const raw = env[COMATE_MAX_TOKENS_ENV];
	if (raw === void 0 || raw.trim() === "") return {};
	if (parseMaxOutputTokens(raw) !== void 0) return {};
	return { ignored: {
		layer: "env",
		raw
	} };
}
/**
* The cap as a pi-ai model descriptor must spell it.
*
* pi-ai refuses a non-positive `maxTokens`, so "unlimited" cannot be written as
* 0 there. It is spelled as the model's own context window instead: the widest
* cap this route can express, and the value the thinking-budget ceiling falls
* back to. The *effective* per-request cap is still governed by
* {@link comateConfiguredMaxTokens}, which omits the model entirely when the
* cap is unlimited — so this number never becomes a request cap on its own.
*
* @param cap - the resolved cap (0 = unlimited).
* @param contextWindow - the model's context window.
* @returns a positive integer for the descriptor's `maxTokens`.
*/
function comateModelMaxTokens(cap, contextWindow) {
	return cap === 0 ? contextWindow : cap;
}
/**
* The profile's `configuredMaxTokens` map: the per-model caps the harness
* materializes into a request that names none of its own.
*
* One entry per model, because the cap is resolved per model: two models on this
* route can legitimately carry different caps, and a model pinned to "unlimited"
* must be left OUT of the map rather than listed with 0 — a 0 here is what the
* harness would materialize into `max_tokens: 0`, and `defaultMaxTokens` must be
* a positive integer where pi-ai validates it.
*
* @param caps - `[modelId, cap]` pairs, cap 0 = unlimited.
* @returns the map to hand to the pi-ai provider profile.
*/
function comateConfiguredMaxTokens(caps) {
	const configured = /* @__PURE__ */ new Map();
	for (const [id, cap] of caps) {
		if (cap === 0) continue;
		configured.set(id, cap);
	}
	return configured;
}
//#endregion
//#region src/thinking-levels.ts
/**
* Which thinking levels this route offers, and what each one sends.
*
* 背景：`dsh-llm-pi-ai` 把「可选档位」和「发什么值」两件事都压在模型描述符的
* `thinkingLevelMap` 上（`getSupportedThinkingLevels()` 决定选择器列出哪些，
* pi-ai 的 openai-completions 用它把档位翻成 `reasoning_effort`）。所以本插件
* 能做的只有一件事：**决定那张表里每个档位是 `null`（不提供）还是线值**。
*
* 默认表 = 四个基础档位照原样发 + `off` / `xhigh` / `max` 三个档位钉成 `null`
* （不提供）。用户手动打开的那几个档位会被填上线值——线值本身以及为什么是这些
* 值（`none` 实测无效、`xhigh`/`max` 实测与 `high` 无差别、以及打开 `off` 会连带
* 改掉「不指定档位」的含义）都记在 `bridge.ts` 的
* {@link COMATE_THINKING_LEVEL_WIRE} 上，那里是**两半共用**的唯一一份事实。
*
* 本模块只负责「把设置里那个字符串数组读成一张干净的档位集合」，外加一个可被
* 测的纯函数式建表。设置字段本身可能来自手写的 `cordis.patch.yml`，所以容错规则
* 与 `max-tokens.ts` 同款：坏条目**只丢自己**，并把「丢了什么」交出去给宿主打日志。
*
* @module dsh-connect-comate/thinking-levels
*/
[...COMATE_BASE_THINKING_LEVELS, ...COMATE_EXTRA_THINKING_LEVELS];
/**
* The default table: the four base levels send themselves, the three extra ones
* are not offered.
*
* 这是「用户什么都没打开」时的表，也是 0.4.1-rc.2 的行为——所以它必须逐字节
* 不变，否则升级会悄悄改掉所有人的选择器。
*/
const COMATE_THINKING_LEVEL_MAP = buildThinkingLevelMap([]);
/**
* Build the table for one set of manually enabled extra levels.
*
* 基础四个永远照原样发（它们就是 OpenAI 的词汇表本身）；`extra` 里的档位填
* {@link COMATE_THINKING_LEVEL_WIRE} 的线值，其余三个保持 `null`。未在 `extra`
* 里出现的档位**显式**钉成 `null` 而不是留空：pi-ai 对 `xhigh` / `max` 的缺省
* 判定与基础档位相反（缺省 = 不支持），显式写出来两边才一致。
*
* @param extra - the manually enabled levels; unknown entries are ignored.
* @returns the `thinkingLevelMap` a model descriptor must carry.
*/
function buildThinkingLevelMap(extra) {
	const enabled = new Set(extra);
	const map = {};
	for (const level of COMATE_BASE_THINKING_LEVELS) map[level] = level;
	for (const level of COMATE_EXTRA_THINKING_LEVELS) map[level] = enabled.has(level) ? COMATE_THINKING_LEVEL_WIRE[level] : null;
	return map;
}
/**
* Read the `extraThinkingLevels` field into the levels it actually names.
*
* 容错：非数组读作「什么都没打开」（默认行为）；数组里的条目逐个校验，认不出的
* 丢掉、其余照用——一个手打错的档位名不该让整份设置失效，更不该让插件装配失败。
* 重复项去重，并按 {@link COMATE_EXTRA_THINKING_LEVELS} 的顺序归一化：选择器里
* 的先后由这张表决定，不由用户在 YAML 里敲的顺序决定。
*
* @param value - the raw settings field.
* @returns the enabled levels, ordered as the card shows them.
*/
function parseExtraThinkingLevels(value) {
	if (!Array.isArray(value)) return [];
	const named = new Set(value.filter((entry) => typeof entry === "string").map((entry) => entry.trim()));
	return COMATE_EXTRA_THINKING_LEVELS.filter((level) => named.has(level));
}
/**
* The entries {@link parseExtraThinkingLevels} refused, in the field's own order.
*
* 与 `max-tokens.ts` 的 `unusableModelTokens` 同一个理由：被丢掉的条目在卡片里
* 表现为「没勾」，与「从没勾过」长得一模一样，只有日志能把它们分开。
*
* 这一层不是多虑：`z.array(z.string())` 只要求是字符串，所以 `[off, xhight]`
* 这种拼错能过 schema 校验、一路走到这里。
*
* @param value - the raw settings field.
* @returns one record per unusable entry (the raw value, deduplicated).
*/
function unusableThinkingLevels(value) {
	if (!Array.isArray(value)) return value === void 0 || value === null ? [] : [value];
	const known = new Set(COMATE_EXTRA_THINKING_LEVELS);
	const refused = [];
	for (const entry of value) {
		if (typeof entry === "string" && known.has(entry.trim())) continue;
		if (!refused.some((seen) => seen === entry)) refused.push(entry);
	}
	return refused;
}
//#endregion
//#region src/adapter.ts
/**
* The `comate` pi-ai provider: one loopback-backed adapter registered
* into the Harness LLM seam, assembled from public `dsh-llm-pi-ai`
* extension points.
*
* 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
*   — pi-ai provider 的装配方式（createProvider + openAICompletionsApi +
*     inert auth plane + 用 shim 的进程内 secret 作为 apiKey）由该项目
*     （转引自 corrinehu/dsh-workbuddy-connect，MIT）实现并验证。
* 改动：模型描述符的多模态由 Comate config 的 llm_types 判定
*   （`llm-multimodal` → 图片输入），而非用户手动勾选；输出上限由
*   `max-tokens.ts` 解析（env / 每模型条目 / 全局字段，0 = 不设上限），同时落进
*   描述符的 `maxTokens` 与 profile 的 `configuredMaxTokens`——只有后者会成为**真**
*   上限（harness 的 `resolveCallWithInfo` 把它物化成 `config.maxTokens`），
*   而且**逐个模型**解析：同一路由上的两个模型可以各用各的上限。
*   `llm_types` 在真机上是**数组**（本机 10 个模型里 5 个带多模态标记），
*   归一化在 `auth.ts` 的 `parseLlmTypes`；出站图片的线形状修正在
*   `multimodal.ts`（实测网关对裸字符串/假 base64/svg 会静默给空正文）。
*
* @module dsh-connect-comate/adapter
*/
/** Provider route this bundle owns. */
const COMATE_PROVIDER = "comate";
/** Provider idle ceiling while one stream read is outstanding. */
const COMATE_STREAM_IDLE_TIMEOUT_MS = 3e5;
/**
* Image-request budgets at the dsh-llm-pi-ai defaults; the profile type made
* them required in 0.1.1-rc.2.
*/
const REQUEST_IMAGE_BUDGETS = {
	maxRequestImageBytes: 20971520,
	requestImagePixelBudget: 4194304,
	requestImageMaxBytes: 1048576
};
/**
* Inert pi-ai auth plane. The comate route authenticates only through the
* shim shared secret resolved per request by `resolveApiKey`, so pi-ai's own
* credential lifecycle and ambient discovery must never manufacture a
* credential for it. `PiAiAdapterOptions.auth` is required since 0.1.1-rc.2;
* every ambient question here answers "nothing stored, nothing set".
*/
const INERT_AUTH = {
	credentials: {
		async read() {},
		async list() {
			return [];
		},
		async modify() {
			throw new Error("dsh-connect-comate: the comate route has no pi-ai credential lifecycle");
		},
		async delete() {}
	},
	authContext: {
		async env() {},
		async fileExists() {
			return false;
		}
	}
};
/** No per-token pricing is knowable for a subscription quota; report zero. */
const NO_COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0
};
/**
* pi-ai input modalities: images only when Comate advertises `llm-multimodal`.
*
* `llmTypes` 是数组（见 `auth.ts` 的 `parseLlmTypes`）。真机 10 个模型里 5 个带
* `llm-multimodal`，网关也确认接受 base64 图片（`multimodal.ts` 里有实测表），
* 所以这个函数是「DSH 允许附图片」的唯一开关。
*/
function comateModelInput(model) {
	return model.llmTypes?.includes("llm-multimodal") === true ? ["text", "image"] : ["text"];
}
/**
* Build one pi-ai model descriptor pointing at the loopback shim.
*
* Exported so the reasoning declaration can be asserted against the REAL
* descriptor rather than a copy of it: `getSupportedThinkingLevels()` on this
* object is exactly what the model picker offers.
*
* @param info - one catalog entry.
* @param baseUrl - the shim origin plus `/v1`.
* @param maxOutputTokens - the resolved output cap; `0` means "no cap", spelled
* here as the model's own window because pi-ai refuses a non-positive
* `maxTokens` (see `comateModelMaxTokens`).
* @param tuning - the per-model display name and the route's extra thinking
* levels; see {@link ComateModelTuning}.
* @returns the pi-ai model descriptor.
*/
function comatePiModel(info, baseUrl, maxOutputTokens = COMATE_DEFAULT_MAX_TOKENS, tuning = {}) {
	const extra = tuning.extraThinkingLevels ?? [];
	return {
		id: info.id,
		name: tuning.alias ?? info.name,
		api: "openai-completions",
		provider: COMATE_PROVIDER,
		baseUrl,
		input: comateModelInput(info),
		cost: NO_COST,
		contextWindow: info.contextWindow,
		maxTokens: comateModelMaxTokens(maxOutputTokens, info.contextWindow),
		reasoning: true,
		thinkingLevelMap: extra.length === 0 ? COMATE_THINKING_LEVEL_MAP : buildThinkingLevelMap(extra),
		compat: {
			supportsReasoningEffort: true,
			thinkingFormat: "openai",
			maxTokensField: "max_tokens"
		}
	};
}
/**
* Assemble the adapter. The provider's `getModels` reads the live catalog,
* and every model's `baseUrl` is re-resolved per read so the shim's
* ephemeral port applies from the first snapshot after startup.
*/
function createComateAdapter(options) {
	const { shim, catalog } = options;
	/** Live read of the configured cap for one model; `0` means "no cap". */
	const outputCap = (modelId) => options.maxOutputTokens?.(modelId) ?? 32e3;
	const buildModels = () => {
		const baseUrl = `${shim.baseUrl()}/v1`;
		const extraThinkingLevels = options.extraThinkingLevels?.() ?? [];
		return catalog.current().map((info) => comatePiModel(info, baseUrl, outputCap(info.id), {
			alias: options.modelAlias?.(info.id),
			extraThinkingLevels
		}));
	};
	const provider = {
		...createProvider({
			id: COMATE_PROVIDER,
			name: "WPS Comate",
			auth: { apiKey: {
				name: "WPS Comate loopback bearer",
				async resolve({ credential }) {
					const apiKey = credential?.key;
					return apiKey === void 0 || apiKey.length === 0 ? void 0 : {
						auth: { apiKey },
						source: "Comate"
					};
				}
			} },
			models: buildModels(),
			api: openAICompletionsApi()
		}),
		getModels: () => buildModels()
	};
	/**
	* Build the profile snapshot: the catalog and the output cap are both read
	* fresh, because `configuredMaxTokens` is what the harness turns into the
	* request's `max_tokens` — a saved cap must land here, not only in the model
	* descriptors.
	*/
	const buildProfile = () => ({
		provider: COMATE_PROVIDER,
		displayName: "WPS Comate",
		streamIdleTimeoutMs: COMATE_STREAM_IDLE_TIMEOUT_MS,
		retryPolicy: resolveRetryPolicy(void 0, "dsh-connect-comate retryPolicy"),
		configuredMaxTokens: comateConfiguredMaxTokens(catalog.current().map((info) => [info.id, outputCap(info.id)])),
		modelErrors: /* @__PURE__ */ new Map(),
		...REQUEST_IMAGE_BUDGETS,
		piProvider: provider
	});
	let profiles = /* @__PURE__ */ new Map([[COMATE_PROVIDER, buildProfile()]]);
	return {
		adapter: new PiAiAdapter({
			profiles: () => profiles,
			auth: INERT_AUTH,
			resolveApiKey: async () => shim.token(),
			resolveAttachments: () => options.attachments?.(),
			resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(attachments, (hostPath) => options.toProcessPath?.(hostPath), ref),
			...options.onReplayDegrade === void 0 ? {} : { onReplayDegrade: options.onReplayDegrade }
		}),
		invalidate: () => {
			profiles = /* @__PURE__ */ new Map([[COMATE_PROVIDER, buildProfile()]]);
		}
	};
}
//#endregion
//#region src/assets.ts
/**
* 图片外置：把请求体里的 inline base64 图片换成模型后端能直接抓取的 URL。
*
* 为什么需要它（本机实测，2026-09-25，`llmproxy/v1/user/chat/completions`，
* 96×96 纯色 PNG，手填 wps_sid 凭据；同一张图按形状各发一次，只看模型是否答对
* 颜色）：
*
* | 模型 | `image_url:{url:'data:image/png;base64,…'}` | `image_url:{url:'https://…'}` |
* | --- | --- | --- |
* | deepseek-v4.1-flash / MiniMax-M3 / kimi-k3 / glm-5.3-flash | 答对 | 答对 |
* | mimo-v2.5 | 200 + SSE `请求参数值有误(unsupported message.content type=image)` | 答对 |
*
* 即 **URL 载荷 5/5 通用，inline base64 对 mimo 必失败**；而 mimo 的网关路由本身
* 是多模态的（响应 id 前缀 `llm-multimodal-xiaomi-mimo-v2.5`），所以这不是能力
* 缺失，是它的后端不收 inline 字节、只自己去抓 URL。位置也不是原因：图片放在
* user 消息、tool 消息（`read_image` 工具结果的真实形状）、或从 tool 提到 user，
* 三种都试过，mimo 一律在 ~205ms（远快于模型推理）被拒。
*
* 于是这里复刻桌面端那三步，接口取自 `binaries/agents/default-agent/tools/
* video-generation/video-upload.js` 的 presign 分支（同一套 assets 接口）：
*
*   Step1 `POST <assetBase>/assets/presign-upload`   → 预签名 PUT URL + relative_key
*   Step2 `PUT  <upload_url>`                        → 字节直传对象存储
*   Step3 `POST <assetBase>/assets/presign-download` → 临时下载 URL（给模型后端抓）
*
* 凭据只用 `Cookie: wps_sid=…`（与桌面端一致，实测可用）。拿不到 cookie、或三步中
* 任何一步失败，都**返回 undefined**，调用方保留 base64 原样发出：本机 5 个模型里
* 有 4 个吃 base64，退回去不会比现状更糟，而多模态功能也不会因为一次上传抖动而整体
* 挂掉。
*
* @module dsh-connect-comate/assets
*/
/** 覆盖资产接口地址（私有化部署/排障用）。 */
const COMATE_ASSET_BASE_ENV = "WPS_COMATE_ASSET_BASE";
/** 资产接口挂在网关同源的 `/api/comate/v1` 下。 */
const COMATE_ASSET_PATH = "/api/comate/v1";
/** 下载 URL 上读不到有效期时的保守默认值。 */
const DEFAULT_DOWNLOAD_TTL_MS = 3e5;
/** 提前量：有效期剩余不足这个数就重新预签名，避免 URL 在模型抓取途中过期。 */
const DOWNLOAD_TTL_MARGIN_MS = 3e4;
/** presign 接口超时；上传走独立（更长）超时。 */
const PRESIGN_TIMEOUT_MS = 2e4;
const UPLOAD_TIMEOUT_MS = 6e4;
/** 解析资产接口地址：env 覆盖优先，否则取网关同源。 */
function resolveAssetBase(baseUrl, env = process.env) {
	const override = env[COMATE_ASSET_BASE_ENV];
	if (typeof override === "string" && override.trim() !== "") return override.trim().replace(/\/+$/, "");
	try {
		return `${new URL(baseUrl).origin}${COMATE_ASSET_PATH}`;
	} catch {
		return;
	}
}
/** 解出 `data:image/<type>;base64,<payload>` 的字节；不是真 base64 图片时 undefined。 */
function decodeImageDataUrl(dataUrl) {
	const match = /^data:(image\/[a-z0-9.+-]+)(?:;[^,]*)?;base64,([\s\S]*)$/i.exec(dataUrl.trim());
	if (match === null) return void 0;
	const payload = match[2].replace(/\s+/g, "");
	if (payload === "") return void 0;
	const bytes = Buffer.from(payload, "base64");
	if (bytes.length === 0) return void 0;
	return {
		mime: match[1].toLowerCase(),
		bytes
	};
}
/** 从预签名 URL 的查询串读有效期（ks3 用 `X-Amz-Expires` 秒数，部分实现用 `Expires` 时间戳）。 */
function downloadUrlExpiry(url, now = Date.now()) {
	try {
		const params = new URL(url).searchParams;
		const expires = params.get("X-Amz-Expires");
		if (expires !== null) {
			const seconds = Number(expires);
			if (Number.isFinite(seconds) && seconds > 0) return now + seconds * 1e3;
		}
		const absolute = params.get("Expires");
		if (absolute !== null) {
			const epoch = Number(absolute);
			if (Number.isFinite(epoch) && epoch > 0) return epoch * 1e3;
		}
	} catch {}
	return now + DEFAULT_DOWNLOAD_TTL_MS;
}
/** 按 mime 猜一个文件名（relative_key 由服务端生成，这里只是给接口一个像样的入参）。 */
function filenameFor(mime) {
	const ext = mime.split("/")[1]?.replace(/[^a-z0-9]/gi, "") ?? "png";
	return `image.${ext === "" ? "png" : ext}`;
}
/**
* 桌面端同款 presign 上传器。
*
* 按内容 sha256 缓存 `relative_key`：同一张图（多轮对话里每轮都会重发）只上传
* 一次；下载 URL 按有效期复用，过期才重新预签名。**刻意不接调用方的
* AbortSignal**：上传结果会被后续请求复用，让一个断开的请求取消共享上传会让
* 另一个正在等同一张图的请求一起失败。每次上传有自己的超时上限。
*/
var ComatePresignUploader = class {
	cache = /* @__PURE__ */ new Map();
	env;
	fetchImpl;
	constructor(options = {}) {
		this.env = options.env ?? process.env;
		this.fetchImpl = options.fetch ?? fetch;
	}
	async upload(dataUrl, credential) {
		const decoded = decodeImageDataUrl(dataUrl);
		if (decoded === void 0) return void 0;
		const cookie = credential.cookie;
		if (cookie === void 0 || cookie.trim() === "") return void 0;
		const base = resolveAssetBase(credential.baseUrl, this.env);
		if (base === void 0) return void 0;
		const hash = createHash("sha256").update(decoded.bytes).digest("hex");
		let pending = this.cache.get(hash);
		if (pending === void 0) {
			pending = this.uploadOnce(base, cookie, decoded);
			this.cache.set(hash, pending);
		}
		const asset = await pending;
		if (asset === void 0) {
			this.cache.delete(hash);
			return;
		}
		return this.freshUrl(base, cookie, asset);
	}
	/** 三步走：presign-upload → PUT → presign-download。 */
	async uploadOnce(base, cookie, decoded) {
		const presign = await this.presignUpload(base, cookie, decoded.mime);
		if (presign === void 0) return void 0;
		if (!await this.putBytes(presign, decoded)) return void 0;
		const download = await this.presignDownload(base, cookie, presign.relativeKey);
		if (download === void 0) return void 0;
		return {
			relativeKey: presign.relativeKey,
			url: download.url,
			expiresAt: download.expiresAt
		};
	}
	/** 复用未过期的下载 URL，过期则只重新预签名（不重传字节）。 */
	async freshUrl(base, cookie, asset) {
		if (Date.now() + DOWNLOAD_TTL_MARGIN_MS < asset.expiresAt) return asset.url;
		const download = await this.presignDownload(base, cookie, asset.relativeKey);
		if (download === void 0) return asset.url;
		asset.url = download.url;
		asset.expiresAt = download.expiresAt;
		return asset.url;
	}
	/** Step1：要一个预签名 PUT URL。 */
	async presignUpload(base, cookie, mime) {
		const response = await this.postJson(`${base}/assets/presign-upload`, cookie, {
			filename: filenameFor(mime),
			content_type: mime
		}, PRESIGN_TIMEOUT_MS);
		if (response === void 0) return void 0;
		const data = response.data;
		if (data === void 0 || data === null) return void 0;
		const uploadUrl = typeof data.upload_url === "string" ? data.upload_url : "";
		const relativeKey = typeof data.relative_key === "string" ? data.relative_key : "";
		if (uploadUrl === "" || relativeKey === "") return void 0;
		return {
			uploadUrl,
			method: typeof data.method === "string" && data.method.trim() !== "" ? data.method.trim() : "PUT",
			headers: isPlainObject(data.headers) ? Object.fromEntries(Object.entries(data.headers).map(([k, v]) => [k, String(v)])) : {},
			relativeKey
		};
	}
	/** Step2：把字节直传对象存储。 */
	async putBytes(presign, decoded) {
		const headers = {
			...presign.headers,
			"Content-Length": String(decoded.bytes.length)
		};
		if (Object.keys(headers).every((key) => key.toLowerCase() !== "content-type")) headers["Content-Type"] = decoded.mime;
		try {
			return (await this.fetchImpl(presign.uploadUrl, {
				method: presign.method.toUpperCase(),
				headers,
				body: decoded.bytes,
				signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS)
			})).ok;
		} catch {
			return false;
		}
	}
	/** Step3：把 relative_key 换成临时下载 URL。 */
	async presignDownload(base, cookie, relativeKey) {
		const response = await this.postJson(`${base}/assets/presign-download`, cookie, { relative_keys: [relativeKey] }, PRESIGN_TIMEOUT_MS);
		if (response === void 0) return void 0;
		const items = response.data?.items;
		if (!Array.isArray(items)) return void 0;
		const first = items[0];
		const url = isPlainObject(first) && typeof first["download_url"] === "string" ? first["download_url"] : "";
		if (url === "") return void 0;
		return {
			url,
			expiresAt: downloadUrlExpiry(url)
		};
	}
	/** POST JSON + `Cookie`；成功且 `code === 0` 才返回解析后的响应体。 */
	async postJson(url, cookie, body, timeoutMs) {
		try {
			const response = await this.fetchImpl(url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"Cookie": cookie
				},
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(timeoutMs)
			});
			if (!response.ok) return void 0;
			const parsed = await response.json();
			if (!isPlainObject(parsed)) return void 0;
			return parsed["code"] === 0 ? parsed : void 0;
		} catch {
			return;
		}
	}
};
function isPlainObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
//#endregion
//#region src/catalog.ts
/**
* Derive the runtime catalog from the discovered directory plus the user's
* explicit enabled-id selection (参考 dsh-connect-workbuddy 的 deriveCatalog，
* MIT)：空选择回退为整个目录，保证从未配置过的插件仍然暴露全部模型；一旦
* 用户保存过显式勾选，运行时只暴露勾选项，未勾选的不进入模型列表。
*/
function selectComateModels(models, enabled) {
	if (enabled.size === 0) return models.map((model) => ({ ...model }));
	return models.filter((model) => enabled.has(model.id)).map((model) => ({ ...model }));
}
/** Mutable catalog shared by the shim's `/v1/models` and the adapter. */
var ComateCatalog = class {
	models = [];
	/** Current entries; empty until the config has been read once. */
	current() {
		return this.models;
	}
	/** Replace the list; callers invalidate their adapter snapshot after this. */
	set(models) {
		this.models = models.map((model) => ({ ...model }));
	}
};
//#endregion
//#region src/model-alias.ts
/**
* Read the `modelAliases` field into the aliases it actually sets.
*
* 规则（两半共用，所以写在注释里当契约）：
*
* - 键和值都 trim；trim 后为空的键或值**都不进表**——空串不是「把名字改空」，
*   而是「没有别名」，回落到发现名。这也是卡片里清空输入框能撤销别名的原因。
* - 值不是字符串的条目丢掉，其余照用：手写 YAML 里的 `{id: 123}` 不该让整张表
*   失效，更不该让插件装配失败。
* - 用 `Map` 而不是普通对象：键来自上游给的模型 id，`__proto__` 这种键不该有机会
*   碰到原型。
*
* @param value - the raw settings field.
* @returns the usable aliases; empty when the field is absent or unreadable.
*/
function parseModelAliases(value) {
	const aliases = /* @__PURE__ */ new Map();
	if (value === null || typeof value !== "object" || Array.isArray(value)) return aliases;
	for (const [rawId, rawName] of Object.entries(value)) {
		if (typeof rawName !== "string") continue;
		const id = rawId.trim();
		const name = rawName.trim();
		if (id === "" || name === "") continue;
		aliases.set(id, name);
	}
	return aliases;
}
/**
* The entries {@link parseModelAliases} refused, in the field's own order.
*
* 被丢掉的条目在卡片里表现为「空框」，与「从没设过」长得一模一样；只有日志能把
* 它们分开，所以宿主需要知道丢的是哪个模型、原值长什么样。
*
* @param value - the raw settings field.
* @returns one record per unusable entry.
*/
function unusableModelAliases(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
	const refused = [];
	for (const [rawId, rawName] of Object.entries(value)) {
		if (typeof rawName === "string" && rawName.trim() !== "" && rawId.trim() !== "") continue;
		refused.push({
			modelId: rawId,
			raw: rawName
		});
	}
	return refused;
}
/**
* One model's alias, or `undefined` to keep the discovered name.
*
* @param aliases - the parsed table.
* @param modelId - the model the descriptor is being built for.
*/
function modelAliasOf(aliases, modelId) {
	return aliases.get(modelId);
}
//#endregion
//#region src/title-fix.ts
/**
* DSH 标题生成请求的预算修复（方案 A）。
*
* 背景（真机实测，2026-09-26）：
*
*   DSH 的 `dsh-session-title-first-prompt-llm` 发起标题请求时固定
*   `max_tokens=64`，而 Comate 网关对多数推理模型把 `max_tokens` 当作
*   **总预算（含 reasoning/thinking）**。标题任务的思考 token 超过 64 后
*   `finish_reason=length`、正文为 0，DSH 把这次的失败静默吞掉，只剩
*   fallback 的首条消息截断标题——表现就是「任务完成后没写标题」。
*
*   实测各模型思考量（标题任务、max_tokens=64）：deepseek-v4-pro ~109
*   字符、MiniMax-M3 ~262、mimo-v2.5(-pro) ~240-252、glm-5.2 ~249、
*   glm-5.3 ~268——全部吃光 64 直接 length；deepseek-v4.1-flash 思考
*   波动（~164）跨过 64 就偶发失败。预算提到 1024 后这些模型均正常出
*   正文；mimo 系的思考随预算膨胀（256→1121 字符、512→2189 仍 length），
*   单独调预算救不了，由 {@link applyTitleReasoningFix} 的
*   `reasoning_effort: "off"` 处理（关掉思考直接出标题）；glm-5.3 不吃
*   任何关思考的拼写，只认预算，两者互为兜底。
*
* 实现：只识别 DSH 标题请求（system 含固定文案 `Create a concise
* title ...`），把 `max_tokens` 从小于 {@link COMATE_TITLE_MAX_TOKENS}
* 的任意值提到 1024。普通任务请求的 system 不会命中，一字不动。
*
* @module dsh-connect-comate/title-fix
*/
/** 标题请求的预算下限：低于它的会被提到这个值。真机验证 1024 对 v4-pro /
* MiniMax-M3 / glm-5.2 / glm-5.3 均足够（思考量级约 100-300 token）。 */
const COMATE_TITLE_MAX_TOKENS = 1024;
/**
* DSH 标题 system 的固定文案片段。宽松匹配（忽略大小写、允许空白差异），
* 宿主改了措辞小变体也能命中；正常任务 prompt 不会包含这句话。
*/
const TITLE_SYSTEM_RE = /create\s+a\s+concise\s+title/i;
/** 消息 content 可能是 string 或 OpenAI 内容块数组，统一取文本。 */
function messageText(value) {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value.map((part) => typeof part === "object" && part !== null && "text" in part ? String(part.text) : "").join("");
	return "";
}
/**
* 解析请求体并判定是否 DSH 标题请求。不抛错：
* 任何解析失败 / 结构怪异都返回 `matched: false`。
*/
function inspectTitleRequest(source) {
	let body;
	try {
		body = JSON.parse(source);
	} catch {
		return { matched: false };
	}
	if (typeof body !== "object" || body === null || Array.isArray(body)) return { matched: false };
	const obj = body;
	if (!Array.isArray(obj["messages"])) return { matched: false };
	const matched = obj["messages"].some((message) => {
		if (typeof message !== "object" || message === null || Array.isArray(message)) return false;
		const msg = message;
		return msg["role"] === "system" && TITLE_SYSTEM_RE.test(messageText(msg["content"]));
	});
	return matched ? {
		obj,
		matched
	} : { matched: false };
}
/**
* 识别 DSH 标题请求并提升其 `max_tokens` 预算。
*
* 纯函数、不抛错：任何解析失败都原样返回（`matched: false`），与
* `prepareChatBody` 的容错风格一致——shim 的聊天数据路径不许因为一个
* 辅助改写挂掉整个请求。
*/
function applyTitleBudgetFix(source) {
	const { obj, matched } = inspectTitleRequest(source);
	if (!matched || obj === void 0) return {
		body: source,
		matched: false
	};
	const current = obj["max_tokens"];
	if (typeof current !== "number" || !Number.isFinite(current) || current < 1) return {
		body: source,
		matched: true
	};
	if (current >= 1024) return {
		body: source,
		matched: true,
		before: current
	};
	obj["max_tokens"] = COMATE_TITLE_MAX_TOKENS;
	return {
		body: JSON.stringify(obj),
		matched: true,
		before: current,
		after: COMATE_TITLE_MAX_TOKENS
	};
}
/**
* 识别 DSH 标题请求并注入 `reasoning_effort: "off"`（方案 B）。
*
* 预算提升（方案 A）救不了思考随预算膨胀的模型（mimo 系实测 256→1121、
* 512→2189 字符仍 length）；关掉思考后它们直接输出标题。对已显式携带
* `reasoning_effort` 的请求不覆盖（DSH 现在不传，但将来传了就尊重它）。
* 网关不认 off 的模型（glm-5.3 实测不吃任何关思考拼写）由预算方案兜底，
* 注入本身无害。
*/
function applyTitleReasoningFix(source) {
	const { obj, matched } = inspectTitleRequest(source);
	if (!matched || obj === void 0) return {
		body: source,
		matched: false,
		injected: false
	};
	const existing = obj["reasoning_effort"];
	if (existing !== void 0) return {
		body: source,
		matched: true,
		injected: false,
		existing: typeof existing === "string" ? existing : String(existing)
	};
	obj["reasoning_effort"] = "off";
	return {
		body: JSON.stringify(obj),
		matched: true,
		injected: true
	};
}
//#endregion
//#region src/shim.ts
/**
* Loopback OpenAI-compatible endpoint. The pi-ai provider points here; the
* shim applies the Comate wire quirks (forced streaming, string
* `tool_choice`, Comate-shaped headers) and forwards to the real upstream.
* It binds 127.0.0.1 only and never serves another interface.
*
* 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
*   — 入站加固的四重校验（Host 必须回环、Origin 必须回环、chat POST 必须
*     JSON、bearer 必须匹配进程内随机 secret）、常量时间比对、
*     随机端口绑定、body 上限、上游错误分类到 HTTP 状态码的映射，
*     均由该项目（转引自 corrinehu/dsh-workbuddy-connect，MIT）设计并验证。
* 改动：安全相关代码不做「改善」，原样沿用，仅替换上游类型与命名。
* v0.4.2：**出口**（`writeOpenAIError`）统一过 `safeMessage` 脱敏。之前只有低频的
*   `check.ts` 有这层，常驻的聊天数据路径反而没有；上游正文里回显一条 Cookie 或
*   Bearer 就会原样交给 pi-ai。
*
* @module dsh-connect-comate/shim
*/
const REQUEST_BODY_LIMIT = 67108864;
/**
* Loopback hostnames the shim's own in-process client uses.
*
* Exported because the read-only catalog route applies the SAME inbound checks:
* one vocabulary for "what counts as this machine" beats two copies that can
* drift apart.
*/
const LOOPBACK_HOSTS = /* @__PURE__ */ new Set([
	"127.0.0.1",
	"localhost",
	"[::1]"
]);
/** Strip the optional :port from a Host header value, IPv6-bracket aware. */
function hostnameOfHost(host) {
	let hostname = host.trim().toLowerCase();
	if (hostname.startsWith("[")) {
		const end = hostname.indexOf("]");
		return end === -1 ? hostname : hostname.slice(0, end + 1);
	}
	const colon = hostname.lastIndexOf(":");
	if (colon !== -1 && /^\d+$/.test(hostname.slice(colon + 1))) hostname = hostname.slice(0, colon);
	return hostname;
}
/**
* The request's Host header must name the loopback interface. A DNS-rebinding
* page (attacker domain re-resolved to 127.0.0.1) sends its own domain in
* Host, so this check drops those before any routing happens.
*/
function hostIsLoopback(host) {
	if (host === void 0 || host.trim() === "") return false;
	return LOOPBACK_HOSTS.has(hostnameOfHost(host));
}
/**
* A browser-sent Origin (present header) must be loopback. Non-browser
* clients (the plugin's own fetch calls) send no Origin at all and pass.
*/
function originIsLoopback(origin) {
	if (origin === void 0 || origin.trim() === "") return true;
	try {
		const { hostname } = new URL(origin);
		return LOOPBACK_HOSTS.has(hostname) || hostname === "::1";
	} catch {
		return false;
	}
}
/** Chat-completion POSTs must carry a JSON body type (simple-request CSRF drops here). */
function isJsonContentType(req) {
	const type = req.headers["content-type"];
	return typeof type === "string" && type.trim().toLowerCase().startsWith("application/json");
}
/** HTTP status each upstream failure class surfaces as. */
const KIND_STATUS = {
	hard_credit: 402,
	soft_rate: 429,
	session_dead: 401,
	not_found: 502,
	server: 502,
	client: 400
};
function writeJson(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(payload)
	});
	res.end(payload);
}
/**
* Write one OpenAI-shaped error, redacting the message on the way out.
*
* 这里是**唯一**的错误出口：调用方给的是上游原文（`result.message`）、是
* `String(error)`、还是我们自己写死的常量，都在这一处过筛。放在出口而不是每个
* 调用点，是因为「记得脱敏」是件靠不住的事——上游正文里回显一条 `Cookie` 或一个
* Bearer，就够把真凭据交给 pi-ai 与浏览器面板；漏掉一个分支的代价，比在这里多跑
* 一次正则大得多。写死的常量过一遍无害（规则对 `[redacted]` 幂等）。
*/
function writeOpenAIError(res, status, kind, message) {
	writeJson(res, status, { error: {
		message: safeMessage(message),
		type: kind,
		code: kind
	} });
}
/** Read a request body with a size cap; over-limit bodies fail the request. */
function readBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > REQUEST_BODY_LIMIT) {
				reject(/* @__PURE__ */ new Error("request body too large"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks)));
		req.on("error", reject);
	});
}
/**
* Start the loopback endpoint. Requests must carry the shim's shared secret;
* the loopback bind alone is not a trust boundary.
*/
function createComateShim(options) {
	const { store, client, catalog, uploader } = options;
	const logger = options.logger;
	const SHARED_SECRET = randomBytes(32).toString("base64url");
	/** Constant-time bearer check; absent or mismatched bearers are rejected. */
	function bearerOk(req) {
		const header = req.headers.authorization;
		if (typeof header !== "string") return false;
		const match = /^Bearer\s+(.+)$/i.exec(header.trim());
		if (match === null) return false;
		const presented = match[1];
		const expected = SHARED_SECRET;
		const a = Buffer.from(presented);
		const b = Buffer.from(expected);
		if (a.length !== b.length) return false;
		return timingSafeEqual(a, b);
	}
	const server = createServer((req, res) => {
		handle(req, res);
	});
	const ready = new Promise((resolve, reject) => {
		server.once("listening", () => resolve());
		server.once("error", reject);
	});
	server.listen(0, "127.0.0.1");
	const baseUrl = () => {
		const address = server.address();
		if (address === null || typeof address === "string") throw new Error("comate shim has no listening address");
		return `http://127.0.0.1:${address.port}`;
	};
	async function handle(req, res) {
		try {
			if (!hostIsLoopback(req.headers.host)) {
				writeOpenAIError(res, 403, "host_not_allowed", "Host header must name the loopback interface");
				return;
			}
			if (!originIsLoopback(req.headers.origin)) {
				writeOpenAIError(res, 403, "origin_not_allowed", "Origin must be a loopback origin");
				return;
			}
			if (!bearerOk(req)) {
				writeOpenAIError(res, 401, "unauthorized", "missing or invalid Authorization bearer");
				return;
			}
			const url = req.url ?? "/";
			if (req.method === "GET" && (url === "/healthz" || url === "/healthz/")) {
				writeJson(res, 200, { ok: true });
				return;
			}
			if (req.method === "GET" && (url === "/v1/models" || url === "/v1/models/")) {
				writeJson(res, 200, {
					object: "list",
					data: catalog.current().map((model) => ({
						id: model.id,
						object: "model",
						created: 0,
						owned_by: "comate"
					}))
				});
				return;
			}
			if (req.method === "POST" && (url === "/v1/chat/completions" || url === "/v1/chat/completions/")) {
				await chatCompletions(req, res);
				return;
			}
			writeOpenAIError(res, 404, "not_found", `no such route: ${req.method} ${url}`);
		} catch (error) {
			if (!res.headersSent) writeOpenAIError(res, 500, "internal", String(error));
			else res.end();
		}
	}
	async function chatCompletions(req, res) {
		if (!isJsonContentType(req)) {
			writeOpenAIError(res, 415, "unsupported_media_type", "Content-Type must be application/json");
			return;
		}
		let credential;
		try {
			credential = await store.resolve();
		} catch (error) {
			writeOpenAIError(res, 401, "not_signed_in", String(error));
			return;
		}
		const raw = (await readBody(req)).toString("utf8");
		const controller = new AbortController();
		req.on("close", () => controller.abort());
		const imageStats = emptyImageStats();
		const uploadStats = emptyUploadStats();
		let prepared = prepareChatBody(raw, imageStats);
		const titleFix = applyTitleBudgetFix(prepared);
		if (titleFix.matched && titleFix.before !== void 0 && titleFix.after !== void 0) logger?.warn(`dsh-connect-comate: title request budget raised ${titleFix.before} -> ${titleFix.after}`);
		prepared = titleFix.body;
		const titleReasoning = applyTitleReasoningFix(prepared);
		if (titleReasoning.injected) logger?.warn("dsh-connect-comate: title request reasoning disabled (reasoning_effort: off)");
		prepared = titleReasoning.body;
		try {
			prepared = await uploadChatImages(prepared, uploader, credential, uploadStats);
		} catch (error) {
			logger?.warn("dsh-connect-comate: image externalization failed, sending inline images", safeMessage(error));
		}
		if (imageStats.stripped > 0 || imageStats.dropped > 0 || uploadStats.externalized > 0 || uploadStats.failed > 0) logger?.warn(`dsh-connect-comate: image content handled (seen=${imageStats.seen}, repaired=${imageStats.repaired}, stripped=${imageStats.stripped}, dropped=${imageStats.dropped}, externalized=${uploadStats.externalized}, upload_failed=${uploadStats.failed})`);
		const result = await client.chatStream(credential, prepared, controller.signal);
		if (!result.ok) {
			writeOpenAIError(res, KIND_STATUS[result.kind], result.kind, `comate upstream ${result.kind} (http ${result.status}): ${result.message}`);
			return;
		}
		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			"Connection": "keep-alive",
			"X-Accel-Buffering": "no"
		});
		let sawDone = false;
		const body = Readable.fromWeb(result.response.body);
		body.on("data", (chunk) => {
			if (chunk.includes("[DONE]")) sawDone = true;
		});
		body.on("error", (error) => {
			logger?.warn("dsh-connect-comate: upstream stream failed mid-flight", safeMessage(error));
			if (!sawDone && res.writable) res.end("data: [DONE]\n\n");
		});
		body.pipe(res);
	}
	return {
		ready,
		baseUrl,
		token: () => SHARED_SECRET,
		close: () => new Promise((resolve, reject) => {
			server.close(() => resolve());
			server.closeAllConnections();
			server.once("error", reject);
		})
	};
}
//#endregion
//#region src/settings-surface.ts
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
function bindComateSettings(ctx, schema, base, onChange) {
	const settings = ctx.settings;
	const configure = settings.configure;
	if (typeof configure === "function") {
		ctx.effect(() => configure.call(settings, { auto: false }, ctx.fiber), "dsh-connect-comate: settings page policy");
		ctx.on("loader/volatile-update", onChange);
		return {
			settingsNs: ctx.fiber.entry?.options.id ?? "dsh-connect-comate",
			current: () => unwrapVolatileDeep(base)
		};
	}
	const register = settings.register;
	if (typeof register !== "function") {
		ctx.logger.error("dsh-connect-comate: the settings service exposes neither configure (0.1.7) nor register (0.1.5); refusing to register the provider half-assembled");
		return;
	}
	const scope = register.call(settings, COMATE_SETTINGS_NS, schema, { base: unwrapVolatileDeep(base) });
	const releaseWatch = scope.watch(onChange);
	ctx.effect(() => () => releaseWatch(), "dsh-connect-comate: settings watch");
	return {
		settingsNs: COMATE_SETTINGS_NS,
		current: () => scope.get()
	};
}
//#endregion
//#region src/web-status.ts
/** Request-body ceiling for the action routes; a sid is a few dozen bytes. */
const ACTION_BODY_LIMIT = 8192;
/** Write one JSON response with an explicit length so the socket can be reused. */
function json(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Content-Length": Buffer.byteLength(payload),
		"Cache-Control": "no-store"
	});
	res.end(payload);
}
/**
* Apply every inbound gate, or report the refusal.
*
* Two independent origin gates: Host catches a DNS-rebinding page (its own
* domain in Host, resolved to 127.0.0.1), Origin catches a cross-site browser
* fetch. A non-browser client sends no Origin and passes the second gate only
* because it already passed the first. POSTs additionally demand a JSON content
* type — the same simple-request CSRF drop the shim applies to chat POSTs, since
* a form-encoded cross-site post cannot set it.
*/
function refuse(req, method) {
	if (req.method !== method) return {
		status: 405,
		error: "method not allowed"
	};
	if (!hostIsLoopback(req.headers.host) || !originIsLoopback(req.headers.origin)) return {
		status: 403,
		error: "origin-not-trusted"
	};
	if (method === "POST" && !isJsonContentType(req)) return {
		status: 415,
		error: "expected application/json"
	};
}
/** Read a bounded JSON body; an empty body reads as ``. */
async function readJsonBody(req) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		const buffer = chunk;
		size += buffer.length;
		if (size > ACTION_BODY_LIMIT) throw new Error("request body too large");
		chunks.push(buffer);
	}
	const text = Buffer.concat(chunks).toString("utf8").trim();
	return text === "" ? {} : JSON.parse(text);
}
/** Narrow an untrusted body to the probe's optional draft fields. */
function toCheckInput(body) {
	if (body === null || typeof body !== "object" || Array.isArray(body)) return {};
	const raw = body;
	const input = {};
	if (typeof raw["wpsSid"] === "string") input.wpsSid = raw["wpsSid"];
	if (typeof raw["cookieOnly"] === "boolean") input.cookieOnly = raw["cookieOnly"];
	if (typeof raw["model"] === "string" && raw["model"].trim() !== "") input.model = raw["model"].trim();
	return input;
}
/** Narrow an untrusted body to the seal request's two shapes. */
function toSealInput(body) {
	if (body === null || typeof body !== "object" || Array.isArray(body)) return {};
	const raw = body;
	const input = {};
	if (typeof raw["sid"] === "string" && raw["sid"].trim() !== "") input.sid = raw["sid"];
	if (raw["fromStored"] === true) input.fromStored = true;
	return input;
}
/**
* Register the status and action routes for as long as the composing deployment
* provides a web server.
*
* `ctx.inject` is the right shape rather than `ctx.get`: an Electron/file-IPC
* deployment has no `webServer` at all, and there the callback simply never runs
* — the card then shows "no model directory yet" and its buttons report the
* action is unavailable, while model serving is unaffected, because the
* adapter's catalog comes from the local Comate config and never from these
* routes.
*
* @param ctx - the plugin's context.
* @param deps - live readers over the host's discovery state.
* @param actions - the three actions the card can trigger.
*/
function registerComateStatusRoute(ctx, deps, actions) {
	ctx.inject(["webServer"], (webCtx) => {
		/** The current status answer, shared by the GET and the refresh route. */
		const snapshot = async () => {
			const answer = {
				signedIn: deps.signedIn(),
				providerRegistered: deps.providerRegistered(),
				models: [...deps.models()]
			};
			if (deps.sidState === void 0) return answer;
			try {
				const state = await deps.sidState();
				if (state.problem === void 0) return {
					...answer,
					sidStorage: state.storage
				};
				return {
					...answer,
					sidStorage: state.storage,
					sidProblem: state.problem
				};
			} catch {
				return answer;
			}
		};
		const routes = [
			{
				path: COMATE_CATALOG_PATH,
				method: "GET",
				handler: async (req, res) => {
					const denied = refuse(req, "GET");
					if (denied !== void 0) {
						json(res, denied.status, { error: denied.error });
						return;
					}
					try {
						json(res, 200, await snapshot());
					} catch {
						json(res, 500, { error: "catalog unavailable" });
					}
				}
			},
			{
				path: COMATE_REFRESH_PATH,
				method: "POST",
				handler: async (req, res) => {
					const denied = refuse(req, "POST");
					if (denied !== void 0) {
						json(res, denied.status, { error: denied.error });
						return;
					}
					try {
						await readJsonBody(req);
						await actions.refresh();
						json(res, 200, await snapshot());
					} catch {
						json(res, 500, { error: "refresh failed" });
					}
				}
			},
			{
				path: COMATE_CHECK_PATH,
				method: "POST",
				handler: async (req, res) => {
					const denied = refuse(req, "POST");
					if (denied !== void 0) {
						json(res, denied.status, { error: denied.error });
						return;
					}
					let input;
					try {
						input = toCheckInput(await readJsonBody(req));
					} catch {
						json(res, 400, { error: "invalid JSON body" });
						return;
					}
					try {
						json(res, 200, await actions.check(input));
					} catch {
						json(res, 500, { error: "check failed" });
					}
				}
			},
			{
				path: COMATE_SEAL_PATH,
				method: "POST",
				handler: async (req, res) => {
					const denied = refuse(req, "POST");
					if (denied !== void 0) {
						json(res, denied.status, { error: denied.error });
						return;
					}
					let input;
					try {
						input = toSealInput(await readJsonBody(req));
					} catch {
						json(res, 400, { error: "invalid JSON body" });
						return;
					}
					if (input.sid === void 0 && input.fromStored !== true) {
						json(res, 400, { error: "expected a non-empty \"sid\", or \"fromStored\": true" });
						return;
					}
					try {
						json(res, 200, await actions.seal(input));
					} catch (error) {
						json(res, 500, { error: safeMessage(error) });
					}
				}
			}
		];
		for (const route of routes) {
			const dispose = webCtx.webServer.register({
				kind: "exact",
				path: route.path,
				handler: route.handler
			});
			webCtx.effect(() => dispose, `dsh-connect-comate: ${route.path}`);
		}
	});
}
//#endregion
//#region src/index.ts
/** Stable Cordis plugin name. */
const name = "dsh-connect-comate";
/** The model registry and settings store required before the provider can register. */
const inject = ["llm", "settings"];
const persistedModelConfig = z.object({
	id: z.string().required(),
	name: z.string().required(),
	multimodal: z.boolean(),
	contextWindow: z.number().step(1).min(1)
});
/**
* The four fields the card writes. Each one is declared volatile so 0.1.7's
* write gate (`volatileForm` non-empty, then `isVolatilePath` per written path)
* accepts it; on 0.1.5 `asVolatile` is an identity no-op and the schema stays
* exactly the shape that line validated before.
*/
const Config = z.object({
	configFile: z.string().description("WPS Comate config.json 路径（默认 ~/.wpscomate/config.json）"),
	wpsSid: asVolatile(z.string().description("手动填写的 WPS 登录 Cookie：打开 www.wps.cn → F12 → Application → Cookies 取 wps_sid 的值（只填值，不带 \"wps_sid=\" 前缀）。卡片里以密码框呈现（只显示圆点、不可复制），保存时由宿主加密成 enc:v1: 密文再写入本文件，因此这里通常是一串密文而非明文。")),
	cookieOnly: asVolatile(z.boolean().description("只使用 Cookie 鉴权（不发送 Authorization 头）；上游报 API 密钥无效时开启")),
	lastCatalog: z.array(persistedModelConfig).default([]).description("已弃用：宿主不再回写目录，卡片改从只读路由读取"),
	enabledModelIds: asVolatile(z.array(z.string()).default([]).description("勾选启用的模型 id；留空表示全部启用")),
	maxOutputTokens: asVolatile(z.number().step(1).min(0).default(COMATE_DEFAULT_MAX_TOKENS).description("输出 token 上限（默认值，所有模型共用）：正整数为上限，0 表示不设上限（由上游决定）；单个模型可在 maxOutputTokensByModel 里覆盖；环境变量 WPS_COMATE_MAX_TOKENS 存在时优先于两者生效")),
	maxOutputTokensByModel: asVolatile(z.dict(z.number().step(1).min(0)).default({}).description("按模型 id 覆盖输出 token 上限：正整数为上限，0 表示该模型不设上限；未列出的模型跟随 maxOutputTokens")),
	modelAliases: asVolatile(z.dict(z.string()).default({}).description("按模型 id 设置显示名别名：只改 DSH 模型选择器里显示的名字，不改 id（请求、输出上限表、default-model 用的都是 id）；值留空即撤销该别名")),
	extraThinkingLevels: asVolatile(z.array(z.string()).default([]).description("额外开放的思考档位（off / xhigh / max 的子集，默认不开放；基础档位 minimal/low/medium/high 始终提供）。off 实测能真正关掉思考，但打开它也会让「provider default」变成不思考；xhigh/max 实测被上游接受、效果与 high 无差别"))
});
/** Convert a discovered Comate model into the card-facing shape. */
function toPersistedModel(model) {
	return {
		id: model.id,
		name: model.name,
		multimodal: comateModelInput(model).includes("image"),
		contextWindow: model.contextWindow
	};
}
/**
* Start the loopback endpoint, register the `comate` provider, and seed the
* model catalog from the desktop client's own config.
*/
function apply(ctx, config) {
	const store = new ComateCredentialStore();
	const client = new ComateUpstreamClient();
	const catalog = new ComateCatalog();
	const shim = createComateShim({
		store,
		client,
		catalog,
		uploader: new ComatePresignUploader(),
		logger: ctx.logger
	});
	/**
	* Live read of the configured output cap for one model (`0` = no cap).
	*
	* Read per call rather than captured, so a saved card value applies to the
	* next request. Precedence and the `0` spelling live in `max-tokens.ts`:
	* env → that model's own entry → the global field → 32000.
	*/
	const outputCap = (modelId) => resolveComateMaxTokens({
		modelId,
		byModel: current().maxOutputTokensByModel,
		configValue: current().maxOutputTokens
	}).value;
	let stopped = false;
	ctx.effect(() => () => {
		stopped = true;
	});
	let discovered = [];
	let persistedCatalog = [];
	let signedIn = false;
	let providerRegistered = false;
	let invalidateCatalog = () => {};
	let lastConfigFile = config.configFile;
	let warnedNoAttachments = false;
	/**
	* Say out loud which output cap is in force, once per change.
	*
	* Three cases deserve a line: a value that was set but unusable (otherwise a
	* mistyped `WPS_COMATE_MAX_TOKENS` — or a hand-edited per-model entry — would
	* silently do nothing), and an env value overriding a differing saved card
	* value (otherwise the card would look broken). An ordinary save, or the plain
	* default, logs nothing.
	*/
	let lastCapNote = "";
	const reportOutputCap = (settings) => {
		const resolution = resolveMaxOutputTokens(settings.maxOutputTokens);
		const saved = resolveMaxOutputTokens(settings.maxOutputTokens, {}).value;
		const overrides = parseMaxTokensByModel(settings.maxOutputTokensByModel);
		const refused = unusableModelTokens(settings.maxOutputTokensByModel);
		const note = `${resolution.source}:${resolution.value}:${String(saved)}:${overrides.size}:${refused.length}`;
		if (note === lastCapNote) return;
		lastCapNote = note;
		if (resolution.ignored !== void 0) ctx.logger.warn(`dsh-connect-comate: ignoring the unusable ${COMATE_MAX_TOKENS_ENV} value (${JSON.stringify(resolution.ignored.raw)}); the output cap falls back to the settings field`);
		if (resolution.source === "env" && saved !== resolution.value) ctx.logger.warn(`dsh-connect-comate: ${COMATE_MAX_TOKENS_ENV} overrides the saved output cap (${resolution.value} instead of ${saved}; 0 means no cap)`);
		for (const entry of refused) ctx.logger.warn(`dsh-connect-comate: ignoring the unusable output cap for model "${entry.modelId}" (${JSON.stringify(entry.raw)}); that model follows the global cap`);
	};
	/** Live view over the plugin's own configuration section. */
	let current = () => config;
	/**
	* Live read of one model's display-name alias (`undefined` = discovered name).
	*
	* Read per call, like the output cap, so a saved rename reaches the picker on
	* the next catalog read instead of the next restart. The parsing rules are
	* shared with the card (`model-alias.ts`), so the map the card writes and the
	* map this reads can never disagree about what a blank value means.
	*/
	const modelAlias = (modelId) => modelAliasOf(parseModelAliases(current().modelAliases), modelId);
	/**
	* Live read of the manually enabled extra thinking levels.
	*
	* Empty means "offer exactly the base four" — the 0.4.1-rc.2 picker — and
	* an unreadable entry is dropped rather than taking the whole list down with
	* it, so a typo in one level cannot hide the other two.
	*/
	const extraThinkingLevels = () => parseExtraThinkingLevels(current().extraThinkingLevels);
	/**
	* Say out loud which alias / thinking-level entries could not be read.
	*
	* Same reasoning as the output-cap pass below: a dropped entry is invisible in
	* the card (the box renders empty, the level renders unchecked, which looks
	* exactly like "never set"), so the log is the only place that can name it.
	* The note is the refused entries THEMSELVES rather than their count: two
	* different typos both have length 1, and the second one still deserves a
	* line.
	*/
	let lastTuningNote = "";
	const reportModelTuning = (settings) => {
		const refusedAliases = unusableModelAliases(settings.modelAliases);
		const refusedLevels = unusableThinkingLevels(settings.extraThinkingLevels);
		const note = JSON.stringify([refusedAliases, refusedLevels]);
		if (note === lastTuningNote) return;
		lastTuningNote = note;
		for (const entry of refusedAliases) ctx.logger.warn(`dsh-connect-comate: ignoring the unusable alias for model "${entry.modelId}" (${JSON.stringify(entry.raw)}); that model keeps the name Comate reported`);
		for (const entry of refusedLevels) ctx.logger.warn(`dsh-connect-comate: ignoring the unusable thinking level ${JSON.stringify(entry)}; extraThinkingLevels accepts only ${COMATE_EXTRA_THINKING_LEVELS.join(", ")}`);
	};
	/**
	* Say out loud how the stored `wps_sid` is protected, once per change.
	*
	* Two states deserve a line. A value written by an older version is still
	* plaintext in a file the user may well share or commit — the card upgrades it,
	* but a headless run never opens the card, so the log is the only place that can
	* say so. A sealed value that cannot be opened (key file deleted, replaced, or
	* copied from another machine) otherwise presents as a plain 401, which is the
	* worst failure shape here: it looks like the upstream refusing a perfectly
	* good sid.
	*/
	let lastSidNote = "";
	const reportSidStorage = async () => {
		let resolution;
		try {
			resolution = await store.resolveSid();
		} catch (error) {
			ctx.logger.warn("dsh-connect-comate: could not inspect the stored wps_sid", error);
			return;
		}
		const note = `${resolution.storage}:${resolution.problem ?? ""}`;
		if (note === lastSidNote) return;
		lastSidNote = note;
		if (resolution.storage === "unreadable") ctx.logger.error(`dsh-connect-comate: the stored wps_sid is sealed but cannot be decrypted (${resolution.problem}); the key file ${resolution.keyFile} is missing, unreadable, or was created for another machine/user. Paste the sid again in the plugin card, or point WPS_COMATE_SECRET_KEY_FILE at the right key file.`);
		else if (resolution.storage === "plaintext") ctx.logger.warn("dsh-connect-comate: the stored wps_sid is still plaintext in the DSH settings document; open the plugin card once (or run `dsh plugin exec dsh-connect-comate seal`) to store it sealed");
	};
	/** Rebuild the runtime catalog from discovery plus the enabled-id set. */
	const republish = () => {
		const enabled = new Set(current().enabledModelIds ?? []);
		catalog.set(selectComateModels(discovered, enabled));
		persistedCatalog = discovered.map(toPersistedModel);
		invalidateCatalog();
	};
	/** Push the resolved settings into the credential store and runtime catalog. */
	const applySettings = () => {
		const next = current();
		store.setConfigFile(next.configFile);
		store.setWpsSid(next.wpsSid);
		store.setCookieOnly(next.cookieOnly === true);
		reportOutputCap(next);
		reportModelTuning(next);
		reportSidStorage();
		republish();
		if (next.configFile !== lastConfigFile) {
			lastConfigFile = next.configFile;
			rediscover();
		}
	};
	/**
	* Re-read the local Comate config and republish the directory.
	*
	* Never rejects: a signed-out machine must still register the provider (with
	* an empty catalog) so the card can explain what to do, and the
	* `configFile`-change path calls this fire-and-forget — a rejection there
	* would surface as an unhandled rejection instead of a warning.
	*/
	const rediscover = async () => {
		try {
			discovered = (await store.resolve()).models;
			signedIn = true;
		} catch (error) {
			discovered = [];
			signedIn = false;
			ctx.logger.warn("dsh-connect-comate: no signed-in WPS Comate credential; provider registered with an empty catalog (run `dsh plugin exec dsh-connect-comate doctor`)", error);
		}
		republish();
	};
	const binding = bindComateSettings(ctx, Config, config, () => {
		if (!stopped) applySettings();
	});
	if (binding === void 0) return;
	const settingsNs = binding.settingsNs;
	current = () => binding.current();
	applySettings();
	ctx.effect(() => () => {
		shim.close();
	});
	/**
	* The model the card's connection probe should use.
	*
	* The first ENABLED model, so the probe exercises a route the user actually
	* intends to use. An empty enabled set means "every discovered model", so this
	* degrades to the directory's first entry exactly when nothing is filtered.
	*/
	const enabledFirstModel = () => selectComateModels(discovered, new Set(current().enabledModelIds ?? []))[0]?.id;
	/**
	* Probe the connection with the card's (possibly unsaved) draft inputs.
	*
	* The draft never touches the store: `store.current(override)` applies it to
	* this one read, so pressing 「测试连接」 cannot change what the plugin uses, and
	* two concurrent probes cannot contaminate each other.
	*
	* Never throws — a failed probe is an answer the card renders.
	*/
	const checkConnection = async (input) => {
		const credential = await store.current({
			...input.wpsSid === void 0 ? {} : { wpsSid: input.wpsSid },
			...input.cookieOnly === void 0 ? {} : { cookieOnly: input.cookieOnly }
		});
		if (credential === void 0) return {
			ok: false,
			reason: "no-credential"
		};
		const model = input.model ?? enabledFirstModel() ?? credential.models[0]?.id;
		if (model === void 0) return {
			ok: false,
			reason: "no-model"
		};
		return runComateCheck({
			credential,
			client,
			model
		});
	};
	registerComateStatusRoute(ctx, {
		models: () => persistedCatalog,
		signedIn: () => signedIn,
		providerRegistered: () => providerRegistered,
		sidState: async () => {
			const resolved = await store.resolveSid();
			return resolved.problem === void 0 ? { storage: resolved.storage } : {
				storage: resolved.storage,
				problem: resolved.problem
			};
		}
	}, {
		refresh: rediscover,
		check: checkConnection,
		seal: (input) => input.fromStored === true ? store.sealStored() : store.seal(input.sid ?? "")
	});
	shim.ready.then(async () => {
		if (stopped) return;
		try {
			const comate = createComateAdapter({
				shim,
				catalog,
				maxOutputTokens: outputCap,
				modelAlias,
				extraThinkingLevels,
				attachments: () => {
					const attachments = ctx.get("attachments");
					if (attachments === void 0 && !warnedNoAttachments) {
						warnedNoAttachments = true;
						ctx.logger.warn("dsh-connect-comate: the host durable attachment service is unavailable; image input will fail with UNSUPPORTED_CONTENT (text requests are unaffected)");
					}
					return attachments;
				},
				toProcessPath: (hostPath) => ctx.get("fs")?.processPathFromHostPath(hostPath),
				onReplayDegrade: ({ provider, model, reason }) => {
					ctx.logger.warn(`dsh-connect-comate: unusable replay state on assistant history for route "${provider}/${model}"; sending that message as provider-neutral content (${reason})`);
				}
			});
			invalidateCatalog = () => {
				comate.invalidate();
			};
			let releaseAdapter;
			let releaseConfigurable;
			try {
				releaseAdapter = ctx.llm.registerAdapter([COMATE_PROVIDER], comate.adapter);
				releaseConfigurable = ctx.llm.registerConfigurableProviders([{
					provider: COMATE_PROVIDER,
					displayName: "WPS Comate",
					settingsNs,
					settingsPath: [],
					declared: false
				}]);
			} finally {
				if (releaseAdapter === void 0 || releaseConfigurable === void 0) {
					releaseAdapter?.();
					releaseConfigurable?.();
				}
			}
			ctx.effect(() => () => {
				releaseAdapter?.();
				releaseConfigurable?.();
			});
			providerRegistered = true;
		} catch (error) {
			ctx.logger.error("dsh-connect-comate: provider registration failed", error);
			return;
		}
		await rediscover();
	}).catch((error) => {
		ctx.logger.error("dsh-connect-comate: loopback endpoint failed to start; provider not registered", error);
	});
}
//#endregion
export { COMATE_ASSET_BASE_ENV, COMATE_BASE_THINKING_LEVELS, COMATE_CATALOG_PATH, COMATE_CHECK_MAX_TOKENS, COMATE_CHECK_PATH, COMATE_CHECK_READ_LIMIT, COMATE_CHECK_TIMEOUT_MS, COMATE_CLIENT_NAME, COMATE_CONFIG_ENV, COMATE_CONNECT_VERSION, COMATE_DEFAULT_CONTEXT_WINDOW, COMATE_DEFAULT_MAX_TOKENS, COMATE_ENTRY_ID, COMATE_EXTRA_THINKING_LEVELS, COMATE_HOME_ENV, COMATE_MAX_TOKENS_ENV, COMATE_PROVIDER, COMATE_REFRESH_PATH, COMATE_SEALED_PREFIX, COMATE_SEAL_PATH, COMATE_SECRET_DIRNAME, COMATE_SECRET_KEY_ENV, COMATE_SECRET_KEY_FILENAME, COMATE_SETTINGS_NS, COMATE_SID_ENV, COMATE_THINKING_LEVEL_WIRE, COMATE_UNLIMITED_MAX_TOKENS, ComateCatalog, ComateCredentialStore, ComatePresignUploader, ComateUpstreamClient, Config, apply, asVolatile, bindComateSettings, classifyUpstreamError, comateCheckBody, comateConfiguredMaxTokens, comateModelInput, comateModelMaxTokens, createComateAdapter, createComateShim, decodeImageDataUrl, defaultComateHome, defaultConfigCandidates, defaultSecretKeyFile, downloadUrlExpiry, emptyImageStats, emptyUploadStats, inject, isSealed, isSealedComateSecret, machineFingerprint, name, normalizeChatImages, openSecret, parseComateConfig, parseComateModel, parseMaxOutputTokens, parseMaxTokensByModel, prepareChatBody, registerComateStatusRoute, resolveAssetBase, resolveComateMaxTokens, resolveMaxOutputTokens, runComateCheck, safeMessage, sanitizeImageSource, sealSecret, selectComateModels, unusableModelTokens, unwrapVolatile, unwrapVolatileDeep, uploadChatImages };
