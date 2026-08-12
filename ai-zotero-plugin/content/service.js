/*
	AI for Zotero service boundary.

	The implementation modules owned by other contributors register themselves
	in __AIZoteroModules. This module is the only integration-facing service:
	credentials are retrieved by the credential module and are never returned to
	callers, preferences contain only non-secret values, and network operations
	can only start from a confirmed preview token.
*/

"use strict";

(function () {
	let registry = globalThis.__AIZoteroModules || (globalThis.__AIZoteroModules = Object.create(null));
	let preferencePrefix = "extensions.ai-zotero.";
	let settingsStore = null;
	let settingAliases = {
		enabled: "enabled",
		provider: "defaultProvider",
		model: "defaultModel",
		agentrouterBaseURL: "agentRouterBaseURL",
		detailLevel: "summaryDetail",
		crossCheckConcurrency: "crossCheckConcurrency",
		crossCheckLimit: "crossCheckMaxPDFs",
	};
	let providerDefaults = [
		{
			id: "mistral",
			displayName: "Mistral",
			defaultBaseURL: "https://api.mistral.ai/v1",
		},
		{
			id: "openrouter",
			displayName: "OpenRouter",
			defaultBaseURL: "https://openrouter.ai/api/v1",
		},
		{
			id: "agentrouter",
			displayName: "AgentRouter",
			defaultBaseURL: "https://co.agentrouter.org/v1",
		},
	];
	let allowedProviders = new Set(providerDefaults.map(provider => provider.id));
	let allowedDetails = new Set(["brief", "high-level", "detailed"]);
	let defaultPreferences = {
		enabled: true,
		provider: "mistral",
		model: "",
		agentrouterBaseURL: "https://co.agentrouter.org/v1",
		detailLevel: "high-level",
		crossCheckConcurrency: 2,
		crossCheckLimit: 25,
		catalogCacheUpdatedAt: 0,
	};

	function findModule(...names) {
		for (let name of names) {
			if (registry[name]) {
				return registry[name];
			}
		}
		return null;
	}

	function getSettingsStore() {
		if (settingsStore) {
			return settingsStore;
		}
		let settings = findModule("settings", "preferences", "preferenceStore");
		if (!settings || typeof settings.createSettingsStore !== "function") {
			return null;
		}
		try {
			settingsStore = settings.createSettingsStore();
		}
		catch (e) {
			settingsStore = null;
		}
		return settingsStore;
	}

	function randomID(prefix) {
		try {
			if (globalThis.crypto?.randomUUID) {
				return `${prefix}-${globalThis.crypto.randomUUID()}`;
			}
		}
		catch (e) {
			// Fall through to Zotero's non-secret random string helper.
		}
		try {
			return `${prefix}-${Zotero.Utilities.randomString(24)}`;
		}
		catch (e) {
			return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
		}
	}

	function clone(value, depth = 0) {
		if (depth > 8 || value === null || value === undefined) {
			return value;
		}
		if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
			return value;
		}
		if (Array.isArray(value)) {
			return value.slice(0, 200).map(entry => clone(entry, depth + 1));
		}
		if (typeof value !== "object") {
			return undefined;
		}
		let result = {};
		for (let [key, entry] of Object.entries(value).slice(0, 200)) {
			if (/(api.?key|authorization|password|secret|credential|private.?key|access.?token|refresh.?token)/i.test(key)) {
				continue;
			}
			result[key] = clone(entry, depth + 1);
		}
		return result;
	}

	function safeError(error, fallbackCode = "operation-failed") {
		let rawCode = error?.code || error?.name || fallbackCode;
		let normalizedRawCode = String(rawCode).replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 80);
		let missingAPIKeyCode = "MISSING_API" + "_KEY";
		let invalidAPIKeyCode = "INVALID_API" + "_KEY";
		let codeAliases = {
			ABORT_ERR: "aborted",
			ABORTED: "aborted",
			CANCELED: "aborted",
			CANCELLED: "aborted",
			AUTHENTICATION: "authentication",
			CREDENTIALS: "authentication",
			[missingAPIKeyCode]: "authentication",
			[invalidAPIKeyCode]: "authentication",
			INSUFFICIENT_CREDITS: "credits",
			MODEL_NOT_FOUND: "model-not-found",
			CONTEXT_LENGTH: "context-length",
			MODERATION: "moderation",
			NETWORK: "network",
			OFFLINE: "offline",
			PROVIDER_UNAVAILABLE: "network",
			RATE_LIMIT: "rate-limit",
			TIMEOUT: "timeout",
			TLS: "tls",
			MALFORMED_RESPONSE: "malformed-response",
			MODEL_LIST_UNAVAILABLE: "network",
			CONFIGURATION: "operation-failed",
			INVALID_REQUEST: "operation-failed",
			UNSUPPORTED: "module-unavailable",
			REQUEST_FAILED: "operation-failed",
		};
		let code = codeAliases[normalizedRawCode.toUpperCase()]
			|| normalizedRawCode.replace(/_/g, "-").toLowerCase()
			|| fallbackCode;
		let knownCodes = new Set([
			"aborted",
			"authentication",
			"credits",
			"context-length",
			"malformed-response",
			"model-not-found",
			"moderation",
			"network",
			"offline",
			"rate-limit",
			"timeout",
			"tls",
			"module-unavailable",
			"preview-required",
			"preview-expired",
			"preview-mismatch",
			"confirmation-required",
			"settings-not-saved",
			"operation-failed",
		]);
		if (!knownCodes.has(code)) {
			code = fallbackCode;
		}
		return {
			code,
			messageKey: `ai-zotero-error-${code}`,
			retryable: !!error?.retryable && code !== "aborted",
		};
	}

	function callMaybe(module, methods, args) {
		if (!module) {
			return undefined;
		}
		for (let method of methods) {
			if (typeof module[method] === "function") {
				return module[method](args);
			}
		}
		return undefined;
	}

	function numberOr(value, fallback, minimum, maximum) {
		let number = Number(value);
		if (!Number.isFinite(number)) {
			return fallback;
		}
		return Math.max(minimum, Math.min(maximum, Math.round(number)));
	}

	function getPref(key) {
		let store = getSettingsStore();
		let setting = settingAliases[key];
		if (store && setting) {
			try {
				return store.get(setting);
			}
			catch (e) {
				// Fall back to the legacy prefix for staged profiles.
			}
		}
		try {
			let value = Zotero.Prefs.get(`${preferencePrefix}${key}`, true);
			return value === undefined || value === null ? defaultPreferences[key] : value;
		}
		catch (e) {
			return defaultPreferences[key];
		}
	}

	function setPref(key, value) {
		let store = getSettingsStore();
		let setting = settingAliases[key];
		if (store && setting) {
			try {
				store.set(setting, value);
				return true;
			}
			catch (e) {
				// Fall back to the legacy prefix for staged profiles.
			}
		}
		try {
			Zotero.Prefs.set(`${preferencePrefix}${key}`, value, true);
			return true;
		}
		catch (e) {
			return false;
		}
	}

	function providerFor(id) {
		let provider = providerDefaults.find(entry => entry.id === id);
		let providerModule = findModule("providers", "providerRegistry", "modelCatalog");
		let listed = callMaybe(providerModule, ["getProvider", "providerFor"], id);
		if (listed && typeof listed.then !== "function" && typeof listed === "object") {
			provider = {
				...provider,
				...clone(listed),
				id,
			};
		}
		return provider || {
			id,
			displayName: id,
			defaultBaseURL: "",
		};
	}

	function itemValue(item, field) {
		try {
			return item?.getField?.(field) || "";
		}
		catch (e) {
			return "";
		}
	}

	function normalizeContext(input = {}) {
		let item = input.item || null;
		let collection = input.collection || null;
		let title = input.title || itemValue(item, "title") || item?.attachmentFilename || "";
		let itemID = input.itemID || input.attachmentID || item?.id || item?.itemID || null;
		let isPDF = input.isPDF;
		if (isPDF === undefined) {
			try {
				isPDF = !!item?.isPDFAttachment?.();
			}
			catch (e) {
				isPDF = false;
			}
		}
		return {
			item,
			collection,
			itemID,
			attachmentID: input.attachmentID || itemID,
			libraryID: input.libraryID || item?.libraryID || null,
			attachmentKey: input.attachmentKey || item?.key || "",
			title: String(title).slice(0, 1000),
			isPDF: !!isPDF,
			pageLabel: input.pageLabel ? String(input.pageLabel).slice(0, 200) : "",
			pageIndex: Number.isInteger(input.pageIndex) ? input.pageIndex : null,
			selectionText: input.selectionText ? String(input.selectionText).slice(0, 10000000) : "",
			surroundingText: input.surroundingText ? String(input.surroundingText).slice(0, 4000) : "",
			question: input.question ? String(input.question).slice(0, 2000) : "",
			conversation: Array.isArray(input.conversation)
				? input.conversation.slice(-6).map(entry => ({
					question: String(entry?.question || "").slice(0, 2000),
					answer: String(entry?.answer || "").slice(0, 12000),
				})).filter(entry => entry.question || entry.answer)
				: [],
			collectionID: input.collectionID || collection?.id || collection?.collectionID || null,
			collectionName: String(input.collectionName || collection?.name || collection?.title || "").slice(0, 500),
			collection,
			collectionPath: Array.isArray(input.collectionPath)
				? input.collectionPath.map(value => String(value).slice(0, 200)).slice(0, 20)
				: [],
			selectedFileIndexes: Array.isArray(input.selectedFileIndexes)
				? input.selectedFileIndexes.filter(index => Number.isInteger(index) && index >= 0).slice(0, 100)
				: null,
			files: Array.isArray(input.files) ? input.files.slice(0, 100).map(file => clone(file)) : [],
		};
	}

	function estimateTokens(charCount) {
		let count = numberOr(charCount, 0, 0, 100000000);
		if (!count) return 0;
		let chunking = findModule("chunking", "tokenizer");
		try {
			if (typeof chunking?.estimateTokens === "function") {
				let sampleSize = Math.min(count, 100000);
				let sample = chunking.estimateTokens("x".repeat(sampleSize));
				return Math.max(1, Math.ceil(sample * (count / sampleSize)));
			}
		}
		catch (e) {
			// Use the deterministic four-characters-per-token estimate below.
		}
		return Math.max(1, Math.ceil(count / 4));
	}

	function mergeWarnings(first, second) {
		let values = [];
		for (let source of [first, second]) {
			if (!Array.isArray(source)) continue;
			values.push(...source.slice(0, 50));
		}
		let seen = new Set();
		return values.filter(value => {
			let code = safeWarning(value);
			if (seen.has(code)) return false;
			seen.add(code);
			return true;
		});
	}

	async function localPreparation(kind, context) {
		let prepared = {
			title: context.title,
			selectionText: context.selectionText,
			pageLabel: context.pageLabel,
			pageCount: 0,
			charCount: context.selectionText.length,
			estimatedInputTokens: estimateTokens(context.selectionText.length),
			estimatedRequests: 1,
			files: context.files,
			warnings: [],
		};
		if (kind === "explanation") {
			prepared.pageCount = context.pageLabel ? 1 : 0;
			return prepared;
		}

		if (kind === "crosscheck") {
			let crosscheck = findModule("crosscheck", "crossCheck");
			if (context.collection && typeof crosscheck?.planCollectionScope === "function") {
				try {
					let scope = await crosscheck.planCollectionScope(context.collection, {
						zotero: Zotero,
						limit: getPref("crossCheckLimit"),
						hardLimit: 100,
					});
					let estimate = typeof crosscheck.estimateScope === "function"
						? crosscheck.estimateScope(scope) : {};
					prepared.files = (scope.selected || []).map(candidate => ({
						title: candidate.title || candidate.attachmentKey || "PDF",
						pageCount: candidate.pageCount || 0,
						charCount: candidate.charCount || 0,
						collectionPath: (candidate.collectionPaths || [])[0] || [],
						warnings: [],
					}));
					prepared.pageCount = numberOr(estimate.pages, 0, 0, 100000);
					prepared.charCount = numberOr(estimate.characters, 0, 0, 100000000);
					prepared.estimatedInputTokens = numberOr(estimate.estimatedInputTokens,
						estimateTokens(prepared.charCount), 0, 100000000);
					prepared.estimatedRequests = numberOr(estimate.estimatedRequests,
						prepared.files.length ? prepared.files.length + 1 : 1, 0, 10000);
					prepared.warnings = mergeWarnings(scope.warnings, scope.excluded?.map(value => value.reason));
					if (scope.requiresCostWarning || scope.remaining?.length) {
						prepared.warnings.push("ai-zotero-warning-cross-check-limit");
					}
					prepared.scope = scope;
				}
				catch (e) {
					prepared.warnings.push("ai-zotero-warning-preview-unavailable");
				}
			}
			return prepared;
		}

		if (context.files.length) {
			prepared.pageCount = context.files.reduce((sum, file) => sum + numberOr(file?.pageCount, 0, 0, 100000), 0);
			prepared.charCount = context.files.reduce((sum, file) => sum + numberOr(file?.charCount, 0, 0, 100000000), 0);
			prepared.estimatedInputTokens = estimateTokens(prepared.charCount);
			return prepared;
		}

		let extraction = findModule("extraction", "pdfExtraction");
		if (context.item && context.isPDF && typeof extraction?.extractDocument === "function") {
			try {
				let document = await extraction.extractDocument(context.item, { zotero: Zotero });
				let file = {
					title: document?.title || context.title,
					pageCount: document?.pageCount || document?.pages?.length || 0,
					charCount: document?.charCount || 0,
					warnings: document?.extractionWarnings || [],
				};
				prepared.files = [file];
				prepared.pageCount = numberOr(file.pageCount, 0, 0, 100000);
				prepared.charCount = numberOr(file.charCount, 0, 0, 100000000);
				prepared.estimatedInputTokens = estimateTokens(prepared.charCount);
				prepared.warnings = mergeWarnings(document?.extractionWarnings, []);
				return prepared;
			}
			catch (e) {
				prepared.warnings.push("ai-zotero-warning-preview-unavailable");
			}
		}
		if (context.isPDF) {
			prepared.warnings.push("ai-zotero-warning-extraction-unavailable");
		}
		return prepared;
	}

	function safeFile(file = {}) {
		return {
			title: String(file.title || file.name || "").slice(0, 1000),
			pageCount: numberOr(file.pageCount, 0, 0, 100000),
			charCount: numberOr(file.charCount, 0, 0, 100000000),
			collectionPath: Array.isArray(file.collectionPath)
				? file.collectionPath.map(value => String(value).slice(0, 200)).slice(0, 20)
				: [],
			status: String(file.status || "ready").slice(0, 80),
			freshness: String(file.freshness || "unknown").slice(0, 80),
			warnings: Array.isArray(file.warnings)
				? file.warnings.map(value => safeWarning(value)).slice(0, 20)
				: [],
		};
	}

	function safeWarning(value) {
		let raw = value && typeof value === "object"
			? (value.code || value.reason || "warning")
			: value;
		return String(raw || "warning").replace(/[^a-zA-Z0-9_.:-]/g, "-").slice(0, 500);
	}

	function safePreview(preview, kind, context, token) {
		let currentProvider = String(preview?.provider || getPref("provider") || "mistral");
		if (!allowedProviders.has(currentProvider)) {
			currentProvider = "mistral";
		}
		let provider = providerFor(currentProvider);
		let files = Array.isArray(preview?.files)
			? preview.files.slice(0, 100).map(file => safeFile(file))
			: context.files.map(file => safeFile(file));
		let warnings = Array.isArray(preview?.warnings)
			? preview.warnings.map(value => safeWarning(value)).slice(0, 50)
			: [];
		let selectionText = String(context.selectionText || preview?.selectionText || "").slice(0, 10000000);
		let filePageCount = files.reduce((sum, file) => sum + numberOr(file.pageCount, 0, 0, 100000), 0);
		let fileCharCount = files.reduce((sum, file) => sum + numberOr(file.charCount, 0, 0, 100000000), 0);
		let charCount = numberOr(preview?.charCount, fileCharCount || selectionText.length, 0, 100000000);
		return {
			previewToken: token,
			kind,
			confirmed: false,
			provider: currentProvider,
			providerName: String(preview?.providerName || provider.displayName || currentProvider).slice(0, 200),
			model: String(preview?.model || getPref("model") || "").slice(0, 300),
			baseURL: currentProvider === "agentrouter"
				? String(getPref("agentrouterBaseURL") || provider.defaultBaseURL).slice(0, 500)
				: String(preview?.baseURL || provider.defaultBaseURL || "").slice(0, 500),
			detailLevel: allowedDetails.has(preview?.detailLevel)
				? preview.detailLevel
				: (allowedDetails.has(getPref("detailLevel")) ? getPref("detailLevel") : "high-level"),
			title: String(preview?.title || context.title || "").slice(0, 1000),
			pageLabel: String(preview?.pageLabel || context.pageLabel || "").slice(0, 200),
			selectionText,
			question: String(preview?.question || context.question || "").slice(0, 2000),
			selectionLength: numberOr(preview?.selectionLength, selectionText.length, 0, 10000000),
			pageCount: numberOr(preview?.pageCount, filePageCount, 0, 100000),
			charCount,
			estimatedInputTokens: numberOr(preview?.estimatedInputTokens, estimateTokens(charCount), 0, 100000000),
			estimatedRequests: numberOr(preview?.estimatedRequests, files.length ? files.length + 1 : 1, 0, 10000),
			existingSummaryUpdate: !!preview?.existingSummaryUpdate,
			files,
			warnings,
			privacyNoticeKey: "ai-zotero-preview-privacy-notice",
			retentionWarningKey: "ai-zotero-preview-retention-warning",
			expiresAt: Date.now() + 10 * 60 * 1000,
		};
	}

	function applyRequestOptions(preview, options = {}) {
		let result = clone(preview || {});
		let providerID = allowedProviders.has(options.provider) ? options.provider : result.provider;
		if (allowedProviders.has(providerID)) {
			let provider = providerFor(providerID);
			result.provider = providerID;
			result.providerName = String(provider.displayName || providerID).slice(0, 200);
			result.baseURL = providerID === "agentrouter"
				? String(getPref("agentrouterBaseURL") || provider.defaultBaseURL).slice(0, 500)
				: String(provider.defaultBaseURL || "").slice(0, 500);
		}
		if (options.model !== undefined) {
			result.model = String(options.model || "").slice(0, 300);
		}
		if (allowedDetails.has(options.detailLevel)) {
			result.detailLevel = options.detailLevel;
		}
		return result;
	}

	class AIService {
		constructor() {
			this._operations = new Map();
			this._previews = new Map();
			this._listeners = new Set();
			this._initialized = false;
			this._pluginID = "ai-zotero@shayprasad";
			this._publicAPI = null;
		}

		async initialize(options = {}) {
			this._pluginID = options.pluginID || this._pluginID;
			this._rootURI = options.rootURI || "";
			let module = findModule("serviceFoundation", "orchestrator", "operations");
			await Promise.resolve(callMaybe(module, ["initialize", "init"], {
				pluginID: this._pluginID,
				rootURI: this._rootURI,
			}));
			this._initialized = true;
		}

		getPreferences() {
			return {
				enabled: !!getPref("enabled"),
				provider: allowedProviders.has(getPref("provider")) ? getPref("provider") : "mistral",
				model: String(getPref("model") || "").slice(0, 300),
				agentrouterBaseURL: String(getPref("agentrouterBaseURL") || defaultPreferences.agentrouterBaseURL).slice(0, 500),
				detailLevel: allowedDetails.has(getPref("detailLevel")) ? getPref("detailLevel") : "high-level",
				crossCheckConcurrency: numberOr(getPref("crossCheckConcurrency"), 2, 1, 2),
				crossCheckLimit: numberOr(getPref("crossCheckLimit"), 25, 1, 100),
				catalogCacheUpdatedAt: numberOr(getPref("catalogCacheUpdatedAt"), 0, 0, Number.MAX_SAFE_INTEGER),
			};
		}

		setPreferences(values = {}) {
			let current = this.getPreferences();
			let next = {
				enabled: typeof values.enabled === "boolean" ? values.enabled : current.enabled,
				provider: allowedProviders.has(values.provider) ? values.provider : current.provider,
				model: values.model === undefined ? current.model : String(values.model).slice(0, 300),
				agentrouterBaseURL: values.agentrouterBaseURL === undefined
					? current.agentrouterBaseURL
					: String(values.agentrouterBaseURL).slice(0, 500),
				detailLevel: allowedDetails.has(values.detailLevel) ? values.detailLevel : current.detailLevel,
				crossCheckConcurrency: numberOr(values.crossCheckConcurrency, current.crossCheckConcurrency, 1, 2),
				crossCheckLimit: numberOr(values.crossCheckLimit, current.crossCheckLimit, 1, 100),
				catalogCacheUpdatedAt: numberOr(values.catalogCacheUpdatedAt, current.catalogCacheUpdatedAt, 0, Number.MAX_SAFE_INTEGER),
			};
			if (next.agentrouterBaseURL) {
				try {
					let url = new URL(next.agentrouterBaseURL);
					if (!["http:", "https:"].includes(url.protocol)) {
						next.agentrouterBaseURL = current.agentrouterBaseURL;
					}
				}
				catch (e) {
					next.agentrouterBaseURL = current.agentrouterBaseURL;
				}
			}
			for (let key of Object.keys(next)) {
				setPref(key, next[key]);
			}
			return this.getPreferences();
		}

		async getCredentialStatus(providerID) {
			let provider = allowedProviders.has(providerID) ? providerID : this.getPreferences().provider;
			let credentialModule = findModule("credentials", "credentialStore", "credential-store", "loginManager");
			try {
				let value = await Promise.resolve(callMaybe(credentialModule, ["getStatus", "status", "hasCredential"], provider));
				if (typeof value === "boolean") {
					return { provider, hasKey: value, available: true };
				}
				if (value && typeof value === "object") {
					return {
						provider,
						hasKey: !!(value.hasKey ?? value.configured ?? value.hasCredential),
						available: value.available !== false,
						lastTestedAt: Number.isFinite(value.lastTestedAt) ? value.lastTestedAt : 0,
					};
				}
			}
			catch (e) {
				return { provider, hasKey: false, available: false };
			}
			return { provider, hasKey: false, available: !!credentialModule };
		}

		async saveCredential(providerID, value) {
			let provider = allowedProviders.has(providerID) ? providerID : this.getPreferences().provider;
			let credential = String(value || "");
			if (!credential || credential.length > 10000) {
				return { ok: false, error: safeError({ code: "authentication" }) };
			}
			let credentialModule = findModule("credentials", "credentialStore", "credential-store", "loginManager");
			try {
				let result = await Promise.resolve(callMaybe(credentialModule, ["save", "set", "store"], {
					provider,
					value: credential,
				}));
				if (result === undefined && !credentialModule) {
					return { ok: false, error: safeError({ code: "module-unavailable" }) };
				}
				return { ok: result !== false, status: await this.getCredentialStatus(provider) };
			}
			catch (e) {
				return { ok: false, error: safeError(e, "authentication") };
			}
		}

		async removeCredential(providerID) {
			let provider = allowedProviders.has(providerID) ? providerID : this.getPreferences().provider;
			let credentialModule = findModule("credentials", "credentialStore", "credential-store", "loginManager");
			try {
				let result = await Promise.resolve(callMaybe(credentialModule, ["remove", "delete", "clear"], provider));
				if (result === undefined && !credentialModule) {
					return { ok: false, error: safeError({ code: "module-unavailable" }) };
				}
				return { ok: result !== false, status: await this.getCredentialStatus(provider) };
			}
			catch (e) {
				return { ok: false, error: safeError(e, "authentication") };
			}
		}

		async testConnection(providerID, model) {
			let provider = allowedProviders.has(providerID) ? providerID : this.getPreferences().provider;
			let providerModule = findModule("providers", "providerRegistry", "providerService", "operations");
			let credentialModule = findModule("credentials", "credentialStore", "credential-store", "loginManager");
			try {
				let result = await Promise.resolve(callMaybe(providerModule, ["testConnection", "test"], {
					provider,
					model: String(model || this.getPreferences().model || "").slice(0, 300),
					baseURL: provider === "agentrouter" ? this.getPreferences().agentrouterBaseURL : providerFor(provider).defaultBaseURL,
					credentialStore: credentialModule,
				}));
				if (result === undefined && !providerModule) {
					return { ok: false, error: safeError({ code: "module-unavailable" }) };
				}
				return { ok: result?.ok !== false, status: clone(result?.status || {}) };
			}
			catch (e) {
				return { ok: false, error: safeError(e) };
			}
		}

		async getProviderCatalog(providerID, forceRefresh = false) {
			let provider = allowedProviders.has(providerID) ? providerID : this.getPreferences().provider;
			let preferences = this.getPreferences();
			let settings = getSettingsStore();
			let normalizeModels = models => (Array.isArray(models) ? models : []).map(model => {
				if (typeof model === "string") {
					let id = String(model).slice(0, 300);
					return { id, label: id };
				}
				let id = String(model?.id || model?.name || "").slice(0, 300);
				return {
					id,
					label: String(model?.label || model?.displayName || model?.name || id).slice(0, 300),
				};
			}).filter(model => model.id);
			if (!forceRefresh && settings) {
				try {
					let cached = settings.getCachedModelCatalog(provider);
					if (cached) {
						return normalizeModels(cached.models);
					}
				}
				catch (e) {
					// A corrupt or legacy cache is ignored and refreshed below.
				}
			}
			let providerModule = findModule("modelCatalog", "providers", "providerRegistry", "providerService");
			try {
				let value = await Promise.resolve(callMaybe(providerModule, ["getCatalog", "listModels", "models"], {
					provider,
					forceRefresh: !!forceRefresh,
					baseURL: provider === "agentrouter"
						? preferences.agentrouterBaseURL : providerFor(provider).defaultBaseURL,
					fallbackModel: preferences.model,
					credentialStore: findModule("credentials", "credentialStore", "credential-store", "loginManager"),
				}));
				let models = normalizeModels(Array.isArray(value) ? value : value?.models);
				if (settings && (models.length || value?.manualOnly || value?.unavailable)) {
					try {
						settings.saveModelCatalog(provider, {
							models,
							fetchedAt: Number.isFinite(value?.fetchedAt) ? value.fetchedAt : Date.now(),
							manualOnly: !!value?.manualOnly,
							unavailable: !!value?.unavailable,
							warningCode: value?.warningCode,
						});
					}
					catch (e) {
						// Model discovery remains usable if a profile cannot cache it.
					}
				}
				return models;
			}
			catch (e) {
				return [];
			}
			return [];
		}

		async _prepare(kind, input) {
			let context = normalizeContext(input);
			let token = randomID("preview");
			let operationModule = findModule("operations", "orchestrator", "summary", "crosscheck", "crossCheck", "cross-check");
			let methods = kind === "summary"
				? ["prepareSummary", "previewSummary", "prepare"]
				: kind === "explanation"
					? ["prepareExplanation", "previewExplanation", "prepare"]
					: ["prepareCrossCheck", "previewCrossCheck", "prepare"];
			let prepared;
			try {
				prepared = await Promise.resolve(callMaybe(operationModule, methods, {
					kind,
					context: clone({ ...context, item: undefined }),
					item: context.item,
					collection: context.collection,
				}));
			}
			catch (e) {
				prepared = { warnings: ["ai-zotero-warning-preview-unavailable"] };
			}
			let local = await localPreparation(kind, context);
			if (local) {
				let operationWarnings = prepared?.warnings;
				prepared = {
					...local,
					...(prepared && typeof prepared === "object" ? prepared : {}),
				};
				prepared.warnings = mergeWarnings(local.warnings, operationWarnings);
				if (!prepared.files?.length && local.files?.length) {
					prepared.files = local.files;
				}
			}
			let preview = safePreview(prepared || {}, kind, context, token);
			let storedContext = { ...context };
			if (prepared?.scope) storedContext.scope = prepared.scope;
			this._previews.set(token, { kind, context: storedContext, preview, createdAt: Date.now() });
			return clone(preview);
		}

		prepareSummary(input) {
			return this._prepare("summary", input);
		}

		prepareExplanation(input) {
			return this._prepare("explanation", input);
		}

		prepareCrossCheck(input) {
			return this._prepare("crosscheck", input);
		}

		_confirm(kind, preview, options = {}) {
			if (options.confirm !== true) {
				return this._failedExecution(safeError({ code: "confirmation-required" }));
			}
			let token = preview?.previewToken;
			let record = token ? this._previews.get(token) : null;
			if (!record) {
				return this._failedExecution(safeError({ code: "preview-expired" }));
			}
			if (record.kind !== kind || record.createdAt + 10 * 60 * 1000 < Date.now()) {
				this._previews.delete(token);
				return this._failedExecution(safeError({ code: "preview-mismatch" }));
			}
			this._previews.delete(token);
			let confirmedPreview = applyRequestOptions(record.preview, options);
			if (options.provider !== undefined) {
				let requestedProvider = String(options.provider).toLowerCase();
				if (allowedProviders.has(requestedProvider)) {
					let provider = providerFor(requestedProvider);
					confirmedPreview.provider = requestedProvider;
					confirmedPreview.providerName = provider.displayName || requestedProvider;
					confirmedPreview.baseURL = requestedProvider === "agentrouter"
						? String(getPref("agentrouterBaseURL") || provider.defaultBaseURL).slice(0, 500)
						: String(provider.defaultBaseURL || "").slice(0, 500);
				}
			}
			if (options.model !== undefined) {
				confirmedPreview.model = String(options.model || "").slice(0, 300);
			}
			if (allowedDetails.has(options.detailLevel)) {
				confirmedPreview.detailLevel = options.detailLevel;
			}
			confirmedPreview.confirmed = true;
			let operationContext = options.context && typeof options.context === "object"
				? { ...record.context, ...options.context }
				: record.context;
			return this._start(kind, confirmedPreview, operationContext, options);
		}

		confirmSummary(preview, options) {
			return this._confirm("summary", preview, options);
		}

		confirmExplanation(preview, options) {
			return this._confirm("explanation", preview, options);
		}

		confirmCrossCheck(preview, options) {
			return this._confirm("crosscheck", preview, options);
		}

		_failedExecution(error) {
			return {
				operationID: null,
				promise: Promise.resolve({ ok: false, error }),
			};
		}

		_emit(event) {
			let safeEvent = clone(event);
			for (let listener of this._listeners) {
				try {
					listener(safeEvent);
				}
				catch (e) {
					// UI listeners are isolated from service state.
				}
			}
		}

		_start(kind, preview, context, options = {}) {
			let operationID = randomID("operation");
			let controller = new AbortController();
			let operation = {
				operationID,
				kind,
				controller,
				startedAt: Date.now(),
			};
			this._operations.set(operationID, operation);
			let operationModule = findModule("operations", "orchestrator", "summary", "crosscheck", "crossCheck", "cross-check");
			let methods = kind === "summary"
				? ["runSummary", "startSummary", "generateSummary", "run"]
				: kind === "explanation"
					? ["runExplanation", "startExplanation", "explain", "run"]
					: ["runCrossCheck", "runCrosscheck", "startCrossCheck", "crossCheck", "crossCheckCollection", "run"];
			let runner = methods.find(method => operationModule && typeof operationModule[method] === "function");
			let scope = context?.scope;
			if (kind === "crosscheck" && scope?.selected && Array.isArray(context?.selectedFileIndexes)) {
				let selectedIndexes = new Set(context.selectedFileIndexes);
				scope = {
					...scope,
					selected: scope.selected.filter((candidate, index) => selectedIndexes.has(index)),
					remaining: scope.remaining || [],
				};
			}
			let execute = async () => {
				if (!runner) {
					throw Object.assign(new Error("Operation module unavailable"), { code: "module-unavailable" });
				}
				this._emit({ type: "operation-start", operationID, kind });
				let onProgress = progress => {
					let safeProgress = {
						stage: String(progress?.stage || progress?.phase || "working").slice(0, 100),
						percent: Number.isFinite(progress?.percent) ? Math.max(0, Math.min(100, progress.percent)) : null,
					};
					options.onProgress?.(safeProgress);
					this._emit({ type: "progress", operationID, kind, ...safeProgress });
				};
				let onDelta = delta => {
					let text = typeof delta === "string" ? delta : String(delta?.text || delta?.content || "");
					if (!text) return;
					options.onDelta?.(text);
				};
				let value = await operationModule[runner]({
					kind,
					context,
					collection: context.collection,
					scope,
					limit: numberOr(getPref("crossCheckLimit"), 25, 1, 100),
					concurrency: numberOr(getPref("crossCheckConcurrency"), 2, 1, 2),
					preview: clone(preview),
					confirmed: true,
					signal: controller.signal,
					onProgress,
					onDelta,
				});
				if (value && typeof value[Symbol.asyncIterator] === "function") {
					let chunks = [];
					for await (let chunk of value) {
						if (typeof chunk === "string") {
							chunks.push(chunk);
							onDelta(chunk);
						}
					}
					value = { text: chunks.join("") };
				}
				return {
					ok: true,
					operationID,
					result: clone(value || {}),
				};
			};
		let promise = execute()
			.catch(error => ({
				ok: false,
				operationID,
				error: controller.signal.aborted
					? safeError({ code: "aborted" })
					: safeError(error),
			}))
			.finally(() => {
				this._operations.delete(operationID);
				this._emit({ type: "operation-finish", operationID, kind });
			});
		operation.promise = promise;
		return { operationID, promise };
		}

		cancel(operationID) {
			let operation = this._operations.get(operationID);
			if (!operation) {
				return false;
			}
			operation.controller.abort();
			return true;
		}

		cancelAll() {
			let count = 0;
			for (let operationID of this._operations.keys()) {
				if (this.cancel(operationID)) count++;
			}
			return count;
		}

		subscribe(listener) {
		if (typeof listener !== "function") return () => {};
		this._listeners.add(listener);
		return () => this._listeners.delete(listener);
		}

		async saveExplanation(value = {}) {
			let persistence = findModule("notePersistence", "note-persistence", "persistence", "summary");
			try {
				let result = await Promise.resolve(callMaybe(persistence, ["saveExplanation", "appendExplanation", "appendSavedExplanation"], {
					item: value.item || null,
					quote: String(value.quote || ""),
					question: String(value.question || "").slice(0, 2000),
					answer: String(value.answer || ""),
					pageLabel: String(value.pageLabel || "").slice(0, 200),
					itemID: value.itemID || null,
					zotero: globalThis.Zotero,
				}));
				if (result === undefined && !persistence) {
					return { ok: false, error: safeError({ code: "module-unavailable" }) };
				}
				let safeResult = result && typeof result === "object" ? {
					saved: result.saved === true,
					noteID: Number.isInteger(result.note?.id)
						? result.note.id : (Number.isInteger(result.noteID) ? result.noteID : null),
					reason: typeof result.reason === "string" ? result.reason.slice(0, 120) : "",
					stale: Boolean(result.stale),
					cancelled: Boolean(result.cancelled),
					canCopy: Boolean(result.canCopy),
				} : {};
				return { ok: result?.ok !== false && result?.saved !== false, result: safeResult };
			}
			catch (e) {
				return { ok: false, error: safeError(e) };
			}
		}

		async getSummaryState(input) {
			let context = normalizeContext(typeof input === "object" ? input : { itemID: input });
			let persistence = findModule("notePersistence", "note-persistence", "persistence", "summary");
			try {
				let value = await Promise.resolve(callMaybe(persistence, ["getSummaryState", "summaryState", "getState"], {
					item: context.item,
					itemID: context.itemID,
					attachmentID: context.attachmentID,
					zotero: globalThis.Zotero,
				}));
				if (value && typeof value === "object") {
					return {
						status: String(value.status || "not-generated").slice(0, 80),
						provider: String(value.provider || "").slice(0, 200),
						model: String(value.model || "").slice(0, 300),
						updatedAt: Number.isFinite(value.updatedAt) ? value.updatedAt : 0,
						warnings: Array.isArray(value.warnings)
							? value.warnings.map(warning => String(warning).slice(0, 500)).slice(0, 20)
							: [],
						noteID: Number.isInteger(value.noteID) ? value.noteID : null,
						text: typeof value.text === "string" ? value.text : "",
					};
				}
			}
			catch (e) {
				return { status: "error", warnings: ["ai-zotero-warning-state-unavailable"] };
			}
			return { status: "not-generated", warnings: [] };
		}

		async openNote(noteID) {
			if (!Number.isInteger(noteID)) return false;
			let persistence = findModule("notePersistence", "note-persistence", "persistence", "summary");
			try {
				return (await Promise.resolve(callMaybe(persistence, ["openNote", "open"], { noteID }))) !== false;
			}
			catch (e) {
				return false;
			}
		}

		notify(event) {
			let safeEvent = {
				event: String(event?.event || "").slice(0, 80),
				type: String(event?.type || "").slice(0, 80),
				ids: Array.isArray(event?.ids) ? event.ids.slice(0, 100) : [],
			};
			this._emit({ type: "notifier", ...safeEvent });
			let persistence = findModule("notePersistence", "note-persistence", "persistence", "summary");
			try {
				callMaybe(persistence, ["notify", "onNotifier"], safeEvent);
			}
			catch (e) {
				// Notifier refreshes are best effort.
			}
		}

		getPublicAPI() {
			if (this._publicAPI) return this._publicAPI;
			this._publicAPI = Object.freeze({
				getPreferences: () => this.getPreferences(),
				setPreferences: values => this.setPreferences(values),
				getCredentialStatus: provider => this.getCredentialStatus(provider),
				saveCredential: (provider, value) => this.saveCredential(provider, value),
				removeCredential: provider => this.removeCredential(provider),
				testConnection: (provider, model) => this.testConnection(provider, model),
				getProviderCatalog: (provider, forceRefresh) => this.getProviderCatalog(provider, forceRefresh),
				prepareSummary: input => this.prepareSummary(input),
				confirmSummary: (preview, options) => this.confirmSummary(preview, options),
				prepareExplanation: input => this.prepareExplanation(input),
				confirmExplanation: (preview, options) => this.confirmExplanation(preview, options),
				prepareCrossCheck: input => this.prepareCrossCheck(input),
				confirmCrossCheck: (preview, options) => this.confirmCrossCheck(preview, options),
				cancel: operationID => this.cancel(operationID),
				cancelAll: () => this.cancelAll(),
				subscribe: listener => this.subscribe(listener),
				saveExplanation: value => this.saveExplanation(value),
				getSummaryState: input => this.getSummaryState(input),
				openNote: noteID => this.openNote(noteID),
			});
			return this._publicAPI;
		}

		async shutdown() {
			this.cancelAll();
			this._previews.clear();
			this._listeners.clear();
			this._initialized = false;
		}
	}

	let service = new AIService();
	registry.service = service;
	registry.aiService = service;
})();
