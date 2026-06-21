/**
 * Neovim snapshot fetching.
 *
 * Talks to a running Neovim server with:
 *   nvim --server <addr> --remote-expr "luaeval('<lua>')"
 * and parses the JSON the Lua expression returns.
 *
 * The two Lua expressions are copied byte-for-byte from nvim-aware-pi — they
 * encode every selection / quickfix / buffer edge case and must not be rewritten.
 */
import { runProcess, vimSingleQuoted, DEFAULT_TIMEOUT_MS } from "./proc.mjs";

export const DEFAULT_SURROUNDING_LINES = 5;
export const DEFAULT_MAX_SELECTION_BYTES = 4000;
export const DEFAULT_MAX_BUFFERS = 30;
export const DEFAULT_MAX_QUICKFIX_ITEMS = 30;

const snapshotExpressionCache = new Map();

/** server\0optionsKey -> { snapshot, createdAt } */
const snapshotCache = new Map();
/** requestKey -> Promise<snapshot> (in-flight de-duplication) */
const snapshotInFlight = new Map();

export function normalizeSnapshotOptions(options = {}) {
	return {
		surroundingLines: Math.max(0, Math.floor(options.surroundingLines ?? DEFAULT_SURROUNDING_LINES)),
		maxSelectionBytes: Math.max(0, Math.floor(options.maxSelectionBytes ?? DEFAULT_MAX_SELECTION_BYTES)),
		maxBuffers: Math.max(1, Math.floor(options.maxBuffers ?? DEFAULT_MAX_BUFFERS)),
		maxQuickfixItems: Math.max(0, Math.floor(options.maxQuickfixItems ?? DEFAULT_MAX_QUICKFIX_ITEMS)),
	};
}

function snapshotOptionsKey(options) {
	return `${options.surroundingLines}:${options.maxSelectionBytes}:${options.maxBuffers}:${options.maxQuickfixItems}`;
}

function snapshotCacheKey(server, options) {
	return `${server}\0${snapshotOptionsKey(options)}`;
}

function rememberSnapshot(snapshot, options) {
	snapshotCache.set(snapshotCacheKey(snapshot.server, options), { snapshot, createdAt: Date.now() });
}

export function cachedSnapshotEntry(server, options) {
	return snapshotCache.get(snapshotCacheKey(server, normalizeSnapshotOptions(options)));
}

/** Lightweight server summary expression: cwd, current file, cursor. */
export function makeServerSummaryExpression() {
	const lua = String.raw`
(function()
  local api = vim.api
  local fn = vim.fn
  local cursor = api.nvim_win_get_cursor(0)
  return fn.json_encode({
    cwd = fn.getcwd(),
    currentFile = api.nvim_buf_get_name(0),
    cursor = { line = cursor[1], column = cursor[2] + 1 },
  })
end)()
`;
	return `luaeval(${vimSingleQuoted(lua)})`;
}

