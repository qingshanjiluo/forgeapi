/**
 * csv —— CSV / TSV 读取 → JSON
 *
 * 补 `out`（JSON → CSV）的反向：把本地文件或 URL 上的表格读成结构化数据。
 * 零依赖：手写 RFC 4180 解析（引号、双写引号、字段内换行、CRLF）。
 */
import fs from 'node:fs';

function detectDelimiter(sample, hint) {
  if (hint && hint !== 'auto') {
    return hint === 'tab' ? '\t' : hint === 'semicolon' ? ';' : hint === 'pipe' ? '|' : ',';
  }
  const firstLine = sample.split(/\r?\n/)[0] || '';
  const counts = {
    ',': (firstLine.match(/,/g) || []).length,
    '\t': (firstLine.match(/\t/g) || []).length,
    ';': (firstLine.match(/;/g) || []).length,
    '|': (firstLine.match(/\|/g) || []).length,
  };
  let best = ',';
  let max = 0;
  for (const [d, c] of Object.entries(counts)) {
    if (c > max) { max = c; best = d; }
  }
  return best;
}

/** RFC 4180 解析：支持引号、双写引号、字段内换行 */
function parseCsv(text, delim) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];

    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += c;
      }
      continue;
    }

    if (c === '"') { inQuotes = true; continue; }
    if (c === delim) { row.push(field); field = ''; continue; }
    if (c === '\r') { continue; }
    if (c === '\n') {
      row.push(field);
      field = '';
      // 跳过全空行
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
      continue;
    }
    field += c;
  }
  // 最后一行
  if (field !== '' || row.length) {
    row.push(field);
    if (row.length > 1 || row[0] !== '') rows.push(row);
  }
  return rows;
}

function coerce(v, inferTypes) {
  if (!inferTypes) return v;
  const s = String(v).trim();
  if (s === '') return null;
  if (/^-?\d+$/.test(s)) {
    const n = Number(s);
    return Number.isSafeInteger(n) ? n : s;
  }
  if (/^-?\d+\.\d+$/.test(s)) return Number(s);
  if (/^(true|false)$/i.test(s)) return s.toLowerCase() === 'true';
  if (/^(null|nil|none)$/i.test(s)) return null;
  return v;
}

export default {
  name: 'csv',
  version: '0.1.0',
  description: 'CSV/TSV 读取 → JSON：本地文件或 URL，自动识别分隔符，可选类型推断',
  permissions: ['fs-read', 'net'],
  schema: {
    type: 'object',
    properties: {
      file: { type: 'string', description: '本地 CSV/TSV 路径' },
      url: { type: 'string', description: '远程 CSV/TSV 地址（与 file 二选一）' },
      delimiter: { type: 'string', description: '分隔符：auto / comma / tab / semicolon / pipe，或直接给字符', default: 'auto' },
      header: { type: 'boolean', description: '首行是否为表头', default: true },
      columns: { type: 'array', items: { type: 'string' }, description: '自定义列名（header=false 时用）' },
      inferTypes: { type: 'boolean', description: '自动推断数字/布尔/null', default: true },
      limit: { type: 'integer', description: '最多返回多少行' },
      skipEmpty: { type: 'boolean', description: '跳过全空行', default: true },
      encoding: { type: 'string', description: '文件编码（仅支持 utf8 / latin1）', default: 'utf8' },
    },
  },

  async execute(params, ctx) {
    let text;
    let source;

    if (params.file) {
      const f = String(params.file);
      if (!fs.existsSync(f)) return { ok: false, error: `文件不存在: ${f}` };
      text = fs.readFileSync(f, params.encoding === 'latin1' ? 'latin1' : 'utf8');
      source = f;
    } else if (params.url) {
      const u = String(params.url);
      ctx.progress(`下载 ${u}`);
      const r = await fetch(u, { headers: { 'user-agent': 'ForgeAPI/0.13 (+local)' } });
      if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
      text = await r.text();
      source = u;
    } else {
      return { ok: false, error: '需要 file 或 url' };
    }

    // 剥 BOM
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);

    const delim = detectDelimiter(text.slice(0, 4096), params.delimiter);
    ctx.log('debug', `分隔符 = ${JSON.stringify(delim)}`);

    let rows = parseCsv(text, delim);
    if (params.skipEmpty !== false) {
      rows = rows.filter((r) => r.some((c) => String(c).trim() !== ''));
    }

    let headers = null;
    let dataRows = rows;

    if (params.header !== false) {
      if (!rows.length) return { ok: false, error: '文件为空' };
      headers = rows[0].map((h, i) => String(h).trim() || `col${i + 1}`);
      dataRows = rows.slice(1);
    } else if (Array.isArray(params.columns) && params.columns.length) {
      headers = params.columns.map(String);
    } else {
      const width = rows.reduce((m, r) => Math.max(m, r.length), 0);
      headers = Array.from({ length: width }, (_v, i) => `col${i + 1}`);
    }

    // 列数不一致时补齐 / 截断
    const records = dataRows.map((r) => {
      const o = {};
      for (let i = 0; i < headers.length; i++) {
        o[headers[i]] = i < r.length ? coerce(r[i], params.inferTypes !== false) : null;
      }
      return o;
    });

    const limit = params.limit ? Number(params.limit) : 0;
    const sliced = limit > 0 ? records.slice(0, limit) : records;

    return {
      ok: true,
      data: sliced,
      meta: {
        source,
        delimiter: delim === '\t' ? 'tab' : delim,
        columns: headers,
        total: records.length,
        returned: sliced.length,
      },
    };
  },
};