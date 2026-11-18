import type { MergeDef, SourceDef } from './types.js';
import { jsonpath } from './extract.js';

/** 从任意对象取字段值（支持 a.b.c） */
export function pick(obj: unknown, key: string): unknown {
  if (!obj || typeof obj !== 'object') return undefined;
  if (Object.prototype.hasOwnProperty.call(obj, key)) return (obj as any)[key];
  let cur: any = obj;
  for (const part of key.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[part];
  }
  return cur;
}

function dedupeKey(item: Record<string, unknown>, m: MergeDef): string {
  const candidates = m.strategy === 'dedupe_by_title'
    ? [m.key, '标题', 'title', 'name', '摘要']
    : [m.key, ...(m.fields || []), 'id', '链接', 'url'];
  for (const c of candidates) {
    if (!c) continue;
    const v = pick(item, c);
    if (v !== undefined && v !== null && v !== '') {
      return String(v).toLowerCase().replace(/\s+/g, ' ').trim();
    }
  }
  return '';
}

function normalize(item: unknown, fields: string[] | undefined, keyMap: Record<string, string> | undefined): Record<string, unknown> {
  if (!item || typeof item !== 'object') return { value: item };
  const src = item as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (fields?.length) {
    for (const f of fields) out[keyMap?.[f] || f] = pick(src, f) ?? null;
    return out;
  }
  for (const [k, v] of Object.entries(src)) out[keyMap?.[k] || k] = v;
  return out;
}

export interface AggregateInput {
  name: string;
  items: unknown[];
  error?: string;
}

export interface AggregateOutput {
  results: Record<string, unknown>[];
  total: number;
  sources: { name: string; count: number; error?: string }[];
}

export function mergeResults(inputs: AggregateInput[], merge: MergeDef, keyMap?: Record<string, string>): AggregateOutput {
  const sources = inputs.map((i) => ({ name: i.name, count: i.items.length, error: i.error }));
  const noKey: Record<string, unknown>[] = [];
  const flat: Record<string, unknown>[] = [];

  for (const inp of inputs) {
    for (const it of inp.items) {
      const norm = normalize(it, merge.fields, keyMap);
      if (!('来源' in norm) || norm['来源'] === null) norm['来源'] = inp.name;
      flat.push(norm);
    }
  }

  let results: Record<string, unknown>[];

  if (merge.strategy === 'dedupe_by_title' || merge.strategy === 'dedupe_by_key') {
    const seen = new Map<string, Record<string, unknown>>();
    for (const item of flat) {
      const k = dedupeKey(item, merge);
      if (!k) { noKey.push(item); continue; }
      const prev = seen.get(k);
      if (!prev) { seen.set(k, { ...item }); continue; }
      for (const [f, v] of Object.entries(item)) {
        const pv = prev[f];
        if (pv === undefined || pv === null || pv === '') { prev[f] = v; continue; }
        if (f === '来源' || f === 'source') {
          const arr = String(pv).split(',').map((s) => s.trim()).filter(Boolean);
          const nv = String(v);
          if (!arr.includes(nv)) { arr.push(nv); prev[f] = arr.join(','); }
        }
      }
    }
    results = [...seen.values(), ...noKey];
  } else if (merge.strategy === 'first_nonempty') {
    results = flat.length ? [flat[0]] : [];
  } else {
    results = flat;
  }

  if (merge.sortBy) {
    const k = merge.sortBy;
    results.sort((a, b) => String(pick(a, k) ?? '').localeCompare(String(pick(b, k) ?? '')));
  }
  if (merge.limit && results.length > merge.limit) results = results.slice(0, merge.limit);

  return { results, total: results.length, sources };
}

/** 从响应体中按类型抽取数组 */
export function itemsFromBody(body: unknown, source: SourceDef): unknown[] {
  if (body === null || body === undefined) return [];
  if (source.jsonpath) {
    const v = jsonpath(body, source.jsonpath);
    if (v.length === 1 && Array.isArray(v[0])) return v[0];
    return v;
  }
  if (Array.isArray(body)) return body;
  if (typeof body === 'object') {
    for (const k of ['data', 'results', 'items', 'list', 'hits', 'records', 'rows']) {
      const v = (body as any)[k];
      if (Array.isArray(v)) return v;
      if (v && typeof v === 'object') {
        for (const k2 of ['results', 'items', 'list', 'hits', 'data']) {
          if (Array.isArray((v as any)[k2])) return (v as any)[k2];
        }
      }
    }
    return [body];
  }
  return [body];
}
