(function (root) {
	"use strict";

	var modules = root.__AIZoteroModules || (root.__AIZoteroModules = {});
	var constants = modules.constants;
	if (!constants && typeof module !== "undefined" && module.exports && typeof require === "function") {
		constants = require("./constants.js");
	}

	function isPlainObject(value) {
		if (!value || Object.prototype.toString.call(value) !== "[object Object]") {
			return false;
		}
		var prototype = Object.getPrototypeOf(value);
		return prototype === Object.prototype || prototype === null;
	}

	function asNonEmptyString(value, fieldName, maxLength) {
		if (typeof value !== "string" || !value.trim()) {
			throw new TypeError((fieldName || "Value") + " must be a non-empty string");
		}
		var result = value.trim();
		if (maxLength && result.length > maxLength) {
			throw new RangeError((fieldName || "Value") + " is too long");
		}
		return result;
	}

	function safeString(value, maxLength) {
		if (typeof value !== "string") {
			return "";
		}
		var result = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
		return result.slice(0, maxLength || 240);
	}

	function safeNumber(value, fallback) {
		return typeof value === "number" && Number.isFinite(value) ? value : fallback;
	}

	function safeInteger(value, fallback, minimum, maximum) {
		if (!Number.isFinite(value)) {
			return fallback;
		}
		var integer = Math.round(value);
		if (minimum !== undefined) {
			integer = Math.max(minimum, integer);
		}
		if (maximum !== undefined) {
			integer = Math.min(maximum, integer);
		}
		return integer;
	}

	function clamp(value, minimum, maximum) {
		return Math.min(maximum, Math.max(minimum, value));
	}

	function now() {
		return Date.now();
	}

	function parseJSON(value) {
		if (typeof value !== "string") {
			return { ok: false, value: null };
		}
		try {
			return { ok: true, value: JSON.parse(value) };
		}
		catch (e) {
			return { ok: false, value: null };
		}
	}

	function normalizeBaseURL(value, fallback) {
		var candidate = value === undefined || value === null || value === "" ? fallback : value;
		candidate = asNonEmptyString(candidate, "Base URL", 2048);
		var URLConstructor = root.URL;
		if (typeof URLConstructor !== "function") {
			throw new TypeError("A URL implementation is required");
		}
		var parsed;
		try {
			parsed = new URLConstructor(candidate);
		}
		catch (e) {
			throw new TypeError("Base URL is invalid");
		}
		if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
			throw new TypeError("Base URL must use HTTP or HTTPS");
		}
		if (parsed.username || parsed.password || parsed.search || parsed.hash) {
			throw new TypeError("Base URL must not contain credentials, a query, or a fragment");
		}
		var pathname = parsed.pathname.replace(/\/+$/, "");
		return parsed.origin + pathname;
	}

	function joinURL(baseURL, path) {
		var base = normalizeBaseURL(baseURL);
		var suffix = asNonEmptyString(path, "Path", 2048).replace(/^\/+/, "");
		return base + "/" + suffix;
	}

	function getHeader(headers, name) {
		if (!headers) {
			return null;
		}
		if (typeof headers.get === "function") {
			return headers.get(name);
		}
		var lowerName = name.toLowerCase();
		for (var key of Object.keys(headers)) {
			if (key.toLowerCase() === lowerName) {
				return headers[key];
			}
		}
		return null;
	}

	function responseStatus(response) {
		return response && typeof response.status === "number" ? response.status : 0;
	}

	function responseIsOK(response) {
		if (!response) {
			return false;
		}
		if (typeof response.ok === "boolean") {
			return response.ok;
		}
		return responseStatus(response) >= 200 && responseStatus(response) < 300;
	}

	function parseRetryAfter(value, currentTime) {
		if (value === null || value === undefined || value === "") {
			return null;
		}
		var seconds = Number(value);
		if (Number.isFinite(seconds) && seconds >= 0) {
			return Math.round(seconds * 1000);
		}
		var timestamp = Date.parse(String(value));
		if (!Number.isFinite(timestamp)) {
			return null;
		}
		var referenceTime = currentTime === undefined ? now() : currentTime;
		return Math.max(0, timestamp - referenceTime);
	}

	function isTransientStatus(status) {
		return status === 408 || status === 429 || status === 502 || status === 503 || status === 504;
	}

	function isAbortError(error) {
		return !!error && (error.name === "AbortError" || error.code === "CANCELED");
	}

	function createAbortError() {
		var DOMExceptionConstructor = root.DOMException;
		if (typeof DOMExceptionConstructor === "function") {
			return new DOMExceptionConstructor("The operation was canceled", "AbortError");
		}
		var error = new Error("The operation was canceled");
		error.name = "AbortError";
		return error;
	}

	function throwIfAborted(signal) {
		if (signal && signal.aborted) {
			throw createAbortError();
		}
	}

	function getAbortController() {
		return typeof root.AbortController === "function" ? root.AbortController : null;
	}

	function createLinkedAbortController(signal) {
		var AbortControllerConstructor = getAbortController();
		if (!AbortControllerConstructor) {
			return {
				controller: null,
				signal: signal,
				cleanup: function () {}
			};
		}
		var controller = new AbortControllerConstructor();
		var onAbort = function () {
			try {
				controller.abort();
			}
			catch (e) {
				// Older AbortController implementations can throw on a second abort.
			}
		};
		if (signal) {
			if (signal.aborted) {
				onAbort();
			}
			else if (typeof signal.addEventListener === "function") {
				signal.addEventListener("abort", onAbort, { once: true });
			}
		}
		return {
			controller: controller,
			signal: controller.signal,
			cleanup: function () {
				if (signal && typeof signal.removeEventListener === "function") {
					signal.removeEventListener("abort", onAbort);
				}
			}
		};
	}

	function delay(milliseconds, signal, setTimeoutImplementation, clearTimeoutImplementation) {
		var delayMs = Math.max(0, Number(milliseconds) || 0);
		if (!delayMs) {
			throwIfAborted(signal);
			return Promise.resolve();
		}
		var setTimeoutFunction = setTimeoutImplementation || root.setTimeout || setTimeout;
		var clearTimeoutFunction = clearTimeoutImplementation || root.clearTimeout || clearTimeout;
		return new Promise(function (resolve, reject) {
			var settled = false;
			var timer = setTimeoutFunction(finish, delayMs);
			var onAbort = function () {
				if (settled) {
					return;
				}
				settled = true;
				clearTimeoutFunction(timer);
				if (signal && typeof signal.removeEventListener === "function") {
					signal.removeEventListener("abort", onAbort);
				}
				reject(createAbortError());
			};
			function finish() {
				if (settled) {
					return;
				}
				settled = true;
				if (signal && typeof signal.removeEventListener === "function") {
					signal.removeEventListener("abort", onAbort);
				}
				if (signal && signal.aborted) {
					reject(createAbortError());
				}
				else {
					resolve();
				}
			}
			if (signal) {
				if (signal.aborted) {
					onAbort();
				}
				else if (typeof signal.addEventListener === "function") {
					signal.addEventListener("abort", onAbort, { once: true });
				}
			}
		});
	}

	function getFetch(fetchImplementation) {
		if (typeof fetchImplementation === "function") {
			return fetchImplementation;
		}
		if (root && typeof root.fetch === "function") {
			return root.fetch.bind(root);
		}
		if (typeof fetch === "function") {
			return fetch;
		}
		return null;
	}

	function toUint8Array(value) {
		if (typeof value === "string") {
			return value;
		}
		if (value instanceof ArrayBuffer) {
			return new Uint8Array(value);
		}
		if (ArrayBuffer.isView(value)) {
			return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
		}
		return value;
	}

	function createTextDecoder() {
		if (typeof root.TextDecoder === "function") {
			return new root.TextDecoder("utf-8", { fatal: false });
		}
		return null;
	}

	function normalizeModelID(value) {
		if (typeof value !== "string") {
			return null;
		}
		var result = safeString(value, 256);
		return result || null;
	}

	function dedupeStrings(values) {
		var result = [];
		var seen = new Set();
		for (var value of values || []) {
			var normalized = normalizeModelID(value);
			if (normalized && !seen.has(normalized)) {
				seen.add(normalized);
				result.push(normalized);
			}
		}
		return result;
	}

	function isSecretField(name) {
		var fieldName = String(name);
		return /(?:api[-_ ]?key|authorization|password|secret|credential|private[-_ ]?key)/i.test(fieldName)
			|| /(?:access[-_ ]?token|refresh[-_ ]?token)/i.test(fieldName);
	}

	function isSafePreferenceKey(name) {
		return typeof name === "string" && !isSecretField(name);
	}

	var utils = {
		isPlainObject,
		asNonEmptyString,
		safeString,
		safeNumber,
		safeInteger,
		clamp,
		now,
		parseJSON,
		normalizeBaseURL,
		joinURL,
		getHeader,
		responseStatus,
		responseIsOK,
		parseRetryAfter,
		isTransientStatus,
		isAbortError,
		createAbortError,
		throwIfAborted,
		getAbortController,
		createLinkedAbortController,
		delay,
		getFetch,
		toUint8Array,
		createTextDecoder,
		normalizeModelID,
		dedupeStrings,
		isSecretField,
		isSafePreferenceKey,
		constants
	};

	modules.utils = utils;
	if (typeof module !== "undefined" && module.exports) {
		module.exports = utils;
	}
})(typeof globalThis !== "undefined" ? globalThis : this);