/** Full snapshot expression, parametrized by the given limits. */
export function makeSnapshotExpression(options) {
	const cacheKey = snapshotOptionsKey(options);
	const cached = snapshotExpressionCache.get(cacheKey);
	if (cached) return cached;

	const lua = String.raw`
(function()
  local api = vim.api
  local fn = vim.fn
  local surrounding = ${options.surroundingLines}
  local max_selection_bytes = ${options.maxSelectionBytes}
  local max_buffers = ${options.maxBuffers}
  local max_quickfix_items = ${options.maxQuickfixItems}
  local visual_block = string.char(22)
  local select_block = string.char(19)
  local newline = string.char(10)

  local function bool(v) return v == true or v == 1 end

  local function mode_is_visual(m)
    return m == 'v' or m == 'V' or m == visual_block or m == 's' or m == 'S' or m == select_block
  end

  local function pos(line, col)
    return { line = line or 0, column = col or 0 }
  end

  local function normalize(a, b)
    local a_line, a_col = a[2] or 0, a[3] or 0
    local b_line, b_col = b[2] or 0, b[3] or 0
    if a_line > b_line or (a_line == b_line and a_col > b_col) then
      return b, a
    end
    return a, b
  end

  local function slice_line(line_text, start_col, end_col)
    if start_col < 1 then start_col = 1 end
    local len = #line_text
    if end_col < 1 or end_col > len then end_col = len end
    if start_col > len then return '' end
    if end_col < start_col then return '' end
    return string.sub(line_text, start_col, end_col)
  end

  local function truncate_text(text, max_bytes)
    if max_bytes <= 0 then return '', #text > 0 end
    if #text <= max_bytes then return text, false end
    return string.sub(text, 1, max_bytes) .. newline .. '…[selection truncated]', true
  end

  local function read_selection(current_mode)
    local active = mode_is_visual(current_mode)
    local selection_mode = active and current_mode or fn.visualmode()
    local raw_start = active and fn.getpos('v') or fn.getpos([=['<]=])
    local raw_end = active and fn.getpos('.') or fn.getpos([=['>]=])
    local start_pos, end_pos = normalize(raw_start, raw_end)
    local start_line, start_col = start_pos[2] or 0, start_pos[3] or 0
    local end_line, end_col = end_pos[2] or 0, end_pos[3] or 0

    if start_line <= 0 or end_line <= 0 then return nil end

    local ok, lines = pcall(api.nvim_buf_get_lines, 0, start_line - 1, end_line, false)
    if not ok or not lines or #lines == 0 then return nil end

    if selection_mode == 'V' then
      -- Keep complete selected lines.
    elseif selection_mode == visual_block or selection_mode == select_block then
      local left = math.min(start_col, end_col)
      local right = math.max(start_col, end_col)
      for i, line_text in ipairs(lines) do
        lines[i] = slice_line(line_text, left, right)
      end
    else
      if #lines == 1 then
        lines[1] = slice_line(lines[1], start_col, end_col)
      else
        lines[1] = slice_line(lines[1], start_col, #lines[1])
        lines[#lines] = slice_line(lines[#lines], 1, end_col)
      end
    end

    local text, truncated = truncate_text(table.concat(lines, newline), max_selection_bytes)
    return {
      active = active,
      mode = selection_mode,
      start = pos(start_line, start_col),
      ['end'] = pos(end_line, end_col),
      text = text,
      truncated = truncated,
    }
  end

  local buffer_cache = {}

  local function buffer_name(bufnr)
    local cached_info = buffer_cache[bufnr]
    if cached_info and cached_info.name then return cached_info.name end
    local ok_name, name = pcall(api.nvim_buf_get_name, bufnr)
    return ok_name and name or ''
  end

  local function buffer_info(bufnr)
    local cached_info = buffer_cache[bufnr]
    if cached_info then return cached_info end

    local loaded = api.nvim_buf_is_loaded(bufnr)
    local line_count = 0
    if loaded then
      local ok_count, count = pcall(api.nvim_buf_line_count, bufnr)
      line_count = ok_count and count or 0
    end

    local filetype = ''
    if loaded then
      local ok_ft, ft = pcall(function() return vim.bo[bufnr].filetype end)
      filetype = ok_ft and ft or ''
    end

    local ok_modified, modified = pcall(function() return vim.bo[bufnr].modified end)
    local ok_listed, listed = pcall(function() return vim.bo[bufnr].buflisted end)

    local info = {
      bufnr = bufnr,
      name = buffer_name(bufnr),
      filetype = filetype,
      modified = ok_modified and bool(modified) or false,
      lineCount = line_count,
      listed = ok_listed and bool(listed) or false,
      visible = false,
    }
    buffer_cache[bufnr] = info
    return info
  end

  local visible_buffers = {}
  local windows = {}
  for _, win in ipairs(api.nvim_list_wins()) do
    local ok_buf, bufnr = pcall(api.nvim_win_get_buf, win)
    if ok_buf then
      visible_buffers[bufnr] = true
      local ok_cursor, win_cursor = pcall(api.nvim_win_get_cursor, win)
      table.insert(windows, {
        winid = win,
        bufnr = bufnr,
        file = buffer_name(bufnr),
        cursor = pos(ok_cursor and win_cursor[1] or 0, ok_cursor and (win_cursor[2] + 1) or 0),
      })
    end
  end

  local function buffer_info_from_getbufinfo(item)
    local bufnr = item.bufnr or 0
    if bufnr <= 0 then return nil end

    local loaded = bool(item.loaded)
    local filetype = ''
    if loaded then
      local ok_ft, ft = pcall(function() return vim.bo[bufnr].filetype end)
      filetype = ok_ft and ft or ''
    end

    local line_count = item.linecount or 0
    if line_count == 0 and loaded then
      local ok_count, count = pcall(api.nvim_buf_line_count, bufnr)
      line_count = ok_count and count or 0
    end

    local info = {
      bufnr = bufnr,
      name = item.name or buffer_name(bufnr),
      filetype = filetype,
      modified = bool(item.changed),
      lineCount = line_count,
      listed = true,
      visible = bool(visible_buffers[bufnr]),
    }
    buffer_cache[bufnr] = info
    return info
  end

  local buffers = {}
  local ok_bufinfo, listed_infos = pcall(fn.getbufinfo, { buflisted = 1 })
  if ok_bufinfo and listed_infos then
    for _, item in ipairs(listed_infos) do
      local info = buffer_info_from_getbufinfo(item)
      if info then
        table.insert(buffers, info)
        if #buffers >= max_buffers then break end
      end
    end
  else
    for _, bufnr in ipairs(api.nvim_list_bufs()) do
      local ok, info = pcall(buffer_info, bufnr)
      if ok and info.listed then
        info.visible = bool(visible_buffers[bufnr])
        table.insert(buffers, info)
        if #buffers >= max_buffers then break end
      end
    end
  end

  local function quickfix_filename(item)
    if type(item.filename) == 'string' and item.filename ~= '' then return item.filename end
    local bufnr = item.bufnr or 0
    if bufnr > 0 then return buffer_name(bufnr) end
    return ''
  end

  local function read_quickfix()
    if max_quickfix_items <= 0 then return nil end

    local ok_qf, qf = pcall(fn.getqflist, { title = 1, idx = 1, size = 1, items = 1 })
    if not ok_qf or type(qf) ~= 'table' then return nil end

    local all_items = qf.items or {}
    local size = qf.size or #all_items
    if size <= 0 or #all_items == 0 then return nil end

    local idx = qf.idx or 0
    local start_index = 1
    local end_index = math.min(#all_items, max_quickfix_items)
    if #all_items > max_quickfix_items and idx > 0 then
      start_index = math.max(1, idx - math.floor(max_quickfix_items / 2))
      end_index = math.min(#all_items, start_index + max_quickfix_items - 1)
      start_index = math.max(1, end_index - max_quickfix_items + 1)
    end

    local items = {}
    for index = start_index, end_index do
      local item = all_items[index]
      table.insert(items, {
        index = index,
        bufnr = item.bufnr or 0,
        filename = quickfix_filename(item),
        line = item.lnum or 0,
        column = item.col or 0,
        endLine = item.end_lnum or 0,
        endColumn = item.end_col or 0,
        type = item.type or '',
        text = item.text or '',
        valid = bool(item.valid),
      })
    end

    return {
      title = qf.title or '',
      currentIndex = idx,
      size = size,
      items = items,
      truncated = #all_items > #items,
    }
  end

  local current_mode = api.nvim_get_mode().mode
  local current_buf = api.nvim_get_current_buf()
  local cursor = api.nvim_win_get_cursor(0)
  local line = cursor[1]
  local column = cursor[2] + 1
  local start_line = math.max(1, line - surrounding)
  local end_line = math.min(api.nvim_buf_line_count(current_buf), line + surrounding)
  local surrounding_lines = {}
  local current_line = nil
  if surrounding > 0 then
    local ok_lines, lines = pcall(api.nvim_buf_get_lines, current_buf, start_line - 1, end_line, false)
    if ok_lines then
      for index, text in ipairs(lines) do
        local line_no = start_line + index - 1
        if line_no == line then current_line = text end
        table.insert(surrounding_lines, { line = line_no, text = text, current = line_no == line })
      end
    end
  end

  if current_line == nil then
    local ok_current_line, fetched_line = pcall(api.nvim_get_current_line)
    current_line = ok_current_line and fetched_line or ''
  end

  local current = buffer_info(current_buf)
  current.visible = true

  return fn.json_encode({
    cwd = fn.getcwd(),
    mode = current_mode,
    currentFile = current.name,
    currentBuffer = current,
    cursor = { line = line, column = column, lineText = current_line },
    surroundingLines = surrounding_lines,
    selection = read_selection(current_mode),
    search = fn.getreg('/'),
    quickfix = read_quickfix(),
    buffers = buffers,
    windows = windows,
  })
end)()
`;

	const expr = `luaeval(${vimSingleQuoted(lua)})`;
	snapshotExpressionCache.set(cacheKey, expr);
	return expr;
}

