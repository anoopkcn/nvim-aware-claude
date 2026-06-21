#!/usr/bin/env node
/**
 * SessionStart hook — the Claude Code analog of nvim-aware-pi's `session_start`.
 * Best-effort connects to a Neovim server and announces it so Claude knows the
 * `nvim_context` tool is available. In `full` mode it preloads a snapshot.
 */
import { getExplicitServer, getPromptContextMode, isDisabled } from "../lib/config.mjs";
import { resolveServer } from "../lib/discover.mjs";
import { getNvimSnapshot } from "../lib/snapshot.mjs";
import { formatOnDemandSystemPromptContext, formatSystemPromptContext } from "../lib/format.mjs";
import { emitContext, readHookInput } from "../lib/hookio.mjs";

const EVENT = "SessionStart";

async function main() {
	if (isDisabled()) return;

	const mode = getPromptContextMode();
	if (mode === "off") return;

	const input = await readHookInput();
	const cwd = input.cwd || process.cwd();
	const explicit = getExplicitServer();

	let server;
	try {
		({ server } = await resolveServer({ explicit, cwd }));
	} catch {
		// No Neovim running — nothing to announce.
		return;
	}

	if (mode === "full") {
		try {
			const snapshot = await getNvimSnapshot(server, { timeoutMs: 1500 });
			emitContext(EVENT, formatSystemPromptContext(snapshot));
			return;
		} catch {
			// Fall through to the lightweight reminder.
		}
	}

	emitContext(EVENT, formatOnDemandSystemPromptContext(server));
}

main().catch(() => process.exit(0));
