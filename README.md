# nvim-aware-claude

A lightweight [Claude Code](https://code.claude.com) plugin that makes Claude aware of a
running **Neovim** session. When your prompt refers to the editor — "this file", "the
selection", "the error under the cursor", "the quickfix list" — Claude is given a live
snapshot of Neovim's state: current file, cursor, visual selection, search register,
quickfix list, visible windows, and listed buffers.

No Neovim plugin or UI changes are required. The integration reads editor state over `nvim --server <addr> --remote-expr`.

## How it works

| Piece | Mechanism | Purpose |
|-------|-----------|---------|
| **Auto context injection** | `UserPromptSubmit` hook | Injects a compact live snapshot when your prompt looks like it depends on editor state. |
| **`nvim_context` tool** | bundled MCP server | Claude can pull fresh, detailed editor state on demand (`mcp__nvim-aware__nvim_context`). |
| **`/nvim` command** | slash command | Print the live context Claude currently sees. |
| **Session announce** | `SessionStart` hook | Detects Neovim at session start and tells Claude the tool is available. |
| **`claude-nvim`** | launcher | Start Claude pre-connected to a Neovim instance (with an interactive picker). |

Everything is zero-dependency Node.js (ESM). It only needs the `nvim` binary on `PATH`
and a Neovim server that is listening (any normal Neovim ≥ 0.5 exposes one via
`v:servername`; or start one explicitly with `nvim --listen /tmp/nvim-main`).

## Install

### Local / development

```bash
claude --plugin-dir /path/to/nvim-aware-claude
```

### Via marketplace

```text
/plugin marketplace add anoopkcn/nvim-aware-claude
/plugin install nvim-aware-claude@nvim-aware-claude
```

(Replace the repo with wherever you host it; the bundled `.claude-plugin/marketplace.json`
makes the repo itself a single-plugin marketplace.)

## Usage

1. Open a file in Neovim.
2. Start Claude Code in the same project (or use `claude-nvim`, below).
3. Ask something that references the editor:
   - "Explain **this file**."
   - "Fix the bug in the **selected** code."
   - "What's the **error under the cursor**?"
   - "Work through the **quickfix list**."

   The `UserPromptSubmit` hook recognizes these and injects the live snapshot. Neutral
   prompts (e.g. "what is 2 + 2") inject nothing, so there is no token cost by default.
4. Run `/nvim` any time to see exactly what Claude sees.
5. Claude can also call the `nvim_context` tool itself when it needs fresh editor state.

### The `claude-nvim` launcher

Starts Claude already connected to a Neovim instance: it discovers the server (showing an
interactive picker if several are running), changes into that instance's working
directory, exports `NVIM_AWARE_SERVER`, then launches `claude`.

```bash
# symlink it onto your PATH once
ln -s /path/to/nvim-aware-claude/bin/claude-nvim ~/.local/bin/claude-nvim

# then, from inside or alongside Neovim:
claude-nvim                                  # auto-pick / prompt
claude-nvim --nvim-server /tmp/nvim-main     # pin a server
claude-nvim --nvim-context full --model opus # unknown flags pass through to claude
```

By default the launcher also auto-loads this plugin (`--plugin-dir`), so you do **not**
need to install it globally — going through `claude-nvim` is enough. If you _do_ install
it globally (via the marketplace), set `NVIM_AWARE_AUTO_PLUGIN_DIR=0` to avoid loading it
twice.

### Opt-in shell wrapper (like a `pi --nvim` setup)

If you'd rather keep typing `claude` and only opt in with a flag, drop a wrapper function
in your `~/.bashrc` / `~/.zshrc`. When any `--nvim…` flag is present it routes to the
launcher; otherwise it runs the real `claude` untouched:

```bash
claude() {
    for arg in "$@"; do
        case "$arg" in
            --nvim|--nvim=*|--nvim-*) claude-nvim "$@"; return ;;
        esac
    done
    command claude "$@"
}
```

Now `claude` behaves exactly as before, while `claude --nvim` connects to Neovim and loads
the plugin on demand. `--nvim=/tmp/nvim-main` is shorthand for `--nvim-server /tmp/nvim-main`.
(Requires `claude-nvim` on your `PATH`, per the symlink above.)

## Configuration

All configuration is via environment variables.

| Variable | Default | Meaning |
|----------|---------|---------|
| `NVIM_AWARE_PROMPT_CONTEXT` | `auto` | How much state to inject per prompt: `auto`, `full`, `hint`, or `off`. |
| `NVIM_AWARE_SERVER` | _(discovered)_ | Pin a specific Neovim server address; skips discovery. |
| `NVIM_AWARE_SNAPSHOT_TTL_MS` | `750` | Snapshot cache TTL inside the MCP server. |
| `NVIM_AWARE_PROMPT_TIMEOUT_MS` | `800` | Refresh timeout floor for prompt-time snapshots. |
| `NVIM_AWARE_DISABLE` | _(unset)_ | Any truthy value disables all context injection. |
| `NVIM_AWARE_AUTO_PLUGIN_DIR` | _(unset)_ | Set to `0` to stop `claude-nvim` auto-loading the plugin via `--plugin-dir` (use when installed globally). |

### Prompt-context modes

- **`auto`** (default) — inject a compact snapshot only when the prompt mentions the
  current file, buffer, selection, cursor, quickfix/errors/warnings, search, windows, or
  buffers. Cheap; nothing injected otherwise.
- **`full`** — inject a compact snapshot before every turn.
- **`hint`** — never inject state; just remind Claude the `nvim_context` tool exists.
- **`off`** — inject nothing (the tool and `/nvim` command remain available).

## Multiple Neovim instances

- The hooks and MCP server pick the instance whose working directory best matches Claude's
  project directory (exact match → file containment → directory containment).
- The `claude-nvim` launcher shows an interactive picker in a TTY, or uses the same
  heuristic when non-interactive. Pass `--nvim-server` to choose explicitly.

## Layout

```
.claude-plugin/plugin.json     plugin manifest
.claude-plugin/marketplace.json single-plugin marketplace
.mcp.json                      registers the MCP server
hooks/hooks.json               SessionStart + UserPromptSubmit
hooks/*.mjs                    hook entry points
commands/nvim.md               /nvim slash command
mcp/nvim-mcp.mjs               stdio MCP server exposing nvim_context
bin/nvim-context.mjs           CLI: print the live snapshot (also on Bash PATH)
bin/claude-nvim                launcher: discover server, set env, exec claude
lib/*.mjs                      shared zero-dep engine (discovery, snapshot, format)
```

## Requirements

- Neovim ≥ 0.5 with a listening server (default for normal sessions, or `nvim --listen`).
- Node.js ≥ 18.
- `nvim` on `PATH`.

## License

MIT
