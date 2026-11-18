/**
 * json-query —— 本地 JSON 查询与投影
 *
 * 不联网：对文件或传入的 JSON 做 JSONPath 取值、字段投影、排序、去重、过滤。
 * 用途：把上一个命令的 JSON 输出落盘后，做二次加工再交给下游。
 */
import fs from 'node:fs';

/* ---------- 迷你 JSONPath（支持 $、.a、[0]、[*]、..、[?(@.k==v)]） ---------- */

function parsePath(expr) {
  let p = String(expr).trim();
  if (p.startsWith('$')) p = p.slice(1);
  const tokens = [];
  let buf = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '.') {
      if (p[i + 1] === '.') {
        if (buf) { tokens.push(buf); buf = ''; }
        tokens.push('..');
        i++;
      } else if (buf) { tokens.push(buf); buf = ''; }
    } else if (c === '[') {
      if (buf) { tokens.push(buf); buf = ''; }
      let j = i + 1;
      let inner = '';
      let depth = 1;
      while (j < p.length) {
        if (p[j] === '[') depth++;
        if (p[j] === ']') { depth--; if (depth === 0) break; }
        inner += p[j++];
      }
      tokens.push(`[${inner}]`);
      i = j;
    } else {
      buf += c;
    }
  }
  if (buf) tokens.push(buf);
  return tokens;
}

