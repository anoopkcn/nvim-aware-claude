---
description: Show the live Neovim context Claude sees
allowed-tools: Bash(node:*)
---

Live Neovim editor context (current file, cursor, selection, search, quickfix, windows, buffers):

!`node "${CLAUDE_PLUGIN_ROOT}/bin/nvim-context.mjs" --format text`
