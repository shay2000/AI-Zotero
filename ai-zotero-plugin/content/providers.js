(function (root) {
	"use strict";

	var modules = root.__AIZoteroModules || (root.__AIZoteroModules = {});
	var constants = modules.constants;
	var utils = modules.utils;
	var errors = modules.errors;
	var sse = modules.sse;
	if (typeof module !== "undefined" && module.exports && typeof require === "function") {
		constants = constants || require("./constants.js");
		utils = utils || require("./utils.js");
		errors = errors || require("./errors.js");
		sse = sse || require("./sse.js");
	}

	function providerDefinition(provider) {
		if (typeof provider === "string") {
			return constants.PROVIDER_DEFINITIONS[provider] || null;
		}
		return provider && provider.id ? provider : null;
	}

	function requireProvider(provider) {
		var definition = providerDefinition(provider);
		if (!definition) {
			throw errors.createConfigurationError("unknown-provider");
		}
		return definition;
	}

	function requireAPIKey(apiKey) {
		try {
			return utils.asNonEmptyString(apiKey, "API key", 4096);
		}
		catch (error) {
			throw errors.createCredentialError("missing-api-key");
		}
	}

	function normalizeMessages(messages) {
		if (!Array.isArray(messages) || !messages.length) {
			throw errors.createConfigurationError("messages-required");
		}
		return messages.map(message => {
			if (!message || typeof message !== "object") {
				throw errors.createConfigurationError("invalid-message");
			}
			var role = typeof message.role === "string" ? message.role.trim() : "";
			if (!["system", "user", "assistant", "tool"].includes(role)) {
				throw errors.createConfigurationError("invalid-message-role");
			}
			var content = message.content;
			if (typeof content !== "string" && !Array.isArray(content)) {
				throw errors.createConfigurationError("invalid-message-content");
			}
			var normalized = { role, content };
			if (typeof message.name === "string" && message.name.trim()) {
				normalized.name = message.name.trim().slice(0, 128);
			}
			if (typeof message.tool_call_id === "string" && message.tool_call_id.trim()) {
				normalized.tool_call_id = message.tool_call_id.trim().slice(0, 256);
			}
			return normalized;
		});
	}

	function contentToText(content) {
		if (typeof content === "string") {
			return content;
		}
		if (!Array.isArray(content)) {
			return "";
		}
		return content.map(part => {
			if (typeof part === "string") {
				return part;
			}
			if (!part || typeof part !== "object") {
				return "";
			}
			if (typeof part.text === "string") {
				return part.text;
			}
			if (typeof part.content === "string") {
				return part.content;
			}
			return "";
		}).join("");
	}

	function normalizeUsage(usage) {
		if (!usage || typeof usage !== "object") {
			return undefined;
		}
		var result = {};
		[
			["prompt_tokens", "prompt_tokens"],
			["completion_tokens", "completion_tokens"],
			["total_tokens", "total_tokens"],
			["promptTokens", "prompt_tokens"],
			["completionTokens", "completion_tokens"],
			["totalTokens", "total_tokens"]
		].forEach(([source, target]) => {
			if (Number.isFinite(Number(usage[source]))) {
				result[target] = Number(usage[source]);
			}
		});
		return Object.keys(result).length ? result : undefined;
	}

	function mergeUsage(previous, next) {
		var normalized = normalizeUsage(next);
		if (!normalized) {
			return previous;
		}
		return Object.assign({}, previous || {}, normalized);
	}

	function responseRequestID(response) {
		return utils.getHeader(response && response.headers, "x-request-id")
			|| utils.getHeader(response && response.headers, "x-request-id".toUpperCase())
			|| undefined;
	}

	function modelEntry(value) {
		if (typeof value === "string") {
			var id = utils.normalizeModelID(value);
			return id ? { id } : null;
		}
		if (!value || typeof value !== "object") {
			return null;
		}
		var modelID = utils.normalizeModelID(value.id || value.model || value.name);
		if (!modelID) {
			return null;
		}
		var entry = { id: modelID };
		var displayName = utils.normalizeModelID(value.display_name || value.displayName || value.name);
		if (displayName && displayName !== modelID) {
			entry.displayName = displayName;
		}
		return entry;
	}

	function normalizeModelCatalog(data, options) {
		options = options || {};
		var rawModels;
		if (Array.isArray(data)) {
			rawModels = data;
		}
		else if (data && Array.isArray(data.data)) {
			rawModels = data.data;
		}
		else if (data && Array.isArray(data.models)) {
			rawModels = data.models;
		}
		else {
			throw errors.createMalformedResponseError({
				provider: options.provider,
				operation: "listModels",
				reason: "model-array-missing"
			});
		}
		var models = [];
		var seen = new Set();
		for (var value of rawModels) {
			var entry = modelEntry(value);
			if (entry && !seen.has(entry.id)) {
				seen.add(entry.id);
				models.push(entry);
			}
			if (models.length >= constants.MAX_MODEL_CACHE_ENTRIES) {
				break;
			}
		}
		return {
			models,
			modelIDs: models.map(entry => entry.id),
			fetchedAt: options.fetchedAt || Date.now(),
			manualOnly: false,
			unavailable: false
		};
	}

	function extractChoiceText(choice) {
		if (!choice || typeof choice !== "object") {
			return "";
		}
		var delta = choice.delta && typeof choice.delta === "object" ? choice.delta : null;
		var message = choice.message && typeof choice.message === "object" ? choice.message : null;
		if (delta && delta.content !== undefined) {
			return contentToText(delta.content);
		}
		if (message && message.content !== undefined) {
			return contentToText(message.content);
		}
		if (typeof choice.text === "string") {
			return choice.text;
		}
		return "";
	}

	function normalizeCompletionResponse(payload, options) {
		options = options || {};
		if (!payload || typeof payload !== "object" || !Array.isArray(payload.choices) || !payload.choices.length) {
			throw errors.createMalformedResponseError({
				provider: options.provider,
				operation: options.operation || "chat",
				model: options.model,
				reason: "choices-missing"
			});
		}
		var text = payload.choices.map(extractChoiceText).join("");
		var firstChoice = payload.choices[0] || {};
		return {
			text,
			id: typeof payload.id === "string" ? payload.id : undefined,
			generationId: typeof payload.id === "string" ? payload.id : undefined,
			model: typeof payload.model === "string" ? payload.model : undefined,
			usage: normalizeUsage(payload.usage),
			finishReason: firstChoice.finish_reason || firstChoice.finishReason || undefined
		};
	}

	class OpenAICompatibleTransport {
		constructor(options) {
			options = options || {};
			this.fetch = utils.getFetch(options.fetchImpl);
			this.sleep = options.sleep || ((milliseconds, signal) => utils.delay(milliseconds, signal));
			this.random = options.random || Math.random;
			this.now = options.now || Date.now;
			this.inactivityTimeoutMs = options.inactivityTimeoutMs === undefined
				? constants.DEFAULT_INACTIVITY_TIMEOUT_MS : options.inactivityTimeoutMs;
			this.maxAttempts = Math.min(constants.DEFAULT_MAX_RETRY_ATTEMPTS,
				Math.max(1, Number(options.maxAttempts) || constants.DEFAULT_MAX_RETRY_ATTEMPTS));
			this.retryInitialDelayMs = options.retryInitialDelayMs === undefined
				? constants.DEFAULT_RETRY_INITIAL_DELAY_MS : Math.max(0, Number(options.retryInitialDelayMs) || 0);
			this.retryMaxDelayMs = options.retryMaxDelayMs === undefined
				? constants.DEFAULT_RETRY_MAX_DELAY_MS : Math.max(0, Number(options.retryMaxDelayMs) || 0);
			this.setTimeout = options.setTimeout;
			this.clearTimeout = options.clearTimeout;
		}

		_resolveBaseURL(definition, baseURL) {
			try {
				return utils.normalizeBaseURL(baseURL, definition.defaultBaseURL);
			}
			catch (error) {
				throw errors.createConfigurationError("invalid-base-url");
			}
		}

		_headers(definition, apiKey, options) {
			var headers = Object.assign({}, definition.extraHeaders || {}, options.headers || {}, {
				Authorization: "Bearer " + apiKey,
				Accept: options.accept || "application/json"
			});
			if (options.body !== undefined) {
				headers["Content-Type"] = "application/json";
			}
			return headers;
		}

		async _fetch(url, init, options) {
			options = options || {};
			if (!this.fetch) {
				throw errors.createConfigurationError("fetch-unavailable");
			}
			utils.throwIfAborted(options.signal);
			var linked = utils.createLinkedAbortController(options.signal);
			var timedOut = false;
			var timer;
			var setTimeoutFunction = this.setTimeout || root.setTimeout || setTimeout;
			var clearTimeoutFunction = this.clearTimeout || root.clearTimeout || clearTimeout;
			var requestInit = Object.assign({}, init);
			if (linked.signal) {
				requestInit.signal = linked.signal;
			}
			if (options.timeoutMs > 0) {
				timer = setTimeoutFunction(() => {
					timedOut = true;
					if (linked.controller) {
						linked.controller.abort();
					}
				}, options.timeoutMs);
			}
			try {
				return await this.fetch(url, requestInit);
			}
			catch (error) {
				throw errors.createNetworkError(error, {
					provider: options.provider,
					operation: options.operation,
					model: options.model,
					timedOut,
					canceled: Boolean(options.signal && options.signal.aborted)
				});
			}
			finally {
				if (timer !== undefined) {
					clearTimeoutFunction(timer);
				}
				linked.cleanup();
			}
		}

		async _responseText(response) {
			if (!response || typeof response.text !== "function") {
				return "";
			}
			var text = await response.text();
			return typeof text === "string" ? text.slice(0, 64 * 1024) : "";
		}

		async _responseError(response, options) {
			var bodyText = "";
			try {
				bodyText = await this._responseText(response);
			}
			catch (error) {
				// A status response is still classifiable when its body is unreadable.
			}
			var parsed = utils.parseJSON(bodyText);
			var retryAfterMs = utils.parseRetryAfter(
				utils.getHeader(response && response.headers, "retry-after"), this.now()
			);
			return errors.createProviderError({
				provider: options.provider,
				operation: options.operation,
				model: options.model,
				status: utils.responseStatus(response),
				payload: parsed.ok ? parsed.value : undefined,
				retryAfterMs,
				requestId: responseRequestID(response)
			});
		}

		_retryDelay(error, attempt) {
			if (error && Number.isFinite(error.details && error.details.retryAfterMs)) {
				return Math.min(this.retryMaxDelayMs, Math.max(0, error.details.retryAfterMs));
			}
			var randomValue;
			try {
				randomValue = Number(this.random());
			}
			catch (e) {
				randomValue = 0.5;
			}
			randomValue = utils.clamp(Number.isFinite(randomValue) ? randomValue : 0.5, 0, 1);
		var exponential = this.retryInitialDelayMs * Math.pow(2, Math.max(0, attempt - 1));
		return Math.min(this.retryMaxDelayMs, Math.round(exponential * (0.5 + randomValue)));
		}

		async _waitForRetry(error, attempt, options) {
			var delayMs = this._retryDelay(error, attempt);
			try {
				await this.sleep(delayMs, options.signal);
			}
			catch (sleepError) {
				if (utils.isAbortError(sleepError)) {
					throw errors.createNetworkError(sleepError, {
						canceled: true,
						provider: options.provider,
						operation: options.operation,
						model: options.model
					});
				}
				throw sleepError;
			}
		}

		_shouldRetry(error, attempt, options, visibleOutput) {
			if (options.retry === false || attempt >= this.maxAttempts || visibleOutput) {
				return false;
			}
			if (options.signal && options.signal.aborted) {
				return false;
			}
			return Boolean(options.retryable !== false && errors.isRetryableError(error));
		}

		async requestJSON(options) {
			options = options || {};
			var definition = requireProvider(options.provider);
			var apiKey = requireAPIKey(options.apiKey);
			var baseURL = this._resolveBaseURL(definition, options.baseURL);
			var url = utils.joinURL(baseURL, options.path);
			var maxAttempts = Math.min(this.maxAttempts,
				Math.max(1, Number(options.maxAttempts) || this.maxAttempts));
			var requestBody = options.body === undefined ? undefined : JSON.stringify(options.body);
			var lastError;
			for (var attempt = 1; attempt <= maxAttempts; attempt++) {
				try {
					var response = await this._fetch(url, {
						method: options.method || "GET",
						headers: this._headers(definition, apiKey, {
							headers: options.headers,
							body: requestBody,
							accept: options.accept
						}),
						body: requestBody
					}, {
						signal: options.signal,
						timeoutMs: options.timeoutMs === undefined ? this.inactivityTimeoutMs : options.timeoutMs,
						provider: definition.id,
						operation: options.operation || "request",
						model: options.model
					});
					if (!utils.responseIsOK(response)) {
						throw await this._responseError(response, {
							provider: definition.id,
							operation: options.operation || "request",
							model: options.model
						});
					}
					var responseText = await this._responseText(response);
					var parsed = utils.parseJSON(responseText);
					if (!parsed.ok || !parsed.value || typeof parsed.value !== "object") {
						throw errors.createMalformedResponseError({
							provider: definition.id,
							operation: options.operation || "request",
							model: options.model,
							reason: "json-body-invalid"
						});
					}
					return {
						data: parsed.value,
						status: utils.responseStatus(response),
						requestId: responseRequestID(response),
						attempts: attempt
					};
				}
				catch (error) {
					lastError = error instanceof errors.AIZoteroError
						? error
						: errors.createNetworkError(error, {
							provider: definition.id,
							operation: options.operation || "request",
							model: options.model,
							canceled: utils.isAbortError(error)
						});
					if (!this._shouldRetry(lastError, attempt, {
						retry: options.retry,
						retryable: options.retryable === undefined ? true : options.retryable,
						signal: options.signal
					}, false)) {
						throw lastError;
					}
					await this._waitForRetry(lastError, attempt, options);
				}
			}
			throw lastError;
		}

		async listModels(options) {
			options = options || {};
			var definition = requireProvider(options.provider);
			try {
				var result = await this.requestJSON({
					provider: definition,
					apiKey: options.apiKey,
					baseURL: options.baseURL,
					path: definition.modelsPath,
					method: "GET",
					operation: "listModels",
					signal: options.signal,
					maxAttempts: options.maxAttempts,
					timeoutMs: options.timeoutMs,
					retry: options.retry
				});
				var catalog = normalizeModelCatalog(result.data, {
					provider: definition.id,
					fetchedAt: this.now()
				});
				catalog.status = result.status;
				catalog.requestId = result.requestId;
				return catalog;
			}
			catch (error) {
				if (definition.id === "agentrouter" && error.code === errors.ERROR_CODES.MODEL_LIST_UNAVAILABLE) {
					var fallbackModel = utils.normalizeModelID(options.fallbackModel);
					var fallbackModels = fallbackModel ? [{ id: fallbackModel }] : [];
					return {
						models: fallbackModels,
						modelIDs: fallbackModels.map(entry => entry.id),
						fetchedAt: this.now(),
						manualOnly: true,
						unavailable: true,
						warningCode: errors.ERROR_CODES.MODEL_LIST_UNAVAILABLE,
						status: error.status
					};
				}
				throw error;
			}
		}

		async testConnection(options) {
			options = options || {};
			var catalog = await this.listModels(options);
			return {
				ok: true,
				provider: requireProvider(options.provider).id,
				model: utils.normalizeModelID(options.model) || undefined,
				models: catalog.models,
				modelIDs: catalog.modelIDs,
				manualOnly: Boolean(catalog.manualOnly),
				unavailable: Boolean(catalog.unavailable),
				warningCode: catalog.warningCode
			};
		}

		async _streamOnce(options, definition, apiKey, baseURL, state, onDelta) {
			var model = utils.normalizeModelID(options.model);
			if (!model) {
				throw errors.createConfigurationError("model-required");
			}
			var body = {
				model,
				messages: normalizeMessages(options.messages),
				stream: true
			};
			if (options.temperature !== undefined && options.temperature !== null) {
				if (!Number.isFinite(Number(options.temperature))) {
					throw errors.createConfigurationError("invalid-temperature");
				}
				body.temperature = Number(options.temperature);
			}
			if (options.maxOutputTokens !== undefined && options.maxOutputTokens !== null) {
				if (!Number.isFinite(Number(options.maxOutputTokens)) || Number(options.maxOutputTokens) <= 0) {
					throw errors.createConfigurationError("invalid-output-budget");
				}
				body.max_tokens = Math.round(Number(options.maxOutputTokens));
			}
			if (options.includeUsage === true) {
				body.stream_options = { include_usage: true };
			}
			var response = await this._fetch(utils.joinURL(baseURL, definition.chatPath), {
				method: "POST",
				headers: this._headers(definition, apiKey, {
					headers: options.headers,
					body,
					accept: "text/event-stream"
				}),
				body: JSON.stringify(body)
			}, {
				signal: options.signal,
				timeoutMs: options.headerTimeoutMs === undefined ? this.inactivityTimeoutMs : options.headerTimeoutMs,
				provider: definition.id,
				operation: "streamChat",
				model: body.model
			});
			if (!utils.responseIsOK(response)) {
				throw await this._responseError(response, {
					provider: definition.id,
					operation: "streamChat",
					model: body.model
				});
			}

			var streamResult = await sse.consumeSSE(response, {
				provider: definition.id,
				operation: "streamChat",
				model: body.model,
				signal: options.signal,
				inactivityTimeoutMs: options.inactivityTimeoutMs === undefined
					? this.inactivityTimeoutMs : options.inactivityTimeoutMs,
				setTimeout: this.setTimeout,
				clearTimeout: this.clearTimeout,
				onEvent: async (event, parsed) => {
					if (!parsed.isJSON || !parsed.value || typeof parsed.value !== "object") {
						throw errors.createMalformedResponseError({
							provider: definition.id,
							operation: "streamChat",
							model: body.model,
							reason: "sse-data-not-json"
						});
					}
					var chunk = parsed.value;
					if (!Array.isArray(chunk.choices) && !chunk.usage && !chunk.id) {
						throw errors.createMalformedResponseError({
							provider: definition.id,
							operation: "streamChat",
							model: body.model,
							reason: "sse-chunk-shape-invalid"
						});
					}
					state.sawChunk = true;
					if (typeof chunk.id === "string" && chunk.id) {
						state.generationId = chunk.id;
					}
					if (typeof chunk.model === "string" && chunk.model) {
						state.model = chunk.model;
					}
					state.usage = mergeUsage(state.usage, chunk.usage);
					if (Array.isArray(chunk.choices)) {
						for (var choice of chunk.choices) {
							var text = extractChoiceText(choice);
							if (text) {
								state.textParts.push(text);
								state.visibleOutput = true;
								if (typeof onDelta === "function") {
									await onDelta(text, {
										provider: definition.id,
										model: state.model || body.model,
										generationId: state.generationId,
										usage: state.usage
									});
								}
							}
							if (choice && typeof choice === "object") {
								state.finishReason = choice.finish_reason || choice.finishReason || state.finishReason;
							}
						}
					}
				}
			});
			if (!state.sawChunk) {
				throw errors.createMalformedResponseError({
					provider: definition.id,
					operation: "streamChat",
					model: body.model,
					reason: "sse-data-missing"
				});
			}
			return {
				text: state.textParts.join(""),
				generationId: state.generationId,
				model: state.model || body.model,
				usage: state.usage,
				finishReason: state.finishReason,
				completed: streamResult.done,
				requestId: responseRequestID(response)
			};
		}

		async streamChat(options) {
			options = options || {};
			var definition = requireProvider(options.provider);
			var apiKey = requireAPIKey(options.apiKey);
			var baseURL = this._resolveBaseURL(definition, options.baseURL);
			var maxAttempts = Math.min(this.maxAttempts,
				Math.max(1, Number(options.maxAttempts) || this.maxAttempts));
			var lastError;
			for (var attempt = 1; attempt <= maxAttempts; attempt++) {
				var state = {
					textParts: [],
					visibleOutput: false,
					sawChunk: false,
					generationId: undefined,
					model: undefined,
					usage: undefined,
					finishReason: undefined
				};
				try {
					return await this._streamOnce(options, definition, apiKey, baseURL, state, options.onDelta);
				}
				catch (error) {
					lastError = error instanceof errors.AIZoteroError
						? error
						: errors.createNetworkError(error, {
							provider: definition.id,
							operation: "streamChat",
							model: options.model,
							canceled: utils.isAbortError(error)
						});
					if (state.textParts.length && lastError && typeof lastError === "object") {
						Object.defineProperty(lastError, "partialText", {
							value: state.textParts.join(""),
							enumerable: false,
							configurable: true
						});
						Object.defineProperty(lastError, "incomplete", {
							value: true,
							enumerable: false,
							configurable: true
						});
					}
					if (!this._shouldRetry(lastError, attempt, {
						retry: options.retry,
						retryable: options.retryable === undefined ? true : options.retryable,
						signal: options.signal
					}, state.visibleOutput)) {
						throw lastError;
					}
					await this._waitForRetry(lastError, attempt, options);
				}
			}
			throw lastError;
		}
	}

	class OpenAICompatibleProviderAdapter {
		constructor(definition, transport) {
			this.id = definition.id;
			this.displayName = definition.displayName;
			this.defaultBaseURL = definition.defaultBaseURL;
			this.transport = transport;
			this.definition = definition;
		}

		listModels(options) {
			return this.transport.listModels(Object.assign({}, options, { provider: this.definition }));
		}

		testConnection(options) {
			return this.transport.testConnection(Object.assign({}, options, { provider: this.definition }));
		}

		streamChat(options) {
			return this.transport.streamChat(Object.assign({}, options, { provider: this.definition }));
		}
	}

	function createProviderRegistry(options) {
		options = options || {};
		var transport = options.transport || new OpenAICompatibleTransport(options);
		var adapters = {};
		for (var providerID of constants.PROVIDER_IDS) {
			adapters[providerID] = new OpenAICompatibleProviderAdapter(
				constants.PROVIDER_DEFINITIONS[providerID], transport
			);
		}
		return {
			transport,
			get: function (providerID) {
				if (!adapters[providerID]) {
					throw errors.createConfigurationError("unknown-provider");
				}
				return adapters[providerID];
			},
			list: function () {
				return Object.keys(adapters).map(providerID => adapters[providerID]);
			}
		};
	}

	var defaultRegistry = createProviderRegistry();

	function getProvider(providerID, registry) {
		return (registry || defaultRegistry).get(providerID);
	}

	async function resolveAPIKey(options) {
		if (options && typeof options.apiKey === "string" && options.apiKey.trim()) {
			return options.apiKey;
		}
		var store = options && options.credentialStore;
		if (!store) {
			store = modules.credentials;
		}
		if (store && typeof store.getKey === "function") {
			return store.getKey(options.provider);
		}
		if (store && typeof store.get === "function") {
			return store.get(options.provider);
		}
		throw errors.createCredentialError("missing-api-key");
	}

	async function listModels(options) {
		options = options || {};
		var provider = getProvider(options.provider);
		var apiKey = await resolveAPIKey(options);
		return provider.listModels(Object.assign({}, options, { apiKey }));
	}

	async function getCatalog(options) {
		var catalog = await listModels(options);
		return catalog && Array.isArray(catalog.models) ? catalog.models : catalog;
	}

	async function testConnection(options) {
		options = options || {};
		var provider = getProvider(options.provider);
		var apiKey = await resolveAPIKey(options);
		return provider.testConnection(Object.assign({}, options, { apiKey }));
	}

	async function streamChat(options) {
		options = options || {};
		var provider = getProvider(options.provider);
		var apiKey = await resolveAPIKey(options);
		return provider.streamChat(Object.assign({}, options, { apiKey }));
	}

	var providers = {
		OpenAICompatibleTransport,
		OpenAICompatibleProviderAdapter,
		ProviderAdapter: OpenAICompatibleProviderAdapter,
		createProviderRegistry,
		createDefaultProviders: createProviderRegistry,
		getProvider,
		providerFor: getProvider,
		listModels,
		getCatalog,
		testConnection,
		test: testConnection,
		streamChat,
		defaultRegistry,
		providerDefinitions: constants.PROVIDER_DEFINITIONS,
		normalizeMessages,
		contentToText,
		normalizeUsage,
		normalizeModelCatalog,
		normalizeCompletionResponse,
		extractChoiceText
	};

	modules.providers = providers;
	if (typeof module !== "undefined" && module.exports) {
		module.exports = providers;
	}
})(typeof globalThis !== "undefined" ? globalThis : this);
