/**
 * Low-level process + utility helpers shared by the engine.
 * Ported from nvim-aware-pi (bin/pi-nvim, extensions/nvim-aware-pi.ts).
 * Zero dependencies — Node built-ins only.
 */
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { relative } from "node:path";

export const DEFAULT_TIMEOUT_MS = 2000;

/**
 * Run a command, capturing stdout/stderr with a hard timeout.
 * Resolves with { stdout, stderr, code } or rejects on spawn error / timeout.
 */
export function runProcess(command, args, options = {}) {
	return new Promise((resolveProcess, reject) => {
		const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
		const stdout = [];
		const stderr = [];
		let settled = false;

		const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		const timer = timeout > 0
			? setTimeout(() => {
					if (settled) return;
					settled = true;
					child.kill("SIGTERM");
					reject(new Error(`${command} timed out after ${timeout}ms`));
				}, timeout)
			: undefined;

		child.stdout.on("data", (chunk) => stdout.push(chunk));
		child.stderr.on("data", (chunk) => stderr.push(chunk));
		child.on("error", (error) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			reject(error);
		});
		child.on("close", (code) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			resolveProcess({
				stdout: Buffer.concat(stdout).toString("utf8"),
				stderr: Buffer.concat(stderr).toString("utf8"),
				code,
			});
		});
	});
}

/** Map over items with a bounded number of concurrent workers, preserving order. */
export async function mapWithConcurrency(items, concurrency, mapper) {
	const results = new Array(items.length);
	let nextIndex = 0;
	const workerCount = Math.min(Math.max(1, concurrency), items.length);

	await Promise.all(
		Array.from({ length: workerCount }, async () => {
			while (nextIndex < items.length) {
				const index = nextIndex++;
				results[index] = await mapper(items[index], index);
			}
		}),
	);

	return results;
}

/** Extract the first balanced { ... } JSON object from noisy output. */
export function parseFirstJsonObject(text) {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start === -1 || end === -1 || end <= start) return null;
	try {
		return JSON.parse(text.slice(start, end + 1));
	} catch {
		return null;
	}
}

/** Trim, drop empties, and de-duplicate a list of strings. */
export function uniqueStrings(values) {
	return [...new Set(values.map((value) => value?.trim()).filter((value) => Boolean(value)))];
}

/** De-duplicate paths by their realpath, keeping the original (existing) value. */
export function uniqueExistingRealpaths(values) {
	const roots = [];
	const seen = new Set();
	for (const value of uniqueStrings(values)) {
		const real = safeRealpath(value);
		if (seen.has(real)) continue;
		seen.add(real);
		roots.push(value);
	}
	return roots;
}

/** True when `child` is `parent` or lives inside it. */
export function isInside(parent, child) {
	if (!parent || !child) return false;
	const rel = relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"));
}

/** Quote a string for use inside a Vim single-quoted string (doubling quotes). */
export function vimSingleQuoted(value) {
	return `'${value.replaceAll("'", "''")}'`;
}

export function safeRealpath(path) {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

export function errorToMessage(error) {
	return error instanceof Error ? error.message : String(error);
}

/** Read a non-negative millisecond value from an env var, falling back if unset/invalid. */
export function readEnvMs(name, fallback) {
	const raw = process.env[name];
	if (!raw) return fallback;
	const value = Number(raw);
	return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function asNonEmptyString(value) {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
