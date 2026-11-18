import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  normalizePipeline, readPipeline, getPath, resolveTemplate, isTruthy,
  runPipeline, stepResultOf, type PipelineDef,
} from '../core/pipeline.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'forge-6x-'));
}

/* ---------------- 定义解析 ---------------- */

test('normalizePipeline 补默认 id 与参数', () => {
  const def = normalizePipeline({
    name: 'p1',
    steps: [
      { plugin: 'a' },
      { id: 'custom', plugin: 'b', params: { x: 1 } },
    ],
  });
  assert.equal(def.steps[0].id, 'step1');
  assert.equal(def.steps[1].id, 'custom');
  assert.deepEqual(def.steps[0].params, {});
  assert.equal(def.steps[0].concurrency, 1);
  assert.equal(def.onError, 'abort');
});

test('normalizePipeline 拒绝空 steps 与缺 plugin', () => {
  assert.throws(() => normalizePipeline({ steps: [] }), /非空 steps/);
  assert.throws(() => normalizePipeline({ steps: [{ id: 'x' }] }), /缺少 plugin/);
});

test('readPipeline 支持 YAML 与 JSON，且剥 BOM', () => {
  const dir = tmpDir();
  const yml = path.join(dir, 'a.yaml');
  fs.writeFileSync(yml, 'name: from-yaml\nsteps:\n  - plugin: p\n', 'utf8');
  assert.equal(readPipeline(yml).name, 'from-yaml');

  const js = path.join(dir, 'b.json');
  fs.writeFileSync(js, '\uFEFF{"name":"from-json","steps":[{"plugin":"p"}]}', 'utf8');
  assert.equal(readPipeline(js).name, 'from-json');
  fs.rmSync(dir, { recursive: true, force: true });
});

/* ---------------- 变量解析 ---------------- */

test('getPath 点路径与数组索引', () => {
  const obj = { a: { b: [{ c: 1 }, { c: 2 }] }, list: ['x', 'y'] };
  assert.equal(getPath(obj, 'a.b[1].c'), 2);
  assert.equal(getPath(obj, 'list[0]'), 'x');
  assert.equal(getPath(obj, 'a.b'), obj.a.b);
  assert.equal(getPath(obj, 'nope.x'), undefined);
  assert.equal(getPath(obj, ''), obj);
});

test('resolveTemplate 纯引用保留原类型', () => {
  const ctx = { input: { n: 5, obj: { k: 1 }, arr: [1, 2] }, steps: {} };
  assert.equal(resolveTemplate('${input.n}', ctx), 5);
  assert.deepEqual(resolveTemplate('${input.obj}', ctx), { k: 1 });
  assert.deepEqual(resolveTemplate('${input.arr}', ctx), [1, 2]);
});

test('resolveTemplate 混排字符串转文本', () => {
  const ctx = { input: { q: 'rust' }, steps: {} };
  assert.equal(resolveTemplate('搜索 ${input.q} 相关', ctx), '搜索 rust 相关');
  // 纯引用找不到 → undefined（保留类型语义，让插件自己判断缺失）
  assert.equal(resolveTemplate('${input.missing}', ctx), undefined);
  // 混排里找不到 → 空串（避免出现 "undefined" 字样）
  assert.equal(resolveTemplate('x${input.missing}y', ctx), 'xy');
});

test('resolveTemplate 递归处理对象与数组', () => {
  const ctx = { input: { q: 'x', n: 2 }, steps: {} };
  const out = resolveTemplate({ a: '${input.q}', b: ['${input.n}', 'static'], c: { d: '${input.q}' } }, ctx);
  assert.deepEqual(out, { a: 'x', b: [2, 'static'], c: { d: 'x' } });
});

test('resolveTemplate 支持 steps / item / index / env', () => {
  const ctx = {
    input: {},
    steps: { s1: { data: { v: 42 } } },
    item: { url: 'u1' },
    index: 3,
  };
  assert.equal(resolveTemplate('${steps.s1.data.v}', ctx), 42);
  assert.equal(resolveTemplate('${item.url}', ctx), 'u1');
  assert.equal(resolveTemplate('${index}', ctx), 3);
  process.env.FORGE_TEST_X = 'ev';
  assert.equal(resolveTemplate('${env:FORGE_TEST_X}', ctx), 'ev');
  delete process.env.FORGE_TEST_X;
});

test('isTruthy 判定规则', () => {
  assert.equal(isTruthy(true), true);
  assert.equal(isTruthy(1), true);
  assert.equal(isTruthy('x'), true);
  assert.equal(isTruthy([1]), true);
  assert.equal(isTruthy(false), false);
  assert.equal(isTruthy(0), false);
  assert.equal(isTruthy(''), false);
  assert.equal(isTruthy([]), false);
  assert.equal(isTruthy(null), false);
  assert.equal(isTruthy(undefined), false);
});

/* ---------------- 执行 ---------------- */