function applyFilter(nodes, expr) {
  // 支持 @.k==v / @.k!=v / @.k>=v / 数字比较
  const m = /^@\.([\w.]+)\s*(==|!=|>=|<=|>|<)\s*(.+)$/.exec(expr.trim());
  if (!m) return [];
  const [, path, op, rawVal] = m;
  let val = rawVal.trim();
  if (/^['"].*['"]$/.test(val)) val = val.slice(1, -1);
  else if (/^-?\d+(\.\d+)?$/.test(val)) val = Number(val);
  else if (val === 'true' || val === 'false') val = val === 'true';

  const get = (o) => {
    let cur = o;
    for (const k of path.split('.')) {
      if (cur === null || cur === undefined) return undefined;
      cur = cur[k];
    }
    return cur;
  };

  return nodes.filter((n) => {
    const v = get(n);
    switch (op) {
      case '==': return v === val || String(v) === String(val);
      case '!=': return !(v === val || String(v) === String(val));
      case '>': return Number(v) > Number(val);
      case '<': return Number(v) < Number(val);
      case '>=': return Number(v) >= Number(val);
      case '<=': return Number(v) <= Number(val);
      default: return false;
    }
  });
}

function walkAll(root) {
  const out = [];
  const collect = (n) => {
    if (n === null || n === undefined) return;
    out.push(n);
    if (Array.isArray(n)) n.forEach(collect);
    else if (typeof n === 'object') Object.values(n).forEach(collect);
  };
  collect(root);
  return out;
}

export function jsonpath(root, expr) {
  if (!expr || expr === '$') return [root];
  let nodes = [root];
  for (const t of parsePath(expr)) {
    if (!t) continue;
    if (t === '..') { nodes = nodes.flatMap(walkAll); continue; }
    if (t.startsWith('[')) {
      const inner = t.slice(1, -1).trim();
      const next = [];
      for (const n of nodes) {
        if (inner === '*' || inner === '') {
          if (Array.isArray(n)) next.push(...n);
          else if (n && typeof n === 'object') next.push(...Object.values(n));
          continue;
        }
        if (inner.startsWith('?')) {
          // JSONPath 谓词： [?(...) ] → 去掉 ? 与外层括号再交给 applyFilter
          const cond = inner.slice(1).trim().replace(/^\(/, '').replace(/\)$/, '');
          next.push(...applyFilter(Array.isArray(n) ? n : [n], cond));
          continue;
        }
        if (/^-?\d+$/.test(inner)) {
          if (!Array.isArray(n)) continue;
          const idx = Number(inner);
          const v = idx < 0 ? n[n.length + idx] : n[idx];
          if (v !== undefined) next.push(v);
          continue;
        }
        if (inner.includes(':') && !inner.includes('(')) {
          if (!Array.isArray(n)) continue;
          const [a, b] = inner.split(':');
          next.push(...n.slice(a ? Number(a) : 0, b ? Number(b) : n.length));
          continue;
        }
        const key = inner.replace(/^['"]|['"]$/g, '');
        for (const item of (Array.isArray(n) ? n : [n])) {
          if (item && typeof item === 'object' && key in item) next.push(item[key]);
        }
      }
      nodes = next;
      continue;
    }
    const next = [];
    for (const n of nodes) {
      if (n && typeof n === 'object' && t in n) next.push(n[t]);
    }
    nodes = next;
  }
  return nodes.filter((v) => v !== undefined);
}

/* ---------- 投影与变换 ---------- */

function pick(obj, path) {
  if (!obj || typeof obj !== 'object') return undefined;
  if (Object.prototype.hasOwnProperty.call(obj, path)) return obj[path];
  let cur = obj;
  for (const k of String(path).split('.')) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[k];
  }
  return cur;
}

function project(items, fields) {
  if (!Array.isArray(fields) || !fields.length) return items;
  return items.map((it) => {
    if (!it || typeof it !== 'object') return { value: it };
    const o = {};
    for (const f of fields) {
      const key = typeof f === 'string' ? f : (f?.as || f?.field);
      const path = typeof f === 'string' ? f : f?.field;
      o[key] = pick(it, path);
    }
    return o;
  });
}

function sortItems(items, by, dir) {
  const d = String(dir || 'asc').toLowerCase() === 'desc' ? -1 : 1;
  return [...items].sort((a, b) => {
    const va = pick(a, by);
    const vb = pick(b, by);
    if (va === undefined || va === null) return 1;
    if (vb === undefined || vb === null) return -1;
    if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * d;
    return String(va).localeCompare(String(vb)) * d;
  });
}

function dedupe(items, key) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const k = key ? String(pick(it, key) ?? '') : JSON.stringify(it);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  return out;
}

export default {
  name: 'json-query',
  version: '0.1.0',
  description: '本地 JSON 查询：JSONPath 取值 + 字段投影 + 排序 + 去重 + 过滤（不联网）',
  permissions: ['fs-read'],
  schema: {
    type: 'object',
    properties: {
      file: { type: 'string', description: 'JSON 文件路径' },
      json: { description: '直接给 JSON 数据（与 file 二选一）' },
      path: { type: 'string', description: 'JSONPath，如 $.data.items 或 $..title' },
      fields: { type: 'array', items: { type: 'string' }, description: '要保留的字段（点路径）' },
      filter: { type: 'string', description: '过滤：@.price>100（JSONPath 谓词语法）' },
      sortBy: { type: 'string', description: '排序字段' },
      order: { type: 'string', enum: ['asc', 'desc'], default: 'asc' },
      uniqueBy: { type: 'string', description: '按该字段去重' },
      limit: { type: 'integer', description: '最多返回多少条' },
      flatten: { type: 'boolean', description: '结果只有 1 条时展开为对象', default: false },
    },
  },

  async execute(params, ctx) {
    let data = params.json;

    if (data === undefined && params.file) {
      const f = String(params.file);
      if (!fs.existsSync(f)) return { ok: false, error: `文件不存在: ${f}` };
      const raw = fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '');
      try { data = JSON.parse(raw); }
      catch (e) { return { ok: false, error: `不是合法 JSON: ${(e && e.message) || String(e)}` }; }
    }
    if (data === undefined) return { ok: false, error: '需要 file 或 json' };

    let items;

    if (params.path) {
      items = jsonpath(data, String(params.path));
      // JSONPath 命中"一个数组节点"时（如 $.results），展开成条目列表
      if (items.length === 1 && Array.isArray(items[0])) items = items[0];
      ctx.log('debug', `path=${params.path} 命中 ${items.length}`);
    } else {
      items = Array.isArray(data) ? data : [data];
    }

    // filter（JSONPath 谓词已在 path 里生效；这里支持独立 filter）
    if (params.filter) {
      const expr = String(params.filter).replace(/^\?\(|\)$/g, '');
      items = applyFilter(items, expr);
    }

    if (Array.isArray(params.fields) && params.fields.length) {
      items = project(items, params.fields);
    }

    if (params.uniqueBy) items = dedupe(items, String(params.uniqueBy));

    if (params.sortBy) items = sortItems(items, String(params.sortBy), params.order);

    const limit = params.limit ? Number(params.limit) : 0;
    if (limit > 0) items = items.slice(0, limit);

    const out = params.flatten && items.length === 1 ? items[0] : items;

    return {
      ok: true,
      data: out,
      meta: { count: items.length, path: params.path || null },
    };
  },
};