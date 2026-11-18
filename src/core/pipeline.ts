/**
 * 插件编排（pipeline）
 *
 * 声明式工作流：把多个插件/批量任务串成一条数据管线。
 *
 * 变量语法（在 params 里任意位置）：
 *   ${input.foo}                 —— 调用时传入的输入参数
 *   ${steps.<id>.data...}        —— 某步骤的输出（可点路径 + 数组索引）
 *   ${item.foo} / ${index}       —— forEach 当前元素 / 序号
 *   ${env:NAME} / ${cred:KEY}    —— 环境变量 / 凭据
 *
 * 纯引用（整串只有一个占位符）保留原始类型（对象/数组原样传入）。
 */
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import type { WorkspacePaths } from './types.js';

export type OnError = 'abort' | 'continue' | 'skip';

export interface PipelineStep {
  /** 步骤 id（作为变量引用名；缺省用 index-<n>） */
  id?: string;
  /** 插件名 */
  plugin: string;
  /** 可选子命令 */
  command?: string;
  /** 参数模板（支持变量插值） */
  params?: Record<string, unknown>;
  /**
   * 循环：值可以是
   *   - 变量引用字符串（解析为数组）
   *   - 数组字面量
   * 每轮把当前元素注入 ${item}
   */
  forEach?: unknown;
  /** forEach 最多处理多少条（支持变量，如 "${input.limit}"） */
  limit?: number | string;
  /** 循环并发数（默认 1，串行） */
  concurrency?: number;
  /** 失败策略，默认继承 pipeline.onError */
  onError?: OnError;
  /** 给该步骤输出加个筛选（点路径），只保留需要的部分，减小体积 */
  pick?: string;
  /** 跳过条件：解析后为真则跳过该步骤（支持变量） */
  when?: unknown;
}

export interface PipelineDef {
  name?: string;
  description?: string;
  /** 输入参数默认值（可被调用时的 input 覆盖） */
  input?: Record<string, unknown>;
  /** 默认失败策略 */
  onError?: OnError;
  steps: PipelineStep[];
  /** 输出模板；缺省输出 { steps: {...} } */
  output?: unknown;
}

export interface PipelineStepResult {
  id: string;
  plugin: string;
  command?: string;
  ok: boolean;
  skipped?: boolean;
  data?: unknown;
  error?: string;
  ms: number;
  /** forEach 时是每轮结果 */
  items?: PipelineStepResult[];
  count?: number;
}

export interface PipelineResult {
  ok: boolean;
  name?: string;
  steps: PipelineStepResult[];
  output?: unknown;
  error?: string;
  ms: number;
}

/* ---------------- 载入 ---------------- */

export function readPipeline(file: string): PipelineDef {
  const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  let def: any;
  if (/\.ya?ml$/i.test(file)) def = yaml.load(raw);
  else {
    try { def = JSON.parse(raw); }
    catch { def = yaml.load(raw); } // 无扩展名时回退 YAML
  }
  return normalizePipeline(def);
}

export function normalizePipeline(def: any): PipelineDef {
  if (!def || typeof def !== 'object') throw new Error('pipeline 定义必须是对象');
  if (!Array.isArray(def.steps) || !def.steps.length) throw new Error('pipeline 需要非空 steps 数组');

  const steps: PipelineStep[] = def.steps.map((s: any, i: number) => {
    if (!s || typeof s !== 'object') throw new Error(`第 ${i + 1} 个步骤必须是对象`);
    if (!s.plugin || typeof s.plugin !== 'string') throw new Error(`第 ${i + 1} 个步骤缺少 plugin`);
    return {
      id: s.id ? String(s.id) : `step${i + 1}`,
      plugin: s.plugin,
      command: s.command ? String(s.command) : undefined,
      params: (s.params && typeof s.params === 'object') ? s.params : {},
      forEach: s.forEach,
      limit: s.limit !== undefined ? s.limit : undefined,
      concurrency: s.concurrency !== undefined ? Math.max(1, Number(s.concurrency)) : 1,
      onError: s.onError,
      pick: s.pick ? String(s.pick) : undefined,
      when: s.when,
    };
  });

  return {
    name: def.name ? String(def.name) : undefined,
    description: def.description ? String(def.description) : undefined,
    input: def.input && typeof def.input === 'object' ? def.input : {},
    onError: def.onError || 'abort',
    steps,
    output: def.output,
  };
}

/* ---------------- 变量解析 ---------------- */

