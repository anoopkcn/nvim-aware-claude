/**
 * Hook I/O plumbing for Claude Code command hooks.
 * Hooks receive a JSON event on stdin and may add context for Claude by
 * printing a hookSpecificOutput object on stdout.
 */

/** Read and parse the JSON event Claude Code passes on stdin. */
export async function readHookInput() {
	const chunks = [];
	for await (const chunk of process.stdin) chunks.push(chunk);
	const raw = Buffer.concat(chunks).toString("utf8").trim();
	if (!raw) return {};
	try {
		return JSON.parse(raw);
	} catch {
		return {};
	}
}

/** Emit additional context to inject into Claude's conversation. No-op when empty. */
export function emitContext(hookEventName, additionalContext) {
	if (!additionalContext) return;
	process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext } }));
}
