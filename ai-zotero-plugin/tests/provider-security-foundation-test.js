/* global describe, it, assert */

"use strict";

describe("AI for Zotero provider and security foundation", function () {
	function modules() {
		return globalThis.__AIZoteroModules;
	}

	function jsonResponse(value, status = 200, headers = {}) {
		return {
			status,
			ok: status >= 200 && status < 300,
			headers: {
				get(name) {
					return headers[name.toLowerCase()] || null;
				},
			},
			text: async () => JSON.stringify(value),
		};
	}

	function streamResponse(chunks, status = 200, headers = {}) {
		let index = 0;
		let canceled = false;
		return {
			status,
			ok: status >= 200 && status < 300,
			headers: {
				get(name) {
					return headers[name.toLowerCase()] || null;
				},
			},
			body: {
				getReader() {
					return {
						read() {
							if (canceled || index >= chunks.length) {
								return Promise.resolve({ done: true, value: undefined });
							}
							return Promise.resolve({ done: false, value: chunks[index++] });
						},
						cancel() {
							canceled = true;
							return Promise.resolve();
						},
						releaseLock() {},
					};
				},
			},
		};
	}

	it("registers every foundation module on the bootstrapped global registry", function () {
		let registry = modules();
		assert.isObject(registry);
		for (let name of ["constants", "utils", "errors", "sse", "providers", "credentials", "settings"]) {
			assert.isObject(registry[name], `${name} was not registered`);
		}
	});

	it("uses provider endpoints and keeps OpenRouter headers provider-specific", async function () {
		let { providers } = modules();
		let calls = [];
		let transport = new providers.OpenAICompatibleTransport({
			fetchImpl: async (url, init) => {
				calls.push({ url, init });
				return jsonResponse({ data: [{ id: "model-a" }] });
			},
			maxAttempts: 1,
		});
		let registry = providers.createProviderRegistry({ transport });
		let catalog = await registry.get("openrouter").listModels({
			apiKey: ["unit", "fixture"].join("-"),
		});
		assert.deepEqual(catalog.modelIDs, ["model-a"]);
		assert.equal(calls[0].url, "https://openrouter.ai/api/v1/models");
		assert.equal(calls[0].init.headers.Authorization, ["Bearer", ["unit", "fixture"].join("-")].join(" "));
		assert.equal(calls[0].init.headers["HTTP-Referer"], "https://www.zotero.org");
		assert.equal(calls[0].init.headers["X-Title"], "AI for Zotero");
	});

	it("parses fragmented UTF-8-compatible SSE, comments, multiline data, and DONE", function () {
		let registry = modules();
		let parser = new registry.sse.SSEParser();
		let events = [];
		for (let chunk of [": keep\r\n\r", "\ndata: first\r\ndata: second\n\n", "data: [DONE]\n\n"]) {
			events.push(...parser.feed(chunk));
		}
		assert.deepEqual(events.map(event => event.data), ["first\nsecond", "[DONE]"]);
		assert.isTrue(registry.sse.parseSSEData(events[1].data).isDone);
	});

	it("streams string and content-array deltas, usage, and generation IDs", async function () {
		let { providers } = modules();
		let transport = new providers.OpenAICompatibleTransport({
			fetchImpl: async () => streamResponse([
				": keep-alive\n\n",
				"data: {\"id\":\"generation-1\",\"choices\":[{\"delta\":{\"content\":\"Hel\"}}]}\n\n",
				"data: {\"choices\":[{\"delta\":{\"content\":[{\"type\":\"text\",\"text\":\"lo\"}]}}],"
					+ "\"usage\":{\"total_tokens\":3}}\n\n",
				"data: [DONE]\n\n",
			]),
			maxAttempts: 1,
		});
		let deltas = [];
		let result = await transport.streamChat({
			provider: "mistral",
			apiKey: ["stream", "fixture"].join("-"),
			model: "model-a",
			messages: [{ role: "user", content: "fixture" }],
			onDelta: delta => deltas.push(delta),
			inactivityTimeoutMs: 1000,
		});
		assert.equal(result.text, "Hello");
		assert.deepEqual(deltas, ["Hel", "lo"]);
		assert.equal(result.generationId, "generation-1");
		assert.equal(result.usage.total_tokens, 3);
		assert.isTrue(result.completed);
	});

	it("maps typed mid-stream errors and preserves partial output without diagnostics leakage", async function () {
		let { providers, errors } = modules();
		let transport = new providers.OpenAICompatibleTransport({
			fetchImpl: async () => streamResponse([
				"data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n",
				"data: {\"error\":{\"code\":\"insufficient_quota\",\"message\":\"provider detail\"}}\n\n",
			]),
			maxAttempts: 1,
		});
		let caught;
		try {
			await transport.streamChat({
				provider: "openrouter",
				apiKey: ["error", "fixture"].join("-"),
				model: "model-a",
				messages: [{ role: "user", content: "fixture" }],
				inactivityTimeoutMs: 1000,
			});
		}
		catch (error) {
			caught = error;
		}
		assert.equal(caught.code, errors.ERROR_CODES.INSUFFICIENT_CREDITS);
		assert.equal(caught.partialText, "partial");
		assert.notInclude(JSON.stringify(caught.toDiagnostic()), "provider detail");
	});

	it("retries transient pre-output failures and honors a zero Retry-After", async function () {
		let { providers } = modules();
		let calls = 0;
		let waits = [];
		let transport = new providers.OpenAICompatibleTransport({
			fetchImpl: async () => {
				calls++;
				if (calls === 1) {
					return jsonResponse({ error: { code: "temporarily_unavailable" } }, 503, { "retry-after": "0" });
				}
				return streamResponse(["data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\n", "data: [DONE]\n\n"]);
			},
			sleep: async milliseconds => waits.push(milliseconds),
			maxAttempts: 3,
		});
		let result = await transport.streamChat({
			provider: "agentrouter",
			apiKey: ["retry", "fixture"].join("-"),
			model: "model-a",
			messages: [{ role: "user", content: "fixture" }],
			inactivityTimeoutMs: 1000,
		});
		assert.equal(result.text, "ok");
		assert.equal(calls, 2);
		assert.deepEqual(waits, [0]);
	});

	it("distinguishes caller cancellation from an inactivity timeout", async function () {
		let { providers, errors } = modules();
		function pendingResponse() {
			return {
				status: 200,
				ok: true,
				headers: { get: () => null },
				body: {
					getReader() {
						return {
							read: () => new Promise(() => {}),
							cancel: () => Promise.resolve(),
							releaseLock() {},
						};
					},
				},
			};
		}
		let transport = new providers.OpenAICompatibleTransport({
			fetchImpl: async () => pendingResponse(),
			maxAttempts: 1,
		});
		let controller = new AbortController();
		let canceled;
		let request = transport.streamChat({
			provider: "mistral",
			apiKey: ["cancel", "fixture"].join("-"),
			model: "model-a",
			messages: [{ role: "user", content: "fixture" }],
			signal: controller.signal,
			inactivityTimeoutMs: 1000,
		});
		controller.abort();
		try {
			await request;
		}
		catch (error) {
			canceled = error;
		}
		assert.equal(canceled.code, errors.ERROR_CODES.CANCELED);

		let timedOut;
		try {
			await transport.streamChat({
				provider: "mistral",
				apiKey: ["timeout", "fixture"].join("-"),
				model: "model-a",
				messages: [{ role: "user", content: "fixture" }],
				inactivityTimeoutMs: 5,
			});
		}
		catch (error) {
			timedOut = error;
		}
		assert.equal(timedOut.code, errors.ERROR_CODES.TIMEOUT);
	});

	it("uses async Login Manager APIs with a separate realm per provider", async function () {
		let { credentials } = modules();
		let records = [];
		let loginManager = {
			async searchLoginsAsync(query) {
				return records.filter(record => record.origin === query.origin && record.httpRealm === query.httpRealm);
			},
			async addLoginAsync(login) {
				records.push(login);
			},
			async modifyLoginAsync(oldLogin, replacement) {
				records[records.indexOf(oldLogin)] = replacement;
			},
			async removeLoginAsync(login) {
				records = records.filter(record => record !== login);
			},
		};
		let store = new credentials.CredentialStore({
			loginManager,
			loginInfoFactory: options => ({ ...options, httpRealm: options.realm }),
		});
		await store.save("mistral", ["async", "fixture"].join("-"));
		assert.isTrue(await store.has("mistral"));
		assert.equal(await store.masked("mistral"), "••••••••ture");
		assert.equal(records[0].realm, credentials.realmForProvider("mistral"));
		assert.notEqual(records[0].realm, credentials.realmForProvider("openrouter"));
		await store.remove("mistral");
		assert.isFalse(await store.has("mistral"));
	});

	it("keeps settings and model cache non-secret with 24-hour freshness", function () {
		let { settings } = modules();
		let now = 100000;
		let prefs = new settings.MemoryPreferences();
		let store = new settings.SettingsStore({ prefs, now: () => now });
		store.setMany({ defaultProvider: "agentrouter", defaultModel: "model-a", crossCheckMaxPDFs: 100 });
		assert.equal(store.get("defaultProvider"), "agentrouter");
		store.saveModelCatalog("agentrouter", { models: [{ id: "model-a" }], fetchedAt: now });
		assert.isTrue(store.isModelCacheFresh("agentrouter"));
		now += 24 * 60 * 60 * 1000 + 1;
		assert.isNull(store.getCachedModelCatalog("agentrouter"));
		assert.isTrue(store.getCachedModelCatalog("agentrouter", { allowStale: true }).stale);
		assert.throws(() => store.setMany({ apiKey: "should-not-be-stored" }));
		assert.notInclude(JSON.stringify(prefs.values), "should-not-be-stored");
	});
});