/** 按点路径取值，支持 `a.b[0].c` 与纯数字索引 */
export function getPath(root: unknown, expr: string): unknown {
  if (!expr) return root;
  const parts: (string | number)[] = [];
  for (const seg of expr.split('.')) {
    const m = /^([^[\]]*)((?:\[\d+\])*)$/.exec(seg);
    if (!m) { parts.push(seg); continue; }
    if (m[1]) parts.push(m[1]);
    for (const idx of m[2].matchAll(/\[(\d+)\]/g)) parts.push(Number(idx[1]));
  }

  let cur: any = root;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof p === 'number') {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[p];
    } else {
      cur = cur[p];
    }
  }
  return cur;
}

interface ResolveCtx {
  input: Record<string, unknown>;
  steps: Record<string, unknown>;
  item?: unknown;
  index?: number;
  cred?: (k: string) => string | undefined;
}

function lookup(expr: string, ctx: ResolveCtx): unknown {
  const e = expr.trim();
  if (e.startsWith('env:')) return process.env[e.slice(4)];
  if (e.startsWith('cred:')) return ctx.cred?.(e.slice(5));
  if (e === 'index') return ctx.index;
  if (e === 'item') return ctx.item;

  if (e.startsWith('input.')) return getPath(ctx.input, e.slice(6));
  if (e === 'input') return ctx.input;

  if (e.startsWith('steps.')) return getPath(ctx.steps, e.slice(6));
  if (e.startsWith('item.')) return getPath(ctx.item, e.slice(5));

  // 顶层：先找 steps，再找 input
  if (Object.prototype.hasOwnProperty.call(ctx.steps, e)) return ctx.steps[e];
  if (Object.prototype.hasOwnProperty.call(ctx.input, e)) return ctx.input[e];
  return undefined;
}

/** 把模板里的 ${...} 全部替换；纯引用保留原类型 */
export function resolveTemplate(tpl: unknown, ctx: ResolveCtx): unknown {
  if (typeof tpl !== 'string') {
    if (Array.isArray(tpl)) return tpl.map((v) => resolveTemplate(v, ctx));
    if (tpl && typeof tpl === 'object') {
      const o: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(tpl as Record<string, unknown>)) o[k] = resolveTemplate(v, ctx);
      return o;
    }
    return tpl;
  }

  const pure = /^\$\{([^}]+)\}$/.exec(tpl);
  if (pure) return lookup(pure[1], ctx);

  return tpl.replace(/\$\{([^}]+)\}/g, (_m, expr: string) => {
    const v = lookup(expr, ctx);
    if (v === undefined || v === null) return '';
    return typeof v === 'object' ? JSON.stringify(v) : String(v);
  });
}

