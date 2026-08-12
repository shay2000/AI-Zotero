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

	function findLineEnding(value) {
		for (var index = 0; index < value.length; index++) {
			if (value[index] === "\n") {
				return { index, length: 1 };
			}
			if (value[index] === "\r") {
				if (index + 1 === value.length) {
					return null;
				}
				return { index, length: value[index + 1] === "\n" ? 2 : 1 };
			}
		}
		return null;
	}

	class SSEParser {
		constructor(options) {
			options = options || {};
			this._decoder = options.decoder || (utils && utils.createTextDecoder ? utils.createTextDecoder() : null);
			this._lineBuffer = "";
			this._dataLines = [];
			this._eventName = "";
			this._lastEventID = "";
			this._retry = undefined;
		}

		feed(chunk) {
			if (chunk === undefined || chunk === null) {
				return [];
			}
			var text;
			if (typeof chunk === "string") {
				text = chunk;
			}
			else if (this._decoder) {
				var bytes = utils && utils.toUint8Array ? utils.toUint8Array(chunk) : chunk;
				text = this._decoder.decode(bytes, { stream: true });
			}
			else {
				throw errors.createMalformedResponseError({ reason: "utf8-decoder-unavailable" });
			}
			return this._consumeText(text);
		}

		flush() {
			var events = [];
			if (this._decoder) {
				var tail = this._decoder.decode();
				if (tail) {
					events = events.concat(this._consumeText(tail));
				}
			}
			if (this._lineBuffer) {
				var finalLine = this._lineBuffer.endsWith("\r")
					? this._lineBuffer.slice(0, -1) : this._lineBuffer;
				events = events.concat(this._processLine(finalLine));
				this._lineBuffer = "";
			}
			var finalEvent = this._dispatchEvent();
			if (finalEvent) {
				events.push(finalEvent);
			}
			return events;
		}

		_consumeText(text) {
			if (!text) {
				return [];
			}
			this._lineBuffer += text;
			var events = [];
			while (this._lineBuffer) {
				var ending = findLineEnding(this._lineBuffer);
				if (!ending) {
					break;
				}
				var line = this._lineBuffer.slice(0, ending.index);
				this._lineBuffer = this._lineBuffer.slice(ending.index + ending.length);
				events = events.concat(this._processLine(line));
			}
			return events;
		}

		_processLine(line) {
			if (line === "") {
				var event = this._dispatchEvent();
				return event ? [event] : [];
			}
			if (line[0] === ":") {
				// SSE comments are provider keep-alives and must not reach callers.
				return [];
			}
			var separator = line.indexOf(":");
			var field = separator === -1 ? line : line.slice(0, separator);
			var value = separator === -1 ? "" : line.slice(separator + 1);
			if (value[0] === " ") {
				value = value.slice(1);
			}
			switch (field) {
				case "data":
					this._dataLines.push(value);
					break;
				case "event":
					this._eventName = value;
					break;
				case "id":
					if (!value.includes("\u0000")) {
						this._lastEventID = value;
					}
					break;
				case "retry":
					if (/^\d+$/.test(value)) {
						this._retry = Number(value);
					}
					break;
				default:
					break;
			}
			return [];
		}

		_dispatchEvent() {
			if (!this._dataLines.length) {
				this._eventName = "";
				this._retry = undefined;
				return null;
			}
			var event = {
				event: this._eventName || "message",
				data: this._dataLines.join("\n"),
				id: this._lastEventID || undefined,
				retry: this._retry
			};
			this._dataLines = [];
			this._eventName = "";
			this._retry = undefined;
			return event;
		}
	}

	function parseSSEData(data) {
		if (typeof data !== "string") {
			return { isDone: false, isJSON: false, value: null };
		}
		if (data.trim() === (constants && constants.SSE_DONE || "[DONE]")) {
			return { isDone: true, isJSON: false, value: null };
		}
		var parsed = utils.parseJSON(data);
		return {
			isDone: false,
			isJSON: parsed.ok,
			value: parsed.ok ? parsed.value : null
		};
	}

	function readWithControls(reader, options) {
		var signal = options.signal;
		var timeoutMs = options.inactivityTimeoutMs;
		utils.throwIfAborted(signal);
		return new Promise(function (resolve, reject) {
			var settled = false;
			var timer;
			var setTimeoutFunction = options.setTimeout || root.setTimeout || setTimeout;
			var clearTimeoutFunction = options.clearTimeout || root.clearTimeout || clearTimeout;

			function cleanup() {
				if (timer !== undefined) {
					clearTimeoutFunction(timer);
				}
				if (signal && typeof signal.removeEventListener === "function") {
					signal.removeEventListener("abort", onAbort);
				}
			}

			function finish(callback, value) {
				if (settled) {
					return;
				}
				settled = true;
				cleanup();
				callback(value);
			}

			function cancelReader() {
				try {
					var cancellation = reader.cancel();
					if (cancellation && typeof cancellation.catch === "function") {
						cancellation.catch(() => {});
					}
				}
				catch (e) {
					// The read promise is already being rejected.
				}
			}

			function onAbort() {
				cancelReader();
				finish(reject, errors.createNetworkError(null, {
					canceled: true,
					operation: options.operation,
					provider: options.provider,
					model: options.model
				}));
			}

			if (signal) {
				if (signal.aborted) {
					onAbort();
					return;
				}
				if (typeof signal.addEventListener === "function") {
					signal.addEventListener("abort", onAbort, { once: true });
				}
			}
			if (timeoutMs > 0) {
				timer = setTimeoutFunction(function () {
					if (settled) {
						return;
					}
					cancelReader();
					finish(reject, errors.createNetworkError(null, {
						timedOut: true,
						operation: options.operation,
						provider: options.provider,
						model: options.model
					}));
				}, timeoutMs);
			}
			var readResult;
			try {
				readResult = reader.read();
			}
			catch (e) {
				finish(reject, e);
				return;
			}
			Promise.resolve(readResult).then(
				value => finish(resolve, value),
				error => finish(reject, error)
			);
		});
	}

	async function consumeSSE(response, options) {
		options = options || {};
		if (!response || !response.body || typeof response.body.getReader !== "function") {
			throw errors.createMalformedResponseError({
				provider: options.provider,
				operation: options.operation,
				model: options.model,
				reason: "stream-body-unavailable"
			});
		}
		var reader = response.body.getReader();
		var parser = options.parser || new SSEParser(options);
		var eventCount = 0;
		var sawDone = false;
		var stopped = false;
		var processEvents = async function (events) {
			for (var event of events) {
				eventCount++;
				var parsed = parseSSEData(event.data);
				if (parsed.isDone) {
					sawDone = true;
					if (typeof options.onDone === "function") {
						await options.onDone(event);
					}
					break;
				}
				if (parsed.isJSON && parsed.value && typeof parsed.value === "object"
						&& parsed.value.error && options.rejectTypedErrors !== false) {
					throw errors.createProviderError({
						provider: options.provider,
						operation: options.operation,
						model: options.model,
						payload: parsed.value,
						status: parsed.value.error && parsed.value.error.status
					});
				}
				if (typeof options.onEvent === "function") {
					var result = await options.onEvent(event, parsed);
					if (result === false) {
						stopped = true;
						break;
					}
				}
			}
		};

		try {
			while (!sawDone && !stopped) {
				var result = await readWithControls(reader, {
					signal: options.signal,
					inactivityTimeoutMs: options.inactivityTimeoutMs === undefined
						? constants.DEFAULT_INACTIVITY_TIMEOUT_MS : options.inactivityTimeoutMs,
					setTimeout: options.setTimeout,
					clearTimeout: options.clearTimeout,
					provider: options.provider,
					operation: options.operation,
					model: options.model
				});
				if (result.done) {
					break;
				}
				await processEvents(parser.feed(result.value));
			}
			if (!sawDone && !stopped) {
				await processEvents(parser.flush());
			}
			return { done: sawDone, stopped, eventCount };
		}
		catch (error) {
			if (error instanceof errors.AIZoteroError) {
				throw error;
			}
			throw errors.createNetworkError(error, {
				provider: options.provider,
				operation: options.operation,
				model: options.model,
				canceled: utils.isAbortError(error)
			});
		}
		finally {
			try {
				var cancellation = reader.cancel();
				if (cancellation && typeof cancellation.catch === "function") {
					cancellation.catch(() => {});
				}
			}
			catch (e) {
				// The stream is already closed.
			}
			if (typeof reader.releaseLock === "function") {
				try {
					reader.releaseLock();
				}
				catch (e) {
					// A provider-specific reader may not support releasing its lock.
				}
			}
		}
	}

	function parseSSE(text, options) {
		var parser = new SSEParser(options);
		var events = parser.feed(text);
		return events.concat(parser.flush());
	}

	var sse = {
		SSEParser,
		parseSSEData,
		parseSSE,
		consumeSSE,
		parseStream: consumeSSE
	};

	modules.sse = sse;
	if (typeof module !== "undefined" && module.exports) {
		module.exports = sse;
	}
})(typeof globalThis !== "undefined" ? globalThis : this);