const fakeRunner = (table: Record<string, (params: any) => any>) =>
  async (plugin: string, _cmd: string | undefined, params: Record<string, unknown>) => {
    const fn = table[plugin];
    if (!fn) return { ok: false, error: `未知插件 ${plugin}`, ms: 1 };
    try {
      const r = fn(params);
      if (r && typeof r === 'object' && 'ok' in r) return { ms: 1, ...r };
      return { ok: true, data: r, ms: 1 };
    } catch (e) {
      return { ok: false, error: (e as Error).message, ms: 1 };
    }
  };

test('runPipeline 串行传递数据（变量引用上一步输出）', async () => {
  const def: PipelineDef = {
    steps: [
      { id: 'first', plugin: 'a', params: { q: '${input.q}' } },
      { id: 'second', plugin: 'b', params: { v: '${steps.first.data.value}' } },
    ],
    output: { got: '${steps.second.data}' },
  };
  const result = await runPipeline(def, fakeRunner({
    a: (p) => ({ value: `A-${p.q}` }),
    b: (p) => ({ echoed: p.v }),
  }), { input: { q: 'Q' } });

  assert.equal(result.ok, true);
  assert.equal(result.steps.length, 2);
  assert.deepEqual(result.output, { got: { echoed: 'A-Q' } });
});

test('runPipeline forEach 逐条执行并传入 item', async () => {
  const def: PipelineDef = {
    steps: [
      { id: 'list', plugin: 'src' },
      { id: 'each', plugin: 'echo', forEach: '${steps.list.data.items}', params: { u: '${item.url}' } },
    ],
    output: '${steps.each.items}',
  };
  const result = await runPipeline(def, fakeRunner({
    src: () => ({ items: [{ url: 'u1' }, { url: 'u2' }] }),
    echo: (p) => ({ got: p.u }),
  }));
  const items = result.output as any[];
  assert.equal(items.length, 2);
  assert.equal(items[0].data.got, 'u1');
  assert.equal(items[1].data.got, 'u2');
});

test('runPipeline forEach 遵守 limit', async () => {
  const def: PipelineDef = {
    steps: [
      { id: 'list', plugin: 'src' },
      { id: 'each', plugin: 'echo', forEach: '${steps.list.data.items}', limit: 2, params: { u: '${item.url}' } },
    ],
  };
  const result = await runPipeline(def, fakeRunner({
    src: () => ({ items: [{ url: 'a' }, { url: 'b' }, { url: 'c' }, { url: 'd' }] }),
    echo: (p) => ({ got: p.u }),
  }));
  const step = result.steps.find((s) => s.id === 'each')!;
  assert.equal(step.count, 2);
  assert.equal(step.items!.length, 2);
});

test('runPipeline forEach 并发受 concurrency 限制', async () => {
  let running = 0;
  let peak = 0;
  const def: PipelineDef = {
    steps: [
      { id: 'list', plugin: 'src' },
      { id: 'each', plugin: 'slow', forEach: '${steps.list.data.items}', concurrency: 2 },
    ],
  };
  await runPipeline(def, async (plugin) => {
    if (plugin === 'src') return { ok: true, data: { items: [1, 2, 3, 4, 5, 6] }, ms: 1 };
    running++;
    peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 10));
    running--;
    return { ok: true, data: 1, ms: 10 };
  });
  assert.ok(peak <= 2, `峰值 ${peak}`);
  assert.ok(peak >= 2, `过低 ${peak}`);
});

test('runPipeline when 为假则跳过', async () => {
  let called = false;
  const def: PipelineDef = {
    steps: [
      { id: 'skipme', plugin: 'x', when: '${input.flag}', params: {} },
    ],
  };
  const result = await runPipeline(def, async () => {
    called = true;
    return { ok: true, data: 1, ms: 1 };
  }, { input: { flag: false } });
  assert.equal(called, false);
  assert.equal(result.steps[0].skipped, true);
  assert.equal(result.ok, true);
});

test('runPipeline when 为真则执行', async () => {
  let called = false;
  const def: PipelineDef = {
    steps: [{ id: 'runme', plugin: 'x', when: '${input.flag}' }],
  };
  const result = await runPipeline(def, async () => {
    called = true;
    return { ok: true, data: 'done', ms: 1 };
  }, { input: { flag: true } });
  assert.equal(called, true);
  assert.equal(result.steps[0].data, 'done');
});

test('onError abort 中止后续步骤', async () => {
  const def: PipelineDef = {
    onError: 'abort',
    steps: [
      { id: 's1', plugin: 'bad' },
      { id: 's2', plugin: 'good' },
    ],
  };
  const result = await runPipeline(def, fakeRunner({ bad: () => { throw new Error('boom'); }, good: () => 1 }));
  assert.equal(result.ok, false);
  assert.match(result.error!, /s1/);
  assert.equal(result.steps.length, 1, 'abort 后不应执行第二步');
});

test('onError continue 继续后续步骤', async () => {
  const def: PipelineDef = {
    onError: 'continue',
    steps: [
      { id: 's1', plugin: 'bad' },
      { id: 's2', plugin: 'good' },
    ],
  };
  const result = await runPipeline(def, fakeRunner({ bad: () => { throw new Error('boom'); }, good: () => 'ok2' }));
  assert.equal(result.ok, true);
  assert.equal(result.steps.length, 2);
  assert.equal(result.steps[0].ok, false);
  assert.equal(result.steps[1].ok, true);
  assert.equal(result.steps[1].data, 'ok2');
});