/** `when` 判定：解析后按 JS 真值 */
export function isTruthy(v: unknown): boolean {
  if (v === undefined || v === null || v === '' || v === 0 || v === false) return false;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

/* ---------------- 执行 ---------------- */

export type StepRunner = (
  plugin: string,
  command: string | undefined,
  params: Record<string, unknown>,
) => Promise<{ ok: boolean; data?: unknown; error?: string; ms: number }>;

export interface RunPipelineOptions {
  input?: Record<string, unknown>;
  cred?: (k: string) => string | undefined;
  onStep?: (ev: { step: string; state: 'start' | 'ok' | 'fail' | 'skip'; index?: number; total?: number }) => void;
}

export async function runPipeline(
  def: PipelineDef,
  runner: StepRunner,
  opts: RunPipelineOptions = {},
): Promise<PipelineResult> {
  const t0 = Date.now();
  const input = { ...(def.input || {}), ...(opts.input || {}) };
  const stepsOut: Record<string, unknown> = {};
  const results: PipelineStepResult[] = [];

  for (const step of def.steps) {
    const onError = step.onError || def.onError || 'abort';
    const baseCtx: ResolveCtx = { input, steps: stepsOut, cred: opts.cred };

    // when 跳过
    if (step.when !== undefined) {
      const cond = resolveTemplate(step.when, baseCtx);
      if (!isTruthy(cond)) {
        const r: PipelineStepResult = { id: step.id!, plugin: step.plugin, command: step.command, ok: true, skipped: true, ms: 0 };
        results.push(r);
        stepsOut[step.id!] = { skipped: true };
        opts.onStep?.({ step: step.id!, state: 'skip' });
        continue;
      }
    }

    // forEach
    if (step.forEach !== undefined) {
      const arrRaw = resolveTemplate(step.forEach, baseCtx);
      const arr = Array.isArray(arrRaw) ? arrRaw : (arrRaw === undefined || arrRaw === null ? [] : [arrRaw]);
      // limit 支持变量：数字直用，字符串先解析（"${input.limit}" → 3）
      const limitN = step.limit === undefined
        ? 0
        : (typeof step.limit === 'number' ? step.limit : Number(resolveTemplate(step.limit, baseCtx)) || 0);
      const sliced = limitN > 0 ? arr.slice(0, limitN) : arr;

      opts.onStep?.({ step: step.id!, state: 'start', index: 0, total: sliced.length });

      const itemResults: PipelineStepResult[] = [];
      const conc = Math.max(1, step.concurrency || 1);
      let cursor = 0;
      let failed = 0;

      const worker = async (): Promise<void> => {
        for (;;) {
          const i = cursor++;
          if (i >= sliced.length) return;
          const itemCtx: ResolveCtx = { input, steps: stepsOut, item: sliced[i], index: i, cred: opts.cred };
          const params = (resolveTemplate(step.params || {}, itemCtx) as Record<string, unknown>) || {};
          const s = Date.now();
          let out: { ok: boolean; data?: unknown; error?: string; ms: number };
          try {
            out = await runner(step.plugin, step.command, params);
          } catch (e) {
            out = { ok: false, error: (e as Error).message, ms: Date.now() - s };
          }
          const one: PipelineStepResult = {
            id: `${step.id}[${i}]`,
            plugin: step.plugin,
            command: step.command,
            ok: out.ok,
            // pick 是相对 data 的点路径，只保留需要的部分
            data: step.pick ? getPath(out.data, step.pick) : out.data,
            error: out.error,
            ms: out.ms ?? Date.now() - s,
          };
          if (!out.ok) failed++;
          itemResults[i] = one;
        }
      };
      await Promise.all(Array.from({ length: Math.min(conc, sliced.length || 1) }, () => worker()));

      const okAll = failed === 0;
      const stepResult: PipelineStepResult = {
        id: step.id!,
        plugin: step.plugin,
        command: step.command,
        ok: okAll,
        items: itemResults.filter(Boolean),
        count: itemResults.filter(Boolean).length,
        ms: itemResults.reduce((a, b) => a + (b?.ms || 0), 0),
        ...(okAll ? {} : { error: `${failed}/${sliced.length} 条失败` }),
      };
      results.push(stepResult);
      stepsOut[step.id!] = stepResult;

      if (!okAll) {
        opts.onStep?.({ step: step.id!, state: 'fail' });
        if (onError === 'abort') {
          return { ok: false, name: def.name, steps: results, error: `步骤 ${step.id} 有 ${failed} 条失败`, ms: Date.now() - t0 };
        }
      } else {
        opts.onStep?.({ step: step.id!, state: 'ok' });
      }
      continue;
    }

    // 单次执行
    opts.onStep?.({ step: step.id!, state: 'start' });
    const params = (resolveTemplate(step.params || {}, baseCtx) as Record<string, unknown>) || {};
    const s = Date.now();
    let out: { ok: boolean; data?: unknown; error?: string; ms: number };
    try {
      out = await runner(step.plugin, step.command, params);
    } catch (e) {
      out = { ok: false, error: (e as Error).message, ms: Date.now() - s };
    }

    const stepResult: PipelineStepResult = {
      id: step.id!,
      plugin: step.plugin,
      command: step.command,
      ok: out.ok,
      data: step.pick ? getPath(out.data, step.pick) : out.data,
      error: out.error,
      ms: out.ms ?? Date.now() - s,
    };
    results.push(stepResult);
    stepsOut[step.id!] = stepResult;

    if (!out.ok) {
      opts.onStep?.({ step: step.id!, state: 'fail' });
      if (onError === 'abort') {
        return { ok: false, name: def.name, steps: results, error: `步骤 ${step.id} 失败: ${out.error}`, ms: Date.now() - t0 };
      }
    } else {
      opts.onStep?.({ step: step.id!, state: 'ok' });
    }
  }

  // 输出模板
  const outCtx: ResolveCtx = { input, steps: stepsOut, cred: opts.cred };
  const output = def.output !== undefined ? resolveTemplate(def.output, outCtx) : { steps: stepsOut };

  return { ok: true, name: def.name, steps: results, output, ms: Date.now() - t0 };
}

/** 从 pipeline 结果里挑一个步骤的结果（便于提取主数据） */
export function stepResultOf(result: PipelineResult, id: string): unknown {
  return result.steps.find((s) => s.id === id);
}