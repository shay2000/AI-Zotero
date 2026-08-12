(function (root) {
	"use strict";

	var modules = root.__AIZoteroModules || (root.__AIZoteroModules = {});

	function freeze(value) {
		if (!value || typeof value !== "object" || Object.isFrozen(value)) {
			return value;
		}
		Object.keys(value).forEach(key => freeze(value[key]));
		return Object.freeze(value);
	}

	var providerDefinitions = {
		mistral: {
			id: "mistral",
			displayName: "Mistral",
			defaultBaseURL: "https://api.mistral.ai/v1",
			chatPath: "/chat/completions",
			modelsPath: "/models",
			extraHeaders: {}
		},
		openrouter: {
			id: "openrouter",
			displayName: "OpenRouter",
			defaultBaseURL: "https://openrouter.ai/api/v1",
			chatPath: "/chat/completions",
			modelsPath: "/models",
			extraHeaders: {
				"HTTP-Referer": "https://www.zotero.org",
				"X-Title": "AI for Zotero"
			}
		},
		agentrouter: {
			id: "agentrouter",
			displayName: "AgentRouter",
			defaultBaseURL: "https://co.agentrouter.org/v1",
			legacyBaseURL: "https://agentrouter.org/v1",
			chatPath: "/chat/completions",
			modelsPath: "/models",
			extraHeaders: {}
		}
	};

	var constants = {
		PLUGIN_ID: "ai-zotero@shayprasad",
		MODULE_NAMESPACE: "__AIZoteroModules",
		PROVIDER_IDS: ["mistral", "openrouter", "agentrouter"],
		PROVIDER_DEFINITIONS: providerDefinitions,
		LOGIN_MANAGER_ORIGIN: "chrome://ai-zotero",
		LOGIN_MANAGER_REALM_PREFIX: "AI-Zotero API key",
		LOGIN_MANAGER_USERNAME_PREFIX: "provider:",
		PREFERENCE_PREFIX: "extensions.ai-zotero.",
		PREFERENCE_KEYS: {
			enabled: "enabled",
			defaultProvider: "defaultProvider",
			defaultModel: "defaultModel",
			agentRouterBaseURL: "agentRouterBaseURL",
			summaryDetail: "summaryDetail",
			crossCheckConcurrency: "crossCheckConcurrency",
			crossCheckMaxPDFs: "crossCheckMaxPDFs",
			modelCachePrefix: "modelCache."
		},
		DEFAULT_SETTINGS: {
			enabled: true,
			defaultProvider: "mistral",
			defaultModel: "",
			agentRouterBaseURL: providerDefinitions.agentrouter.defaultBaseURL,
			summaryDetail: "high-level",
			crossCheckConcurrency: 2,
			crossCheckMaxPDFs: 25
		},
		SUMMARY_DETAIL_LEVELS: ["brief", "high-level", "detailed"],
		DEFAULT_TEMPERATURE: 0.2,
		DEFAULT_OUTPUT_BUDGETS: {
			summary: 1400,
			explanation: 600,
			crosscheck: 2400
		},
		MODEL_CACHE_TTL_MS: 24 * 60 * 60 * 1000,
		MODEL_CACHE_SCHEMA_VERSION: 1,
		SETTINGS_SCHEMA_VERSION: 1,
		SSE_DONE: "[DONE]",
		DEFAULT_INACTIVITY_TIMEOUT_MS: 120 * 1000,
		DEFAULT_MAX_RETRY_ATTEMPTS: 3,
		DEFAULT_RETRY_INITIAL_DELAY_MS: 400,
		DEFAULT_RETRY_MAX_DELAY_MS: 8 * 1000,
		MAX_CROSS_CHECK_PDFS: 100,
		MAX_MODEL_CACHE_ENTRIES: 10000,
		SAFE_DIAGNOSTIC_FIELDS: [
			"code",
			"provider",
			"status",
			"operation",
			"model",
			"requestId",
			"generationId",
			"retryAfterMs",
			"attempt",
			"maxAttempts",
			"timingMs",
			"tokenUsage",
			"reason"
		]
	};

	freeze(constants);
	modules.constants = constants;

	if (typeof module !== "undefined" && module.exports) {
		module.exports = constants;
	}
})(typeof globalThis !== "undefined" ? globalThis : this);