test('步骤级 onError 覆盖 pipeline 级', async () => {
  const def: PipelineDef = {
    onError: 'abort',
    steps: [
      { id: 's1', plugin: 'bad', onError: 'continue' },
      { id: 's2', plugin: 'good' },
    ],
  };
  const result = await runPipeline(def, fakeRunner({ bad: () => { throw new Error('boom'); }, good: () => 'ok2' }));
  assert.equal(result.ok, true);
  assert.equal(result.steps.length, 2);
});

test('forEach 部分失败按 onError 处理', async () => {
  const def: PipelineDef = {
    onError: 'abort',
    steps: [
      { id: 'list', plugin: 'src' },
      { id: 'each', plugin: 'flaky', forEach: '${steps.list.data.items}', onError: 'continue' },
    ],
  };
  const result = await runPipeline(def, fakeRunner({
    src: () => ({ items: [1, 2, 3] }),
    flaky: () => { throw new Error('nope'); },
  }));
  assert.equal(result.ok, true, 'continue 策略下整条 pipeline 仍成功');
  const step = result.steps.find((s) => s.id === 'each')!;
  assert.equal(step.ok, false);
  assert.equal(step.items!.filter((i) => !i.ok).length, 3);
});

test('pick 裁剪输出（相对 data 路径）', async () => {
  const def: PipelineDef = {
    steps: [{ id: 's', plugin: 'rich', pick: 'meta.title' }],
  };
  const result = await runPipeline(def, fakeRunner({
    rich: () => ({ meta: { title: 'T' }, big: { a: 1 } }),
  }));
  assert.equal(result.steps[0].data, 'T');
});

test('output 模板可组合多步结果', async () => {
  const def: PipelineDef = {
    steps: [
      { id: 'a', plugin: 'pa' },
      { id: 'b', plugin: 'pb' },
    ],
    output: {
      va: '${steps.a.data.v}',
      vb: '${steps.b.data.v}',
      static: 'hello',
    },
  };
  const result = await runPipeline(def, fakeRunner({
    pa: () => ({ v: 1 }),
    pb: () => ({ v: 2 }),
  }));
  assert.deepEqual(result.output, { va: 1, vb: 2, static: 'hello' });
});

test('无 output 时默认输出 { steps }', async () => {
  const def: PipelineDef = { steps: [{ id: 'a', plugin: 'pa' }] };
  const result = await runPipeline(def, fakeRunner({ pa: () => ({ v: 1 }) }));
  const out = result.output as any;
  assert.ok(out.steps.a);
  assert.equal(out.steps.a.data.v, 1);
});

test('stepResultOf 取指定步骤', async () => {
  const def: PipelineDef = { steps: [{ id: 'x', plugin: 'pa' }] };
  const result = await runPipeline(def, fakeRunner({ pa: () => 'value' }));
  const s = stepResultOf(result, 'x') as any;
  assert.equal(s.id, 'x');
  assert.equal(s.data, 'value');
  assert.equal(stepResultOf(result, 'nope'), undefined);
});

test('onStep 回调覆盖 start/ok/fail/skip', async () => {
  const events: string[] = [];
  const def: PipelineDef = {
    onError: 'continue',
    steps: [
      { id: 'ok1', plugin: 'good' },
      { id: 'bad1', plugin: 'bad' },
      { id: 'skip1', plugin: 'good', when: false },
    ],
  };
  await runPipeline(def, fakeRunner({ good: () => 1, bad: () => { throw new Error('e'); } }), {
    onStep: (ev) => events.push(`${ev.state}:${ev.step}`),
  });
  assert.ok(events.includes('start:ok1'));
  assert.ok(events.includes('ok:ok1'));
  assert.ok(events.includes('fail:bad1'));
  assert.ok(events.includes('skip:skip1'));
});

test('forEach 空数组不报错', async () => {
  const def: PipelineDef = {
    steps: [
      { id: 'list', plugin: 'src' },
      { id: 'each', plugin: 'echo', forEach: '${steps.list.data.items}' },
    ],
  };
  const result = await runPipeline(def, fakeRunner({
    src: () => ({ items: [] }),
    echo: () => 1,
  }));
  assert.equal(result.ok, true);
  const step = result.steps.find((s) => s.id === 'each')!;
  assert.equal(step.count, 0);
});

test('forEach 非数组值被包成单元素', async () => {
  const def: PipelineDef = {
    steps: [{ id: 'each', plugin: 'echo', forEach: '${input.one}', params: { v: '${item}' } }],
  };
  const result = await runPipeline(def, fakeRunner({ echo: (p) => p.v }), { input: { one: 'single' } });
  const step = result.steps.find((s) => s.id === 'each')!;
  assert.equal(step.count, 1);
  assert.equal(step.items![0].data, 'single');
});