/**
 * transform —— 字段级表达式计算
 *
 * 抓到的原始数据往往要算成业务需要的形态（换算、拼接、条件标记）。
 * 当前 pipeline 只能搬运变量，不能计算 —— transform 补这一步。
 *
 * 用法：给一组「新字段名 → 表达式」，对每条数据求值。
 *   price_usd: "it.price / 7.2"
 *   label:     "it.name + ' (' + it.price + ')'"
 *   level:     "it.price > 1000 ? 'high' : 'low'"
 *
 * 表达式在受限函数内求值：可访问 it（当前条目）、i（序号）、all（全量）、F（内置函数）。
 */

const HELPERS = {
  round: (n, d = 0) => {
    const k = Math.pow(10, Number(d));
    return Math.round(Number(n) * k) / k;
  },
  floor: (n) => Math.floor(Number(n)),
  ceil: (n) => Math.ceil(Number(n)),
  abs: (n) => Math.abs(Number(n)),
  num: (v) => {
    if (typeof v === 'number') return v;
    const m = String(v ?? '').replace(/[,\s]/g, '').match(/-?\d+(\.\d+)?/);
    return m ? Number(m[0]) : 0;
  },
  str: (v) => (v === null || v === undefined ? '' : String(v)),
  lower: (v) => String(v ?? '').toLowerCase(),
  upper: (v) => String(v ?? '').toUpperCase(),
  trim: (v) => String(v ?? '').trim(),
  len: (v) => (Array.isArray(v) ? v.length : String(v ?? '').length),
  join: (arr, sep = ',') => (Array.isArray(arr) ? arr.join(sep) : String(arr ?? '')),
  split: (s, sep = ',') => String(s ?? '').split(sep),
  slice: (v, a, b) => (Array.isArray(v) ? v.slice(a, b) : String(v ?? '').slice(a, b)),
  replace: (s, a, b) => String(s ?? '').replace(a, b),
  includes: (s, sub) => String(s ?? '').includes(sub),
  match: (s, re) => {
    const m = String(s ?? '').match(new RegExp(re));
    return m ? m[0] : null;
  },
  pick: (obj, key, fallback = null) => (obj && typeof obj === 'object' && key in obj ? obj[key] : fallback),
  get: (obj, path, fallback = null) => {
    let cur = obj;
    for (const k of String(path).split('.')) {
      if (cur === null || cur === undefined) return fallback;
      cur = cur[k];
    }
    return cur === undefined ? fallback : cur;
  },
  now: () => new Date().toISOString(),
  date: (v) => {
    const d = v ? new Date(v) : new Date();
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  },
  has: (v) => v !== null && v !== undefined && v !== '',
  /** 简单条件选择 */
  ifelse: (cond, a, b) => (cond ? a : b),
  /** 数字区间映射 */
  scale: (n, inMin, inMax, outMin, outMax) =>
    outMin + ((Number(n) - inMin) / (inMax - inMin || 1)) * (outMax - outMin),
};

export default {
  name: 'transform',
  version: '0.1.0',
  description: '字段级表达式计算：对每条数据求值，生成换算/拼接/条件字段（不联网）',
  permissions: ['fs-read'],
  schema: {
    type: 'object',
    properties: {
      data: { description: '输入数据（数组或对象）；与 file 二选一' },
      file: { type: 'string', description: '读 JSON 文件' },
      expr: {
        type: 'object',
        description: '新字段 → 表达式，如 {"price_usd":"it.price / 7.2","label":"it.name + \'!\'"}',
      },
      keepOriginals: { type: 'boolean', description: '保留原字段（false 时只输出新字段）', default: true },
      onError: { type: 'string', enum: ['null', 'throw', 'skip'], description: '单个字段求值失败时的处理', default: 'null' },
      limit: { type: 'integer', description: '最多处理多少条' },
    },
    required: ['expr'],
  },

  async execute(params, ctx) {
    const exprs = params.expr;
    if (!exprs || typeof exprs !== 'object' || !Object.keys(exprs).length) {
      return { ok: false, error: '需要 expr（新字段 → 表达式）' };
    }

    // 载入数据
    let data = params.data;
    if (data === undefined && params.file) {
      const fs = await import('node:fs');
      const f = String(params.file);
      if (!fs.existsSync(f)) return { ok: false, error: `文件不存在: ${f}` };
      try { data = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '')); }
      catch (e) { return { ok: false, error: `不是合法 JSON: ${(e && e.message) || String(e)}` }; }
    }
    if (data === undefined) return { ok: false, error: '需要 data 或 file' };

    const rows = Array.isArray(data) ? data : [data];
    const limit = params.limit ? Number(params.limit) : 0;
    const targets = limit > 0 ? rows.slice(0, limit) : rows;
    const keepOriginals = params.keepOriginals !== false;
    const onError = String(params.onError || 'null');

    // 预编译表达式（一次编译，多次求值）
    const compiled = [];
    for (const [name, raw] of Object.entries(exprs)) {
      const src = String(raw);
      try {
        const body = `"use strict"; const {round,floor,ceil,abs,num,str,lower,upper,trim,len,join,split,slice,replace,includes,match,pick,get,now,date,has,ifelse,scale}=F; return (${src});`;
        // eslint-disable-next-line no-new-func
        const fn = new Function('it', 'i', 'all', 'F', body);
        compiled.push({ name, fn });
      } catch (e) {
        return { ok: false, error: `表达式编译失败 [${name}]: ${(e && e.message) || String(e)}` };
      }
    }
    ctx.log('debug', `编译 ${compiled.length} 条表达式`);

    const errors = [];
    const out = [];

    for (let i = 0; i < targets.length; i++) {
      const it = targets[i];
      const base =
        keepOriginals && it && typeof it === 'object' && !Array.isArray(it)
          ? { ...it }
          : {};

      for (const { name, fn } of compiled) {
        try {
          base[name] = fn(it, i, targets, HELPERS);
        } catch (e) {
          const msg = (e && e.message) || String(e);
          errors.push({ index: i, field: name, message: msg });
          if (onError === 'throw') return { ok: false, error: `第 ${i} 条 [${name}] 求值失败: ${msg}` };
          if (onError === 'null') base[name] = null;
          // skip: 不写该字段
        }
      }
      out.push(base);
    }

    return {
      ok: true,
      data: Array.isArray(data) ? out : out[0],
      meta: {
        rows: out.length,
        fields: compiled.map((c) => c.name),
        errors: errors.length ? errors.slice(0, 20) : undefined,
      },
    };
  },
};