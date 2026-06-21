#!/usr/bin/env node
/**
 * nvim-context — print the live Neovim context the plugin sees.
 *
 * Backs the /nvim slash command and is also available on the Bash tool's PATH,
 * so Claude can run `nvim-context` directly when it wants fresh editor state.
 *
 * Usage: nvim-context [--server <addr>] [--format text|json]
 */
import { getExplicitServer } from "../lib/config.mjs";
import { resolveServer } from "../lib/discover.mjs";
import { getNvimSnapshot } from "../lib/snapshot.mjs";
import { formatSnapshot } from "../lib/format.mjs";
import { errorToMessage } from "../lib/proc.mjs";

function parseArgs(argv) {
	const opts = { server: undefined, format: "text" };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--server") {
			opts.server = argv[++i];
		} else if (arg.startsWith("--server=")) {
			opts.server = arg.slice("--server=".length);
		} else if (arg === "--format") {
			opts.format = argv[++i];
		} else if (arg.startsWith("--format=")) {
			opts.format = arg.slice("--format=".length);
		} else if (arg === "--help" || arg === "-h") {
			opts.help = true;
		}
	}
	return opts;
}

async function main() {
	const opts = parseArgs(process.argv.slice(2));
	if (opts.help) {
		process.stdout.write("Usage: nvim-context [--server <addr>] [--format text|json]\n");
		return;
	}

	const explicit = opts.server || getExplicitServer();
	let server;
	try {
		({ server } = await resolveServer({ explicit, cwd: process.cwd() }));
	} catch (error) {
		process.stderr.write(`${errorToMessage(error)}\n`);
		process.exit(1);
	}

	try {
		const snapshot = await getNvimSnapshot(server, { timeoutMs: 2000 });
		if (opts.format === "json") {
			process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
		} else {
			process.stdout.write(`${formatSnapshot(snapshot, { compact: false }).join("\n")}\n`);
		}
	} catch (error) {
		process.stderr.write(`Failed to read Neovim context from ${server}: ${errorToMessage(error)}\n`);
		process.exit(1);
	}
}

main().catch((error) => {
	process.stderr.write(`${errorToMessage(error)}\n`);
	process.exit(1);
});
