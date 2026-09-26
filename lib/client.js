window.__ModuleLoader__.load({
	id: "dsh-connect-comate",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/bridge.ts
		/**
		* Host ↔ browser bridge: the node-free vocabulary both halves of the plugin
		* share, plus the two volatility helpers the DSH 0.1.7 line makes mandatory.
		*
		* 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
		*   — `asVolatile()` / `unwrapVolatile()` / `unwrapVolatileDeep()` 的判定方式
		*     （运行时探测 `schema.volatile()`、活引用形状 `{get(): T}`、交给 settings
		*     服务前必须递归剥净）由该项目在 2.0.12–2.0.14 三个版本里逐条查出并验证。
		* 改动：把常量与类型也收进这里，使浏览器半不再需要 import 任何宿主模块。
		*
		* ## 为什么 0.1.7 上必须有这三个 helper
		*
		* 1. **写入被拒**：0.1.7 的 settings 写入门先要 `volatileForm(schema)` 非空
		*    （否则 `Plugin entry "<ns>" has no volatile fields`），再要求每条写入路径
		*    `isVolatilePath` 为真。因此可写字段必须由 schema 自己声明 volatile。
		* 2. **声明方式**：`volatile()` 是 schemastery 3.18.3 才有的方法。更早的版本上
		*    只能退化成 identity no-op——**刻意不手写 `meta.volatile = true`**：那会绕过
		*    schemastery 自身的 `validateVolatileSchema` 校验，产出一个它自己都不认的
		*    schema。
		* 3. **取值形状**：声明为 volatile 的字段在 `apply()` 里、以及浏览器侧 settings
		*    镜像里，交付的都是冻结的 `{get(): T}` **活引用**（`createVolatile`）。不解包
		*    就会静默拿到对象或 `undefined`。而活引用**仍然是 `typeof === "object"`**，
		*    所以任何「是对象就当映射用」的读法都会栽在这里。
		*
		* @module dsh-connect-comate/bridge
		*/
		/** Stable browser-plugin name suffix; the host entry keeps the bare package name. */
		const COMATE_CLIENT_NAME = "dsh-connect-comate-client";
		/**
		* The profile plugin entry id, which on DSH 0.1.7 **is** the settings namespace.
		*
		* 0.1.5 registered its own namespace string (`comate`); 0.1.7 replaced that with
		* the Loader entry: `SettingsForms.write` resolves a namespace by
		* `configEditor.entries().find(row => row.options.id === ns)`.
		*/
		const COMATE_ENTRY_ID = "dsh-connect-comate";
		/**
		* The settings namespace the plugin registers on the 0.1.5 line, where a plugin
		* owns the namespace string instead of inheriting its entry id. Kept for the
		* capability-probed fallback and for `bin` diagnostics.
		*/
		const COMATE_SETTINGS_NS = "comate";
		/**
		* Read-only host route the card reads the discovered model directory from.
		*
		* The host deliberately does NOT write the directory back into settings: on
		* 0.1.7 a settings write targets the user's hand-written `cordis.patch.yml`, and
		* rewriting that file whenever discovery changes would destroy its comments and
		* formatting. A loopback-only GET route keeps the channel read-only.
		*/
		const COMATE_CATALOG_PATH = "/plugins/dsh-connect-comate/__catalog";
		/**
		* Action route: re-read the local Comate config and republish the directory.
		*
		* The host discovers models at startup and when `configFile` changes; a model
		* the user just added (or signed into) in the desktop client would otherwise
		* need a DSH restart. A POST because it performs work, even though it writes
		* nothing anywhere.
		*/
		const COMATE_REFRESH_PATH = "/plugins/dsh-connect-comate/__refresh";
		/**
		* Action route: send one minimal chat request to verify the credential.
		*
		* Optionally carries an UNSAVED draft `wpsSid` / `cookieOnly` so the card can be
		* tested before saving. The draft lives only in that one request: nothing
		* persists it and the answer never echoes it back.
		*/
		const COMATE_CHECK_PATH = "/plugins/dsh-connect-comate/__check";
		/**
		* Action route: seal a plaintext `wps_sid` into its storable form.
		*
		* The browser half cannot do this itself: the encryption key is host-side
		* (a key file plus this machine's fingerprint, see `./secret.ts`), and the
		* browser has no business holding it. So the card sends the typed value over the
		* same loopback path the connection probe already uses and gets back only the
		* ciphertext to store.
		*
		* Two inputs, one route: a typed `sid`, or `fromStored: true` to seal whatever is
		* already saved — the latter is how a plaintext value left by an older version is
		* upgraded WITHOUT the plaintext ever entering the browser.
		*/
		const COMATE_SEAL_PATH = "/plugins/dsh-connect-comate/__seal";
		/**
		* Shortest possible base64url body of a sealed value: 12-byte IV + 16-byte GCM
		* tag + at least 1 byte of ciphertext.
		*
		* Only used to reject obviously-junk strings early (a hand-edited `enc:v1:` with
		* nothing behind it). The authoritative structural check is in `./secret.ts`,
		* which actually parses the payload.
		*/
		const COMATE_SEALED_MIN_CHARS = 39;
		/**
		* Whether a stored value carries this plugin's sealed envelope.
		*
		* Anything without the prefix is a LEGACY PLAINTEXT value: every version before
		* 0.4 wrote one, so the host must keep reading it and the card must offer to
		* upgrade it. This predicate is deliberately about the envelope only — whether a
		* sealed value can actually be opened depends on the key file, which only the
		* host can touch.
		*/
		function isSealedComateSecret(value) {
			if (!value.startsWith("enc:v1:")) return false;
			const body = value.slice(7);
			return body.length >= COMATE_SEALED_MIN_CHARS && /^[A-Za-z0-9_-]+$/.test(body);
		}
		/**
		* Default output-token cap for every model on this route.
		*
		* The Comate config exposes no max-output field for any of its models (verified:
		* `~/.wpscomate/config.json` and the desktop client's `agent/models.json` carry
		* only `context_window` / `id` / `llm_types` / `model_source` / `model_tier` /
		* `name`), so this is this plugin's own default rather than a mirror of anything
		* upstream.
		*
		* Declared here, not in `auth.ts`, because **both halves** need the number: the
		* host resolves the effective cap from it (`max-tokens.ts`), and the card seeds
		* its input field with it. `auth.ts` imports `node:crypto`, so a browser-half
		* import from there would drag that into the client bundle — and this module is
		* the node-free vocabulary the two halves already share.
		*/
		const COMATE_DEFAULT_MAX_TOKENS = 32e3;
		/**
		* Thinking levels this route offers WITHOUT asking, in pi-ai's own escalation
		* order: the four the model picker has always listed.
		*
		* Declared here, not in `./thinking-levels.ts`, because **both halves** name
		* them: the host builds `thinkingLevelMap` from them, and the card interpolates
		* the list into the copy that explains what the extra levels add on top.
		*/
		const COMATE_BASE_THINKING_LEVELS = [
			"minimal",
			"low",
			"medium",
			"high"
		];
		/**
		* Thinking levels that are offered only when the user turns them on, in the
		* order the card shows them.
		*
		* They are off by default because each one is a claim this plugin cannot make
		* on its own: `off` changes what an UNNAMED effort means (see
		* {@link COMATE_THINKING_LEVEL_WIRE}), and `xhigh` / `max` are accepted by the
		* gateway but were measured to behave no differently from `high`.
		*
		* The order below is the CARD's, not the model picker's: the picker lists what
		* pi-ai's own `EXTENDED_THINKING_LEVELS` says, which puts `off` first.
		*/
		const COMATE_EXTRA_THINKING_LEVELS = [
			"off",
			"xhigh",
			"max"
		];
		/**
		* The `reasoning_effort` value each manually enabled level sends.
		*
		* Measured on the live gateway (2026-09-26, this machine, the 10-model catalog),
		* not guessed. Every number below is `reasoning_content` characters on one
		* arithmetic prompt, so the two ends are comparable:
		*
		* - `'off'` really does stop thinking — it drops to **0 chars** from a
		*   non-zero baseline on deepseek-v4-flash (656→0), -pro (398→0),
		*   -v4.1-flash (313→0), MiniMax-M3 (104→0), mimo-v2.5 (1609→0),
		*   mimo-v2.5-pro (132→0) and glm-5.2 (1242→0). Two models ignore it and think
		*   *more*: glm-5.3-flash (660→1357) and glm-5.3 (810→3059). kimi-k3 cannot be
		*   counted either way — its baseline is already 0 on this prompt.
		*   (An earlier measurement in this file claimed all three zhipu models ignored
		*   `off`; re-measuring on 2026-09-26 showed glm-5.2 obeying it, so the caveat
		*   is scoped to the two glm-5.3 models.)
		* - `'none'` — the value the OpenAI `reasoning_effort` vocabulary uses for
		*   "off" — is ACCEPTED (HTTP 200) and **ignored**: `reasoning_content` stays
		*   at its baseline length on all ten models (201–1665 chars, none at 0). So
		*   `none` is NOT the off switch here, and spelling the level with it would be
		*   a lie the picker told.
		* - `'xhigh'` / `'max'` are accepted (HTTP 200) and still reason, but two
		*   samples per level could not tell them apart from `high`. The spread WITHIN
		*   one level dwarfs any between-level difference: deepseek-v4-flash `high`
		*   came back 412 and 365 while `xhigh` gave 332/377 and `max` 230/335; on
		*   -pro, `high` gave 536/722 against `xhigh` 628/402 and `max` 522/392. They
		*   are therefore offered as aliases the user opts into, never as a measured
		*   escalation.
		* - `reasoning_effort: false` is a 400 (`invalid request body`), so a level must
		*   carry a string.
		*
		* ## Why offering `off` also changes what "no effort" means
		*
		* pi-ai consults `thinkingLevelMap.off` in exactly one place when nothing names
		* an effort (`openai-completions.js`: `else if (!options?.reasoningEffort &&
		* model.reasoning && compat.supportsReasoningEffort)`), and that same entry is
		* what makes the level appear in the picker at all. There is no way to offer
		* `off` without also making the picker's "provider default" send it — so the
		* card says so out loud instead of hiding it.
		*/
		const COMATE_THINKING_LEVEL_WIRE = {
			off: "off",
			xhigh: "xhigh",
			max: "max"
		};
		/**
		* Peel ONE level of live reference.
		*
		* A volatile field resolves to a frozen `{get(): T}` object; ordinary values
		* pass through untouched. This is the read path: it returns exactly the value
		* the field holds, without copying it.
		*
		* @param value - a resolved config value, possibly a live reference.
		* @returns the referenced value, or the input unchanged.
		*/
		function unwrapVolatile(value) {
			if (value === null || typeof value !== "object") return value;
			const getter = value.get;
			if (typeof getter !== "function") return value;
			return getter.call(value);
		}
		//#endregion
		//#region src/max-tokens.ts
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
		* A fingerprint of an alias map that ignores key order.
		*
		* 卡片问这张表的两个问题——「用户碰过没有」与「有没有东西要存」——都不能用原始文本
		* 回答：同一张表换个键序重建就会读成「变了」，而那种「保存失败」的提示用户根本没法
		* 处理。所以这里排序后 `JSON.stringify`：键序无关，且**转义安全**——别名是用户敲的
		* 任意文本，拼字符串当指纹的话 `{"a": "x\ny=z"}` 会和 `{"a": "x", "y": "z"}`
		* 撞在一起（一个多行别名就能撞），而 JSON 会把换行转义掉。
		*
		* @param aliases - the parsed table.
		*/
		function aliasKey(aliases) {
			const pairs = [...aliases.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
			return JSON.stringify(pairs);
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
		buildThinkingLevelMap([]);
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
		const COMATE_PLUGIN_ICON = `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="%232b6df6"/><text x="32" y="42" font-family="Segoe UI,Arial,sans-serif" font-size="30" font-weight="700" fill="white" text-anchor="middle">C</text></svg>`;
		//#endregion
		//#region src/client/styles.ts
		/**
		* Client styles for the Comate plugin card.
		* 卡片外壳与按钮原语沿用 dsh-connect-workbuddy/trae 的 dsm-* 表现语言（MIT），
		* 表单部分为本插件新增。
		*
		* 折叠箭头是**纯 CSS** 的，不是图标组件：两条线的 primitives 图标名不重叠
		* （0.1.5 是 `IconChevronDownOutline14`，0.1.7 是
		* `IconChevronDownOutlineRegular`），没有任何一个静态图标 import 能同时服务
		* 两边——在另一条线上会渲染成 `undefined` 并直接抛错。
		*
		* @module dsh-connect-comate/client/styles
		*/
		const COMATE_CARD_CSS = `
.dsm-plugin-card{border:1px solid var(--dsw-alias-border-l2,#36373b);background:var(--dsw-alias-bg-layer-3,#202126);border-radius:12px;list-style:none;transition:border-color .16s,background .16s}
.dsm-plugin-card:hover{border-color:var(--dsw-alias-label-dimmed,#777)}
.dsm-plugin-card-open{background:var(--dsw-alias-bg-layer-2,#25262b);border-color:var(--dsw-alias-label-dimmed,#777)}
.dsm-plugin-card-header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:transparent;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}
.dsm-plugin-card-header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:-2px}
.dsm-plugin-card-head{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}
.dsm-plugin-card-title{color:var(--dsw-alias-label-primary,#e6e6e6);font-size:15px;font-weight:600;line-height:1.4}
.dsm-plugin-card-description{color:var(--dsw-alias-label-tertiary,#999);font-size:13px;line-height:1.5}
.dsm-plugin-card-chevron{color:var(--dsw-alias-label-tertiary,#999);flex:none;width:16px;height:16px;position:relative;transition:transform .16s}
.dsm-plugin-card-chevron::before{content:"";display:block;position:absolute;left:4px;top:5px;width:7px;height:7px;border-right:1.6px solid currentColor;border-bottom:1.6px solid currentColor;transform:rotate(45deg)}
.dsm-plugin-card-chevron-open{transform:rotate(180deg)}
.dsm-plugin-card-body{border-top:1px solid var(--dsw-alias-border-l2,#36373b);margin:0 16px;padding:0 0 8px}
.dsm-plugin-card-icon{width:32px;height:32px;flex:none;border-radius:7px}
.dsm-btn{appearance:none;font:inherit;cursor:pointer;border:1px solid transparent;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5}
.dsm-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:1px}
.dsm-btn:disabled{opacity:.4;cursor:default}
.dsm-btn-outline{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:transparent;font-weight:500}
.dsm-btn-outline:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed);background:rgba(255,255,255,.04)}
.dsm-btn-primary{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}
.dsm-btn-primary:hover:not(:disabled){opacity:.9}
.dsm-comate{display:flex;flex-direction:column;gap:14px;margin:0;padding:16px 0 4px}
.dsm-comate-status{display:flex;align-items:center;gap:8px;font-size:13px;line-height:18px;color:var(--dsw-alias-label-secondary,#b8b8b8)}
.dsm-comate-status-dot{width:9px;height:9px;border-radius:50%;flex:0 0 auto}
.dsm-comate-status-ok{background:var(--dsw-alias-state-success-primary,#22a06b)}
.dsm-comate-status-empty{background:var(--dsw-alias-state-warning-primary,#d9a320)}
.dsm-comate-field{display:flex;flex-direction:column;gap:6px}
.dsm-comate-label{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,#e6e6e6)}
.dsm-comate-input{width:100%;box-sizing:border-box;font:inherit;font-family:ui-monospace,Consolas,monospace;font-size:12.5px;padding:9px 11px;border:1px solid var(--dsw-alias-border-l2,#3a3d45);border-radius:10px;color:var(--dsw-alias-label-primary,#e6e6e6);background:var(--dsw-alias-bg-layer-3,#2a2c33);transition:border-color .15s,box-shadow .15s}
.dsm-comate-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary,#5686fe);box-shadow:0 0 0 3px rgba(86,134,254,.22)}
.dsm-comate-hint{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#9aa0a8)}
.dsm-comate-sid-row{display:flex;gap:8px;align-items:center}
.dsm-comate-sid-row .dsm-comate-input{flex:1;min-width:0}
.dsm-comate-sid-row .dsm-btn{flex:none;white-space:nowrap}
/* 密码型输入：圆点本身由 type=password 负责，这里只补两点。letter-spacing 让圆点
   不至于挤成一条线（也避免等宽字体下按字符数估计长度）；user-select:none 掐掉
   拖拽选中，是「不可复制」里除事件拦截外的第二道。 */
.dsm-comate-input-secret{letter-spacing:.14em;user-select:none;-webkit-user-select:none}
.dsm-comate-input-secret::placeholder{letter-spacing:normal}
.dsm-comate-status-warn{color:var(--dsw-alias-state-warning-primary,#d9a320)}
.dsm-comate-number-row{display:flex;align-items:center;gap:8px}
.dsm-comate-input-number{width:160px;flex:none}
.dsm-comate-unit{font-size:12px;color:var(--dsw-alias-label-tertiary,#9aa0a8)}
.dsm-comate-hint-error{color:var(--dsw-alias-state-error-primary,#ef4444)}
.dsm-comate-check{display:flex;align-items:flex-start;gap:8px;font-size:13px;line-height:19px;color:var(--dsw-alias-label-secondary,#c6c9d0);cursor:pointer}
.dsm-comate-check input{margin-top:3px}
.dsm-comate-actions{display:flex;align-items:center;gap:10px;justify-content:flex-end;flex-wrap:wrap}
.dsm-comate-saved{margin:0;font-size:12.5px;color:var(--dsw-alias-state-success-primary,#22a06b)}
.dsm-comate-error{margin:0;font-size:12.5px;color:var(--dsw-alias-state-error-primary,#ef4444)}
.dsm-comate-info{margin:0;font-size:12.5px;color:var(--dsw-alias-label-tertiary,#9aa0a8)}
.dsm-comate-models{display:flex;flex-direction:column;gap:8px}
.dsm-comate-models-head{display:flex;align-items:center;justify-content:space-between;gap:10px}
.dsm-comate-models-title{margin:0;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,#e6e6e6)}
.dsm-comate-models-tools{display:flex;gap:6px}
.dsm-comate-models-tools .dsm-btn{padding:2px 9px;font-size:12px}
.dsm-comate-model-list{display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l2,#3a3d45);border-radius:10px;overflow:hidden;max-height:280px;overflow-y:auto}
.dsm-comate-model{display:flex;flex-direction:column;gap:3px;padding:9px 12px;background:var(--dsw-alias-bg-layer-2,#232529)}
.dsm-comate-model+.dsm-comate-model{border-top:1px solid var(--dsw-alias-border-l2,#3a3d45)}
/* 一行 = 勾选/名称 + 右侧的该模型上限输入框。名称那一侧允许收缩（min-width:0），
   否则长 id 会把输入框挤出容器；输入框固定宽度，不参与收缩。 */
.dsm-comate-model-main{display:flex;align-items:center;gap:10px}
.dsm-comate-model-main .dsm-comate-model-row{flex:1;min-width:0}
.dsm-comate-model-cap{display:flex;align-items:center;gap:6px;flex:none}
/* 别名输入框：在名称与上限框之间，宽度固定且不参与收缩（名称那一侧已经 min-width:0）。
   它比上限框宽一点——上限是数字，别名是文字。 */
.dsm-comate-model-alias{display:flex;align-items:center;flex:none}
.dsm-comate-model-alias .dsm-comate-input{width:132px;flex:none;padding:4px 8px;font-size:12px}
.dsm-comate-thinking{display:flex;flex-direction:column;gap:8px}
.dsm-comate-thinking-levels{display:flex;flex-direction:column;gap:6px}
.dsm-comate-model-cap .dsm-comate-input{width:104px;flex:none;padding:4px 8px;font-size:12px}
.dsm-comate-model-cap .dsm-comate-unit{font-size:11px}
.dsm-comate-model-row{display:flex;align-items:center;gap:9px;font-size:13px;color:var(--dsw-alias-label-primary,#e6e6e6);cursor:pointer}
.dsm-comate-model-row input{margin:0}
.dsm-comate-model-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,Consolas,monospace;font-size:12px}
.dsm-comate-model-tag{flex:none;font-size:10.5px;padding:1px 6px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,#3a3d45);color:var(--dsw-alias-label-tertiary,#9aa0a8)}
.dsm-comate-model-meta{padding-left:23px;margin:0;font-size:11.5px;color:var(--dsw-alias-label-tertiary,#9aa0a8)}
`;
		//#endregion
		//#region src/client/settings-scope.ts
		/**
		* Browser half's settings surface: acquire the form for this plugin's section
		* on whichever DSH line is running, read it through the volatile-reference
		* unwrapper, and write it with read-back verification.
		*
		* 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
		*   — 「按能力获取 scope（0.1.7 走 `configForms.get(ns)`、0.1.5 回落
		*     `settingsScope.bind()`）、`set()` resolve 不等于已落盘所以要回读校验」
		*     这两条结论由该项目在 2.0.12–2.0.14 逐条查出并验证。
		* 改动：只保留本插件真正用到的成员；回读校验抽成可测的纯函数。
		*
		* ## 为什么这个模块不碰 `document`、也不 import 任何宿主模块
		*
		* 它是 host↔browser 的纯逻辑桥梁：这样它既能在 node 测试环境里被真实调用
		* （而不是像 workbuddy 2.0.14 之前那样，整套测试只用普通对象模拟
		* `getSnapshot().value`，于是线上真实的活引用形状从未被测过），也不会把
		* 任何宿主代码拖进浏览器 bundle。
		*
		* @module dsh-connect-comate/client/settings-scope
		*/
		/**
		* A settings write the Host did not accept.
		*
		* Distinguishing the two causes matters to the user: `refused` means the Host
		* rejected the value, `not-persisted` means the write was answered but the
		* document did not change — on Windows the profile patch is replaced by
		* "write temp + rename", and a virus scanner, sync folder, or editor holding the
		* file makes that rename fail after the retries, which the scope reports as a
		* normal return. Reporting the second as success is how a save "takes effect"
		* and then silently reverts.
		*/
		var ComateSettingsWriteError = class extends Error {
			/** Machine-readable cause, stable across bundle boundaries. */
			code;
			/** The field that did not land. */
			field;
			constructor(code, field, message) {
				super(message);
				this.name = "ComateSettingsWriteError";
				this.code = code;
				this.field = field;
			}
		};
		/**
		* The Loader entry id the Host actually serves this plugin under.
		*
		* 0.1.7 keys settings by entry id, and a plugin can be composed under an id that
		* differs from its package name — so the served namespace is taken from the
		* describe mirror rather than assumed. The exact id wins over the fuzzy match:
		* a sibling package whose name merely contains "comate" must not be mistaken for
		* this one.
		*/
		function servedEntryId(forms) {
			let namespaces = [];
			try {
				namespaces = forms.describe().getSnapshot().view?.namespaces ?? [];
			} catch {
				return COMATE_ENTRY_ID;
			}
			const exact = namespaces.find((entry) => entry.ns === COMATE_ENTRY_ID);
			if (exact !== void 0) return exact.ns;
			return namespaces.find((entry) => /comate/i.test(entry.ns))?.ns ?? "dsh-connect-comate";
		}
		/**
		* Resolve the settings form for this plugin's section, or `undefined` when
		* neither line's service is available.
		*
		* @param probe - the browser context (or any `{ get }` stub in tests).
		* @returns the form, or `undefined` so the card can render read-only.
		*/
		function acquireComateSettingsForm(probe) {
			try {
				const forms = probe.get("configForms");
				if (forms !== void 0 && forms !== null && typeof forms.get === "function" && typeof forms.describe === "function") return forms.get(servedEntryId(forms));
				const legacy = probe.get("settingsScope");
				if (legacy !== void 0 && legacy !== null && typeof legacy.bind === "function") return legacy.bind({ namespace: COMATE_SETTINGS_NS });
			} catch (error) {
				console.error("[dsh-connect-comate] settings surface probe failed:", error);
			}
		}
		/**
		* Whether the Host document accepts writes through this form.
		*
		* No form at all means no write path, so the card renders read-only rather than
		* offering buttons that cannot work. An absent `writable` flag is NOT read as
		* "not writable": 0.1.5's snapshot may omit it, and treating that as locked would
		* freeze a perfectly writable card.
		*/
		function comateSettingsWritable(form) {
			if (form === void 0) return false;
			return form.getSnapshot().writable !== false;
		}
		/**
		* Read the card's view of the section.
		*
		* Every field may arrive as a `{get(): T}` live reference on 0.1.7 (and as a
		* plain value on 0.1.5), so each one goes through {@link unwrapVolatile}; a live
		* reference is still `typeof === 'object'`, which is exactly how a naive reader
		* ends up treating it as the section itself.
		*
		* The deprecated host-published `lastCatalog` is deliberately NOT read: the
		* model directory now has one source, the read-only catalog route.
		*
		* @param form - the settings form, if any.
		* @returns the section as plain values; `{}` when nothing is available.
		*/
		function readComateValue(form) {
			const raw = form?.getSnapshot().value;
			if (raw === null || typeof raw !== "object") return {};
			const section = raw;
			const value = {};
			const configFile = unwrapVolatile(section.configFile);
			if (typeof configFile === "string") value.configFile = configFile;
			const wpsSid = unwrapVolatile(section.wpsSid);
			if (typeof wpsSid === "string") value.wpsSid = wpsSid;
			const cookieOnly = unwrapVolatile(section.cookieOnly);
			if (typeof cookieOnly === "boolean") value.cookieOnly = cookieOnly;
			const enabled = unwrapVolatile(section.enabledModelIds);
			if (Array.isArray(enabled)) value.enabledModelIds = enabled.filter((id) => typeof id === "string");
			const maxOutputTokens = unwrapVolatile(section.maxOutputTokens);
			if (typeof maxOutputTokens === "number" && Number.isSafeInteger(maxOutputTokens) && maxOutputTokens >= 0) value.maxOutputTokens = maxOutputTokens;
			const byModel = unwrapVolatile(section.maxOutputTokensByModel);
			if (byModel !== null && typeof byModel === "object" && !Array.isArray(byModel)) {
				const caps = {};
				for (const [id, raw] of Object.entries(byModel)) {
					const cap = unwrapVolatile(raw);
					if (id.trim() === "" || typeof cap !== "number" || !Number.isSafeInteger(cap) || cap < 0) continue;
					caps[id] = cap;
				}
				if (Object.keys(caps).length > 0) value.maxOutputTokensByModel = caps;
			}
			const aliases = unwrapVolatile(section.modelAliases);
			if (aliases !== null && typeof aliases === "object" && !Array.isArray(aliases)) {
				const names = parseModelAliases(Object.fromEntries(Object.entries(aliases).map(([id, raw]) => [id, unwrapVolatile(raw)])));
				if (names.size > 0) value.modelAliases = Object.fromEntries(names);
			}
			const levels = unwrapVolatile(section.extraThinkingLevels);
			if (Array.isArray(levels)) {
				const named = parseExtraThinkingLevels(levels.map(unwrapVolatile));
				if (named.length > 0) value.extraThinkingLevels = [...named];
			}
			return value;
		}
		/** Set equality over model ids; order is not part of the saved value's meaning. */
		function sameStringSet(left, right) {
			if (left.length !== right.length) return false;
			const set = new Set(left);
			return right.every((id) => set.has(id));
		}
		/**
		* Whether two cap maps say the same thing.
		*
		* By membership and value, not by key order: a map rebuilt in another order (or
		* one that dropped a key whose value was the same as the global field) is still
		* the same setting, and a false "did not persist" verdict would be unactionable.
		*/
		function sameCapMap(left, right) {
			const ids = Object.keys(left);
			if (ids.length !== Object.keys(right).length) return false;
			return ids.every((id) => left[id] === right[id]);
		}
		/**
		* Whether two string maps say the same thing.
		*
		* Key order is not part of the value's meaning, so it is not part of the test:
		* a map the Host re-serialized in another order is the same setting, and a false
		* "did not persist" verdict would be unactionable for the user.
		*/
		function sameStringMap(left, right) {
			const ids = Object.keys(left);
			if (ids.length !== Object.keys(right).length) return false;
			return ids.every((id) => left[id] === right[id]);
		}
		/**
		* Let the form's write answer fold back into the settings mirror before the
		* read-back below inspects it. A macrotask, not a microtask: it drains every
		* pending microtask first, so the fold cannot be observed half-applied.
		*/
		function afterWriteSettles() {
			return new Promise((resolve) => {
				setTimeout(resolve, 0);
			});
		}
		/**
		* Queue one field write and refuse to treat a refusal as success.
		*
		* @param form - the settings form.
		* @param field - scalar field inside the section.
		* @param value - JSON-shaped value selected by the user.
		* @throws {ComateSettingsWriteError} `refused` when the Host answered `false`.
		*/
		async function writeField(form, field, value) {
			if (await form.set(field, value) === false) throw new ComateSettingsWriteError("refused", field, `the Host refused the settings field "${field}"`);
		}
		/**
		* Save the card's fields, verifying that they actually landed.
		*
		* @param form - the settings form.
		* @param patch - the values to save; an omitted field is neither written nor
		* verified, so the stored sid in particular survives a save untouched.
		* @throws {ComateSettingsWriteError} `refused` for a rejected write,
		* `not-persisted` when a written value reads back different.
		*/
		async function writeComateSettings(form, patch) {
			if (patch.wpsSid !== void 0) await writeField(form, "wpsSid", patch.wpsSid);
			if (patch.cookieOnly !== void 0) await writeField(form, "cookieOnly", patch.cookieOnly);
			if (patch.enabledModelIds !== void 0) await writeField(form, "enabledModelIds", [...patch.enabledModelIds]);
			if (patch.maxOutputTokens !== void 0) await writeField(form, "maxOutputTokens", patch.maxOutputTokens);
			if (patch.maxOutputTokensByModel !== void 0) await writeField(form, "maxOutputTokensByModel", { ...patch.maxOutputTokensByModel });
			if (patch.modelAliases !== void 0) await writeField(form, "modelAliases", { ...patch.modelAliases });
			if (patch.extraThinkingLevels !== void 0) await writeField(form, "extraThinkingLevels", [...patch.extraThinkingLevels]);
			await afterWriteSettles();
			const saved = readComateValue(form);
			if (patch.wpsSid !== void 0 && saved.wpsSid !== patch.wpsSid) throw new ComateSettingsWriteError("not-persisted", "wpsSid", "settings field \"wpsSid\" was not persisted");
			if (patch.cookieOnly !== void 0 && saved.cookieOnly === true !== patch.cookieOnly) throw new ComateSettingsWriteError("not-persisted", "cookieOnly", "settings field \"cookieOnly\" was not persisted");
			if (patch.enabledModelIds !== void 0 && !sameStringSet(saved.enabledModelIds ?? [], patch.enabledModelIds)) throw new ComateSettingsWriteError("not-persisted", "enabledModelIds", "settings field \"enabledModelIds\" was not persisted");
			if (patch.maxOutputTokens !== void 0 && saved.maxOutputTokens !== patch.maxOutputTokens) throw new ComateSettingsWriteError("not-persisted", "maxOutputTokens", "settings field \"maxOutputTokens\" was not persisted");
			if (patch.maxOutputTokensByModel !== void 0 && !sameCapMap(saved.maxOutputTokensByModel ?? {}, patch.maxOutputTokensByModel)) throw new ComateSettingsWriteError("not-persisted", "maxOutputTokensByModel", "settings field \"maxOutputTokensByModel\" was not persisted");
			if (patch.modelAliases !== void 0 && !sameStringMap(saved.modelAliases ?? {}, patch.modelAliases)) throw new ComateSettingsWriteError("not-persisted", "modelAliases", "settings field \"modelAliases\" was not persisted");
			if (patch.extraThinkingLevels !== void 0 && !sameStringSet(saved.extraThinkingLevels ?? [], patch.extraThinkingLevels)) throw new ComateSettingsWriteError("not-persisted", "extraThinkingLevels", "settings field \"extraThinkingLevels\" was not persisted");
		}
		/**
		* POST one JSON body to a host action route and parse its answer.
		*
		* Both actions are same-origin loopback calls, so they carry the session
		* credentials but never a plugin-issued token: the host's own gates (loopback
		* Host + loopback Origin + JSON content type) are the authorization.
		*
		* @param path - the action route.
		* @param body - the JSON body, or undefined for an empty POST.
		* @returns the parsed answer.
		* @throws {Error} with the route's own error text when it refuses the request.
		*/
		async function postAction(path, body) {
			const response = await fetch(path, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					accept: "application/json"
				},
				credentials: "same-origin",
				body: JSON.stringify(body ?? {})
			});
			if (!response.ok) {
				let detail = `HTTP ${response.status}`;
				try {
					const parsed = await response.json();
					if (typeof parsed?.error === "string" && parsed.error !== "") detail = parsed.error;
				} catch {}
				throw new Error(detail);
			}
			return await response.json();
		}
		/**
		* Re-read the local Comate config on the host and return the fresh directory.
		*
		* The host discovers models at startup and when `configFile` changes, so a model
		* the user just signed into in the desktop client would otherwise need a DSH
		* restart.
		*
		* @returns the host's post-refresh snapshot.
		*/
		async function refreshComateCatalog() {
			return postAction(COMATE_REFRESH_PATH);
		}
		/**
		* Send one minimal chat request through the host to verify the credential.
		*
		* `input` carries the card's UNSAVED draft values, so a sid can be tested before
		* it is saved. The host applies them to that single request only; nothing is
		* persisted and the answer never echoes them back.
		*
		* @param input - optional draft overrides.
		* @returns the probe's outcome; a failed probe resolves, it does not reject.
		*/
		async function testComateConnection(input = {}) {
			return postAction(COMATE_CHECK_PATH, input);
		}
		/**
		* Encrypt a plaintext sid into the value that belongs in the settings document.
		*
		* The key is host-side by design (a key file plus this machine's fingerprint), so
		* the browser cannot seal anything itself — and should not be able to. The
		* plaintext travels over the same loopback path the connection probe already
		* uses, and only the ciphertext comes back.
		*
		* Unlike the probe, this REJECTS when it fails: the caller must abort the save,
		* because the only alternative would be writing the plaintext, which is exactly
		* what this route exists to prevent.
		*
		* @param sid - the plaintext value as typed.
		* @returns the sealed string plus the plaintext length, for the card's copy.
		*/
		async function sealComateSid(sid) {
			return postAction(COMATE_SEAL_PATH, { sid });
		}
		/**
		* Seal the value the settings document already stores.
		*
		* The plaintext-upgrade path: the host seals what it already holds, so a
		* credential saved by an older version never has to enter the browser just to be
		* re-saved in encrypted form.
		*
		* @returns the sealed string plus the plaintext length.
		*/
		async function sealStoredComateSid() {
			return postAction(COMATE_SEAL_PATH, { fromStored: true });
		}
		//#endregion
		//#region src/client/ComateCard.tsx
		/**
		* Comate connection card contributed to DSH's plugin configuration:
		* a wps_sid input, a cookie-only toggle, a default output-token cap, a
		* model-selection list with a per-model cap box and name alias on every row,
		* the advanced thinking-level switches, and save/discard actions.
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
		* ## 两个「高级」区
		*
		* 别名（每行一个输入框）与思考档位（三个勾选框）都在这里，但都不属于「第一次
		* 打开就该改」的东西，所以文案里把它们的代价写清楚，尤其是 `off` 会连带改掉
		* 「不指定档位」的含义（见 `bridge.ts` 的 `COMATE_THINKING_LEVEL_WIRE`）。
		*
		* @module dsh-connect-comate/client/ComateCard
		*/
		/** Inject the shared card CSS once per module load. */
		if (typeof document !== "undefined") {
			const cssId = "dsh-connect-comate/client.css";
			const existing = document.querySelector(`style[data-plugin-css="${cssId}"]`);
			if (existing !== null) existing.textContent = COMATE_CARD_CSS;
			else {
				const styleTag = document.createElement("style");
				styleTag.dataset.plugin = "dsh-connect-comate";
				styleTag.dataset.pluginCss = cssId;
				styleTag.textContent = COMATE_CARD_CSS;
				document.head.appendChild(styleTag);
			}
		}
		/** Turn a probe outcome into the single line the card shows. */
		function describeOutcome(outcome, t) {
			if (outcome.ok) return outcome.content === true ? {
				tone: "ok",
				text: t("row.testOkContent", { model: outcome.model ?? "" })
			} : {
				tone: "ok",
				text: t("row.testOkNoContent", { model: outcome.model ?? "" })
			};
			if (outcome.reason === "no-credential") return {
				tone: "error",
				text: t("row.testNoCredential")
			};
			if (outcome.reason === "no-model") return {
				tone: "error",
				text: t("row.testNoModel")
			};
			const detail = {
				status: outcome.status ?? "-",
				kind: outcome.kind ?? "unknown",
				message: outcome.message ?? ""
			};
			if (outcome.accepted === true) return {
				tone: "error",
				text: t("row.testIncomplete", detail)
			};
			return {
				tone: "error",
				text: t("row.testFail", detail)
			};
		}
		/** Render one inline action result, toned by outcome. */
		function Note({ note }) {
			const className = note.tone === "ok" ? "dsm-comate-saved" : note.tone === "error" ? "dsm-comate-error" : "dsm-comate-info";
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				className,
				children: note.text
			});
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
		function blockClipboard(event) {
			event.preventDefault();
		}
		/** One message from an unknown thrown value. */
		function messageOf(cause) {
			return cause instanceof Error ? cause.message : String(cause);
		}
		/** Narrow the host's `sidStorage` field; anything else means "no verdict". */
		function toSidStorage(value) {
			return value === "unset" || value === "plaintext" || value === "sealed" || value === "unreadable" ? value : void 0;
		}
		/** Narrow one entry of the catalog route's answer. */
		function isPersistedModel(value) {
			if (value === null || typeof value !== "object") return false;
			const model = value;
			return typeof model.id === "string" && typeof model.name === "string" && typeof model.contextWindow === "number" && typeof model.multimodal === "boolean";
		}
		/** Set equality over model ids: a draft only re-seeds while it still matches. */
		function sameIdSet(left, right) {
			return left.size === right.size && [...left].every((id) => right.has(id));
		}
		/**
		* Read the per-model boxes: the caps they would save, plus the ids that hold
		* something unusable.
		*
		* An EMPTY box means "no override" and is dropped rather than defaulted: that
		* is what makes "follow the global cap" expressible, and what lets the user undo
		* an override by clearing the box.
		*/
		function parseCapDrafts(drafts) {
			const caps = {};
			const invalid = [];
			for (const [id, text] of Object.entries(drafts)) {
				if (text.trim() === "") continue;
				const value = parseMaxOutputTokens(text);
				if (value === void 0) invalid.push(id);
				else caps[id] = value;
			}
			return {
				caps,
				invalid
			};
		}
		/**
		* A fingerprint of a cap map that ignores key order.
		*
		* Used for the two questions the card asks about a map: "has the user touched
		* this draft?" and "is there anything to save?". A JSON dump would answer
		* neither — the same map rebuilt in another order would read as a change.
		*/
		function capKey(caps) {
			return Object.keys(caps).sort().map((id) => `${id}=${String(caps[id])}`).join("\n");
		}
		/** Seed the text boxes from a stored map (0 is a real value: "unlimited"). */
		function textCapDrafts(caps) {
			const drafts = {};
			for (const [id, value] of Object.entries(caps)) drafts[id] = String(value);
			return drafts;
		}
		/**
		* Seed the alias boxes from the stored map.
		*
		* The alias boxes hold plain text, so unlike the cap boxes there is nothing to
		* normalize here: an absent key is an empty box, which is also what "no alias"
		* means. Parsing (and therefore what a blank box means on save) stays in
		* `model-alias.ts`, shared with the host.
		*/
		function textAliasDrafts(aliases) {
			const drafts = {};
			for (const [id, name] of aliases) drafts[id] = name;
			return drafts;
		}
		/**
		* Which locale key labels each manually enableable thinking level.
		*
		* A map rather than a template string (`row.thinking.${level}`) because `t` is
		* typed on the exact key union: a computed key would widen to `string` and lose
		* the check that every level has copy — which is the check that matters when a
		* fourth level is added to {@link COMATE_EXTRA_THINKING_LEVELS}.
		*/
		const THINKING_LEVEL_LABEL = {
			off: "row.thinkingOff",
			xhigh: "row.thinkingXhigh",
			max: "row.thinkingMax"
		};
		/** Render the Comate sign-in configuration as one card (or page body). */
		function ComateCard({ t, settingsScope, view }) {
			if (t === void 0) throw new Error("Comate plugin card requires its translation function");
			const [open, setOpen] = (0, react.useState)(view === "page");
			const [revision, setRevision] = (0, react.useState)(0);
			const saved = (0, react.useMemo)(() => readComateValue(settingsScope), [settingsScope, revision]);
			const savedSid = saved.wpsSid ?? "";
			const sidShape = savedSid === "" ? "unset" : isSealedComateSecret(savedSid) ? "sealed" : "plaintext";
			const savedCookieOnly = saved.cookieOnly === true;
			const savedConfigFile = saved.configFile ?? "";
			const savedMaxTokens = saved.maxOutputTokens ?? 32e3;
			const savedModelCaps = (0, react.useMemo)(() => saved.maxOutputTokensByModel ?? {}, [saved.maxOutputTokensByModel]);
			const savedModelCapsKey = (0, react.useMemo)(() => capKey(savedModelCaps), [savedModelCaps]);
			const savedAliases = (0, react.useMemo)(() => parseModelAliases(saved.modelAliases), [saved.modelAliases]);
			const savedAliasesKey = (0, react.useMemo)(() => aliasKey(savedAliases), [savedAliases]);
			const savedExtraLevels = (0, react.useMemo)(() => new Set(parseExtraThinkingLevels(saved.extraThinkingLevels)), [saved.extraThinkingLevels]);
			const [catalog, setCatalog] = (0, react.useState)([]);
			const [catalogFailed, setCatalogFailed] = (0, react.useState)(false);
			const catalogIds = (0, react.useMemo)(() => catalog.map((model) => model.id), [catalog]);
			const savedEnabledIds = (0, react.useMemo)(() => {
				const stored = new Set(saved.enabledModelIds ?? []);
				return stored.size === 0 ? new Set(catalogIds) : stored;
			}, [saved.enabledModelIds, catalogIds]);
			const [draftSid, setDraftSid] = (0, react.useState)(null);
			const [clearPending, setClearPending] = (0, react.useState)(false);
			const [draftCookieOnly, setDraftCookieOnly] = (0, react.useState)(savedCookieOnly);
			const [draftEnabled, setDraftEnabled] = (0, react.useState)(savedEnabledIds);
			const [draftMaxTokens, setDraftMaxTokens] = (0, react.useState)(String(savedMaxTokens));
			const [draftModelCaps, setDraftModelCaps] = (0, react.useState)(() => textCapDrafts(savedModelCaps));
			const [draftAliases, setDraftAliases] = (0, react.useState)(() => textAliasDrafts(savedAliases));
			const [draftExtraLevels, setDraftExtraLevels] = (0, react.useState)(savedExtraLevels);
			const [saving, setSaving] = (0, react.useState)(false);
			const [savedFlash, setSavedFlash] = (0, react.useState)(false);
			const [error, setError] = (0, react.useState)(void 0);
			const [refreshing, setRefreshing] = (0, react.useState)(false);
			const [refreshNote, setRefreshNote] = (0, react.useState)(void 0);
			const [testing, setTesting] = (0, react.useState)(false);
			const [testNote, setTestNote] = (0, react.useState)(void 0);
			const [migrating, setMigrating] = (0, react.useState)(false);
			const [sidNote, setSidNote] = (0, react.useState)(void 0);
			const [hostSid, setHostSid] = (0, react.useState)(void 0);
			const sidStorage = hostSid?.storage ?? sidShape;
			const mounted = (0, react.useRef)(true);
			const migrateStarted = (0, react.useRef)(false);
			(0, react.useEffect)(() => {
				mounted.current = true;
				return () => {
					mounted.current = false;
				};
			}, []);
			(0, react.useEffect)(() => settingsScope?.subscribe(() => {
				setRevision((value) => value + 1);
			}), [settingsScope]);
			/**
			* Read the directory from the host's read-only route.
			*
			* Failure is not an error state for the plugin: the route needs `webServer`,
			* and a deployment without one still serves models. The card simply has
			* nothing to list.
			*/
			const loadCatalog = (0, react.useCallback)(async () => {
				try {
					const response = await fetch(COMATE_CATALOG_PATH, {
						headers: { accept: "application/json" },
						credentials: "same-origin"
					});
					if (!response.ok) throw new Error(`HTTP ${response.status}`);
					const body = await response.json();
					const models = Array.isArray(body.models) ? body.models.filter(isPersistedModel) : [];
					if (!mounted.current) return;
					setCatalog(models);
					setCatalogFailed(false);
					const storage = toSidStorage(body.sidStorage);
					if (storage !== void 0) setHostSid(typeof body.sidProblem === "string" && body.sidProblem !== "" ? {
						storage,
						problem: body.sidProblem
					} : { storage });
				} catch {
					if (!mounted.current) return;
					setCatalog([]);
					setCatalogFailed(true);
				}
			}, []);
			(0, react.useEffect)(() => {
				loadCatalog();
			}, [loadCatalog]);
			/**
			* Ask the host to re-read the local Comate config, then take its snapshot.
			*
			* The button exists because the host discovers models at startup and when
			* `configFile` changes: a model the user just signed into in the desktop
			* client would otherwise need a DSH restart to appear.
			*/
			const onRefresh = async () => {
				if (refreshing) return;
				setRefreshing(true);
				setRefreshNote(void 0);
				try {
					const answer = await refreshComateCatalog();
					if (!mounted.current) return;
					setCatalog([...answer.models]);
					setCatalogFailed(false);
					setRefreshNote({
						tone: answer.signedIn ? "ok" : "info",
						text: answer.signedIn ? t("row.refreshed", { count: answer.models.length }) : t("row.refreshSignedOut")
					});
				} catch (cause) {
					if (mounted.current) setRefreshNote({
						tone: "error",
						text: t("row.refreshFailed", { message: cause instanceof Error ? cause.message : String(cause) })
					});
				} finally {
					if (mounted.current) setRefreshing(false);
				}
			};
			/**
			* Send one minimal request through the host, using the CURRENT DRAFT values.
			*
			* Testing the draft is the point: the sid can be verified before it is saved,
			* so a wrong paste never reaches the settings document. The host applies the
			* draft to that single request and persists nothing.
			*/
			const onTest = async () => {
				if (testing) return;
				setTesting(true);
				setTestNote(void 0);
				try {
					const outcome = await testComateConnection({
						...sidReplace ? { wpsSid: trimmedSid } : {},
						cookieOnly: draftCookieOnly
					});
					if (!mounted.current) return;
					setTestNote(describeOutcome(outcome, t));
				} catch (cause) {
					if (mounted.current) setTestNote({
						tone: "error",
						text: t("row.testFail", {
							status: "-",
							kind: "route",
							message: cause instanceof Error ? cause.message : String(cause)
						})
					});
				} finally {
					if (mounted.current) setTesting(false);
				}
			};
			const prevConfigFile = (0, react.useRef)(savedConfigFile);
			(0, react.useEffect)(() => {
				if (prevConfigFile.current === savedConfigFile) return;
				prevConfigFile.current = savedConfigFile;
				loadCatalog();
			}, [savedConfigFile, loadCatalog]);
			const prevSavedCookieOnly = (0, react.useRef)(savedCookieOnly);
			const prevSavedMaxTokens = (0, react.useRef)(savedMaxTokens);
			const prevSavedModelCaps = (0, react.useRef)(void 0);
			const prevSavedEnabled = (0, react.useRef)(void 0);
			(0, react.useEffect)(() => {
				const previous = prevSavedCookieOnly.current;
				if (previous === savedCookieOnly) return;
				prevSavedCookieOnly.current = savedCookieOnly;
				setDraftCookieOnly((current) => current === previous ? savedCookieOnly : current);
			}, [savedCookieOnly]);
			(0, react.useEffect)(() => {
				const previous = prevSavedMaxTokens.current;
				if (previous === savedMaxTokens) return;
				prevSavedMaxTokens.current = savedMaxTokens;
				setDraftMaxTokens((current) => current === String(previous) ? String(savedMaxTokens) : current);
			}, [savedMaxTokens]);
			(0, react.useEffect)(() => {
				const previous = prevSavedModelCaps.current;
				prevSavedModelCaps.current = savedModelCapsKey;
				if (previous === void 0 || previous === savedModelCapsKey) return;
				setDraftModelCaps((current) => capKey(parseCapDrafts(current).caps) === previous ? textCapDrafts(savedModelCaps) : current);
			}, [savedModelCapsKey, savedModelCaps]);
			const prevSavedAliases = (0, react.useRef)(void 0);
			(0, react.useEffect)(() => {
				const previous = prevSavedAliases.current;
				prevSavedAliases.current = savedAliasesKey;
				if (previous === void 0 || previous === savedAliasesKey) return;
				setDraftAliases((current) => aliasKey(parseModelAliases(current)) === previous ? textAliasDrafts(savedAliases) : current);
			}, [savedAliasesKey, savedAliases]);
			const prevSavedExtraLevels = (0, react.useRef)(void 0);
			(0, react.useEffect)(() => {
				const previous = prevSavedExtraLevels.current;
				prevSavedExtraLevels.current = savedExtraLevels;
				if (previous === void 0 || sameIdSet(previous, savedExtraLevels)) return;
				setDraftExtraLevels((current) => sameIdSet(current, previous) ? new Set(savedExtraLevels) : current);
			}, [savedExtraLevels]);
			(0, react.useEffect)(() => {
				const previous = prevSavedEnabled.current;
				prevSavedEnabled.current = savedEnabledIds;
				if (previous === void 0 || sameIdSet(previous, savedEnabledIds)) return;
				setDraftEnabled((current) => sameIdSet(current, previous) ? new Set(savedEnabledIds) : current);
			}, [savedEnabledIds]);
			const writable = comateSettingsWritable(settingsScope);
			const trimmedSid = (draftSid ?? "").trim();
			const sidReplace = draftSid !== null && trimmedSid.length > 0;
			const sidDirty = clearPending || sidReplace;
			const draftMaxTokensValue = parseMaxOutputTokens(draftMaxTokens);
			const maxTokensInvalid = draftMaxTokensValue === void 0;
			const maxTokensDirty = draftMaxTokens.trim() !== String(savedMaxTokens);
			const capDrafts = parseCapDrafts(draftModelCaps);
			const modelCapsInvalid = capDrafts.invalid.length > 0;
			const modelCapsDirty = capKey(capDrafts.caps) !== savedModelCapsKey;
			const aliasDrafts = parseModelAliases(draftAliases);
			const aliasesDirty = aliasKey(aliasDrafts) !== savedAliasesKey;
			const extraLevelsDirty = !sameIdSet(draftExtraLevels, savedExtraLevels);
			const dirty = sidDirty || draftCookieOnly !== savedCookieOnly || maxTokensDirty || modelCapsDirty || aliasesDirty || extraLevelsDirty || !sameIdSet(draftEnabled, savedEnabledIds);
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
			const migratePlaintext = (0, react.useCallback)(async () => {
				if (settingsScope === void 0) return;
				setMigrating(true);
				setSidNote(void 0);
				try {
					const answer = await sealStoredComateSid();
					await writeComateSettings(settingsScope, { wpsSid: answer.sealed });
					if (!mounted.current) return;
					setSidNote({
						tone: "ok",
						text: t("row.sidMigrated", { length: answer.length })
					});
				} catch (cause) {
					if (!mounted.current) return;
					setSidNote({
						tone: "error",
						text: t("row.sidMigrateFailed", { message: messageOf(cause) })
					});
				} finally {
					if (mounted.current) setMigrating(false);
				}
			}, [settingsScope, t]);
			(0, react.useEffect)(() => {
				if (sidStorage !== "plaintext" || !writable || saving || migrating) return;
				if (draftSid !== null || clearPending || migrateStarted.current) return;
				migrateStarted.current = true;
				migratePlaintext();
			}, [
				sidStorage,
				writable,
				saving,
				migrating,
				draftSid,
				clearPending,
				migratePlaintext
			]);
			const toggleModel = (id) => {
				setDraftEnabled((current) => {
					const next = new Set(current);
					if (!next.delete(id)) next.add(id);
					return next;
				});
			};
			/**
			* Flip one extra thinking level in the draft.
			*
			* A set, not a list: the levels have a fixed vocabulary and a fixed display
			* order (both from `bridge.ts`), so the draft only ever records membership and
			* the save path emits the canonical order.
			*/
			const toggleThinkingLevel = (level) => {
				setDraftExtraLevels((current) => {
					const next = new Set(current);
					if (!next.delete(level)) next.add(level);
					return next;
				});
			};
			const discard = () => {
				setDraftSid(null);
				setClearPending(false);
				setDraftCookieOnly(savedCookieOnly);
				setDraftEnabled(new Set(savedEnabledIds));
				setDraftMaxTokens(String(savedMaxTokens));
				setDraftModelCaps(textCapDrafts(savedModelCaps));
				setDraftAliases(textAliasDrafts(savedAliases));
				setDraftExtraLevels(new Set(savedExtraLevels));
				setError(void 0);
				setSidNote(void 0);
			};
			const formatContext = (value) => {
				if (value >= 1e6) return `${value / 1e6}M`;
				if (value >= 1e3) return `${value / 1e3}K`;
				return String(value);
			};
			const save = async () => {
				if (settingsScope === void 0 || saving) return;
				setSaving(true);
				setError(void 0);
				setSidNote(void 0);
				try {
					let sealedSid;
					let sealedLength;
					if (sidReplace) try {
						const answer = await sealComateSid(trimmedSid);
						sealedSid = answer.sealed;
						sealedLength = answer.length;
					} catch (cause) {
						if (mounted.current) setError(t("row.sidSealFailed", { message: messageOf(cause) }));
						return;
					}
					const allSelected = catalogIds.every((id) => draftEnabled.has(id));
					const enabledModelIds = catalog.length === 0 ? saved.enabledModelIds ?? [] : allSelected ? [] : catalogIds.filter((id) => draftEnabled.has(id));
					await writeComateSettings(settingsScope, {
						...clearPending ? { wpsSid: "" } : sidReplace ? { wpsSid: sealedSid } : {},
						cookieOnly: draftCookieOnly,
						enabledModelIds,
						...draftMaxTokensValue === void 0 ? {} : { maxOutputTokens: draftMaxTokensValue },
						...modelCapsDirty ? { maxOutputTokensByModel: capDrafts.caps } : {},
						...aliasesDirty ? { modelAliases: Object.fromEntries(aliasDrafts) } : {},
						...extraLevelsDirty ? { extraThinkingLevels: COMATE_EXTRA_THINKING_LEVELS.filter((level) => draftExtraLevels.has(level)) } : {}
					});
					if (!mounted.current) return;
					setDraftSid(null);
					setClearPending(false);
					setSavedFlash(true);
					if (clearPending) setHostSid({ storage: "unset" });
					else if (sealedSid !== void 0) setHostSid({ storage: "sealed" });
					if (sealedLength !== void 0) setSidNote({
						tone: "ok",
						text: t("row.sidSavedSealed", { length: sealedLength })
					});
					window.setTimeout(() => {
						if (mounted.current) setSavedFlash(false);
					}, 4e3);
				} catch (cause) {
					if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
				} finally {
					if (mounted.current) setSaving(false);
				}
			};
			const title = t("row.title");
			const sidConfigured = sidStorage !== "unset";
			const sidKeepsStored = sidStorage === "sealed" || sidStorage === "plaintext";
			const sidStatusText = sidStorage === "sealed" ? t("row.sidSet") : sidStorage === "plaintext" ? t("row.sidSetPlain") : sidStorage === "unreadable" ? t("row.sidUnreadable") : t("row.sidUnset");
			const sidStatusTone = sidStorage === "sealed" ? "ok" : sidStorage === "unset" ? "empty" : "warn";
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
				className: `dsm-plugin-card${open ? " dsm-plugin-card-open" : ""}`,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
					type: "button",
					className: "dsm-plugin-card-header",
					"aria-expanded": open,
					"aria-label": `${t(open ? "row.collapse" : "row.expand")}: ${title}`,
					onClick: () => {
						setOpen(!open);
					},
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("img", {
							className: "dsm-plugin-card-icon",
							src: COMATE_PLUGIN_ICON,
							alt: ""
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: "dsm-plugin-card-head",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dsm-plugin-card-title",
								children: title
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dsm-plugin-card-description",
								children: t("row.desc")
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							"aria-hidden": "true",
							className: `dsm-plugin-card-chevron${open ? " dsm-plugin-card-chevron-open" : ""}`
						})
					]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: "dsm-plugin-card-body",
					hidden: !open,
					children: open ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsm-comate",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dsm-comate-status",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										"aria-hidden": "true",
										className: `dsm-comate-status-dot ${sidStatusTone === "ok" ? "dsm-comate-status-ok" : "dsm-comate-status-empty"}`
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: sidStatusTone === "warn" ? "dsm-comate-status-warn" : void 0,
										children: sidStatusText
									}),
									sidStorage === "unreadable" && hostSid?.problem !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "dsm-comate-status-warn",
										children: t("row.sidUnreadableWhy", { reason: hostSid.problem })
									}) : null,
									sidStorage === "plaintext" && writable ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: "dsm-btn dsm-btn-outline",
										disabled: saving || migrating,
										onClick: () => {
											migrateStarted.current = true;
											migratePlaintext();
										},
										children: migrating ? t("row.sidMigrating") : t("row.sidMigrate")
									}) : null
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dsm-comate-field",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
										className: "dsm-comate-label",
										htmlFor: "dsh-comate-wps-sid",
										children: t("row.sidLabel")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "dsm-comate-sid-row",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
											id: "dsh-comate-wps-sid",
											className: "dsm-comate-input dsm-comate-input-secret",
											type: "password",
											autoComplete: "new-password",
											autoCapitalize: "off",
											autoCorrect: "off",
											spellCheck: false,
											"aria-describedby": "dsh-comate-wps-sid-hint",
											onCopy: blockClipboard,
											onCut: blockClipboard,
											onDragStart: blockClipboard,
											onContextMenu: blockClipboard,
											placeholder: clearPending ? t("row.sidClearPending") : sidKeepsStored ? t("row.sidPlaceholderSet") : t("row.sidPlaceholder"),
											value: draftSid ?? "",
											disabled: !writable || saving || clearPending || migrating,
											onChange: (event) => {
												setDraftSid(event.currentTarget.value);
											}
										}), sidConfigured && writable && !clearPending ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											className: "dsm-btn dsm-btn-outline",
											disabled: saving,
											onClick: () => {
												setClearPending(true);
												setDraftSid(null);
											},
											children: t("row.clear")
										}) : null]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
										className: "dsm-comate-hint",
										id: "dsh-comate-wps-sid-hint",
										children: t("row.sidHint")
									}),
									sidNote === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Note, { note: sidNote })
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
								className: "dsm-comate-check",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									type: "checkbox",
									checked: draftCookieOnly,
									disabled: !writable || saving,
									onChange: (event) => {
										setDraftCookieOnly(event.currentTarget.checked);
									}
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("row.cookieOnly") })]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dsm-comate-field",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
										className: "dsm-comate-label",
										htmlFor: "dsh-comate-max-tokens",
										children: t("row.maxTokensLabel")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "dsm-comate-number-row",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
											id: "dsh-comate-max-tokens",
											className: "dsm-comate-input dsm-comate-input-number",
											type: "number",
											inputMode: "numeric",
											min: 0,
											step: 1,
											spellCheck: false,
											placeholder: String(COMATE_DEFAULT_MAX_TOKENS),
											value: draftMaxTokens,
											disabled: !writable || saving,
											"aria-invalid": maxTokensInvalid,
											onChange: (event) => {
												setDraftMaxTokens(event.currentTarget.value);
											}
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "dsm-comate-unit",
											children: t("row.maxTokensUnit")
										})]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
										className: `dsm-comate-hint${maxTokensInvalid ? " dsm-comate-hint-error" : ""}`,
										children: maxTokensInvalid ? t("row.maxTokensInvalid") : t("row.maxTokensHint")
									})
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
								className: "dsm-comate-models",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "dsm-comate-models-head",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
											className: "dsm-comate-models-title",
											children: t("row.modelsTitle")
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: "dsm-comate-models-tools",
											children: [
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
													type: "button",
													className: "dsm-btn dsm-btn-outline",
													disabled: !writable || saving,
													onClick: () => {
														setDraftEnabled(new Set(catalogIds));
													},
													children: t("row.selectAll")
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
													type: "button",
													className: "dsm-btn dsm-btn-outline",
													disabled: !writable || saving,
													onClick: () => {
														setDraftEnabled(/* @__PURE__ */ new Set());
													},
													children: t("row.selectNone")
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
													type: "button",
													className: "dsm-btn dsm-btn-outline",
													disabled: refreshing,
													onClick: () => {
														onRefresh();
													},
													children: refreshing ? t("row.refreshing") : t("row.refresh")
												})
											]
										})]
									}),
									refreshNote === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Note, { note: refreshNote }),
									catalog.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
										className: "dsm-comate-hint",
										children: t(catalogFailed ? "row.modelsUnavailable" : "row.modelsEmpty")
									}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
											className: "dsm-comate-hint",
											children: [
												t("row.modelsSummary", {
													checked: draftEnabled.size,
													total: catalog.length
												}),
												" · ",
												t("row.modelsHint")
											]
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
											className: "dsm-comate-model-list",
											children: catalog.map((model) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
												className: "dsm-comate-model",
												children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
													className: "dsm-comate-model-main",
													children: [
														/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
															className: "dsm-comate-model-row",
															title: model.id,
															children: [
																/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
																	type: "checkbox",
																	checked: draftEnabled.has(model.id),
																	disabled: !writable || saving,
																	onChange: () => {
																		toggleModel(model.id);
																	}
																}),
																/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
																	className: "dsm-comate-model-name",
																	children: (draftAliases[model.id] ?? "").trim() || model.name
																}),
																model.multimodal ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
																	className: "dsm-comate-model-tag",
																	children: t("row.modelMultimodal")
																}) : null
															]
														}),
														/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
															className: "dsm-comate-model-alias",
															children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
																className: "dsm-comate-input",
																type: "text",
																spellCheck: false,
																autoComplete: "off",
																"aria-label": t("row.modelAliasAria", { model: model.name }),
																title: t("row.modelAliasTitle"),
																placeholder: model.name,
																value: draftAliases[model.id] ?? "",
																disabled: !writable || saving,
																onChange: (event) => {
																	const text = event.currentTarget.value;
																	setDraftAliases((current) => ({
																		...current,
																		[model.id]: text
																	}));
																}
															})
														}),
														/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
															className: "dsm-comate-model-cap",
															children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
																className: "dsm-comate-input dsm-comate-input-number",
																type: "number",
																inputMode: "numeric",
																min: 0,
																step: 1,
																spellCheck: false,
																"aria-label": t("row.modelCapAria", {
																	model: model.name,
																	global: savedMaxTokens
																}),
																title: t("row.modelCapTitle"),
																placeholder: String(savedMaxTokens),
																value: draftModelCaps[model.id] ?? "",
																disabled: !writable || saving,
																"aria-invalid": capDrafts.invalid.includes(model.id),
																onChange: (event) => {
																	const text = event.currentTarget.value;
																	setDraftModelCaps((current) => ({
																		...current,
																		[model.id]: text
																	}));
																}
															}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
																className: "dsm-comate-unit",
																children: t("row.maxTokensUnit")
															})]
														})
													]
												}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
													className: "dsm-comate-model-meta",
													children: [
														formatContext(model.contextWindow),
														" context · ",
														model.id
													]
												})]
											}, model.id))
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
											className: `dsm-comate-hint${modelCapsInvalid ? " dsm-comate-hint-error" : ""}`,
											children: modelCapsInvalid ? t("row.modelCapInvalid") : t("row.modelCapHint", { global: savedMaxTokens })
										})
									] })
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
								className: "dsm-comate-thinking",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
										className: "dsm-comate-models-title",
										children: t("row.thinkingTitle")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
										className: "dsm-comate-hint",
										children: t("row.thinkingHint", { base: COMATE_BASE_THINKING_LEVELS.join(" / ") })
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										className: "dsm-comate-thinking-levels",
										children: COMATE_EXTRA_THINKING_LEVELS.map((level) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
											className: "dsm-comate-check",
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
												type: "checkbox",
												checked: draftExtraLevels.has(level),
												disabled: !writable || saving,
												onChange: () => {
													toggleThinkingLevel(level);
												}
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t(THINKING_LEVEL_LABEL[level], { wire: COMATE_THINKING_LEVEL_WIRE[level] }) })]
										}, level))
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
										className: "dsm-comate-hint",
										children: t("row.thinkingOffHint")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
										className: "dsm-comate-hint",
										children: t("row.thinkingExtraHint")
									})
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dsm-comate-actions",
								children: [
									savedFlash ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
										className: "dsm-comate-saved",
										children: t("row.saved")
									}) : null,
									error === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
										className: "dsm-comate-error",
										children: t("row.saveError", { message: error })
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: "dsm-btn dsm-btn-outline",
										disabled: testing,
										onClick: () => {
											onTest();
										},
										children: testing ? t("row.testing") : t("row.test")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: "dsm-btn dsm-btn-outline",
										disabled: !dirty || saving,
										onClick: discard,
										children: t("row.discard")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: "dsm-btn dsm-btn-primary",
										disabled: !writable || !dirty || saving || maxTokensInvalid || modelCapsInvalid || sidReplace && trimmedSid.startsWith("wps_sid="),
										onClick: () => {
											save();
										},
										children: saving ? t("row.saving") : t("row.save")
									})
								]
							}),
							testNote === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Note, { note: testNote })
						]
					}) : null
				})]
			});
		}
		//#endregion
		//#region src/client/locales.ts
		/**
		* Plugin-card copy registered under the settings.comate locale namespace.
		* 结构参考 dingminhua/dsh-connect-workbuddy（MIT），文案按 Comate 改写。
		*
		* @module dsh-connect-comate/client/locales
		*/
		const en = {
			"row.title": "WPS Comate connection (dsh-connect-comate)",
			"row.desc": "Use the models of the locally signed-in WPS Comate account in DSH. Paste the wps_sid cookie from www.wps.cn below; it is stored encrypted.",
			"row.expand": "Expand",
			"row.collapse": "Collapse",
			"row.sidLabel": "wps_sid cookie (stored encrypted)",
			"row.sidPlaceholder": "Paste the wps_sid value (without the \"wps_sid=\" prefix)",
			"row.sidPlaceholderSet": "Saved (encrypted) — leave empty to keep the current value",
			"row.sidClearPending": "Will be cleared on save",
			"row.sidHint": "How to get it: sign in at https://www.wps.cn → F12 → Application → Cookies → copy the value of wps_sid. Saving encrypts it (AES-256-GCM) before it reaches the settings file; the key never leaves this machine. The field masks what you type and refuses to be copied.",
			"row.sidSet": "Configured (stored encrypted)",
			"row.sidSetPlain": "Configured, but still PLAINTEXT — upgrade it to encrypted storage",
			"row.sidUnset": "Not configured — llmproxy answers 401 without it",
			"row.sidUnreadable": "Saved encrypted, but this machine cannot decrypt it — treat it as not configured",
			"row.sidUnreadableWhy": "Reason: {reason}. The key file is missing, unreadable, or was made for another machine/user. Paste the sid again below, or point WPS_COMATE_SECRET_KEY_FILE at the right key file.",
			"row.sidMigrate": "Encrypt now",
			"row.sidMigrating": "Encrypting…",
			"row.sidMigrated": "Upgraded the plaintext sid to encrypted storage ({length} chars).",
			"row.sidMigrateFailed": "Upgrade to encrypted storage failed: {message}",
			"row.sidSavedSealed": "sid saved encrypted ({length} chars).",
			"row.sidSealFailed": "Encryption failed: {message} — nothing was written, the plaintext never reaches the settings file.",
			"row.cookieOnly": "Cookie-only auth (do not send Authorization; enable only if the upstream rejects the key)",
			"row.maxTokensLabel": "Default output token cap",
			"row.maxTokensUnit": "tokens",
			"row.maxTokensHint": "A positive integer caps every answer; 0 means no cap (the upstream decides). Default 32000, and it applies to every model that has no cap of its own below. The WPS_COMATE_MAX_TOKENS environment variable wins over both when set.",
			"row.maxTokensInvalid": "Enter 0 or a positive integer.",
			"row.modelCapTitle": "Per-model output token cap (empty = follow the default)",
			"row.modelCapHint": "Each model can cap itself: leave a box empty to follow the default above ({global}); 0 means no cap for that model.",
			"row.modelCapInvalid": "A per-model cap is unusable: enter 0 or a positive integer.",
			"row.modelCapAria": "Output token cap for {model} (empty follows the default {global})",
			"row.modelAliasTitle": "Display name for this model (empty keeps the name Comate reported)",
			"row.modelAliasAria": "Display name for {model} (empty keeps the discovered name)",
			"row.thinkingTitle": "Thinking levels (advanced)",
			"row.thinkingHint": "The picker lists {base} by default; the levels you check below are ADDED to it.",
			"row.thinkingOff": "Off (sends reasoning_effort={wire})",
			"row.thinkingXhigh": "Xhigh (sends reasoning_effort={wire})",
			"row.thinkingMax": "Max (sends reasoning_effort={wire})",
			"row.thinkingOffHint": "Off really sends reasoning_effort=off, and that stops thinking on most models in this catalog — but it is not only a new row in the picker: choosing Off sends no level at all, and pi-ai reads \"no level\" as this entry, so the picker's \"provider default\" starts meaning \"no thinking\" too. Two measured caveats: the OpenAI spelling `none` is NOT this (the gateway accepts it and keeps thinking), and whether thinking really stops is up to the upstream model (glm-5.3 / glm-5.3-flash were measured ignoring `off`).",
			"row.thinkingExtraHint": "Xhigh and Max are accepted and keep thinking, but measured no stronger than high: two samples at the SAME level differed by more than the levels differ from each other. They are offered as aliases, not as a stronger setting.",
			"row.save": "Save",
			"row.saving": "Saving…",
			"row.saved": "Saved. Restart is not required; the next chat uses it.",
			"row.discard": "Discard",
			"row.saveError": "Save failed: {message}",
			"row.clear": "Clear saved sid",
			"row.modelsTitle": "Enabled models",
			"row.modelsHint": "Only checked models appear in the DSH model list; leaving all checked (or saving none) shows every model.",
			"row.modelsSummary": "{checked} / {total} shown",
			"row.selectAll": "Check all",
			"row.selectNone": "Uncheck all",
			"row.modelMultimodal": "Image",
			"row.modelsEmpty": "No model directory yet. Sign the WPS Comate desktop client in and restart DSH.",
			"row.modelsUnavailable": "The model directory is unavailable: this deployment serves no host web route. Model serving is unaffected — reopen DSH with the web UI, or run `dsh plugin exec dsh-connect-comate status`.",
			"row.refresh": "Refresh models",
			"row.refreshing": "Refreshing…",
			"row.refreshed": "Re-read the local Comate config: {count} model(s).",
			"row.refreshSignedOut": "Re-read the local Comate config, but found no signed-in Comate credential.",
			"row.refreshFailed": "Refresh failed: {message}",
			"row.test": "Test connection",
			"row.testing": "Testing…",
			"row.testOkContent": "Connected. Credential accepted, stream completed, and the model returned content. Probe model: {model}",
			"row.testOkNoContent": "Connected. Credential accepted and the stream completed, but no text arrived — the probe caps output at 8 tokens, so a thinking model can answer with nothing but reasoning. Probe model: {model}",
			"row.testIncomplete": "Credential accepted, but the probe did not finish: HTTP {status} [{kind}] {message}",
			"row.testFail": "Failed: HTTP {status} [{kind}] {message}",
			"row.testNoCredential": "No credential to test: paste a wps_sid above, or sign in to the WPS Comate desktop client first.",
			"row.testNoModel": "No model available to probe: the discovered directory is empty."
		};
		const zh = {
			"row.title": "WPS Comate 连接（dsh-connect-comate）",
			"row.desc": "在 DSH 中直接使用本机 WPS Comate 账号的模型。把 www.wps.cn 的 wps_sid Cookie 填到下面即可，保存后以密文存储。",
			"row.expand": "展开",
			"row.collapse": "收起",
			"row.sidLabel": "wps_sid Cookie（密文保存）",
			"row.sidPlaceholder": "粘贴 wps_sid 的值（不带 \"wps_sid=\" 前缀）",
			"row.sidPlaceholderSet": "已保存（密文）——留空保持现有值不变",
			"row.sidClearPending": "将在保存时清除",
			"row.sidHint": "获取方式：登录 https://www.wps.cn → F12 → Application（应用）→ Cookies → 复制 wps_sid 的值。保存时会先用 AES-256-GCM 加密再写入设置文件，密钥不出本机；输入框只显示圆点，且不允许复制。",
			"row.sidSet": "已配置（密文保存）",
			"row.sidSetPlain": "已配置，但当前仍是明文——建议升级为密文存储",
			"row.sidUnset": "未配置——不填的话上游会返回 401",
			"row.sidUnreadable": "已密文保存，但本机解不开——请当作未配置处理",
			"row.sidUnreadableWhy": "原因：{reason}。密钥文件缺失、不可读，或是在别的机器/账号下生成的。请在下方重新粘贴 sid，或用 WPS_COMATE_SECRET_KEY_FILE 指向正确的密钥文件。",
			"row.sidMigrate": "立即加密",
			"row.sidMigrating": "加密中…",
			"row.sidMigrated": "已把明文 sid 升级为密文存储（{length} 字符）。",
			"row.sidMigrateFailed": "升级为密文失败：{message}",
			"row.sidSavedSealed": "sid 已加密保存（{length} 字符）。",
			"row.sidSealFailed": "加密失败：{message}——未写入任何内容，明文不会落盘。",
			"row.cookieOnly": "只用 Cookie 鉴权（不发送 Authorization；仅在上游报密钥无效时开启）",
			"row.maxTokensLabel": "默认输出 token 上限",
			"row.maxTokensUnit": "tokens",
			"row.maxTokensHint": "正整数为上限；0 表示不限制（由上游决定）。默认 32000，下面没有单独设上限的模型都用这个值。环境变量 WPS_COMATE_MAX_TOKENS 存在时优先于两者生效。",
			"row.maxTokensInvalid": "请填 0 或正整数。",
			"row.modelCapTitle": "该模型的输出 token 上限（留空 = 跟随默认值）",
			"row.modelCapHint": "每个模型可以单独设上限：留空跟随上面的默认值（{global}）；0 表示这个模型不限制。",
			"row.modelCapInvalid": "有模型的输出上限填写不合法：请填 0 或正整数。",
			"row.modelCapAria": "{model} 的输出 token 上限（留空则跟随默认值 {global}）",
			"row.modelAliasTitle": "该模型的显示名（留空则用 Comate 报的名字）",
			"row.modelAliasAria": "{model} 的显示名（留空则用发现到的名字）",
			"row.thinkingTitle": "思考档位（高级）",
			"row.thinkingHint": "模型选择器默认只列出 {base} 四档；下面勾选的档位会追加到选择器里。",
			"row.thinkingOff": "Off（发送 reasoning_effort={wire}）",
			"row.thinkingXhigh": "Xhigh（发送 reasoning_effort={wire}）",
			"row.thinkingMax": "Max（发送 reasoning_effort={wire}）",
			"row.thinkingOffHint": "Off 会真的发出 reasoning_effort=off，本目录里多数模型就此停止思考；但它不只多一行选项：在选择器里选 Off 等于什么都不发，而 pi-ai 正是把「什么都没发」读成这一项——所以打开它以后，选择器里的「provider default」也会一起变成不思考。两条实测注意：OpenAI 词汇表里的 none 不是这个意思（网关接受却照常思考），而是否真的停思考由上游模型决定（glm-5.3 / glm-5.3-flash 实测忽略 off）。",
			"row.thinkingExtraHint": "Xhigh / Max 上游接受且仍会思考，但实测并不比 high 更强：同一档位两次采样的差别就大于档位之间的差别。因此只作为别名提供，不代表更强的推理。",
			"row.save": "保存",
			"row.saving": "保存中…",
			"row.saved": "已保存，无需重启，下一条对话即生效。",
			"row.discard": "撤销修改",
			"row.saveError": "保存失败：{message}",
			"row.clear": "清除已存的 sid",
			"row.modelsTitle": "启用的模型",
			"row.modelsHint": "只有勾选的模型会出现在 DSH 模型列表里；全部勾选（或一个都不保存）时显示全部模型。",
			"row.modelsSummary": "已显示 {checked} / {total}",
			"row.selectAll": "全选",
			"row.selectNone": "全不选",
			"row.modelMultimodal": "图片",
			"row.modelsEmpty": "还没有模型目录：请先登录 WPS Comate 桌面端并重启 DSH。",
			"row.modelsUnavailable": "取不到模型目录：当前部署没有宿主 Web 路由。模型服务不受影响——请在带 Web UI 的 DSH 里重新打开，或运行 `dsh plugin exec dsh-connect-comate status` 查看。",
			"row.refresh": "刷新模型列表",
			"row.refreshing": "刷新中…",
			"row.refreshed": "已重新读取本机 Comate 配置：{count} 个模型。",
			"row.refreshSignedOut": "已重新读取本机 Comate 配置，但没有找到已登录的 Comate 凭据。",
			"row.refreshFailed": "刷新失败：{message}",
			"row.test": "测试连接",
			"row.testing": "测试中…",
			"row.testOkContent": "连接成功：凭据已通过、流正常结束、模型已返回内容。测试所用模型：{model}",
			"row.testOkNoContent": "连接成功：凭据已通过、流正常结束，但这次没有收到文本（探测只给 8 个输出 token，思考型模型可能只产出思考）。测试所用模型：{model}",
			"row.testIncomplete": "凭据已通过，但探测没有跑完：HTTP {status} [{kind}] {message}",
			"row.testFail": "失败：HTTP {status} [{kind}] {message}",
			"row.testNoCredential": "没有可测的凭据：请在上方填入 wps_sid，或先登录 WPS Comate 桌面端。",
			"row.testNoModel": "没有可用于测试的模型：发现的模型目录是空的。"
		};
		//#endregion
		//#region src/client/index.tsx
		/** Stable browser-plugin name. */
		const name = COMATE_CLIENT_NAME;
		/**
		* Client services required by this contribution.
		*
		* Deliberately only the two services that exist on BOTH host lines. The settings
		* surface differs by line — 0.1.5 provides `settingsScope`, 0.1.7 replaces it
		* with `configForms` — and Cordis' dependency gate is hard: any `inject` entry
		* the running line does not provide keeps `apply` from ever running. Probing both
		* through `ctx.get()` is what lets one build serve both lines.
		*/
		const inject = ["slots", "locale"];
		/** Register card copy and the Comate card under the plugin configuration surfaces. */
		function apply(ctx) {
			try {
				const namespace = "settings.comate";
				ctx.effect(() => ctx.locale.register(namespace, {
					zh,
					en
				}), "dsh-connect-comate: settings copy");
				const t = ctx.locale.bind(namespace);
				const settingsScope = acquireComateSettingsForm(ctx);
				const injectFace = () => ({
					t,
					settingsScope
				});
				/**
				* Run one registration, isolating its failure.
				*
				* Slots are declared by different plugins and differ per line: a slot this
				* line does not declare throws. Registering them all inside one guard would
				* let the missing one take the working ones with it — which is precisely how
				* a two-line build breaks on the line it was not tested against.
				*/
				const guarded = (label, register) => {
					try {
						register();
					} catch (error) {
						console.error(`[dsh-connect-comate] card slot "${label}" failed to register (host provider unaffected):`, error);
					}
				};
				guarded("plugins.bundle.config", () => {
					ctx.slots.inject("plugins.bundle.config", () => ctx.slots.register({
						name: "plugins.bundle.config",
						key: COMATE_ENTRY_ID,
						priority: 30,
						inject: injectFace
					}, ComateCard));
				});
				guarded("plugins.row.config", () => {
					ctx.slots.inject("plugins.row.config", () => ctx.slots.register({
						name: "plugins.row.config",
						key: `${COMATE_ENTRY_ID}#${COMATE_ENTRY_ID}`,
						priority: 30,
						inject: injectFace
					}, ComateCard));
				});
				guarded("settings.plugin.item", () => {
					const legacy = ctx.slots;
					legacy.inject("settings.plugin.item", () => legacy.register({
						name: "settings.plugin.item",
						key: COMATE_SETTINGS_NS,
						priority: 30,
						inject: injectFace
					}, ComateCard));
				});
			} catch (error) {
				console.error("[dsh-connect-comate] client card failed to load (host provider unaffected):", error);
			}
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});
