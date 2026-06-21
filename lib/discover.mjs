/**
 * Neovim server discovery + selection.
 * Ported from nvim-aware-pi (bin/pi-nvim discovery + extension resolveServer).
 *
 * Candidate sources, in order:
 *   explicit address  ->  $NVIM  ->  $NVIM_LISTEN_ADDRESS  ->  serverlist()
 *   ->  (fallback) socket-file scan of $XDG_RUNTIME_DIR / $TMPDIR / /tmp
 */
import { lstat, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	errorToMessage,
	isInside,
	mapWithConcurrency,
	parseFirstJsonObject,
	runProcess,
	uniqueExistingRealpaths,
	uniqueStrings,
} from "./proc.mjs";
import { getNvimServerSummary } from "./snapshot.mjs";

const PROBE_CONCURRENCY = 4;
const DEFAULT_PROBE_TIMEOUT_MS = 1200;

/** Ask a throwaway headless Neovim for the list of running servers. */
export async function listServersFromNvim() {
	try {
		const result = await runProcess(
			"nvim",
			[
				"--headless",
				"--clean",
				"-n",
				"+echo json_encode({'self': v:servername, 'servers': serverlist()})",
				"+qa",
			],
			{ timeoutMs: 1500 },
		);
		const parsed = parseFirstJsonObject(result.stdout + result.stderr);
		if (!parsed?.servers || !Array.isArray(parsed.servers)) return [];
		return parsed.servers.filter((server) => typeof server === "string" && server && server !== parsed.self);
	} catch {
		return [];
	}
}

/** Scan likely runtime directories for Neovim-looking unix sockets. */
export async function scanNvimSocketFiles() {
	if (process.platform === "win32") return [];

	const roots = uniqueExistingRealpaths([process.env.XDG_RUNTIME_DIR, process.env.TMPDIR, tmpdir(), "/tmp"]);
	const sockets = [];
	const seen = new Set();
	const maxSockets = 3000;

	const addSocket = (path) => {
		if (seen.has(path)) return;
		seen.add(path);
		sockets.push(path);
	};

	const walk = async (dir, depth, inNvimishDir) => {
		if (depth < 0 || sockets.length >= maxSockets) return;

		let entries;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}

		for (const entry of entries) {
			if (sockets.length >= maxSockets) return;

			const path = join(dir, entry.name);
			const pathLower = path.toLowerCase();
			const nameIsNvimish = entry.name.toLowerCase().includes("nvim");
			const pathIsNvimish = inNvimishDir || nameIsNvimish || pathLower.includes("nvim");

			if (entry.isSocket?.()) {
				if (pathIsNvimish) addSocket(path);
				continue;
			}

			if (!entry.isDirectory()) {
				if (!pathIsNvimish) continue;
				try {
					if ((await lstat(path)).isSocket()) addSocket(path);
				} catch {
					// Ignore entries that disappeared or cannot be inspected.
				}
				continue;
			}

			if (depth === 0) continue;
			if (pathIsNvimish) {
				await walk(path, depth - 1, true);
			}
		}
	};

	for (const root of roots) {
		await walk(root, 5, false);
	}

	return sockets;
}

/** Fast candidate addresses (no socket scan). */
export async function fastCandidates(explicit) {
	if (explicit) return [explicit];
	return uniqueStrings([
		process.env.NVIM,
		process.env.NVIM_LISTEN_ADDRESS,
		...(await listServersFromNvim()),
	]);
}

/** Probe a list of servers for their summaries, with bounded concurrency. */
export async function probeSummaries(candidates, options = {}) {
	const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
	return mapWithConcurrency(candidates, PROBE_CONCURRENCY, async (server) => {
		try {
			return { server, summary: await getNvimServerSummary(server, { timeoutMs }) };
		} catch (error) {
			return { server, error: errorToMessage(error) };
		}
	});
}

/** Pick the server most relevant to `cwd`: exact cwd, then file proximity, then containment. */
export function chooseBestNvimServer(items, cwd) {
	const best = items.find((item) => item.cwd === cwd) ??
		items.find((item) => isInside(cwd, item.currentFile)) ??
		items.find((item) => isInside(item.cwd, cwd)) ??
		items[0];
	if (!best) throw new Error("No Neovim server candidates responded");
	return best;
}

/**
 * Collect summaries for every responding server.
 * Tries fast candidates first, falling back to a socket scan when nothing responds.
 * Returns { summaries, failures, candidateCount }.
 */
export async function collectServerSummaries(options = {}) {
	const explicit = options.explicit;
	const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;

	const fast = await fastCandidates(explicit);
	let results = fast.length > 0 ? await probeSummaries(fast, { timeoutMs }) : [];
	let summaries = results.flatMap((r) => (r.summary ? [r.summary] : []));

	if (!explicit && summaries.length === 0) {
		const scanned = uniqueStrings((await scanNvimSocketFiles()).filter((s) => !fast.includes(s)));
		if (scanned.length > 0) {
			results = [...results, ...(await probeSummaries(scanned, { timeoutMs }))];
			summaries = results.flatMap((r) => (r.summary ? [r.summary] : []));
		}
	}

	const failures = results.flatMap((r) => (r.error ? [`${r.server}: ${r.error}`] : []));
	return { summaries, failures, candidateCount: summaries.length };
}

/**
 * Resolve the single best server for a given cwd (non-interactive).
 * Throws a descriptive error when no server is found / responds.
 */
export async function resolveServer(options = {}) {
	const explicit = options.explicit;
	const cwd = options.cwd ?? process.cwd();

	const { summaries, failures, candidateCount } = await collectServerSummaries({
		explicit,
		timeoutMs: options.timeoutMs,
	});

	if (summaries.length === 0) {
		if (failures.length > 0) {
			throw new Error(`Found Neovim server candidates, but none responded. ${failures.join("; ")}`);
		}
		throw new Error(
			"No Neovim server found. Start Neovim normally, or run `nvim --listen /tmp/nvim-main` and set NVIM_AWARE_SERVER=/tmp/nvim-main.",
		);
	}

	const best = chooseBestNvimServer(summaries, cwd);
	return { server: best.server, summary: best, candidateCount };
}
