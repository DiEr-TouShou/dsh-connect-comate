import { chmod, link, mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { arch, homedir, hostname, platform, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, randomUUID } from "node:crypto";
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
* Prefix of a sealed (encrypted) `wps_sid` value.
*
* Declared here, not in `./secret.ts`, because **both halves** must agree on it:
* the host writes and reads it, and the card has to tell "already sealed" from
* "still plaintext" without importing `node:crypto`. `./secret.ts` imports this
* constant, so the spelling exists once.
*/
const COMATE_SEALED_PREFIX = "enc:v1:";
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
* Mark a schema field as a stable config reference on the DSH lines that
* support it.
*
* `volatile()` exists from schemastery 3.18.3 (the DSH 0.1.7 line, whose write
* gate reads the marker). Older pinning (3.18.2, the 0.1.5 line) has no such
* method, and the schema must stay byte-identical to the unmarked original
* there — so on that line this degrades to an identity no-op that returns the
* very same object.
*
* The signature preserves the caller's schema type exactly, so it works without
* importing schemastery's (unexported) `Schema` type alias, and both arms stay
* testable with a plain object stub.
*
* @param schema - any schemastery schema instance.
* @returns the volatile-marked schema, or the input unchanged when unsupported.
*/
function asVolatile(schema) {
	const probe = schema;
	if (typeof probe.volatile !== "function") return schema;
	return probe.volatile();
}
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
/**
* Deep copy of a config value with every live reference replaced by the value it
* resolves to.
*
* {@link unwrapVolatile} only peels the one level a caller reads, which is all
* ordinary read paths need. Handing a config object to a settings service is
* different: 0.1.5's `installSection` validates and `structuredClone`s the WHOLE
* object, so a reference surviving anywhere inside it fails schema validation
* with a message that names the field but not the cause
* (`$.wpsSid expected string but got [object Object]`) — and the namespace then
* never registers, so the card's settings silently disappear.
*
* Arrays are rebuilt rather than mutated in place, and the caller's object is
* never touched.
*
* @param value - a raw or resolved config value.
* @returns an equivalent structure containing no live references.
*/
function unwrapVolatileDeep(value) {
	const plain = unwrapVolatile(value);
	if (Array.isArray(plain)) return plain.map((item) => unwrapVolatileDeep(item));
	if (plain === null || typeof plain !== "object") return plain;
	const prototype = Object.getPrototypeOf(plain);
	if (prototype !== Object.prototype && prototype !== null) return plain;
	const source = plain;
	const result = {};
	for (const key of Object.keys(source)) result[key] = unwrapVolatileDeep(source[key]);
	return result;
}
//#endregion
//#region src/secret.ts
/**
* At-rest protection for the manually pasted `wps_sid`.
*
* 背景：v0.4 之前，卡片里填的 `wps_sid` 以**明文**写进 DSH 的设置文档
* （0.1.7 上就是用户手写的 `cordis.patch.yml`）。那是一个真实的长效凭据，而设置
* 文件会被分享、同步、备份、截图、误提交进 git——明文躺在里面就等于凭据在漂。
*
* 本模块把它变成密文：AES-256-GCM，密钥由**本机密钥文件**（随机 32 字节）与
* **机器指纹**经 HKDF-SHA256 派生。
*
* ## 威胁模型（说清楚，免得当成它做不到的事）
*
* 防的是：设置文件单独外流。共享 profile、提交 `cordis.patch.yml`、同步盘、
* 备份、截图、贴日志——拿到这些的人只看到 `enc:v1:<base64url>`。
*
* 不防的是：攻击者已经能读这台机器上当前用户的任意文件。密钥文件就在
* `~/.wpscomate/dsh-connect-comate/secret.key`，同机同用户可读；这不是
* 「用户设主密码」那种强度，也刻意不做成那种强度——那会要求每次启动解锁，
* 破坏无头运行与自启动。
*
* 机器指纹进 KDF 是为了堵住「设置文件 + 密钥文件一起被拷走」这条路径：换机、
* 换用户名、换平台/架构，派生出的密钥就不同，密文解不开（此时插件会明确报告
* 「已保存但无法解密」，让用户重新粘贴，而不是静默 401）。
*
* ## 格式
*
* 密钥文件（JSON，0600）：
*   `{ "v": 1, "alg": "aes-256-gcm+hkdf-sha256", "salt": "<base64url 32B>", "createdAt": "…" }`
*
* 密文（一个 YAML/JSON 里都安全的字符串）：
*   `enc:v1:` + base64url( iv[12] || tag[16] || ciphertext )
*
* base64url 而不是标准 base64，是为了让整串**不含 `+` `/` `=`**：它会写进
* YAML 的 plain scalar 位置，出现这些字符就要靠序列化器正确加引号，而
* `enc:v1:…` 里的冒号后面没有空格、本身就是合法 plain scalar（真机实测
* js-yaml dump/load 往返一致）。
*
* ## 为什么本模块不 import `auth.ts`
*
* `auth.ts` 需要它来解密（`auth → secret`），所以反过来 import 会成环。密钥
* 文件的**默认路径**因此留给 `auth.ts`（它本来就知道 `~/.wpscomate` 在哪），
* 这里只收显式路径：一个纯粹「路径进、密码学与文件 IO 出」的模块，也更好测。
*
* @module dsh-connect-comate/secret
*/
/**
* Env var pointing the key file somewhere else.
*
* 存在的理由和 `WPS_COMATE_CONFIG_FILE` 一样：无头/CI 场景要能把密钥放在自己
* 管得住的目录里。它**不是**「换一把密钥」的开关——换路径就是换密钥，已存的
* 密文会解不开。
*/
const COMATE_SECRET_KEY_ENV = "WPS_COMATE_SECRET_KEY_FILE";
/** Sub-directory of the Comate home that holds this plugin's own key file. */
const COMATE_SECRET_DIRNAME = "dsh-connect-comate";
/** File name of the key file inside {@link COMATE_SECRET_DIRNAME}. */
const COMATE_SECRET_KEY_FILENAME = "secret.key";
/** AES-256. */
const KEY_BYTES = 32;
/** GCM nonce length; 12 is the length GCM is specified and fastest for. */
const IV_BYTES = 12;
/** Random salt length in the key file. */
const SALT_BYTES = 32;
/** GCM additional authenticated data: never encrypted, but tamper-evident. */
const AAD = Buffer.from("dsh-connect-comate/wpsSid/v1", "utf8");
/** Cap on the derived-key cache; a handful of key files is already unusual. */
const DERIVED_CACHE_LIMIT = 8;
/**
* A stable, non-secret description of this machine and user.
*
* Every component is case-folded: Windows treats host names and user names
* case-insensitively, so a differently-cased read of the same machine must not
* derive a different key.
*
* `homedir()` is deliberately NOT part of it — it usually embeds the user name
* already, and a home directory that moves (a remapped drive, a renamed profile
* folder) would then silently invalidate every stored secret.
*
* @returns the fingerprint string used as HKDF salt.
*/
function machineFingerprint() {
	let user = "";
	try {
		user = userInfo().username;
	} catch {}
	return [
		platform(),
		arch(),
		hostname().toLowerCase(),
		user.toLowerCase()
	].join("|");
}
/** Derived keys by `path|stamp|fingerprint`, so a read does not re-run HKDF. */
const derivedKeys = /* @__PURE__ */ new Map();
/**
* Derive the AES key from the key file's salt and the machine fingerprint.
*
* `hkdfSync(digest, ikm, salt, info, keylen)`: the key file's random bytes are
* the input keying material (the secret), the fingerprint is the HKDF salt (not
* secret), and {@link HKDF_INFO} separates this key from any future use of the
* same file.
*/
function deriveKey(salt, fingerprint) {
	return Buffer.from(hkdfSync("sha256", salt, Buffer.from(fingerprint, "utf8"), AAD, KEY_BYTES));
}
/** Read and validate the key document, or say why it is unusable. */
async function readKeyDocument(path) {
	let text;
	let stamp;
	try {
		const [content, info] = await Promise.all([readFile(path, "utf8"), stat(path)]);
		text = content;
		stamp = `${info.mtimeMs}:${info.size}`;
	} catch (error) {
		return error?.code === "ENOENT" ? "missing" : "unreadable";
	}
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		return "unreadable";
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return "unreadable";
	const raw = parsed;
	if (typeof raw["salt"] !== "string") return "unreadable";
	const salt = Buffer.from(raw["salt"], "base64url");
	if (salt.length !== SALT_BYTES) return "unreadable";
	return {
		salt,
		stamp
	};
}
/**
* Publish a fresh key document at `path`, never replacing an existing one.
*
* Temp file + `link()`: `link` fails with `EEXIST` instead of overwriting, which
* is what makes "two processes seal at the same instant" safe — the loser reads
* the winner's key rather than installing a second one and orphaning the
* ciphertext the winner already produced. A plain `writeFile` would also leave a
* truncated file behind if the process died mid-write, and a truncated key file
* is unrecoverable (it can decrypt nothing, and overwriting it would orphan
* everything already sealed).
*
* On filesystems where hard links are unavailable the fallback is an exclusive
* create (`flag: 'wx'`), which keeps the "never replace" property.
*/
async function createKeyDocument(path) {
	const salt = randomBytes(SALT_BYTES);
	const document = `${JSON.stringify({
		v: 1,
		alg: "aes-256-gcm+hkdf-sha256",
		salt: salt.toString("base64url"),
		createdAt: (/* @__PURE__ */ new Date()).toISOString()
	}, null, 2)}\n`;
	const temp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
	try {
		await mkdir(dirname(path), {
			recursive: true,
			mode: 448
		});
		await writeFile(temp, document, {
			encoding: "utf8",
			mode: 384,
			flag: "wx"
		});
		await chmod(temp, 384).catch(() => {});
		try {
			await link(temp, path);
		} catch (error) {
			if (error?.code === "EEXIST") return await readKeyDocument(path);
			try {
				await writeFile(path, document, {
					encoding: "utf8",
					mode: 384,
					flag: "wx"
				});
				await chmod(path, 384).catch(() => {});
			} catch (fallbackError) {
				if (fallbackError?.code !== "EEXIST") return "unreadable";
			}
		}
		return await readKeyDocument(path);
	} catch {
		return "unreadable";
	} finally {
		await unlink(temp).catch(() => {});
	}
}
/**
* Load the derived key, optionally creating the key file.
*
* @param options - key file path and fingerprint.
* @param create - `true` when sealing (a missing key file is created), `false`
* when opening (a missing key file means the ciphertext is unrecoverable —
* creating one there would silently produce a key that can never decrypt it).
* @returns the key, or the failure to report.
*/
async function loadKey(options, create) {
	const fingerprint = options.fingerprint ?? machineFingerprint();
	let document = await readKeyDocument(options.keyFile);
	if (document === "missing") {
		if (!create) return "key-missing";
		document = await createKeyDocument(options.keyFile);
	}
	if (document === "missing") return "key-missing";
	if (document === "unreadable") return "key-unreadable";
	const cacheId = `${options.keyFile}|${document.stamp}|${fingerprint}`;
	const cached = derivedKeys.get(cacheId);
	if (cached !== void 0) return cached;
	const key = deriveKey(document.salt, fingerprint);
	if (derivedKeys.size >= DERIVED_CACHE_LIMIT) derivedKeys.clear();
	derivedKeys.set(cacheId, key);
	return key;
}
/** Whether a value is already sealed (never re-seals, never double-wraps). */
function isSealed(value) {
	return isSealedComateSecret(value);
}
/**
* Encrypt one plaintext secret into its storable form.
*
* @param plaintext - the sid, already trimmed by the caller.
* @param options - key file path and optional fingerprint override.
* @returns `enc:v1:<base64url>`, safe to put in a settings document.
* @throws {Error} when the key file cannot be created or read. Callers must not
* fall back to writing the plaintext: the whole point is that it never lands.
*/
async function sealSecret(plaintext, options) {
	if (plaintext === "") throw new Error("comate: refusing to seal an empty secret");
	const key = await loadKey(options, true);
	if (typeof key === "string") throw new Error(`comate: cannot seal the secret: the key file is ${key} (${options.keyFile})`);
	const iv = randomBytes(IV_BYTES);
	const cipher = createCipheriv("aes-256-gcm", key, iv);
	cipher.setAAD(AAD);
	const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
	return COMATE_SEALED_PREFIX + Buffer.concat([
		iv,
		cipher.getAuthTag(),
		ciphertext
	]).toString("base64url");
}
/**
* Decrypt a stored value.
*
* Never throws: "the stored sid cannot be opened" is a state the caller renders
* (the card explains it, `doctor` reports it), not an exception to guess at.
*
* @param sealed - the stored string, expected to carry the sealed prefix.
* @param options - key file path and optional fingerprint override.
* @returns the plaintext, or the reason it is unavailable.
*/
async function openSecret(sealed, options) {
	if (!isSealedComateSecret(sealed)) return {
		ok: false,
		reason: "malformed"
	};
	const raw = Buffer.from(sealed.slice(7), "base64url");
	if (raw.length <= 28) return {
		ok: false,
		reason: "malformed"
	};
	const key = await loadKey(options, false);
	if (typeof key === "string") return {
		ok: false,
		reason: key
	};
	try {
		const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, IV_BYTES));
		decipher.setAAD(AAD);
		decipher.setAuthTag(raw.subarray(IV_BYTES, 28));
		const value = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
		return value === "" ? {
			ok: false,
			reason: "malformed"
		} : {
			ok: true,
			value
		};
	} catch {
		return {
			ok: false,
			reason: "auth-failed"
		};
	}
}
//#endregion
//#region src/auth.ts
/**
* WPS Comate credential resolution: read-only discovery of the locally
* signed-in Comate desktop client.
*
* 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
*   — 只读发现桌面端登录态、按平台探测候选路径、doctor/status 诊断结构、
*     凭据绝不写入 DSH 设置等设计思路沿用自该项目；WPS 侧的路径与字段
*     为本机实测（2026-09）。
*
* WPS Comate 桌面端把登录后的模型接入配置保存在
*   `~/.wpscomate/config.json`（`providers.official` 一节），内含：
*     baseUrl    —— 如 https://comate.wps.cn/llmproxy/v1/user
*     apiKey     —— 上游鉴权密钥（authHeader=true 时走 Authorization 头）
*     headers.cookie —— 上游 Cookie
*     models[]   —— 模型目录（id / name / context_window / llm_types ...）
* 同构副本在 `~/.wpscomate/agent/models.json`。
* 本模块只读这些文件，从不写入；token 不进入 DSH 设置。
*
* ## 手动 wps_sid 的存储（v0.4 起为密文）
*
* 桌面端 config 里的 apiKey/cookie 只是占位，真正的会话 Cookie 由 Comate UI 每次
* 任务下发，所以 llmproxy 需要一个手工填的 `wps_sid`。它存在 DSH 的设置文档里
* （0.1.7 上就是用户手写的 `cordis.patch.yml`）——**v0.4 起存的是密文**
* （`enc:v1:…`，见 `./secret.ts`），本模块负责在读路径上把它解开。
*
* 兼容性：没有该前缀的值一律按**明文**读（0.4 之前写进去的、以及 `WPS_COMATE_SID`
* 这种用户自己给的值），所以升级不会把手上的凭据弄丢；卡片会在打开时把它升级成
* 密文。解不开的密文（密钥文件丢了、或密文来自另一台机器/另一个用户）不会抛错，
* 而是被当作「没有可用凭据」上报，并带上原因——静默 401 是这里最坏的失败形态。
*
* @module dsh-connect-comate/auth
*/
/** Env var overriding the exact Comate config file path. */
const COMATE_CONFIG_ENV = "WPS_COMATE_CONFIG_FILE";
/** Env var overriding the Comate home directory (default `~/.wpscomate`). */
const COMATE_HOME_ENV = "WPS_COMATE_HOME";
/**
* Env var providing the WPS login cookie (wps_sid) for manual auth mode.
*
* A **sealed** value is accepted here too: the read path is shared with the
* settings field, so `WPS_COMATE_SID=enc:v1:…` works and is the only way a
* headless run can use an encrypted credential.
*/
const COMATE_SID_ENV = "WPS_COMATE_SID";
const COMATE_CONFIG_FILENAME = "config.json";
const COMATE_MODELS_FILENAME = "models.json";
const COMATE_AGENT_SUBDIR = "agent";
const COMATE_USER_AUTH_RELPATH = join(COMATE_AGENT_SUBDIR, "auth", "user_auth.json");
/** Default context window when the config omits it (all observed models use 1M). */
const COMATE_DEFAULT_CONTEXT_WINDOW = 1e6;
/**
* The Comate marker for image input, one entry of a model's `llm_types`.
*
* 真机形状（`~/.wpscomate/config.json` → `providers.official.models[]`）：
*   `"llm_types": ["llm-chat", "llm-multimodal"]`
* 本机 10 个模型里 5 个带这个标记。
*/
const COMATE_MULTIMODAL_TYPE = "llm-multimodal";
/** The chat marker every catalogued model carries. */
const COMATE_CHAT_TYPE = "llm-chat";
function nonEmptyEnv(value) {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : void 0;
}
/** Trim a candidate value, treating blank as absent. */
function nonEmptyString(value) {
	return value === void 0 || value.trim() === "" ? void 0 : value.trim();
}
/** The Comate home directory (env override or `~/.wpscomate`). */
function defaultComateHome(env = process.env, home = homedir()) {
	return nonEmptyEnv(env["WPS_COMATE_HOME"]) ?? join(home, ".wpscomate");
}
/** Platform-default config candidates, in probe order. */
function defaultConfigCandidates(env = process.env, home = homedir()) {
	const root = defaultComateHome(env, home);
	return [join(root, COMATE_CONFIG_FILENAME), join(root, COMATE_AGENT_SUBDIR, COMATE_MODELS_FILENAME)];
}
/**
* Where the key that protects the stored `wps_sid` lives by default.
*
* Under the Comate home, NOT under the DSH profile: the whole point of sealing
* the sid is that the profile's settings document can leave this machine (be
* shared, synced, backed up, committed) without the credential going with it, so
* the key must not sit in the same directory tree as the ciphertext.
*
* It is a plain file, deliberately: OS keychain access would mean a native
* dependency or a platform-specific API call, and a master password would mean
* the user unlocking something before every headless run.
*
* @param env - environment to read {@link COMATE_SECRET_KEY_ENV} from.
* @param home - home directory to resolve the Comate home against.
* @returns the absolute key-file path.
*/
function defaultSecretKeyFile(env = process.env, home = homedir()) {
	return nonEmptyEnv(env["WPS_COMATE_SECRET_KEY_FILE"]) ?? join(defaultComateHome(env, home), "dsh-connect-comate", "secret.key");
}
/**
* Normalize one model's `llm_types` into a trimmed, de-duplicated array.
*
* 两种形状都收：真机是 **JSON 数组**（`["llm-chat", "llm-multimodal"]`），
* 而本模块最初的实现只认空格分隔的字符串——于是真机上 `llmTypes` 恒为
* `undefined`，5 个多模态模型在 DSH 里全部失去图片输入能力（测试数据用的是
* 字符串，所以 128 例全绿而真机功能缺失）。字符串分支保留，是为了让旧写法与
* 别处副本继续可读，不是主路径。
*
* @returns the types, or undefined when nothing usable is present.
*/
function parseLlmTypes(value) {
	const entries = typeof value === "string" ? value.split(/[\s,]+/) : Array.isArray(value) ? value : [];
	const types = [];
	for (const entry of entries) {
		if (typeof entry !== "string") continue;
		const type = entry.trim();
		if (type !== "" && !types.includes(type)) types.push(type);
	}
	return types.length === 0 ? void 0 : types;
}
/** Parse one config model entry; entries without an id are dropped. */
function parseComateModel(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return void 0;
	const raw = value;
	const id = typeof raw["id"] === "string" ? raw["id"].trim() : "";
	if (id === "") return void 0;
	const name = typeof raw["name"] === "string" && raw["name"].trim() !== "" ? raw["name"].trim() : id;
	const contextValue = typeof raw["context_window"] === "number" ? raw["context_window"] : raw["contextWindow"];
	const contextWindow = typeof contextValue === "number" && contextValue > 0 ? contextValue : COMATE_DEFAULT_CONTEXT_WINDOW;
	const llmTypes = typeof raw["multimodal"] === "boolean" ? [COMATE_CHAT_TYPE, ...raw["multimodal"] === true ? [COMATE_MULTIMODAL_TYPE] : []] : parseLlmTypes(raw["llm_types"]);
	const modelSource = typeof raw["model_source"] === "string" && raw["model_source"] !== "" ? raw["model_source"] : void 0;
	const modelTier = typeof raw["model_tier"] === "string" && raw["model_tier"] !== "" ? raw["model_tier"] : void 0;
	return {
		id,
		name,
		contextWindow,
		...llmTypes === void 0 ? {} : { llmTypes },
		...modelSource === void 0 ? {} : { modelSource },
		...modelTier === void 0 ? {} : { modelTier }
	};
}
/**
* Parse a Comate config document. Returns undefined when the document carries
* no usable `providers.official` (missing file content, wrong shape, empty
* baseUrl or apiKey).
*/
function parseComateConfig(text, filePath) {
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		return;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return void 0;
	const document = parsed;
	const providers = typeof document["providers"] === "object" && document["providers"] !== null ? document["providers"] : {};
	const official = typeof providers["official"] === "object" && providers["official"] !== null ? providers["official"] : void 0;
	if (official === void 0) return void 0;
	const baseUrl = typeof official["baseUrl"] === "string" && official["baseUrl"].trim() !== "" ? official["baseUrl"].trim() : "";
	const apiKey = typeof official["apiKey"] === "string" && official["apiKey"].trim() !== "" ? official["apiKey"].trim() : "";
	if (baseUrl === "" || apiKey === "") return void 0;
	const authHeader = official["authHeader"] !== false;
	let cookie;
	const headers = typeof official["headers"] === "object" && official["headers"] !== null ? official["headers"] : {};
	if (typeof headers["cookie"] === "string" && headers["cookie"] !== "" && headers["cookie"].trim().toUpperCase() !== "COOKIE") cookie = headers["cookie"];
	const models = [];
	if (Array.isArray(official["models"])) for (const raw of official["models"]) {
		const model = parseComateModel(raw);
		if (model !== void 0) models.push(model);
	}
	return {
		baseUrl,
		apiKey,
		...cookie === void 0 ? {} : { cookie },
		authHeader,
		models,
		configFile: filePath
	};
}
/**
* Read-only credential store. Resolves the first candidate that yields a
* valid credential; never writes the desktop client's files.
*/
var ComateCredentialStore = class {
	configFileOverride;
	wpsSidOverride;
	cookieOnlyOverride;
	secretKeyFileOverride;
	constructor(options = {}) {
		this.configFileOverride = options.configFile;
		this.wpsSidOverride = options.wpsSid;
		this.cookieOnlyOverride = options.cookieOnly === true;
		this.secretKeyFileOverride = options.secretKeyFile;
	}
	/** Repoint the config file; applies on the next read. */
	setConfigFile(path) {
		this.configFileOverride = path;
	}
	/**
	* Set the manual wps_sid; applies on the next read.
	*
	* The value is whatever the settings document holds — sealed (`enc:v1:…`) or
	* legacy plaintext — and is deliberately NOT decrypted here: this setter runs
	* inside the synchronous settings-change handler, and keeping the raw string
	* means the plaintext only exists for the one read that actually needs it.
	*/
	setWpsSid(sid) {
		this.wpsSidOverride = sid;
	}
	/** Toggle cookie-only auth; applies on the next read. */
	setCookieOnly(value) {
		this.cookieOnlyOverride = value;
	}
	/** Repoint the key file that protects a sealed sid; applies on the next read. */
	setSecretKeyFile(path) {
		this.secretKeyFileOverride = path;
	}
	/** The key file in force: explicit override, env, then the Comate-home default. */
	keyFile(env = process.env) {
		return this.secretKeyFileOverride ?? defaultSecretKeyFile(env);
	}
	/** The raw stored value (settings override or env), still sealed if sealed. */
	rawSid(env = process.env) {
		const sid = this.wpsSidOverride ?? nonEmptyEnv(env["WPS_COMATE_SID"]);
		return sid === void 0 || sid.trim() === "" ? void 0 : sid.trim();
	}
	/**
	* The raw value that came from the SETTINGS document, env ignored.
	*
	* The plaintext-upgrade path must act on what is actually stored: sealing the
	* `WPS_COMATE_SID` env value and writing that back would put a credential the
	* user only ever meant for one shell session into a persisted file.
	*/
	storedRawSid() {
		const sid = this.wpsSidOverride;
		return sid === void 0 || sid.trim() === "" ? void 0 : sid.trim();
	}
	/**
	* Resolve the stored sid for one read, decrypting a sealed value.
	*
	* @param env - environment to read {@link COMATE_SID_ENV} from.
	* @returns the usable sid (if any), how it was stored, and the key file used.
	*/
	async resolveSid(env = process.env) {
		const raw = this.rawSid(env);
		const keyFile = this.keyFile(env);
		if (raw === void 0) return {
			storage: "unset",
			keyFile
		};
		if (!raw.startsWith("enc:v1:")) return {
			sid: raw,
			storage: "plaintext",
			keyFile
		};
		const opened = await openSecret(raw, { keyFile });
		return opened.ok ? {
			sid: opened.value,
			storage: "sealed",
			keyFile
		} : {
			storage: "unreadable",
			problem: opened.reason,
			keyFile
		};
	}
	/**
	* Seal a plaintext sid into its storable form.
	*
	* @param sid - the value as typed; trimmed, and an empty one is refused.
	* @returns the sealed string plus the plaintext length, for the card's copy.
	* @throws {Error} when the key file cannot be created or read.
	*/
	async seal(sid, env = process.env) {
		const trimmed = sid.trim();
		if (trimmed === "") throw new Error("comate: refusing to seal an empty sid");
		return {
			sealed: await sealSecret(trimmed, { keyFile: this.keyFile(env) }),
			length: trimmed.length
		};
	}
	/**
	* Seal the value already stored in the settings document.
	*
	* This is the plaintext-upgrade path: the host seals what it already holds, so
	* the plaintext never has to travel through the browser to be re-saved.
	*
	* @throws {Error} when nothing is stored, the stored value is already sealed,
	* or the key file cannot be used.
	*/
	async sealStored(env = process.env) {
		const stored = this.storedRawSid();
		if (stored === void 0) throw new Error("comate: no stored wps_sid to seal");
		if (isSealedComateSecret(stored)) throw new Error("comate: the stored wps_sid is already sealed");
		if (stored.startsWith("enc:v1:")) throw new Error("comate: the stored wps_sid is a damaged sealed value; paste the sid again instead of re-sealing it");
		return await this.seal(stored, env);
	}
	/** The config-file candidates, in probe order. */
	candidates(env = process.env, home = homedir()) {
		const explicit = this.configFileOverride ?? nonEmptyEnv(env["WPS_COMATE_CONFIG_FILE"]);
		if (explicit !== void 0) return [explicit];
		return defaultConfigCandidates(env, home);
	}
	/** Read one candidate; a parse failure is reported, never thrown. */
	async readCandidate(path) {
		let text;
		try {
			text = await readFile(path, "utf8");
		} catch (error) {
			return { error: error?.code === "ENOENT" ? "missing" : `unreadable: ${String(error)}` };
		}
		const credential = parseComateConfig(text, path);
		return credential === void 0 ? { error: "unparsable or missing providers.official" } : { credential };
	}
	/**
	* First candidate that yields a valid credential.
	*
	* @param override - one-shot credential inputs, applied to THIS call only and
	* never stored. It exists so the card's 「测试连接」 can probe an unsaved draft
	* sid before the user commits to saving it; writing the draft into the
	* instance fields instead would let two concurrent requests contaminate each
	* other, and would make a mere test silently change what the plugin uses.
	* An absent or blank field falls back to the saved value.
	* @returns the credential, or undefined when no candidate resolves.
	*/
	async current(override = {}) {
		const draftSid = nonEmptyString(override.wpsSid);
		const cookieOnly = override.cookieOnly ?? this.cookieOnlyOverride;
		const storedSid = draftSid === void 0 ? (await this.resolveSid()).sid : void 0;
		const sid = draftSid ?? storedSid;
		for (const path of this.candidates()) {
			const { credential } = await this.readCandidate(path);
			if (credential !== void 0) {
				if (sid !== void 0 || cookieOnly) return {
					...credential,
					...sid !== void 0 ? { cookie: `wps_sid=${sid}` } : {},
					authHeader: credential.authHeader && !cookieOnly
				};
				return credential;
			}
		}
	}
	/** The credential to send upstream; throws when none is signed in. */
	async resolve() {
		const credential = await this.current();
		if (credential === void 0) throw new Error(`comate: no signed-in WPS Comate credential found (expected ${this.candidates().join(" or ")}, or set ${COMATE_CONFIG_ENV})`);
		return credential;
	}
	/** Read-only sign-in summary; never throws. */
	async status() {
		const credential = await this.current();
		return credential === void 0 ? { state: "signed-out" } : {
			state: "signed-in",
			baseUrl: credential.baseUrl,
			modelCount: credential.models.length
		};
	}
	/** Secret-free diagnostics for the doctor CLI. */
	async doctor(version, env = process.env, home = homedir()) {
		const candidates = [];
		for (const path of this.candidates(env, home)) {
			const { credential, error } = await this.readCandidate(path);
			candidates.push({
				path,
				present: error !== "missing",
				valid: credential !== void 0,
				...credential === void 0 ? {} : {
					baseUrl: credential.baseUrl,
					modelCount: credential.models.length
				},
				...error !== void 0 && error !== "missing" ? { error } : {}
			});
		}
		const signIn = (await this.status()).state;
		const userAuthPresent = await this.userAuthPresent(env, home);
		const sid = await this.resolveSid(env);
		const wpsSid = sid.storage === "unset" ? "unset" : "set";
		const hints = [];
		if (signIn !== "signed-in") hints.push("Sign in once in the WPS Comate desktop client (it writes ~/.wpscomate/config.json), then run status again.");
		if (!candidates.some((candidate) => candidate.present)) hints.push(`No Comate config file found; set ${COMATE_CONFIG_ENV} if it lives elsewhere.`);
		if (sid.storage === "unset") hints.push("The desktop config stores placeholder apiKey/cookie only (the real credential is delivered per task by the Comate UI), so llmproxy answers 401. Fill `wpsSid` in the DSH plugin settings (wps_sid from www.wps.cn cookies) or set WPS_COMATE_SID.");
		if (sid.storage === "plaintext") hints.push("The stored wps_sid is still PLAINTEXT in the DSH settings document. Open the plugin card once — it upgrades the value in place — or run `dsh-connect-comate seal` and paste the result yourself.");
		if (sid.storage === "unreadable") hints.push(`The stored wps_sid is sealed but cannot be decrypted (${sid.problem}); the key file ${sid.keyFile} is missing, unreadable, or was created for another machine/user. Paste the sid again in the plugin card, or point ${COMATE_SECRET_KEY_ENV} at the right key file.`);
		if (userAuthPresent === false) hints.push("No user_auth.json found; the plugin relies on config.json as-is (token refresh is a future step).");
		return {
			schemaVersion: 1,
			package: "dsh-connect-comate",
			version,
			node: process.version,
			candidates,
			userAuthPresent,
			signIn,
			wpsSid,
			wpsSidStorage: sid.storage,
			wpsSidProblem: sid.problem,
			wpsSidKeyFile: sid.keyFile,
			hints
		};
	}
	async userAuthPresent(env = process.env, home = homedir()) {
		const path = join(defaultComateHome(env, home), COMATE_USER_AUTH_RELPATH);
		try {
			await readFile(path);
			return true;
		} catch {
			return false;
		}
	}
	/**
	* The plugin keeps no credential copy of its own, so there is nothing to
	* remove; the Comate desktop files are never touched.
	*
	* The key file is deliberately left alone as well: deleting it would not
	* "log out", it would only make every already-stored ciphertext permanently
	* unopenable (and the next seal would mint a different key behind the user's
	* back). Removing the sid means clearing the settings field, which the card's
	* 「清除已存的 sid」 does.
	*/
	async logout() {}
};
//#endregion
//#region src/redact.ts
/**
* 凭据脱敏：任何**第三方文本**在越过边界（写进下游响应、写进日志）之前，先把里面
* 长得像令牌的东西抹掉。
*
* ## 为什么要有这个模块
*
* 上游网关的错误正文是别人写的文本，我们只是搬运工。它里面可能回显请求头、回显
* `Cookie`、或者干脆把整条 URL 抄回来——那是 `wps_sid`、Bearer、JWT 的真实内容。
* 这些字节一旦进了下游的 `{error:{message}}`，就等于把凭据交给了 pi-ai、交给了
* 浏览器面板、交给了任何读日志的人。所以脱敏不是「美化错误信息」，是**安全边界**。
*
* 之前只有 `check.ts` 有这层（按按钮时走一次），常驻的聊天数据路径 `shim.ts`
* 反而没有——低频那条路装了锁，高频那条门开着。现在两处 import 同一份规则。
* shim 写日志那几行本来就过了 `safeMessage`，缺的只是**下游响应**那三条出口。
*
* ## 为什么零依赖、单独一个文件
*
* 与 `model-alias.ts` 同理：卡片（浏览器半）与宿主（node 半）必须用**同一份**规则。
* 各写一份的话，「卡片里看不到凭据」与「日志里看不到凭据」会悄悄分叉。这个文件不
* import 任何东西，两半都能安全地引。
*
* ## 规则是「宁可多抹」，不是「精确识别」
*
* 误伤的表现是错误信息里少一个词（可接受），漏抹的表现是真凭据外泄（不可接受）。
* 所以键名匹配是宽泛的：`token` / `sid` / `key` / `secret` / `auth` 这些词（含
* `api_key`、`refresh_token` 这类派生写法）后面跟的 `=值` 或 `:值` 一律抹掉，
* 不区分它是不是真的密钥。
*
* 覆盖不到的：**没有键名、也没有已知前缀的裸凭据**（比如上游在散文里直接写
* `invalid sid 8f7e6d5c4b3a`）。识别它需要猜测「哪个长字符串是秘密」，那必然要么
* 误伤正常数字、要么仍然漏。这一条限制是自觉的，写在注释里而不是假装不存在。
* 它也是两处刻意例外的原因：`code=<错误码>`（纯数字或 `not_login` 这类标识，要留着给人搜）
* 与短的裸 `key: value`（那是英文句子，不是 YAML）。
*
* @module dsh-connect-comate/redact
*/
/** Replacement for a keyed value, e.g. `wps_sid=[redacted]`. */
const REDACTED = "[redacted]";
/** Replacement for a standalone token, e.g. `Bearer [redacted token]`. */
const REDACTED_TOKEN = "[redacted token]";
/**
* Key names whose value is treated as a secret, matched case-insensitively and
* allowing `-` / `_` between words (`api-key` / `api_key` / `apiKey`).
*
* `wps_sid` comes first so the alternation picks it over the bare `sid` — same
* output either way, but deterministic.
*
* `cookie` / `set-cookie` are deliberately **not** here: they are container
* headers, not single secrets, so matching them would swallow the whole value
* (`Cookie: [redacted]`) and hide which member leaked. Their members are always
* `k=v` pairs, which the same rule redacts one by one — labels intact.
*/
const SECRET_KEYS = "wps_sid|sid|session[_-]?id|session|token|access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|apikey|app[_-]?key|secret|client[_-]?secret|password|passwd|pwd|authorization|auth|code";
/**
* `code` 是唯一带例外的键，因为这个插件这条链路上的 `code` 几乎总是**错误码**，
* 而且实测有两种形状：纯数字（网关把会话失效写成 `"code":"12153"`）与符号标识
* （`"code":"not_login"`，本机真实返回）。两者都是用户要去搜的、也是本插件
* `classifyUpstreamError` 自己认的标记——抹成 `[redacted]` 等于让错误信息比上游原文
* 更难用，换来的安全性接近零。
*
* 只放行**标识符形状**：纯数字 ≤ 6 位，或字母开头、字母数字/下划线、≤ 32 字符。
* 凭据形状的值照样过不去：`-` `.` `+` `/` `=` 全不在允许集里（base64、UUID、
* `sk-live-…` 都不合规），JWT 与已知前缀更是被更早的规则先一步抹掉。
*
* 残留缺口（自觉的）：一个纯字母数字、≤ 32 字符的裸令牌恰好出现在 `code` 下会漏。
* 这与模块开头声明的「无键名、无已知前缀的裸凭据识别不了」是同一类限制。
*/
const ERROR_CODE_SHAPE = /^(?:\d{1,6}|[A-Za-z][A-Za-z0-9_]{0,31})$/u;
/**
* Minimum value length for the **bare** `key: value` spelling (no quotes, no `=`).
*
* 只有这一种拼写会和正常英文撞车：`cannot seal the secret: the key file is …`
* 里的 `secret: the` 长得和一条 YAML 凭据一模一样，而它只是句子。JSON（`"k":"v"`）
* 和 `k=v` 不会有这种歧义，所以只给裸冒号拼写加一个门槛：值得像凭据
* （无空格——这由正则保证——且至少 8 个字符）。
*
* 代价写清楚：`Authorization: abc123` 这种又短又没前缀、还没写 scheme 的值会漏过去。
* 真机上不会遇到（header 里的凭据都是长串），而这属于本模块开头就声明的
* 「无键名、无已知前缀的裸凭据识别不了」那一类限制。
*/
const BARE_COLON_MIN_VALUE = 8;
/** Well-known token prefixes that identify a secret even without a key name. */
const TOKEN_PREFIXES = "sk|ak|pk|glpat|gh[pousr]|xox[abprs]";
/**
* Keyed secrets in all three spellings: `k=v` (query, cookie, form), `"k":"v"`
* (JSON) and `k: v` (header, prose). The value stops at the first
* quote/comma/semicolon/ampersand/space/brace, which is what keeps a redacted
* JSON field from swallowing its neighbours.
*
* Kept apart from {@link TEMPLATE_RULES} because this one needs a replacer (the
* `code` carve-out below), not a `$n` template.
*/
const KEYED_SECRET = new RegExp(String.raw`(\b"?)(` + SECRET_KEYS + String.raw`)(\b"?\s*[=:]\s*"?)([^"',;&\s}]+)`, "giu");
/**
* One pass per shape, applied in order. Order matters in one place: the
* `Bearer <value>` rule runs before {@link KEYED_SECRET} so the scheme word is
* consumed as a scheme rather than mistaken for the value. Every rule is
* idempotent (`[redacted]` matches nothing), so a second pass over already
* redacted text is a no-op.
*/
const TEMPLATE_RULES = [
	[/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{4,}/giu, `$1 ${REDACTED}`],
	[/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{4,}(?:\.[A-Za-z0-9_-]+)?/gu, REDACTED_TOKEN],
	[new RegExp(String.raw`\b(?:` + TOKEN_PREFIXES + String.raw`)[-_][A-Za-z0-9_-]{8,}`, "gu"), REDACTED_TOKEN]
];
/**
* Remove token-shaped substrings from arbitrary text.
*
* Pure and idempotent: `redactSecrets(redactSecrets(x)) === redactSecrets(x)`.
*
* @param text - any text about to cross a boundary.
* @returns the same text with credential-shaped substrings replaced.
*/
function redactSecrets(text) {
	let out = text;
	for (const [pattern, replacement] of TEMPLATE_RULES) out = out.replace(pattern, replacement);
	return out.replace(KEYED_SECRET, (match, lead, key, separator, value) => {
		if (!separator.includes("=") && !separator.includes("\"") && value.length < BARE_COLON_MIN_VALUE) return match;
		if (key.toLowerCase() === "code" && ERROR_CODE_SHAPE.test(value)) return match;
		return `${lead}${key}${separator}${REDACTED}`;
	});
}
/**
* Redact an unexpected value and cap its length, for a message that leaves the
* host.
*
* Redaction runs BEFORE the cap: a cap-first order could cut a token in half and
* leave the first half of a real secret on display.
*
* @param error - any thrown value or third-party excerpt.
* @returns a single-line, redacted, length-capped message.
*/
function safeMessage(error) {
	return redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 500);
}
//#endregion
//#region src/multimodal.ts
/**
* Image media types the Comate pipeline handles.
*
* 抄自桌面端 `sidecar-v2/dist/multimodal/model-image-support.js` 的
* `SUPPORTED_IMAGE_MIME_TYPES`（实测该集合之外的类型会得到空正文，
* 例如 svg）。
*/
const SUPPORTED_IMAGE_MIME_TYPES = /* @__PURE__ */ new Set([
	"image/png",
	"image/jpeg",
	"image/webp",
	"image/gif",
	"image/bmp",
	"image/x-icon",
	"image/avif"
]);
/**
* `data:image/<type>;base64,<http(s) URL>` — a base64 prefix wrapped around a
* URL, i.e. a *fake* data URL. The payload after `base64,` is the real source.
*/
const FAKE_BASE64_IMAGE_URL_RE = /^data:image\/[^;,\s]+(?:;[^,]*)*;base64,(https?:\/\/.*)$/i;
/** `data:<mime>;<params>,<payload>`, with the mime and payload split out. */
const DATA_URL_RE = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+)((?:;[^,]*)*),([\s\S]*)$/i;
/** A zeroed stats record. */
function emptyImageStats() {
	return {
		seen: 0,
		repaired: 0,
		stripped: 0,
		dropped: 0
	};
}
/**
* Decide what (if anything) to send for one image source.
*
* Pure: no logging, no mutation, so the table in the module doc is directly
* assertable in tests.
*/
function sanitizeImageSource(source) {
	const trimmed = source.trim();
	if (trimmed === "") return { reason: "empty image source" };
	const fake = FAKE_BASE64_IMAGE_URL_RE.exec(trimmed);
	if (fake !== null) {
		const url = fake[1].trim();
		return url === "" ? { reason: "empty image source" } : {
			url,
			stripped: true
		};
	}
	const data = DATA_URL_RE.exec(trimmed);
	if (data !== null) {
		const mime = data[1].toLowerCase();
		if (data[3].trim() === "") return { reason: "empty image source" };
		return SUPPORTED_IMAGE_MIME_TYPES.has(mime) ? { url: trimmed } : { reason: `unsupported media type ${mime}` };
	}
	if (/^https?:\/\//i.test(trimmed)) return { url: trimmed };
	return { reason: "not an http(s) URL or image data URL" };
}
/** Content part types that carry an image on this wire. */
function isImagePart(part) {
	if (typeof part !== "object" || part === null || Array.isArray(part)) return false;
	const type = part["type"];
	return type === "image_url" || type === "input_image";
}
/** The source string of an image part, in either the string or object spelling. */
function imageSourceOf(part) {
	const value = part["image_url"];
	if (typeof value === "string") return value;
	if (typeof value === "object" && value !== null && !Array.isArray(value)) {
		const url = value["url"];
		if (typeof url === "string") return url;
	}
	const data = part["data"];
	return typeof data === "string" ? data : void 0;
}
/** The text part that stands in for an image we refuse to send. */
function omittedNotice(reason) {
	return {
		type: "text",
		text: `[image omitted: ${reason}]`
	};
}
/**
* Rewrite every image content part of a chat body into the shape the Comate
* gateway actually honours. Mutates `body` in place; stats are accumulated into
* the passed record so the caller can log what happened.
*
* @param body - a parsed chat-completions body.
* @param stats - accumulator; defaults to a throwaway record.
* @returns the same stats record.
*/
function normalizeChatImages(body, stats = emptyImageStats()) {
	const messages = body["messages"];
	if (!Array.isArray(messages)) return stats;
	for (const entry of messages) {
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
		const message = entry;
		const content = message["content"];
		if (!Array.isArray(content)) continue;
		const next = [];
		for (const part of content) {
			if (!isImagePart(part)) {
				next.push(part);
				continue;
			}
			stats.seen += 1;
			const record = part;
			const source = imageSourceOf(record);
			const verdict = source === void 0 ? { reason: "missing image source" } : sanitizeImageSource(source);
			if (verdict.url === void 0) {
				stats.dropped += 1;
				next.push(omittedNotice(verdict.reason ?? "unusable image source"));
				continue;
			}
			if (verdict.stripped === true) stats.stripped += 1;
			const alreadyObject = typeof record["image_url"] === "object" && record["image_url"] !== null;
			const urlChanged = source !== verdict.url;
			if (record["type"] !== "image_url" || !alreadyObject || urlChanged) stats.repaired += 1;
			const carried = {};
			for (const [key, value] of Object.entries(record)) if (key !== "data" && key !== "image_url" && key !== "type") carried[key] = value;
			next.push({
				...carried,
				type: "image_url",
				image_url: {
					...alreadyObject ? record["image_url"] : {},
					url: verdict.url
				}
			});
		}
		message["content"] = next;
	}
	return stats;
}
/** A zeroed upload-stats record. */
function emptyUploadStats() {
	return {
		externalized: 0,
		failed: 0
	};
}
/** 真 base64 图片 data URL；其余（裸 URL、假 base64 已被前一遍剥掉）不碰。 */
const INLINE_IMAGE_DATA_URL_RE = /^data:image\/[a-z0-9.+-]+(?:;[^,]*)?;base64,/i;
/** 取到能就地改写 `url` 的那个对象，兼容对象与字符串两种 `image_url` 拼法。 */
function imageUrlHolder(part) {
	const value = part["image_url"];
	if (typeof value === "object" && value !== null && !Array.isArray(value)) return value;
	if (typeof value === "string") {
		const holder = { url: value };
		part["image_url"] = holder;
		return holder;
	}
}
/**
* 把 body 里 inline base64 的图片换成上传后的 URL。
*
* 设计要点：
* - **在 {@link normalizeChatImages} 之后跑**：那时图片只剩「对象形状 + 真 base64」
*   一种形式，这一遍只需认 `data:image/*;base64,`，不必再处理裸字符串/假 base64。
* - **逐张降级**：某张图上传失败只影响那一张（保留 base64），不拖累整个请求。
* - **同一请求内按 URL 去重**：同一张图在一轮里出现多次（多轮历史）只等一次上传。
* - **没有任何改动就返回原字符串**：无图片的请求不重新序列化，字节级不变。
*
* @param source - 已归一化的请求体 JSON。
* @param uploader - 上传器；未注入时直接原样返回（功能关闭）。
* @param credential - 当前凭据；无 cookie 时上传器会拒绝，这里照样原样返回。
* @param stats - accumulator; filled with what was externalized and what failed.
* @returns 改写后的 body JSON，或原字符串。
*/
async function uploadChatImages(source, uploader, credential, stats = emptyUploadStats()) {
	if (uploader === void 0 || credential === void 0) return source;
	if (!source.includes("data:image/")) return source;
	let body;
	try {
		body = JSON.parse(source);
	} catch {
		return source;
	}
	if (typeof body !== "object" || body === null || Array.isArray(body)) return source;
	const messages = body["messages"];
	if (!Array.isArray(messages)) return source;
	const inFlight = /* @__PURE__ */ new Map();
	let changed = false;
	for (const entry of messages) {
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
		const content = entry["content"];
		if (!Array.isArray(content)) continue;
		for (const part of content) {
			if (!isImagePart(part)) continue;
			const holder = imageUrlHolder(part);
			if (holder === void 0) continue;
			const url = holder["url"];
			if (typeof url !== "string" || !INLINE_IMAGE_DATA_URL_RE.test(url.trim())) continue;
			let pending = inFlight.get(url);
			if (pending === void 0) {
				pending = uploader.upload(url, credential);
				inFlight.set(url, pending);
			}
			const uploaded = await pending;
			if (uploaded === void 0) {
				stats.failed += 1;
				continue;
			}
			holder["url"] = uploaded;
			stats.externalized += 1;
			changed = true;
		}
	}
	return changed ? JSON.stringify(body) : source;
}
//#endregion
//#region src/upstream.ts
/**
* WPS Comate upstream client: OpenAI-compatible chat streaming against the
* Comate `llmproxy` gateway.
*
* 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
*   — 强制 stream:true、tool_choice 压平为字符串、developer→system 改写、
*     错误分类（hard_credit / soft_rate / session_dead / ...）的做法沿用自
*     该项目（其上游协议参照 Sliverkiss/workbuddy2api，MIT）。
*
* 端点依据（本机实测，2026-09）：
*   WPS Comate 桌面端 config.json `providers.official` 给出的
*   baseUrl = https://comate.wps.cn/llmproxy/v1/user，
*   api = openai-completions；桌面端 sdk-v2-adapter 的请求头清单为
*   Cookie / X-Comate-Scene / X-Comate-Version / X-Request-Id / X-Session-Id，
*   authHeader=true（apiKey 走 Authorization）。
*   chat 请求路径 = {baseUrl}/chat/completions，SSE 流式返回。
*   X-Comate-Scene / X-Comate-Version 的具体取值需实机抓包确认；
*   服务端通常容忍缺失或旧版本，README 将其列为第一待验证项。
*
* @module dsh-connect-comate/upstream
*/
const COMATE_ORIGIN = "https://comate.wps.cn";
const COMATE_UA = "WPSComate/2.0 (compatible; dsh-connect-comate)";
const ERROR_BODY_LIMIT = 4096;
/** Insufficient-credit markers, ASCII lowercase plus the original Chinese. */
const HARD_CREDIT_MARKERS = [
	"insufficient credit",
	"no credit",
	"credit exhausted",
	"out of credit",
	"quota exceeded",
	"quota exhaust",
	"payment required",
	"credit not enough",
	"not enough credit",
	"积分不足",
	"额度不足",
	"余额不足",
	"积分用完",
	"额度用尽",
	"没有积分"
];
/** Session-invalidation markers that mean "sign in again in the Comate client". */
const SESSION_DEAD_MARKERS = [
	"Offline user session not found",
	"12153",
	"session expired",
	"not logged in",
	"unauthorized"
];
/** Classify an upstream failure from its HTTP status and body excerpt. */
function classifyUpstreamError(status, body) {
	if (status === 402) return "hard_credit";
	const lower = body.toLowerCase();
	for (const marker of HARD_CREDIT_MARKERS) if (lower.includes(marker.toLowerCase()) || body.includes(marker)) return "hard_credit";
	for (const marker of SESSION_DEAD_MARKERS) if (body.includes(marker)) return "session_dead";
	if (status === 429) return "soft_rate";
	if (status === 404) return "not_found";
	if (status >= 500) return "server";
	if (status >= 400) return "client";
	return "client";
}
/**
* Normalize an OpenAI chat-completions body for the Comate upstream: force
* `stream: true` (the Comate client streams SSE), flatten `tool_choice` (object
* forms are a common 400 source on custom gateways), and repair the image
* content shapes the gateway mishandles silently (see `multimodal.ts` for the
* probe table). `developer` role is rewritten to `system` defensively; if the
* gateway rejects `system`, remove this rewrite and re-test.
*
* @param source - the raw request body as received by the shim.
* @param imageStats - optional accumulator; when passed, it is filled with what
* the image pass saw and changed so the caller can log it. Purely diagnostic:
* omitting it changes no behaviour.
*/
function prepareChatBody(source, imageStats) {
	let body;
	try {
		body = JSON.parse(source);
	} catch {
		return source;
	}
	if (typeof body !== "object" || body === null || Array.isArray(body)) return source;
	const obj = body;
	obj["stream"] = true;
	if (Array.isArray(obj["messages"])) for (const value of obj["messages"]) {
		if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
		const message = value;
		if (message["role"] === "developer") message["role"] = "system";
	}
	normalizeToolChoice(obj);
	normalizeChatImages(obj, imageStats ?? emptyImageStats());
	return JSON.stringify(obj);
}
/** Rewrite OpenAI `tool_choice` spellings into the upstream's string form. */
function normalizeToolChoice(obj) {
	const suppress = () => {
		delete obj["tools"];
		delete obj["functions"];
	};
	if (!("tool_choice" in obj)) return;
	const choice = obj["tool_choice"];
	if (typeof choice === "string") {
		if (choice.trim().toLowerCase() === "none") {
			delete obj["tool_choice"];
			suppress();
		}
		return;
	}
	if (typeof choice === "object" && choice !== null && !Array.isArray(choice)) {
		const wrapped = choice;
		const type = typeof wrapped["type"] === "string" ? wrapped["type"].trim().toLowerCase() : "";
		if (type === "none") {
			delete obj["tool_choice"];
			suppress();
		} else if (type === "auto" || type === "required") obj["tool_choice"] = type;
		else if (type === "function") {
			const fn = typeof wrapped["function"] === "object" && wrapped["function"] !== null ? wrapped["function"] : void 0;
			let name = typeof fn?.["name"] === "string" ? fn["name"] : "";
			if (name === "" && typeof wrapped["name"] === "string") name = wrapped["name"];
			name = name.trim();
			obj["tool_choice"] = name !== "" ? name : "auto";
		} else delete obj["tool_choice"];
		return;
	}
	delete obj["tool_choice"];
}
/** Headers every chat request carries; values beyond auth are best-effort. */
function chatHeaders(credential) {
	return {
		"Accept": "text/event-stream, application/json",
		"Content-Type": "application/json",
		"User-Agent": COMATE_UA,
		"Origin": COMATE_ORIGIN,
		"Referer": `${COMATE_ORIGIN}/`,
		"X-Comate-Scene": "localChat",
		"X-Comate-Version": "2.0",
		"X-Request-Id": randomUUID(),
		"X-Session-Id": randomUUID(),
		...credential.authHeader ? { "Authorization": `Bearer ${credential.apiKey}` } : {},
		...credential.cookie === void 0 ? {} : { "Cookie": credential.cookie }
	};
}
/**
* Upstream HTTP client. One instance serves the whole plugin; requests take
* the credential explicitly so a config change applies on the next call.
*/
var ComateUpstreamClient = class {
	/** POST the chat endpoint; a successful answer is the raw SSE response. */
	async chatStream(credential, bodyJson, signal) {
		const base = credential.baseUrl.replace(/\/+$/, "");
		let response;
		try {
			response = await fetch(`${base}/chat/completions`, {
				method: "POST",
				headers: chatHeaders(credential),
				body: bodyJson,
				...signal === void 0 ? {} : { signal }
			});
		} catch (error) {
			return {
				ok: false,
				status: 0,
				kind: "server",
				message: `transport error: ${String(error)}`
			};
		}
		if (response.ok) return {
			ok: true,
			response
		};
		const text = (await response.text()).slice(0, ERROR_BODY_LIMIT);
		return {
			ok: false,
			status: response.status,
			kind: classifyUpstreamError(response.status, text),
			message: text
		};
	}
};
//#endregion
//#region src/check.ts
/**
* Output budget of the probe request. Small on purpose: the point is to learn
* whether the credential is accepted, not to generate anything.
*/
const COMATE_CHECK_MAX_TOKENS = 8;
/**
* Total wall-clock budget of one probe: the request AND the stream read.
*
* The probe is a handful of bytes each way and normally answers in under two
* seconds; a thinking model spending its eight tokens can take longer. What the
* budget is really for is the case where the upstream answers the status line
* and then says nothing at all — without it, the test button spins forever.
*/
const COMATE_CHECK_TIMEOUT_MS = 15e3;
/**
* How much of the probe stream is read at most.
*
* Reading the stream is only safe because it is bounded: a probe needs a few
* chunks to see whether an event, a clean end and some text arrived, and a
* stream that is still going after 64 KiB is not going to answer a question
* this small.
*/
const COMATE_CHECK_READ_LIMIT = 65536;
/**
* The probe request body.
*
* Deliberately minimal and fixed: `stream: true` because the Comate gateway
* always streams, one short user turn, and a tiny output budget. The CLI and
* the card send these same bytes, so a passing card check means exactly what a
* passing `check` command means.
*
* @param model - the model id to probe.
* @returns the JSON request body.
*/
function comateCheckBody(model) {
	return JSON.stringify({
		model,
		messages: [{
			role: "user",
			content: "ping"
		}],
		stream: true,
		max_tokens: 8
	});
}
/**
* Sentinel the read loop races its reads against.
*
* A plain `AbortSignal` is not enough on its own: aborting the fetch does kill
* the socket on the real path, but the loop must also stop waiting when the
* body in front of it ignores the abort (a stalled gateway, or a test's
* synthetic stream). Racing a deadline covers both, and the abort is still sent
* alongside it so the real socket is released rather than merely abandoned.
*/
const EXPIRED = Symbol("comate-probe-deadline");
/**
* Send one minimal chat request and report what happened.
*
* Never throws: every failure mode is an answer the caller renders, because
* "the probe failed" is a normal outcome of pressing a test button.
*
* @param options - credential, client, and the model to probe.
* @returns the observed outcome.
*/
async function runComateCheck(options) {
	const { credential, client, model, signal } = options;
	const timeoutMs = options.timeoutMs ?? 15e3;
	const controller = new AbortController();
	const budget = {
		ms: timeoutMs,
		spent: false,
		aborted: false
	};
	let expire = () => {};
	const expired = new Promise((resolve) => {
		expire = () => resolve(EXPIRED);
	});
	const timer = setTimeout(() => {
		budget.spent = true;
		expire();
		controller.abort();
	}, timeoutMs);
	const onAbort = () => {
		budget.aborted = true;
		expire();
		controller.abort();
	};
	if (signal !== void 0) {
		if (signal.aborted) onAbort();
		else signal.addEventListener("abort", onAbort, { once: true });
	}
	try {
		const step = await Promise.race([client.chatStream(credential, comateCheckBody(model), controller.signal), expired]);
		if (step === EXPIRED) return {
			ok: false,
			model,
			status: 0,
			kind: "server",
			message: budget.aborted ? "the probe was aborted before the upstream answered" : `probe timed out after ${timeoutMs}ms before the upstream answered`
		};
		const result = step;
		if (!result.ok) return {
			ok: false,
			model,
			status: result.status,
			kind: result.kind,
			message: safeMessage(result.message)
		};
		return await observeProbe(model, result.response, budget, expired);
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
	}
}
/**
* Read the probe stream and turn what it carried into an outcome.
*
* The branches mirror the order the gateway answers in: an error inside the
* stream, then "nothing at all", then "started but never finished", then a
* clean round trip. The first two are the shapes the old implementation
* reported as success.
*
* @param model - the model the probe used, echoed into the outcome.
* @param response - the 2xx response whose body is the SSE stream.
* @param budget - this probe's clock, read after the read to tell a timeout from an EOF.
* @param expired - the promise the read loop races against.
*/
async function observeProbe(model, response, budget, expired) {
	const observation = {
		events: 0,
		content: false,
		reasoning: false,
		ended: false,
		truncated: false
	};
	let readFailure;
	try {
		if (response.body === null) readFailure = "the response carried no body";
		else await readProbeStream(response.body, observation, expired);
	} catch (error) {
		readFailure = safeMessage(error);
	}
	const base = {
		model,
		status: response.status
	};
	if (observation.error !== void 0) return {
		...base,
		ok: false,
		accepted: observation.error.kind !== "session_dead",
		completed: false,
		content: observation.content,
		reasoning: observation.reasoning,
		kind: observation.error.kind,
		message: safeMessage(observation.error.message)
	};
	if (observation.events === 0) return {
		...base,
		ok: false,
		accepted: false,
		completed: false,
		content: false,
		reasoning: false,
		kind: "server",
		message: cutoffReason(budget, observation, readFailure)
	};
	if (!observation.ended) return {
		...base,
		ok: false,
		accepted: true,
		completed: false,
		content: observation.content,
		reasoning: observation.reasoning,
		kind: "server",
		message: cutoffReason(budget, observation, readFailure)
	};
	return {
		...base,
		ok: true,
		accepted: true,
		completed: true,
		content: observation.content,
		reasoning: observation.reasoning
	};
}
/**
* Why the read stopped before a clean end, in one line.
*
* Ordered by what the user can act on: a cancelled probe is not a fault, a
* spent budget means a slow or silent upstream, the byte cap means a stream
* that never ends, and anything left is the stream's own behaviour (a dead
* socket, or an end with nothing in it).
*
* @param budget - the probe's clock.
* @param observation - what the read got through.
* @param readFailure - the read's own error text, when it threw.
* @returns a redaction-safe one-line reason.
*/
function cutoffReason(budget, observation, readFailure) {
	const progress = observation.events === 0 ? "without a single SSE event" : `with ${observation.events} event(s) read`;
	if (budget.aborted) return `the probe was aborted ${progress}`;
	if (budget.spent) return `probe timed out after ${budget.ms}ms ${progress}`;
	if (observation.truncated) return `stopped reading after ${COMATE_CHECK_READ_LIMIT} bytes (${progress})`;
	return readFailure ?? `the stream ended ${progress}`;
}
/**
* Frame the SSE stream and record what it carried.
*
* Deliberately not a general SSE parser: the probe only needs to know whether
* an event arrived, whether one of them was an error, whether the stream
* signalled a clean end, and whether any text came out. Unknown fields are
* ignored, and a payload that is neither JSON nor `[DONE]` is ignored rather
* than fatal — a probe should not fail because the gateway added a comment line.
*
* @param body - the probe response body.
* @param observation - filled in place; a throw leaves the partial progress.
* @param expired - resolves when the probe's budget is spent.
*/
async function readProbeStream(body, observation, expired) {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let pending = "";
	let data = [];
	let bytes = 0;
	const flush = () => {
		if (data.length === 0) return;
		const payload = data.join("\n");
		data = [];
		absorbEvent(payload, observation);
	};
	try {
		for (;;) {
			const step = await Promise.race([reader.read(), expired]);
			if (step === EXPIRED) return;
			if (step.done) break;
			bytes += step.value.byteLength;
			pending += decoder.decode(step.value, { stream: true });
			let index = pending.indexOf("\n");
			while (index >= 0) {
				const line = pending.slice(0, index).replace(/\r$/, "");
				pending = pending.slice(index + 1);
				if (line === "") flush();
				else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
				index = pending.indexOf("\n");
			}
			if (observation.error !== void 0 || observation.ended) return;
			if (bytes >= 65536) {
				observation.truncated = true;
				return;
			}
		}
		flush();
		observation.ended = true;
	} finally {
		reader.cancel().catch(() => {});
	}
}
/** Fold one SSE event payload into the observation. */
function absorbEvent(payload, observation) {
	const text = payload.trim();
	if (text === "") return;
	observation.events += 1;
	if (text === "[DONE]") {
		observation.ended = true;
		return;
	}
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		if (classifyUpstreamError(200, text) === "session_dead") observation.error = {
			kind: "session_dead",
			message: text
		};
		return;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
	const frame = parsed;
	const error = frame["error"];
	if (error !== void 0 && error !== null) {
		observation.error = {
			kind: classifyStreamError(text, error),
			message: text
		};
		return;
	}
	const choices = frame["choices"];
	if (!Array.isArray(choices)) return;
	for (const choice of choices) {
		if (typeof choice !== "object" || choice === null) continue;
		const record = choice;
		const carrier = record["delta"] ?? record["message"];
		if (typeof carrier === "object" && carrier !== null) {
			const delta = carrier;
			if (nonEmptyText(delta["reasoning_content"]) || nonEmptyText(delta["reasoning"])) observation.reasoning = true;
			if (nonEmptyText(delta["content"])) observation.content = true;
		}
		if (record["finish_reason"] !== void 0 && record["finish_reason"] !== null) observation.ended = true;
	}
}
/**
* Classify an in-stream error payload.
*
* The HTTP status is 200 by definition here, so {@link classifyUpstreamError}
* gets a synthetic status and works off the body's markers alone. That is also
* why the gateway's own `"type":"authentication_error"` spelling is checked
* separately: it is the shape the live gateway uses for an expired session, and
* the marker list has no wording for it.
*
* @param text - the raw event payload.
* @param error - the parsed `error` member, for the fields the markers miss.
* @returns the classified kind.
*/
function classifyStreamError(text, error) {
	const classified = classifyUpstreamError(200, text);
	if (classified !== "client") return classified;
	if (typeof error === "object" && error !== null) {
		const frame = error;
		if (frame["type"] === "authentication_error" || frame["code"] === "not_login") return "session_dead";
	}
	return classified;
}
/** Whether a delta field actually carries text. */
function nonEmptyText(value) {
	return typeof value === "string" && value.trim() !== "";
}
//#endregion
//#region src/version.ts
/** The npm package version this build was produced from. */
const COMATE_CONNECT_VERSION = "0.5.1";
//#endregion
export { isSealed as A, COMATE_EXTRA_THINKING_LEVELS as B, defaultConfigCandidates as C, COMATE_SECRET_DIRNAME as D, parseComateModel as E, COMATE_CATALOG_PATH as F, COMATE_THINKING_LEVEL_WIRE as G, COMATE_SEALED_PREFIX as H, COMATE_CHECK_PATH as I, unwrapVolatile as J, asVolatile as K, COMATE_CLIENT_NAME as L, openSecret as M, sealSecret as N, COMATE_SECRET_KEY_ENV as O, COMATE_BASE_THINKING_LEVELS as P, COMATE_DEFAULT_MAX_TOKENS as R, defaultComateHome as S, parseComateConfig as T, COMATE_SEAL_PATH as U, COMATE_REFRESH_PATH as V, COMATE_SETTINGS_NS as W, unwrapVolatileDeep as Y, COMATE_DEFAULT_CONTEXT_WINDOW as _, comateCheckBody as a, COMATE_SID_ENV as b, classifyUpstreamError as c, emptyUploadStats as d, normalizeChatImages as f, COMATE_CONFIG_ENV as g, safeMessage as h, COMATE_CHECK_TIMEOUT_MS as i, machineFingerprint as j, COMATE_SECRET_KEY_FILENAME as k, prepareChatBody as l, uploadChatImages as m, COMATE_CHECK_MAX_TOKENS as n, runComateCheck as o, sanitizeImageSource as p, isSealedComateSecret as q, COMATE_CHECK_READ_LIMIT as r, ComateUpstreamClient as s, COMATE_CONNECT_VERSION as t, emptyImageStats as u, COMATE_HOME_ENV as v, defaultSecretKeyFile as w, ComateCredentialStore as x, COMATE_MULTIMODAL_TYPE as y, COMATE_ENTRY_ID as z };
