#!/usr/bin/env node
/**
 * nvim-aware MCP server.
 *
 * A tiny, dependency-free JSON-RPC 2.0 server over stdio (newline-delimited
 * messages) that exposes a single `nvim_context` tool. It is the Claude Code
 * analog of nvim-aware-pi's `registerTool("nvim_context")`.
 *
 * Claude sees the tool as `mcp__nvim-aware__nvim_context`.
 */
import { getExplicitServer } from "../lib/config.mjs";
import { resolveServer } from "../lib/discover.mjs";
import { errorToMessage, readEnvMs } from "../lib/proc.mjs";
import {
	DEFAULT_MAX_BUFFERS,
	DEFAULT_MAX_QUICKFIX_ITEMS,
	DEFAULT_MAX_SELECTION_BYTES,
	DEFAULT_SURROUNDING_LINES,
	getCachedNvimSnapshot,
} from "../lib/snapshot.mjs";
import { formatSnapshot } from "../lib/format.mjs";
import { DEFAULT_SNAPSHOT_CACHE_TTL_MS } from "../lib/config.mjs";

const SERVER_INFO = { name: "nvim-aware", version: "0.1.0" };
const PROTOCOL_VERSION = "2024-11-05";

const TOOL = {
	name: "nvim_context",
	description:
		"Get live context from the connected Neovim instance: current file, cursor, selection, search register, quickfix list, windows, and listed buffers. " +
		"Use it when the user refers to the current Neovim file, cursor, visual selection, quickfix list, errors/warnings, open buffers, current search, or says things like 'this code' without naming a path. " +
		"When the result includes absolute paths, prefer those exact paths with read/edit/write tools instead of guessing.",
	inputSchema: {
		type: "object",
		properties: {
			includeSurroundingLines: {
				type: "boolean",
				description: "Include a small snippet around the cursor. Defaults to true.",
			},
			maxSelectionBytes: {
				type: "number",
				description: "Maximum bytes of selected text to return. Defaults to 4000.",
			},
			maxBuffers: {
				type: "number",
				description: "Maximum listed buffers to return. Defaults to 30.",
			},
			maxQuickfixItems: {
				type: "number",
				description: "Maximum quickfix items to return. Defaults to 30.",
			},
		},
		additionalProperties: false,
	},
};

// Remember the resolved server across calls; clear it if a call fails.
let choice = null;

async function ensureServer() {
	if (choice) return choice;
	const explicit = getExplicitServer();
	const resolved = await resolveServer({ explicit, cwd: process.cwd() });
	choice = resolved.server;
	return choice;
}

async function runNvimContext(params = {}) {
	const options = {
		surroundingLines: params.includeSurroundingLines === false ? 0 : DEFAULT_SURROUNDING_LINES,
		maxSelectionBytes: params.maxSelectionBytes ?? DEFAULT_MAX_SELECTION_BYTES,
		maxBuffers: params.maxBuffers ?? DEFAULT_MAX_BUFFERS,
		maxQuickfixItems: params.maxQuickfixItems ?? DEFAULT_MAX_QUICKFIX_ITEMS,
	};
	const ttlMs = readEnvMs("NVIM_AWARE_SNAPSHOT_TTL_MS", DEFAULT_SNAPSHOT_CACHE_TTL_MS);

	try {
		const server = await ensureServer();
		const snapshot = await getCachedNvimSnapshot(server, options, { ttlMs });
		const text = formatSnapshot(snapshot, { compact: false }).join("\n");
		return { content: [{ type: "text", text }] };
	} catch (error) {
		choice = null; // force re-resolution next time
		return { content: [{ type: "text", text: `Neovim context unavailable: ${errorToMessage(error)}` }], isError: true };
	}
}

async function handleRequest(method, params) {
	switch (method) {
		case "initialize":
			return {
				protocolVersion: typeof params?.protocolVersion === "string" ? params.protocolVersion : PROTOCOL_VERSION,
				capabilities: { tools: {} },
				serverInfo: SERVER_INFO,
			};
		case "ping":
			return {};
		case "tools/list":
			return { tools: [TOOL] };
		case "tools/call": {
			if (params?.name !== TOOL.name) {
				throw rpcError(-32602, `Unknown tool: ${params?.name}`);
			}
			return runNvimContext(params?.arguments ?? {});
		}
		default:
			throw rpcError(-32601, `Method not found: ${method}`);
	}
}

function rpcError(code, message) {
	const error = new Error(message);
	error.rpcCode = code;
	return error;
}

function send(message) {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function dispatch(message) {
	const { id, method, params } = message ?? {};
	const isNotification = id === undefined || id === null;

	if (typeof method !== "string") {
		if (!isNotification) {
			send({ jsonrpc: "2.0", id, error: { code: -32600, message: "Invalid Request" } });
		}
		return;
	}

	// Notifications (e.g. notifications/initialized) get no response.
	if (isNotification) {
		return;
	}

	try {
		const result = await handleRequest(method, params);
		send({ jsonrpc: "2.0", id, result });
	} catch (error) {
		send({
			jsonrpc: "2.0",
			id,
			error: { code: error?.rpcCode ?? -32603, message: errorToMessage(error) },
		});
	}
}

function main() {
	let buffer = "";
	let pending = 0;
	let stdinEnded = false;

	// Exit only once stdin has closed AND every in-flight request has been answered,
	// so async tool calls are never cut off mid-flight.
	const maybeExit = () => {
		if (stdinEnded && pending === 0) process.exit(0);
	};
	const track = (message) => {
		pending++;
		Promise.resolve()
			.then(() => dispatch(message))
			.catch(() => {})
			.finally(() => {
				pending--;
				maybeExit();
			});
	};

	process.stdin.setEncoding("utf8");
	process.stdin.on("data", (chunk) => {
		buffer += chunk;
		let newlineIndex;
		while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
			const line = buffer.slice(0, newlineIndex).trim();
			buffer = buffer.slice(newlineIndex + 1);
			if (!line) continue;
			let message;
			try {
				message = JSON.parse(line);
			} catch {
				send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
				continue;
			}
			if (Array.isArray(message)) {
				for (const item of message) track(item);
			} else {
				track(message);
			}
		}
	});
	process.stdin.on("end", () => {
		stdinEnded = true;
		maybeExit();
	});
}

main();
