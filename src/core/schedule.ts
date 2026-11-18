/**
 * 内置调度器
 *
 * 把 run / batch / watch 挂到时间表，由 `forge schedule daemon` 常驻执行。
 *
 * 存储：~/.forgeapi/schedules.json
 * 结构：[{ id, name, kind, args, everySec | cron, enabled, lastRun, lastStatus, nextRun, runs }]
 *
 * 时间语义：
 *   everySec —— 固定间隔（从上一次执行完开始算）
 *   cron     —— 五字段 Vixie cron（分 时 日 月 周），本地时区
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { WorkspacePaths } from './types.js';
import { readJson, writeJson } from './workspace.js';

export type ScheduleKind = 'run' | 'batch' | 'watch' | 'pipeline';

export interface ScheduleEntry {
  id: string;
  name: string;
  kind: ScheduleKind;
  /** run: { plugin, params, command? }；batch: { file }；watch: { plugin, name?, params, key? } */
  args: Record<string, unknown>;
  /** 固定间隔秒（与 cron 二选一） */
  everySec?: number;
  /** 五字段 cron 表达式 */
  cron?: string;
  /** 本地时区偏移（分钟），默认读取系统 */
  tzOffsetMin?: number;
  enabled: boolean;
  createdAt: string;
  lastRun?: string;
  lastStatus?: 'ok' | 'fail';
  lastSummary?: string;
  nextRun?: string;
  runs: number;
  failures: number;
}

export interface ScheduleStore {
  version: 1;
  entries: ScheduleEntry[];
}

export function scheduleFile(paths: WorkspacePaths): string {
  return path.join(paths.root, 'schedules.json');
}

export function loadSchedules(paths: WorkspacePaths): ScheduleStore {
  const s = readJson<ScheduleStore>(scheduleFile(paths), { version: 1, entries: [] });
  return { version: 1, entries: Array.isArray(s.entries) ? s.entries : [] };
}

export function saveSchedules(paths: WorkspacePaths, store: ScheduleStore): void {
  writeJson(scheduleFile(paths), store);
}

/* ---------------- cron 解析 ---------------- */

interface CronSpec {
  minutes: number[];
  hours: number[];
  days: number[];
  months: number[];
  weekdays: number[];
}

/** 解析单个字段：支持 星号、单值、区间、区间加步长、星号加步长、逗号列表 */
function parseField(raw: string, min: number, max: number, field: string): number[] {
  const out = new Set<number>();
  for (const part of raw.split(',')) {
    const p = part.trim();
    if (!p) continue;
    if (p === '*') {
      for (let i = min; i <= max; i++) out.add(i);
      continue;
    }
    const stepMatch = /^(.*)\/(\d+)$/.exec(p);
    const step = stepMatch ? Number(stepMatch[2]) : 1;
    if (step <= 0) throw new Error(`cron ${field} 步长非法: ${p}`);
    const body = stepMatch ? stepMatch[1] : p;

    let from: number;
    let to: number;
    if (body === '*') {
      from = min; to = max;
    } else if (body.includes('-')) {
      const [a, b] = body.split('-').map((x) => Number(x));
      from = a; to = b;
    } else {
      from = Number(body); to = Number(body);
    }
    if (!Number.isFinite(from) || !Number.isFinite(to)) throw new Error(`cron ${field} 字段非法: ${p}`);
    if (from < min || to > max || from > to) throw new Error(`cron ${field} 越界: ${p}（允许 ${min}-${max}）`);
    for (let i = from; i <= to; i += step) out.add(i);
  }
  if (!out.size) throw new Error(`cron ${field} 为空`);
  return [...out].sort((a, b) => a - b);
}

export function parseCron(expr: string): CronSpec {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`cron 需要 5 个字段（分 时 日 月 周），收到 ${parts.length} 个`);
  const spec: CronSpec = {
    minutes: parseField(parts[0], 0, 59, '分钟'),
    hours: parseField(parts[1], 0, 23, '小时'),
    days: parseField(parts[2], 1, 31, '日'),
    months: parseField(parts[3], 1, 12, '月'),
    weekdays: parseField(parts[4], 0, 6, '周'),
  };
  return spec;
}

/** 判断某时间点是否命中 cron（本地时间语义） */
export function cronMatches(spec: CronSpec, at: Date): boolean {
  if (!spec.minutes.includes(at.getMinutes())) return false;
  if (!spec.hours.includes(at.getHours())) return false;
  if (!spec.months.includes(at.getMonth() + 1)) return false;

  // 标准语义：日与周都受限时取"或"，否则取"且"
  const domRestricted = spec.days.length < 31;
  const dowRestricted = spec.weekdays.length < 7;
  const domOk = spec.days.includes(at.getDate());
  const dowOk = spec.weekdays.includes(at.getDay());

  if (domRestricted && dowRestricted) return domOk || dowOk;
  if (domRestricted) return domOk;
  if (dowRestricted) return dowOk;
  return true;
}

