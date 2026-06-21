/**
 * Human-readable formatting of a Neovim snapshot.
 * Ported from nvim-aware-pi (extensions/nvim-aware-pi.ts).
 */
import { DEFAULT_MAX_BUFFERS } from "./snapshot.mjs";

/** Wrap a compact snapshot as the live-context block injected before a turn. */
export function formatSystemPromptContext(snapshot) {
	return [
		"# Live Neovim context",
		"The user may refer to this editor state as 'current file', 'cursor', 'selection', 'quickfix', 'buffers', or 'search'. This is a live snapshot from Neovim at the time of the prompt.",
		...formatSnapshot(snapshot, { compact: true }),
	].join("\n");
}

/** The reminder shown when Neovim is connected but state is not preloaded. */
export function formatOnDemandSystemPromptContext(server) {
	return [
		"# Neovim integration",
		`Neovim is connected (${server}), but editor state is not preloaded to save input tokens.`,
		"Use the `nvim_context` tool (or run `nvim-context`) if the user's request depends on the current file, cursor, selection, quickfix list/errors/warnings, search register, visible windows, or listed buffers.",
	].join("\n");
}

export function formatSnapshot(snapshot, options) {
	const lines = [];
	const currentFile = snapshot.currentFile || "[No Name]";
	const modified = snapshot.currentBuffer.modified ? " modified" : "";
	const filetype = snapshot.currentBuffer.filetype ? ` ft=${snapshot.currentBuffer.filetype}` : "";

	lines.push(`- Neovim server: ${snapshot.server}`);
	lines.push(`- Neovim cwd: ${snapshot.cwd}`);
	lines.push(`- Mode: ${snapshot.mode}`);
	lines.push(`- Current file: ${currentFile}${filetype}${modified}`);
	lines.push(`- Cursor: line ${snapshot.cursor.line}, column ${snapshot.cursor.column}`);
	lines.push(`- Cursor line: ${snapshot.cursor.lineText}`);

	if (snapshot.selection) {
		const kind = snapshot.selection.active ? "active visual selection" : "last visual selection";
		lines.push(
			`- Selection: ${kind}, mode=${printableMode(snapshot.selection.mode)}, ${snapshot.selection.start.line}:${snapshot.selection.start.column}-${snapshot.selection.end.line}:${snapshot.selection.end.column}${snapshot.selection.truncated ? " (truncated)" : ""}`,
		);
		if (snapshot.selection.text) {
			lines.push("```text");
			lines.push(snapshot.selection.text);
			lines.push("```");
		}
	} else {
		lines.push("- Selection: none");
	}

	if (snapshot.search) lines.push(`- Search register: ${snapshot.search}`);

	if (snapshot.quickfix && snapshot.quickfix.size > 0) {
		const title = snapshot.quickfix.title ? `: ${snapshot.quickfix.title}` : "";
		const shown = snapshot.quickfix.truncated ? `, showing ${snapshot.quickfix.items.length}` : "";
		const current = snapshot.quickfix.currentIndex > 0 ? `, current=${snapshot.quickfix.currentIndex}` : "";
		lines.push(`- Quickfix list (${snapshot.quickfix.size}${shown}${current})${title}`);
		const max = options.compact ? 8 : snapshot.quickfix.items.length;
		for (const item of snapshot.quickfix.items.slice(0, max)) {
			const marker = item.index === snapshot.quickfix.currentIndex ? ">" : " ";
			const kind = item.type ? ` ${item.type}` : "";
			const valid = item.valid ? "" : " invalid";
			const location = formatQuickfixLocation(item);
			lines.push(`  ${marker} [${item.index}]${kind}${valid} ${location}${item.text ? ` ${item.text}` : ""}`);
		}
		if (options.compact && snapshot.quickfix.items.length > max) {
			lines.push(`  - … ${snapshot.quickfix.items.length - max} more quickfix item(s); use nvim_context for full list`);
		}
	}

	if (!options.compact && snapshot.surroundingLines.length > 0) {
		lines.push("- Lines around cursor:");
		for (const row of snapshot.surroundingLines) {
			const marker = row.current ? ">" : " ";
			lines.push(`  ${marker} ${String(row.line).padStart(5, " ")} | ${row.text}`);
		}
	}

	if (!options.compact && snapshot.windows.length > 0) {
		lines.push("- Visible windows:");
		for (const win of snapshot.windows) {
			lines.push(`  - win ${win.winid}: ${win.file || "[No Name]"} @ ${win.cursor.line}:${win.cursor.column}`);
		}
	}

	if (snapshot.buffers.length > 0) {
		const displayedBuffers = options.compact
			? snapshot.buffers.filter((buffer) => buffer.visible || buffer.modified).slice(0, 6)
			: snapshot.buffers;

		if (displayedBuffers.length > 0) {
			lines.push(`- Listed buffers (${snapshot.buffers.length}${snapshot.buffers.length >= DEFAULT_MAX_BUFFERS ? "+" : ""}):`);
			for (const buffer of displayedBuffers) {
				const flags = [buffer.visible ? "visible" : undefined, buffer.modified ? "modified" : undefined, buffer.filetype]
					.filter(Boolean)
					.join(", ");
				lines.push(`  - [${buffer.bufnr}] ${buffer.name || "[No Name]"}${flags ? ` (${flags})` : ""}`);
			}
			if (options.compact && snapshot.buffers.length > displayedBuffers.length) {
				lines.push(`  - … ${snapshot.buffers.length - displayedBuffers.length} more buffer(s); use nvim_context for full list`);
			}
		}
	}

	return lines;
}

function formatQuickfixLocation(item) {
	const file = item.filename || "[No file]";
	if (item.line <= 0) return file;
	const column = item.column > 0 ? `:${item.column}` : "";
	return `${file}:${item.line}${column}`;
}

function printableMode(mode) {
	if (mode === "\u0016") return "block";
	if (mode === "\u0013") return "select-block";
	if (mode === "V") return "line";
	if (mode === "v") return "char";
	return mode;
}
