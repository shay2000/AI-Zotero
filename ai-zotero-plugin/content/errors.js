(function (root) {
	"use strict";

	var modules = root.__AIZoteroModules || (root.__AIZoteroModules = {});
	var constants = modules.constants;
	var utils = modules.utils;
	if (typeof module !== "undefined" && module.exports && typeof require === "function") {
		constants = constants || require("./constants.js");
		utils = utils || require("./utils.js");
	}

	var ERROR_CODES = {
		UNKNOWN: "UNKNOWN",
		CONFIGURATION: "CONFIGURATION",
		CREDENTIALS: "CREDENTIALS",
		AUTHENTICATION: "AUTHENTICATION",
		INSUFFICIENT_CREDITS: "INSUFFICIENT_CREDITS",
		MODEL_NOT_FOUND: "MODEL_NOT_FOUND",
		MODEL_LIST_UNAVAILABLE: "MODEL_LIST_UNAVAILABLE",
		CONTEXT_LENGTH: "CONTEXT_LENGTH",
		MODERATION: "MODERATION",
		INVALID_REQUEST: "INVALID_REQUEST",
		RATE_LIMIT: "RATE_LIMIT",
		PROVIDER_UNAVAILABLE: "PROVIDER_UNAVAILABLE",
		NETWORK: "NETWORK",
		OFFLINE: "OFFLINE",
		TLS: "TLS",
		TIMEOUT: "TIMEOUT",
		CANCELED: "CANCELED",
		MALFORMED_RESPONSE: "MALFORMED_RESPONSE",
		UNSUPPORTED: "UNSUPPORTED",
		REQUEST_FAILED: "REQUEST_FAILED"
	};

	var DEFAULT_MESSAGES = {
		UNKNOWN: "The AI provider request failed.",
		CONFIGURATION: "The AI provider configuration is invalid.",
		CREDENTIALS: "The AI provider credentials could not be accessed.",
		AUTHENTICATION: "The AI provider rejected the API key.",
		INSUFFICIENT_CREDITS: "The AI provider account has insufficient credits.",
		MODEL_NOT_FOUND: "The selected model is unavailable for this provider.",
		MODEL_LIST_UNAVAILABLE: "The provider did not make a model catalog available.",
		CONTEXT_LENGTH: "The request is too large for the selected model.",
		MODERATION: "The provider rejected the request under its safety policy.",
		INVALID_REQUEST: "The provider rejected the request parameters.",
		RATE_LIMIT: "The provider rate limit was reached.",
		PROVIDER_UNAVAILABLE: "The provider is temporarily unavailable.",
		NETWORK: "The network request to the provider failed.",
		OFFLINE: "The device appears to be offline.",
		TLS: "A secure connection to the provider could not be established.",
		TIMEOUT: "The provider request timed out.",
		CANCELED: "The provider request was canceled.",
		MALFORMED_RESPONSE: "The provider returned an invalid response.",
		UNSUPPORTED: "This provider operation is not supported.",
		REQUEST_FAILED: "The provider request failed."
	};

	var SAFE_DETAIL_KEYS = [
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
		"reason",
		"retryable"
	];

	function sanitizeMessage(value, fallback) {
		var message = utils && utils.safeString ? utils.safeString(value, 240) : String(value || "").slice(0, 240);
		message = message
			.replace(/Bearer\s+[^\s]+/gi, "Bearer [redacted]")
			.replace(/(?:api[-_ ]?key|authorization|password|secret)\s*[:=]\s*[^\s,;]+/gi, "$1: [redacted]");
		return message || fallback;
	}

	function safeDetailValue(key, value) {
		if (value === undefined || value === null) {
			return undefined;
		}
		if (key === "status" || key === "retryAfterMs" || key === "attempt"
				|| key === "maxAttempts" || key === "timingMs") {
			return Number.isFinite(Number(value)) ? Number(value) : undefined;
		}
		if (key === "retryable") {
			return Boolean(value);
		}
		if (key === "tokenUsage") {
			if (!value || typeof value !== "object") {
				return undefined;
			}
			var usage = {};
			["prompt_tokens", "completion_tokens", "total_tokens", "promptTokens", "completionTokens", "totalTokens"]
				.forEach(name => {
					if (Number.isFinite(Number(value[name]))) {
						usage[name] = Number(value[name]);
					}
				});
			return Object.keys(usage).length ? usage : undefined;
		}
		if (key === "reason") {
			var reason = utils && utils.safeString ? utils.safeString(value, 120) : String(value).slice(0, 120);
			return reason.replace(/[^a-zA-Z0-9_.-]/g, "-");
		}
		return utils && utils.safeString ? utils.safeString(value, 256) : String(value).slice(0, 256);
	}

	function sanitizeDetails(details) {
		var result = {};
		if (!details || typeof details !== "object") {
			return result;
		}
		for (var key of SAFE_DETAIL_KEYS) {
			var value = safeDetailValue(key, details[key]);
			if (value !== undefined) {
				result[key] = value;
			}
		}
		return result;
	}

	function messageForCode(code) {
		return DEFAULT_MESSAGES[code] || DEFAULT_MESSAGES.UNKNOWN;
	}

	class AIZoteroError extends Error {
		constructor(code, message, details) {
			var normalizedCode = ERROR_CODES[code] || code || ERROR_CODES.UNKNOWN;
			super(sanitizeMessage(message, messageForCode(normalizedCode)));
			this.name = "AIZoteroError";
			this.code = normalizedCode;
			this.details = sanitizeDetails(details);
			this.provider = this.details.provider;
			this.status = this.details.status;
			this.retryable = Boolean(this.details.retryable);
			if (Error.captureStackTrace) {
				Error.captureStackTrace(this, AIZoteroError);
			}
		}

		toDiagnostic(extra) {
			return toSafeDiagnostic(this, extra);
		}
	}

	function copyHints(payload) {
		if (!payload || typeof payload !== "object") {
			return "";
		}
		var error = payload.error && typeof payload.error === "object" ? payload.error : payload;
		var hints = [];
		["code", "type", "status", "reason", "message", "param"].forEach(key => {
			if (typeof error[key] === "string" || typeof error[key] === "number") {
				hints.push(String(error[key]).toLowerCase());
			}
		});
		return hints.join(" ");
	}

	function codeFromProviderResponse(status, payload, operation) {
		var hints = copyHints(payload);
		if (/insufficient[_ -]?(credit|quota)|billing|payment_required|credit[s]?/.test(hints) || status === 402) {
			return ERROR_CODES.INSUFFICIENT_CREDITS;
		}
		if (/moderation|safety|content[_ -]?policy|blocked|policy_violation/.test(hints) || status === 451) {
			return ERROR_CODES.MODERATION;
		}
		if (/context[_ -]?(length|window)|too[_ -]?large|maximum[_ -]?token|token[_ -]?limit/.test(hints)
				|| status === 413) {
			return ERROR_CODES.CONTEXT_LENGTH;
		}
		if (/model[_ -]?(not[_ -]?found|unavailable|does[_ -]?not[_ -]?exist)|unknown[_ -]?model/.test(hints)) {
			return ERROR_CODES.MODEL_NOT_FOUND;
		}
		if (/rate[_ -]?limit|too[_ -]?many|throttl/.test(hints) || status === 429) {
			return ERROR_CODES.RATE_LIMIT;
		}
		if (status === 401 || (status === 403 && !/credit|quota|billing/.test(hints))) {
			return ERROR_CODES.AUTHENTICATION;
		}
		if (operation === "listModels" && (status === 404 || status === 405 || status === 501)) {
			return ERROR_CODES.MODEL_LIST_UNAVAILABLE;
		}
		if (status === 404) {
			return ERROR_CODES.MODEL_NOT_FOUND;
		}
		if (utils && utils.isTransientStatus && utils.isTransientStatus(status)) {
			return status === 429 ? ERROR_CODES.RATE_LIMIT : ERROR_CODES.PROVIDER_UNAVAILABLE;
		}
		if (status >= 400 && status < 500) {
			return ERROR_CODES.INVALID_REQUEST;
		}
		return ERROR_CODES.REQUEST_FAILED;
	}

	function createProviderError(options) {
		options = options || {};
		var status = Number.isFinite(Number(options.status)) ? Number(options.status) : 0;
		var code = options.code || codeFromProviderResponse(status, options.payload, options.operation);
		var retryable = options.retryable;
		if (retryable === undefined) {
			retryable = code === ERROR_CODES.RATE_LIMIT
				|| code === ERROR_CODES.PROVIDER_UNAVAILABLE
				|| code === ERROR_CODES.NETWORK
				|| code === ERROR_CODES.TIMEOUT;
		}
		var details = {
			provider: options.provider,
			status: status || undefined,
			operation: options.operation,
			model: options.model,
			retryAfterMs: options.retryAfterMs,
			requestId: options.requestId,
			generationId: options.generationId,
			retryable
		};
		return new AIZoteroError(code, options.safeMessage || messageForCode(code), details);
	}

	function createNetworkError(error, options) {
		options = options || {};
		if (options.timedOut) {
			return new AIZoteroError(ERROR_CODES.TIMEOUT, messageForCode(ERROR_CODES.TIMEOUT), {
				provider: options.provider,
				operation: options.operation,
				model: options.model,
				retryable: true
			});
		}
		if (options.canceled || (utils && utils.isAbortError && utils.isAbortError(error))) {
			return new AIZoteroError(ERROR_CODES.CANCELED, messageForCode(ERROR_CODES.CANCELED), {
				provider: options.provider,
				operation: options.operation,
				model: options.model,
				retryable: false
			});
		}
		var errorCode = String(error && (error.code || error.name) || "").toUpperCase();
		var online = root.navigator && root.navigator.onLine;
		var code = /TLS|SSL|CERT/.test(errorCode) ? ERROR_CODES.TLS
			: online === false ? ERROR_CODES.OFFLINE : ERROR_CODES.NETWORK;
		return new AIZoteroError(code, messageForCode(code), {
			provider: options.provider,
			operation: options.operation,
			model: options.model,
			retryable: code === ERROR_CODES.NETWORK
		});
	}

	function createMalformedResponseError(options) {
		options = options || {};
		return new AIZoteroError(ERROR_CODES.MALFORMED_RESPONSE, messageForCode(ERROR_CODES.MALFORMED_RESPONSE), {
			provider: options.provider,
			operation: options.operation,
			model: options.model,
			retryable: false,
			reason: options.reason
		});
	}

	function createConfigurationError(reason) {
		return new AIZoteroError(ERROR_CODES.CONFIGURATION, messageForCode(ERROR_CODES.CONFIGURATION), {
			reason
		});
	}

	function createCredentialError(reason) {
		return new AIZoteroError(ERROR_CODES.CREDENTIALS, messageForCode(ERROR_CODES.CREDENTIALS), {
			reason
		});
	}

	function isRetryableError(error) {
		return !!error && (Boolean(error.retryable)
			|| error.code === ERROR_CODES.RATE_LIMIT
			|| error.code === ERROR_CODES.PROVIDER_UNAVAILABLE
			|| error.code === ERROR_CODES.NETWORK
			|| error.code === ERROR_CODES.TIMEOUT);
	}

	function isCancellation(error) {
		return !!error && (error.code === ERROR_CODES.CANCELED || (utils && utils.isAbortError && utils.isAbortError(error)));
	}

	function toSafeDiagnostic(error, extra) {
		var result = {};
		if (error && error.code) {
			result.code = error.code;
		}
		var details = error && error.details ? error.details : error;
		if (details && typeof details === "object") {
			for (var key of SAFE_DETAIL_KEYS) {
				if (key === "code") {
					continue;
				}
				var value = safeDetailValue(key, details[key]);
				if (value !== undefined) {
					result[key] = value;
				}
			}
		}
		if (!result.code && error && error.name === "AbortError") {
			result.code = ERROR_CODES.CANCELED;
		}
		if (extra && typeof extra === "object") {
			for (var extraKey of SAFE_DETAIL_KEYS) {
				if (extraKey === "code" || result[extraKey] !== undefined) {
					continue;
				}
				var extraValue = safeDetailValue(extraKey, extra[extraKey]);
				if (extraValue !== undefined) {
					result[extraKey] = extraValue;
				}
			}
		}
		if (!result.code) {
			result.code = ERROR_CODES.UNKNOWN;
		}
		result.message = messageForCode(result.code);
		return result;
	}

	var errors = {
		ERROR_CODES,
		CODES: ERROR_CODES,
		DEFAULT_MESSAGES,
		AIZoteroError,
		ProviderError: AIZoteroError,
		StreamError: AIZoteroError,
		sanitizeDetails,
		messageForCode,
		codeFromProviderResponse,
		createProviderError,
		fromProviderPayload: createProviderError,
		fromResponse: createProviderError,
		createNetworkError,
		createMalformedResponseError,
		createConfigurationError,
		createCredentialError,
		isRetryableError,
		isCancellation,
		toSafeDiagnostic,
		toDiagnostic: toSafeDiagnostic
	};

	modules.errors = errors;
	if (typeof module !== "undefined" && module.exports) {
		module.exports = errors;
	}
})(typeof globalThis !== "undefined" ? globalThis : this);