/** 下次触发时间（当前时间之后），最多向后找 366 天 */
export function nextCronTime(spec: CronSpec, from = new Date()): Date {
  const t = new Date(from.getTime());
  t.setSeconds(0, 0);
  t.setMinutes(t.getMinutes() + 1);
  const limit = 366 * 24 * 60;
  for (let i = 0; i < limit; i++) {
    if (cronMatches(spec, t)) return new Date(t.getTime());
    t.setMinutes(t.getMinutes() + 1);
  }
  throw new Error('cron 未来一年内无触发点');
}

/* ---------------- 条目管理 ---------------- */

export function computeNext(entry: ScheduleEntry, from = new Date()): Date | null {
  if (!entry.enabled) return null;
  if (entry.cron) {
    try { return nextCronTime(parseCron(entry.cron), from); } catch { return null; }
  }
  if (entry.everySec && entry.everySec > 0) {
    const base = entry.lastRun ? new Date(entry.lastRun) : new Date(entry.createdAt);
    const next = new Date(base.getTime() + entry.everySec * 1000);
    return next.getTime() > from.getTime() ? next : new Date(from.getTime() + entry.everySec * 1000);
  }
  return null;
}

export interface AddScheduleInput {
  name: string;
  kind: ScheduleKind;
  args: Record<string, unknown>;
  everySec?: number;
  cron?: string;
  enabled?: boolean;
}

export function addSchedule(paths: WorkspacePaths, input: AddScheduleInput): ScheduleEntry {
  if (!input.name) throw new Error('需要 --name');
  if (!input.everySec && !input.cron) throw new Error('需要 --every <秒> 或 --cron "<5 字段>"');
  if (input.everySec && input.cron) throw new Error('--every 与 --cron 只能二选一');
  if (input.everySec !== undefined && (!Number.isInteger(input.everySec) || input.everySec < 10)) {
    throw new Error('--every 需 ≥10 秒');
  }
  if (input.cron) parseCron(input.cron); // 语法校验

  const store = loadSchedules(paths);
  if (store.entries.some((e) => e.name === input.name)) {
    throw new Error(`同名调度已存在: ${input.name}（先 remove 或换名）`);
  }

  const entry: ScheduleEntry = {
    id: crypto.randomUUID(),
    name: input.name,
    kind: input.kind,
    args: input.args,
    ...(input.everySec ? { everySec: input.everySec } : {}),
    ...(input.cron ? { cron: input.cron } : {}),
    enabled: input.enabled !== false,
    createdAt: new Date().toISOString(),
    runs: 0,
    failures: 0,
  };
  const next = computeNext(entry);
  if (next) entry.nextRun = next.toISOString();

  store.entries.push(entry);
  saveSchedules(paths, store);
  return entry;
}

export function removeSchedule(paths: WorkspacePaths, nameOrId: string): boolean {
  const store = loadSchedules(paths);
  const i = store.entries.findIndex((e) => e.name === nameOrId || e.id === nameOrId);
  if (i < 0) return false;
  store.entries.splice(i, 1);
  saveSchedules(paths, store);
  return true;
}

export function setEnabled(paths: WorkspacePaths, nameOrId: string, enabled: boolean): ScheduleEntry | null {
  const store = loadSchedules(paths);
  const e = store.entries.find((x) => x.name === nameOrId || x.id === nameOrId);
  if (!e) return null;
  e.enabled = enabled;
  const next = computeNext(e);
  e.nextRun = next ? next.toISOString() : undefined;
  saveSchedules(paths, store);
  return e;
}

export function markRun(
  paths: WorkspacePaths,
  nameOrId: string,
  result: { ok: boolean; summary: string; at?: Date },
): ScheduleEntry | null {
  const store = loadSchedules(paths);
  const e = store.entries.find((x) => x.name === nameOrId || x.id === nameOrId);
  if (!e) return null;
  e.lastRun = (result.at || new Date()).toISOString();
  e.lastStatus = result.ok ? 'ok' : 'fail';
  e.lastSummary = result.summary.slice(0, 500);
  e.runs += 1;
  if (!result.ok) e.failures += 1;
  const next = computeNext(e, new Date());
  e.nextRun = next ? next.toISOString() : undefined;
  saveSchedules(paths, store);
  return e;
}

/** 找出到期该跑的条目（nextRun <= now） */
export function dueEntries(paths: WorkspacePaths, now = new Date()): ScheduleEntry[] {
  const store = loadSchedules(paths);
  return store.entries.filter((e) => {
    if (!e.enabled) return false;
    const next = e.nextRun ? new Date(e.nextRun) : computeNext(e, now);
    if (!next) return false;
    return next.getTime() <= now.getTime();
  });
}