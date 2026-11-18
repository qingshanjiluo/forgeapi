import * as cheerio from 'cheerio';
import type { AnyNode, Element } from 'domhandler';
import type { FieldRule, SelectorKind } from './types.js';

/* ---------------- JSONPath 迷你实现 ---------------- */

type Json = any;

function jsonpathWalk(root: Json, expr: string): Json[] {
  let path = expr.trim();
  if (path.startsWith('$')) path = path.slice(1);
  let nodes: Json[] = [root];
  const tokens: string[] = [];
  // 拆 $.a.b[0].c / a[*] / $.a..b
  let buf = '';
  for (let i = 0; i < path.length; i++) {
    const c = path[i];
    if (c === '.') {
      if (path[i + 1] === '.') {
        if (buf) tokens.push(buf), (buf = '');
        tokens.push('..');
        i++;
      } else {
        if (buf) tokens.push(buf), (buf = '');
      }
    } else if (c === '[') {
      if (buf) tokens.push(buf), (buf = '');
      let j = i + 1, inner = '';
      while (j < path.length && path[j] !== ']') inner += path[j++];
      tokens.push(`[${inner}]`);
      i = j;
    } else {
      buf += c;
    }
  }
  if (buf) tokens.push(buf);

  for (const t of tokens) {
    if (!t) continue;
    if (t === '..') {
      const all: Json[] = [];
      const collect = (n: Json) => {
        if (n === null || n === undefined) return;
        all.push(n);
        if (Array.isArray(n)) n.forEach(collect);
        else if (typeof n === 'object') Object.values(n).forEach(collect);
      };
      nodes.forEach(collect);
      nodes = all;
      continue;
    }
    if (t.startsWith('[')) {
      const inner = t.slice(1, -1).trim();
      const next: Json[] = [];
      for (const n of nodes) {
        if (!Array.isArray(n)) continue;
        if (inner === '*' || inner === '') next.push(...n);
        else if (/^-?\d+$/.test(inner)) {
          const idx = Number(inner);
          const v = idx < 0 ? n[n.length + idx] : n[idx];
          if (v !== undefined) next.push(v);
        } else if (inner.includes(':')) {
          const [a, b] = inner.split(':');
          const s = a ? Number(a) : 0;
          const e = b ? Number(b) : n.length;
          next.push(...n.slice(s, e));
        } else {
          // ['key'] 形式
          const key = inner.replace(/^['"]|['"]$/g, '');
          for (const item of n) {
            if (item && typeof item === 'object' && key in item) next.push(item[key]);
          }
        }
      }
      nodes = next;
      continue;
    }
    const next: Json[] = [];
    for (const n of nodes) {
      if (n && typeof n === 'object' && t in n) next.push((n as any)[t]);
    }
    nodes = next;
  }
  return nodes;
}

export function jsonpath(root: Json, expr: string): Json[] {
  const out = jsonpathWalk(root, expr);
  return out.filter((v) => v !== undefined);
}

/* ---------------- 选择器类型识别 ---------------- */

export function detectKind(selector: string, explicit?: SelectorKind): SelectorKind {
  if (explicit) return explicit;
  if (selector.startsWith('$') || selector.startsWith('..')) return 'jsonpath';
  if (selector.startsWith('/') || selector.startsWith('//') || selector.startsWith('(')) return 'xpath';
  if (selector.startsWith('re:')) return 'regex';
  return 'css';
}

/* ---------------- 值处理 ---------------- */

function transformValue(v: string, rule: FieldRule): unknown {
  switch (rule.transform) {
    case 'trim': return v.trim();
    case 'lower': return v.toLowerCase();
    case 'upper': return v.toUpperCase();
    case 'number': {
      const m = v.replace(/[,\s]/g, '').match(/-?\d+(\.\d+)?/);
      return m ? Number(m[0]) : null;
    }
    case 'json': try { return JSON.parse(v); } catch { return null; }
    case 'none': return v;
    default: return v.trim();
  }
}

function coerceType(v: unknown, rule: FieldRule): unknown {
  if (v === null || v === undefined) return null;
  if (rule.type === 'number') {
    if (typeof v === 'number') return v;
    const m = String(v).replace(/[,\s]/g, '').match(/-?\d+(\.\d+)?/);
    return m ? Number(m[0]) : null;
  }
  if (rule.type === 'bool') {
    if (typeof v === 'boolean') return v;
    const s = String(v).trim().toLowerCase();
    return ['true', '1', 'yes', 'y', '是', '有'].includes(s);
  }
  if (typeof v === 'string' && rule.transform) return transformValue(v, rule);
  if (typeof v === 'string') return v.trim();
  return v;
}

/* ---------------- HTML 字段提取 ---------------- */

function textOf($: cheerio.CheerioAPI, el: cheerio.Cheerio<AnyNode>): string {
  return el.text().replace(/\s+/g, ' ').trim();
}

function extractLeaf($: cheerio.CheerioAPI, scope: cheerio.Cheerio<AnyNode> | null, rule: FieldRule, html: string): unknown {
  const kind = detectKind(rule.selector || '', rule.kind);
  const sel = (rule.selector || '').trim();

  // 空选择器 = 当前节点自身
  if (!sel && kind !== 'regex') {
    if (!scope) return rule.optional ? undefined : null;
    if (rule.type === 'html') return scope.html() ?? '';
    if (rule.type === 'attr') return rule.attr ? scope.attr(rule.attr) ?? null : null;
    if (rule.type === 'url') return scope.attr('href') ?? scope.attr('src') ?? null;
    if (rule.type === 'list') {
      const out: unknown[] = [];
      scope.each((_i: number, node: AnyNode) => {
        out.push(coerceType(textOf($, $(node)), rule));
      });
      return out;
    }
    return coerceType(textOf($, scope), rule);
  }

  if (kind === 'regex') {
    const pattern = sel.replace(/^re:/, '');
    const target = scope ? scope.text() : html;
    const re = new RegExp(pattern, 'g');
    const all = [...target.matchAll(re)].map((m) => m[Number(rule.group ?? 1)] ?? m[0]);
    if (rule.type === 'list') return all.slice(0, rule.limit ?? all.length).map((v) => coerceType(v, rule));
    return all.length ? coerceType(all[0], rule) : null;
  }

  const base = scope ?? $.root();

  if (rule.type === 'list') {
    const nodes = kind === 'xpath' ? [] : base.find(sel);
    const out: unknown[] = [];
    (nodes as cheerio.Cheerio<AnyNode>).each((_i: number, node: AnyNode) => {
      const item = $(node);
      if (rule.fields && rule.fields.length) {
        const obj: Record<string, unknown> = {};
        for (const f of rule.fields) obj[f.name] = extractLeaf($, item, f, html);
        out.push(obj);
      } else {
        out.push(coerceType(textOf($, item), rule));
      }
    });
    return rule.limit ? out.slice(0, rule.limit) : out;
  }

  const found = scope ? scope.find(sel).first() : $(sel).first();
  if (!found.length) return rule.optional ? undefined : null;

  if (rule.type === 'html') return found.html() ?? '';
  if (rule.type === 'attr') return rule.attr ? found.attr(rule.attr) ?? null : null;
  if (rule.type === 'url') return found.attr('href') ?? found.attr('src') ?? null;
  const raw = textOf($, found);
  return coerceType(raw, rule);
}

export interface ExtractOptions {
  root?: string;
  rootKind?: SelectorKind;
}

export function extractFromHtml(html: string, fields: FieldRule[], opts: ExtractOptions = {}): Record<string, unknown> {
  const $ = cheerio.load(html);
  let scope: cheerio.Cheerio<AnyNode> | null = null;
  if (opts.root) {
    scope = $(opts.root);
  }
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const v = extractLeaf($, scope, f, html);
    if (v === undefined) continue;
    out[f.name] = v;
  }
  return out;
}

/** 从 JSON 响应按字段规则提取（字段 selector 走 JSONPath） */
export function extractFromJson(json: unknown, fields: FieldRule[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const sel = f.selector || '$';
    if (f.type === 'list' && f.fields?.length) {
      const arr = jsonpath(json, sel).flatMap((v) => (Array.isArray(v) ? v : [v]));
      out[f.name] = arr.slice(0, f.limit ?? arr.length).map((item) => {
        const o: Record<string, unknown> = {};
        for (const sub of f.fields!) {
          const vals = jsonpath(item, sub.selector || '$');
          o[sub.name] = coerceType(vals[0] ?? null, sub);
        }
        return o;
      });
    } else {
      const vals = jsonpath(json, sel);
      if (!vals.length) {
        if (!f.optional) out[f.name] = null;
        continue;
      }
      out[f.name] = f.type === 'list' ? vals.map((v) => coerceType(v, f)) : coerceType(vals[0], f);
    }
  }
  return out;
}

/** 上下文变量替换：${VAR} / ${cred:KEY} / ${env:NAME}
 *  纯引用（整串只有一个占位符）返回原始值（保留对象/数组类型） */
export function interpolate(tpl: unknown, vars: Record<string, unknown>, cred?: (k: string) => string | undefined): unknown {
  if (typeof tpl !== 'string') {
    if (Array.isArray(tpl)) return tpl.map((v) => interpolate(v, vars, cred));
    if (tpl && typeof tpl === 'object') {
      const o: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(tpl as Record<string, unknown>)) o[k] = interpolate(v, vars, cred);
      return o;
    }
    return tpl;
  }
  const pure = tpl.match(/^\$\{([^}]+)\}$/);
  if (pure) {
    const e = pure[1].trim();
    if (e.startsWith('env:')) return process.env[e.slice(4)];
    if (e.startsWith('cred:')) return cred?.(e.slice(5));
    const v = vars[e];
    return v === undefined ? '' : v;
  }
  return tpl.replace(/\$\{([^}]+)\}/g, (_m, expr: string) => {
    const e = expr.trim();
    if (e.startsWith('env:')) return process.env[e.slice(4)] ?? '';
    if (e.startsWith('cred:')) return cred?.(e.slice(5)) ?? '';
    const v = vars[e];
    if (v === undefined || v === null) return '';
    return typeof v === 'object' ? JSON.stringify(v) : String(v);
  });
}
