/**
 * out —— 结果格式化
 *
 * 把任意来源的 JSON（数组 / 对象）转成人类可读格式：CSV / Markdown 表格 / 列表 / TSV。
 * 也能直接读文件（上一个命令的输出落盘后用本插件转格式）。
 *
 * 用途：抓完数据要贴进文档 / Excel / 聊天窗口时，不必再手工整理。
 */
import fs from 'node:fs';

/** 取嵌套字段（支持 a.b.c） */
function pick(obj, key) {
  if (obj === null || obj === undefined) return undefined;
  if (typeof obj !== 'object') return undefined;
  if (Object.prototype.hasOwnProperty.call(obj, key)) return obj[key];
  let cur = obj;
  for (const p of String(key).split('.')) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[p];
  }
  return cur;
}

/** 从数据里推断主数组 */
function extractRows(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    for (const k of ['results', 'items', 'topics', 'boards', 'posts', 'entries', 'urls', 'data']) {
      if (Array.isArray(data[k])) return data[k];
    }
    for (const v of Object.values(data)) if (Array.isArray(v)) return v;
    return [data];
  }
  return [{ value: data }];
}

/** 收集列：显式优先，否则取所有条目键的并集（保持首次出现顺序） */
function collectColumns(rows, explicit) {
  if (Array.isArray(explicit) && explicit.length) return explicit.map(String);
  const seen = new Set();
  const order = [];
  for (const r of rows) {
    if (!r || typeof r !== 'object') {
      if (!seen.has('value')) { seen.add('value'); order.push('value'); }
      continue;
    }
    for (const k of Object.keys(r)) {
      if (!seen.has(k)) { seen.add(k); order.push(k); }
    }
  }
  return order.length ? order : ['value'];
}

/** 单元格值 → 字符串（对象转 JSON，数组用 ; 连） */
function cell(v) {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join('; ');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function csvEscape(s, sep) {
  const needs = s.includes(sep) || s.includes('"') || s.includes('\n') || s.includes('\r');
  const body = s.replace(/"/g, '""');
  return needs ? `"${body}"` : body;
}

function toCsv(rows, cols, sep, withHeader) {
  const lines = [];
  if (withHeader) lines.push(cols.map((c) => csvEscape(c, sep)).join(sep));
  for (const r of rows) {
    lines.push(cols.map((c) => csvEscape(cell(pick(r, c) ?? (typeof r === 'object' ? undefined : r)), sep)).join(sep));
  }
  return lines.join('\n');
}

function mdEscape(s) {
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function toMarkdown(rows, cols) {
  const lines = [];
  lines.push('| ' + cols.map(mdEscape).join(' | ') + ' |');
  lines.push('| ' + cols.map(() => '---').join(' | ') + ' |');
  for (const r of rows) {
    lines.push('| ' + cols.map((c) => mdEscape(cell(pick(r, c) ?? (typeof r === 'object' ? undefined : r)))).join(' | ') + ' |');
  }
  return lines.join('\n');
}

function toList(rows, cols) {
  return rows.map((r, i) => {
    const parts = cols
      .map((c) => {
        const v = pick(r, c) ?? (typeof r === 'object' ? undefined : r);
        const s = cell(v);
        return s ? `${c}: ${s}` : '';
      })
      .filter(Boolean);
    return `${i + 1}. ${parts.join(' | ')}`;
  }).join('\n');
}

function toTsv(rows, cols) {
  return toCsv(rows, cols, '\t', true);
}

export default {
  name: 'out',
  version: '0.1.0',
  description: '结果格式化：JSON → CSV / Markdown 表格 / 列表 / TSV（可读文件或直接给数据）',
  permissions: ['fs-read'],
  schema: {
    type: 'object',
    properties: {
      file: { type: 'string', description: '读取 JSON 文件（与 data 二选一）' },
      data: { description: '直接给数据（数组或对象）' },
      format: { type: 'string', enum: ['csv', 'markdown', 'list', 'tsv'], default: 'markdown' },
      columns: { type: 'array', items: { type: 'string' }, description: '要输出的列（点路径，缺省取全部键）' },
      headers: { type: 'array', items: { type: 'string' }, description: '表头显示名（与 columns 一一对应）' },
      limit: { type: 'integer', description: '最多输出多少行', default: 100 },
      separator: { type: 'string', description: 'CSV 分隔符', default: ',' },
      noHeader: { type: 'boolean', description: 'CSV 不带表头', default: false },
    },
  },

  async execute(params, ctx) {
    let data = params.data;

    if (data === undefined && params.file) {
      const f = String(params.file);
      if (!fs.existsSync(f)) return { ok: false, error: `文件不存在: ${f}` };
      const raw = fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '');
      try { data = JSON.parse(raw); }
      catch (e) { return { ok: false, error: `不是合法 JSON: ${(e && e.message) || String(e)}` }; }
      ctx.log('debug', `读入 ${f}`);
    }

    if (data === undefined) {
      return { ok: false, error: '需要 file 或 data' };
    }

    const rows = extractRows(data);
    const limit = Number(params.limit ?? 100);
    const sliced = rows.slice(0, limit);
    const cols = collectColumns(sliced, params.columns);
    const headers = Array.isArray(params.headers) && params.headers.length === cols.length
      ? params.headers.map(String)
      : cols;

    const fmt = String(params.format || 'markdown');
    let text;

    if (fmt === 'csv') {
      // 有自定义表头时，先按表头替换第一行
      const body = toCsv(sliced, cols, String(params.separator || ','), params.noHeader !== true);
      text = (params.headers?.length === cols.length && !params.noHeader)
        ? body.replace(/^.*$/m, headers.map((h) => csvEscape(h, String(params.separator || ','))).join(String(params.separator || ',')))
        : body;
    } else if (fmt === 'tsv') {
      text = toTsv(sliced, cols);
    } else if (fmt === 'list') {
      text = toList(sliced, cols);
    } else {
      text = toMarkdown(sliced, cols);
    }

    return {
      ok: true,
      data: {
        format: fmt,
        rows: sliced.length,
        total: rows.length,
        columns: cols,
        text,
      },
    };
  },
};