/**
 * Configuration + prompt heuristics.
 *
 * Environment variables (renamed from the reference's PI_NVIM_* knobs):
 *   NVIM_AWARE_SERVER             explicit Neovim server address to pin
 *   NVIM_AWARE_PROMPT_CONTEXT     auto | full | hint | off   (default: auto)
 *   NVIM_AWARE_SNAPSHOT_TTL_MS    snapshot cache TTL          (default: 750)
 *   NVIM_AWARE_PROMPT_TIMEOUT_MS  refresh timeout on prompt   (default: 800)
 *   NVIM_AWARE_DISABLE            any truthy value disables injection entirely
 */
import { asNonEmptyString } from "./proc.mjs";

export const DEFAULT_PROMPT_CONTEXT_MODE = "auto";
export const VALID_PROMPT_CONTEXT_MODES = new Set(["auto", "full", "hint", "off"]);

export const DEFAULT_SNAPSHOT_CACHE_TTL_MS = 750;
export const DEFAULT_PROMPT_REFRESH_TIMEOUT_MS = 800;

/** Resolve the prompt-context mode from the environment. */
export function getPromptContextMode() {
	const value = asNonEmptyString(process.env.NVIM_AWARE_PROMPT_CONTEXT) ?? DEFAULT_PROMPT_CONTEXT_MODE;
	const normalized = value.toLowerCase();
	return VALID_PROMPT_CONTEXT_MODES.has(normalized) ? normalized : DEFAULT_PROMPT_CONTEXT_MODE;
}

/** The explicit server address, if pinned via env. */
export function getExplicitServer() {
	return asNonEmptyString(process.env.NVIM_AWARE_SERVER);
}

/** Master kill switch for context injection. */
export function isDisabled() {
	const raw = process.env.NVIM_AWARE_DISABLE;
	if (!raw) return false;
	const value = raw.trim().toLowerCase();
	return value !== "" && value !== "0" && value !== "false" && value !== "no";
}

/**
 * Decide whether a user's prompt looks like it depends on live editor state.
 * Kept byte-for-byte from nvim-aware-pi so behaviour matches exactly.
 */
export function promptLikelyNeedsNvimContext(prompt) {
	const text = String(prompt ?? "").toLowerCase();
	return [
		/\b(neovim|nvim)\b/,
		/\b(current|open|active)\s+(file|buffer|window|tab)\b/,
		/\b(this|that)\s+(file|buffer|code|function|class|method|selection|snippet)\b/,
		/\b(selected|selection|visual selection|highlighted)\b/,
		/\b(cursor|under cursor|around here|right here|line under|current line)\b/,
		/\b(quickfix|qflist|quickfix list|diagnostics?|errors?|warnings?|lint|linter|compiler|build failure)\b/,
		/\b(search register|last search|open buffers?|listed buffers?|visible windows?)\b/,
	].some((pattern) => pattern.test(text));
}
