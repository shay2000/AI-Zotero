/*
	Preferences pane controller. It only receives redacted settings and
	credential status from Zotero.AIZotero.api. The password field is cleared
	immediately after a Login Manager operation and is never written to a
	preference or diagnostic.
*/

"use strict";

var AIZoteroPreferences = {
	_api: null,
	_listeners: [],
	_initialized: false,

	init() {
		if (this._initialized) return;
		this._initialized = true;
		this._api = Zotero.AIZotero?.api || null;
		this._bind("ai-zotero-enabled", "command", () => this.saveSettings());
		this._bind("ai-zotero-provider", "command", () => {
			this.updateProviderVisibility();
			this.saveSettings();
			this.refreshCredentialStatus();
			this.refreshModels(false);
		});
		this._bind("ai-zotero-model", "change", () => this.saveSettings());
		this._bind("ai-zotero-agentrouter-url", "change", () => this.saveSettings());
		this._bind("ai-zotero-detail", "command", () => this.saveSettings());
		this._bind("ai-zotero-concurrency", "change", () => this.saveSettings());
		this._bind("ai-zotero-limit", "change", () => this.saveSettings());
		this._bind("ai-zotero-refresh-models", "command", () => this.refreshModels(true));
		this._bind("ai-zotero-save-key", "command", () => this.saveKey());
		this._bind("ai-zotero-remove-key", "command", () => this.removeKey());
		this._bind("ai-zotero-test-connection", "command", () => this.testConnection());
		this.refresh();
	},

	uninit() {
		for (let { element, type, listener } of this._listeners) {
			element?.removeEventListener(type, listener);
		}
		this._listeners = [];
		this._api = null;
		this._initialized = false;
	},

	_bind(id, type, callback) {
		let element = document.getElementById(id);
		if (!element) return;
		element.addEventListener(type, callback);
		this._listeners.push({ element, type, listener: callback });
	},

	_element(id) {
		return document.getElementById(id);
	},

	_setL10n(element, id, args) {
		if (!element) return;
		element.setAttribute("data-l10n-id", id);
		if (args && Object.keys(args).length) {
			element.setAttribute("data-l10n-args", JSON.stringify(args));
		}
		try {
			document.l10n?.setAttributes?.(element, id, args || {});
		}
		catch (e) {
			// The preference window will translate the fragment when ready.
		}
	},

	_setResult(id, args) {
		let result = this._element("ai-zotero-credential-result");
		this._setL10n(result, id, args);
	},

	async refresh() {
		if (!this._api) {
			this._setResult("ai-zotero-error-module-unavailable");
			return;
		}
		let preferences;
		try {
			preferences = this._api.getPreferences();
		}
		catch (e) {
			this._setResult("ai-zotero-error-module-unavailable");
			return;
		}
		this._element("ai-zotero-enabled").checked = !!preferences.enabled;
		this._element("ai-zotero-provider").value = preferences.provider || "mistral";
		this._element("ai-zotero-model").value = preferences.model || "";
		this._element("ai-zotero-agentrouter-url").value = preferences.agentrouterBaseURL || "";
		this._element("ai-zotero-detail").value = preferences.detailLevel || "high-level";
		this._element("ai-zotero-concurrency").value = preferences.crossCheckConcurrency || 2;
		this._element("ai-zotero-limit").value = preferences.crossCheckLimit || 25;
		this.updateProviderVisibility();
		await this.refreshCredentialStatus();
		await this.refreshModels(false);
	},

	updateProviderVisibility() {
		let provider = this._element("ai-zotero-provider")?.value;
		let row = this._element("ai-zotero-agentrouter-url-row");
		if (row) row.hidden = provider !== "agentrouter";
	},

	collectSettings() {
		return {
			enabled: !!this._element("ai-zotero-enabled")?.checked,
			provider: this._element("ai-zotero-provider")?.value || "mistral",
			model: this._element("ai-zotero-model")?.value || "",
			agentrouterBaseURL: this._element("ai-zotero-agentrouter-url")?.value || "",
			detailLevel: this._element("ai-zotero-detail")?.value || "high-level",
			crossCheckConcurrency: Number(this._element("ai-zotero-concurrency")?.value || 2),
			crossCheckLimit: Number(this._element("ai-zotero-limit")?.value || 25),
		};
	},

	saveSettings() {
		if (!this._api?.setPreferences) return;
		try {
			this._api.setPreferences(this.collectSettings());
		}
		catch (e) {
			this._setResult("ai-zotero-error-settings-not-saved");
		}
	},

	async refreshCredentialStatus() {
		let provider = this._element("ai-zotero-provider")?.value || "mistral";
		let status = this._element("ai-zotero-api-key-status");
		if (!status || !this._api?.getCredentialStatus) return;
		try {
			let value = await this._api.getCredentialStatus(provider);
			if (value?.hasKey) {
				this._setL10n(status, "ai-zotero-key-configured");
			}
			else if (value?.available === false) {
				this._setL10n(status, "ai-zotero-key-storage-unavailable");
			}
			else {
				this._setL10n(status, "ai-zotero-key-not-configured");
			}
		}
		catch (e) {
			this._setL10n(status, "ai-zotero-key-storage-unavailable");
		}
	},

	async saveKey() {
		let input = this._element("ai-zotero-api-key");
		let value = input?.value || "";
		let provider = this._element("ai-zotero-provider")?.value || "mistral";
		if (!value) {
			this._setResult("ai-zotero-key-empty");
			return;
		}
		try {
			let result = await this._api?.saveCredential?.(provider, value);
			if (result?.ok) {
				this._setResult("ai-zotero-key-saved");
			}
			else {
				this._setResult(result?.error?.messageKey || "ai-zotero-error-authentication");
			}
		}
		catch (e) {
			this._setResult("ai-zotero-error-authentication");
		}
		finally {
			// Do not leave the secret in the pane or in a JS property.
			input.value = "";
			await this.refreshCredentialStatus();
		}
	},

	async removeKey() {
		let provider = this._element("ai-zotero-provider")?.value || "mistral";
		try {
			let result = await this._api?.removeCredential?.(provider);
			this._setResult(result?.ok ? "ai-zotero-key-removed" : (result?.error?.messageKey || "ai-zotero-error-authentication"));
		}
		catch (e) {
			this._setResult("ai-zotero-error-authentication");
		}
		await this.refreshCredentialStatus();
	},

	async testConnection() {
		let provider = this._element("ai-zotero-provider")?.value || "mistral";
		let model = this._element("ai-zotero-model")?.value || "";
		this._setResult("ai-zotero-connection-testing");
		try {
			let result = await this._api?.testConnection?.(provider, model);
			this._setResult(result?.ok ? "ai-zotero-connection-success" : (result?.error?.messageKey || "ai-zotero-error-network"));
		}
		catch (e) {
			this._setResult("ai-zotero-error-network");
		}
	},

	async refreshModels(forceRefresh) {
		let provider = this._element("ai-zotero-provider")?.value || "mistral";
		let status = this._element("ai-zotero-model-status");
		if (!status || !this._api?.getProviderCatalog) return;
		this._setL10n(status, forceRefresh ? "ai-zotero-models-refreshing" : "ai-zotero-model-status");
		try {
			let models = await this._api.getProviderCatalog(provider, !!forceRefresh);
			if (models?.length) {
				this._setL10n(status, "ai-zotero-models-loaded", { count: models.length });
			}
			else {
				this._setL10n(status, "ai-zotero-models-manual");
			}
		}
		catch (e) {
			this._setL10n(status, "ai-zotero-models-manual");
		}
	},
};
