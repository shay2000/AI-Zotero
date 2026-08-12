(function (root) {
	"use strict";

	var modules = root.__AIZoteroModules || (root.__AIZoteroModules = {});
	var constants = modules.constants;
	var utils = modules.utils;
	var errors = modules.errors;
	if (typeof module !== "undefined" && module.exports && typeof require === "function") {
		constants = constants || require("./constants.js");
		utils = utils || require("./utils.js");
		errors = errors || require("./errors.js");
	}

	class MemoryPreferences {
		constructor(initial) {
			this.values = Object.assign({}, initial || {});
		}

		get(key) {
			return this.values[key];
		}

		set(key, value) {
			this.values[key] = value;
		}

		clear(key) {
			delete this.values[key];
		}
	}

	function resolvePreferences(preferences) {
		if (preferences) {
			return preferences;
		}
		if (root.Zotero && root.Zotero.Prefs) {
			return root.Zotero.Prefs;
		}
		return new MemoryPreferences();
	}

	function validateProvider(provider) {
		var providerID = typeof provider === "string" ? provider.trim().toLowerCase() : "";
		if (!constants.PROVIDER_IDS.includes(providerID)) {
			throw errors.createConfigurationError("unknown-provider");
		}
		return providerID;
	}

	function assertNoSecretFields(value) {
		if (!value || typeof value !== "object") {
			return;
		}
		if (Array.isArray(value)) {
			value.forEach(assertNoSecretFields);
			return;
		}
		for (var key of Object.keys(value)) {
			if (utils.isSecretField(key)) {
				throw errors.createConfigurationError("secret-in-preferences");
			}
			assertNoSecretFields(value[key]);
		}
	}

	function normalizedCacheModel(value) {
		var id;
		var displayName;
		if (typeof value === "string") {
			id = utils.normalizeModelID(value);
		}
		else if (value && typeof value === "object") {
			id = utils.normalizeModelID(value.id || value.model || value.name);
			displayName = utils.normalizeModelID(value.displayName || value.display_name);
		}
		if (!id) {
			return null;
		}
		var result = { id };
		if (displayName && displayName !== id) {
			result.displayName = displayName;
		}
		return result;
	}

	function normalizeCacheRecord(provider, record, nowValue) {
		if (!record || typeof record !== "object") {
			return null;
		}
		var fetchedAt = Number(record.fetchedAt);
		if (!Number.isFinite(fetchedAt) || fetchedAt <= 0) {
			return null;
		}
		var models = [];
		var seen = new Set();
		for (var value of Array.isArray(record.models) ? record.models : []) {
			var model = normalizedCacheModel(value);
			if (model && !seen.has(model.id)) {
				seen.add(model.id);
				models.push(model);
			}
			if (models.length >= constants.MAX_MODEL_CACHE_ENTRIES) {
				break;
			}
		}
		var warningCode = typeof record.warningCode === "string"
			&& Object.prototype.hasOwnProperty.call(errors.ERROR_CODES, record.warningCode)
			? record.warningCode : undefined;
		var normalized = {
			schemaVersion: constants.MODEL_CACHE_SCHEMA_VERSION,
			provider,
			fetchedAt,
			models,
			modelIDs: models.map(model => model.id),
			manualOnly: Boolean(record.manualOnly),
			unavailable: Boolean(record.unavailable)
		};
		if (warningCode) {
			normalized.warningCode = warningCode;
		}
		normalized.expiresAt = fetchedAt + constants.MODEL_CACHE_TTL_MS;
		normalized.stale = fetchedAt + constants.MODEL_CACHE_TTL_MS <= nowValue;
		return normalized;
	}

	class SettingsStore {
		constructor(options) {
			options = options || {};
			this.preferences = resolvePreferences(options.preferences || options.prefs);
			this.prefix = options.prefix || constants.PREFERENCE_PREFIX;
			this.now = options.now || Date.now;
			this.defaults = Object.assign({}, constants.DEFAULT_SETTINGS, options.defaults || {});
			assertNoSecretFields(this.defaults);
		}

		_key(name) {
			return this.prefix + name;
		}

		_read(name) {
			try {
				return this.preferences.get(this._key(name));
			}
			catch (error) {
				return undefined;
			}
		}

		_write(name, value) {
			assertNoSecretFields(value);
			try {
				this.preferences.set(this._key(name), value);
			}
			catch (error) {
				throw errors.createConfigurationError("preference-write-failed");
			}
		}

		_clear(name) {
			try {
				if (typeof this.preferences.clear === "function") {
					this.preferences.clear(this._key(name));
				}
				else {
					this.preferences.set(this._key(name), undefined);
				}
			}
			catch (error) {
				throw errors.createConfigurationError("preference-clear-failed");
			}
		}

		_normalize(name, value) {
			switch (name) {
				case "enabled":
					if (value === undefined) {
						return Boolean(this.defaults.enabled);
					}
					if (typeof value === "boolean") {
						return value;
					}
					if (value === "true" || value === "false") {
						return value === "true";
					}
					throw errors.createConfigurationError("invalid-enabled-setting");
				case "defaultProvider":
					return validateProvider(value === undefined ? this.defaults.defaultProvider : value);
				case "defaultModel":
					if (value === undefined || value === null) {
						return "";
					}
					if (typeof value !== "string") {
						throw errors.createConfigurationError("invalid-default-model");
					}
					return utils.safeString(value, 256);
				case "agentRouterBaseURL":
					try {
						return utils.normalizeBaseURL(
							value === undefined ? this.defaults.agentRouterBaseURL : value,
							constants.PROVIDER_DEFINITIONS.agentrouter.defaultBaseURL
						);
					}
					catch (error) {
						throw errors.createConfigurationError("invalid-agentrouter-base-url");
					}
				case "summaryDetail":
					var detail = value === undefined ? this.defaults.summaryDetail : value;
					if (!constants.SUMMARY_DETAIL_LEVELS.includes(detail)) {
						throw errors.createConfigurationError("invalid-summary-detail");
					}
					return detail;
				case "crossCheckConcurrency":
					return utils.safeInteger(
						value === undefined ? this.defaults.crossCheckConcurrency : Number(value),
						2, 1, 2
					);
				case "crossCheckMaxPDFs":
					return utils.safeInteger(
						value === undefined ? this.defaults.crossCheckMaxPDFs : Number(value),
						25, 1, constants.MAX_CROSS_CHECK_PDFS
					);
				default:
					throw errors.createConfigurationError("unknown-setting");
			}
		}

		get(name) {
			var raw = this._read(name);
			if (raw === undefined || raw === null) {
				return this._normalize(name, undefined);
			}
			if (name === "enabled" && typeof raw === "string") {
				raw = raw !== "false";
			}
			return this._normalize(name, raw);
		}

		getAll() {
		var result = {};
		for (var name of Object.keys(constants.PREFERENCE_KEYS)) {
			if (name === "modelCachePrefix") {
				continue;
			}
			result[name] = this.get(name);
		}
		return result;
		}

		set(name, value) {
			var normalized = this._normalize(name, value);
			this._write(name, normalized);
			return normalized;
		}

		setMany(values) {
			if (!values || typeof values !== "object" || Array.isArray(values)) {
				throw errors.createConfigurationError("invalid-settings-object");
			}
			assertNoSecretFields(values);
			var normalized = {};
			for (var name of Object.keys(values)) {
				normalized[name] = this._normalize(name, values[name]);
			}
			for (var key of Object.keys(normalized)) {
				this._write(key, normalized[key]);
			}
			return normalized;
		}

		reset(name) {
			if (name === undefined) {
				for (var setting of [
					"enabled", "defaultProvider", "defaultModel", "agentRouterBaseURL", "summaryDetail",
					"crossCheckConcurrency", "crossCheckMaxPDFs"
				]) {
					this._clear(setting);
				}
				return this.getAll();
			}
			this._clear(name);
			return this.get(name);
		}

		_cacheKey(provider) {
			return constants.PREFERENCE_KEYS.modelCachePrefix + validateProvider(provider);
		}

		saveModelCatalog(provider, catalog) {
			var providerID = validateProvider(provider);
			if (!catalog || typeof catalog !== "object") {
				throw errors.createConfigurationError("invalid-model-catalog");
			}
			assertNoSecretFields(catalog);
			var record = normalizeCacheRecord(providerID, Object.assign({}, catalog, {
				fetchedAt: catalog.fetchedAt || this.now()
			}), this.now());
			if (!record) {
				throw errors.createConfigurationError("invalid-model-catalog");
			}
			delete record.expiresAt;
			delete record.stale;
			this._write(this._cacheKey(providerID), JSON.stringify(record));
			return normalizeCacheRecord(providerID, record, this.now());
		}

		getCachedModelCatalog(provider, options) {
			options = options || {};
			var providerID = validateProvider(provider);
			var raw = this._read(this._cacheKey(providerID));
			if (typeof raw === "string") {
				var parsed = utils.parseJSON(raw);
				if (!parsed.ok) {
					return null;
				}
				raw = parsed.value;
			}
			var record = normalizeCacheRecord(providerID, raw, this.now());
			if (!record || (record.stale && options.allowStale !== true)) {
				return null;
			}
			return record;
		}

		getModelCacheMetadata(provider) {
			var record = this.getCachedModelCatalog(provider, { allowStale: true });
			if (!record) {
				return null;
			}
			return {
				provider: record.provider,
				fetchedAt: record.fetchedAt,
				expiresAt: record.expiresAt,
				modelCount: record.models.length,
				manualOnly: record.manualOnly,
				unavailable: record.unavailable,
				stale: record.stale
			};
		}

		isModelCacheFresh(provider) {
			return Boolean(this.getCachedModelCatalog(provider));
		}

		clearModelCatalog(provider) {
			this._clear(this._cacheKey(provider));
		}
	}

	function createSettingsStore(options) {
		return new SettingsStore(options);
	}

	var settings = {
		MemoryPreferences,
		SettingsStore,
		PreferencesStore: SettingsStore,
		DEFAULT_SETTINGS: constants.DEFAULT_SETTINGS,
		createSettingsStore,
		assertNoSecretFields,
		normalizeCacheRecord
	};

	modules.settings = settings;
	if (typeof module !== "undefined" && module.exports) {
		module.exports = settings;
	}
})(typeof globalThis !== "undefined" ? globalThis : this);