/** Fetch a full snapshot from a server (no caching). */
export async function getNvimSnapshot(server, options = {}) {
	const normalized = normalizeSnapshotOptions(options);
	const expr = makeSnapshotExpression(normalized);
	const result = await runProcess("nvim", ["--server", server, "--remote-expr", expr], {
		timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
	});

	if (result.code !== 0) {
		throw new Error(`nvim --remote-expr failed: ${result.stderr.trim() || result.stdout.trim()}`);
	}

	const json = result.stdout.trim() || result.stderr.trim();
	if (!json) throw new Error("Neovim returned an empty snapshot");

	const snapshot = JSON.parse(json);
	return { ...snapshot, server };
}

/** Fetch a lightweight summary (cwd / current file / cursor) from a server. */
export async function getNvimServerSummary(server, options = {}) {
	const result = await runProcess("nvim", ["--server", server, "--remote-expr", makeServerSummaryExpression()], {
		timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
	});

	if (result.code !== 0) {
		throw new Error(`nvim --remote-expr failed: ${result.stderr.trim() || result.stdout.trim()}`);
	}

	const json = result.stdout.trim() || result.stderr.trim();
	if (!json) throw new Error("Neovim returned an empty server summary");

	const summary = JSON.parse(json);
	return { ...summary, server };
}

/**
 * Fetch a snapshot with TTL caching + in-flight de-duplication.
 * (Only meaningful inside the long-lived MCP server; short-lived hooks just fetch once.)
 */
export async function getCachedNvimSnapshot(server, options = {}, cacheOptions = {}) {
	const normalized = normalizeSnapshotOptions(options);
	const cacheKey = snapshotCacheKey(server, normalized);
	const now = Date.now();
	const cached = snapshotCache.get(cacheKey);
	const ttlMs = cacheOptions.ttlMs ?? 0;
	if (!cacheOptions.force && ttlMs > 0 && cached && now - cached.createdAt <= ttlMs) {
		return cached.snapshot;
	}

	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const requestKey = `${cacheKey}\0${timeoutMs}`;
	const inFlight = snapshotInFlight.get(requestKey);
	if (inFlight) return inFlight;

	const promise = getNvimSnapshot(server, { ...normalized, timeoutMs })
		.then((snapshot) => {
			rememberSnapshot(snapshot, normalized);
			return snapshot;
		})
		.finally(() => {
			snapshotInFlight.delete(requestKey);
		});
	snapshotInFlight.set(requestKey, promise);
	return promise;
}
