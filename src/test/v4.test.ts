import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readTasks, runBatch, summarizeBatch, type BatchTask } from '../core/scheduler.js';
import { hashPluginDir, verifyPlugin, lockBaseline, verifyAll, listPluginFiles } from '../core/integrity.js';
import { diffResults, readSnapshot, writeSnapshot, snapshotFile, extractItems, pickKey } from '../core/diff.js';
import { resolvePaths, ensureDirs } from '../core/workspace.js';
import { Registry } from '../core/registry.js';
import { installPlugin } from '../core/installer.js';

function tmpDir(prefix = 'forge-4x-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
function tmpWorkspace() {
  const dir = tmpDir();
  const paths = resolvePaths(dir);
  ensureDirs(paths);
  return { paths, dir };
}

/* ---------------- 任务文件解析 ---------------- */

test('readTasks 解析 JSON 数组', () => {
  const dir = tmpDir();
  const f = path.join(dir, 'tasks.json');
  fs.writeFileSync(f, JSON.stringify([
    { plugin: 'a', params: { x: 1 } },
    { plugin: 'b', command: 'sub', id: 'k1' },
  ]), 'utf8');
  const tasks = readTasks(f);
  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].plugin, 'a');
  assert.deepEqual(tasks[0].params, { x: 1 });
  assert.equal(tasks[1].command, 'sub');
  assert.equal(tasks[1].id, 'k1');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('readTasks 解析 JSONL 并跳过注释空行', () => {
  const dir = tmpDir();
  const f = path.join(dir, 'tasks.jsonl');
  fs.writeFileSync(f, [
    '# 注释行',
    '{"plugin":"a","params":{"q":"x"}}',
    '',
    '{"plugin":"b"}',
  ].join('\n'), 'utf8');
  const tasks = readTasks(f);
  assert.equal(tasks.length, 2);
  assert.equal(tasks[1].plugin, 'b');
  assert.deepEqual(tasks[1].params, {});
  fs.rmSync(dir, { recursive: true, force: true });
});

test('readTasks 单对象也能读', () => {
  const dir = tmpDir();
  const f = path.join(dir, 'one.json');
  fs.writeFileSync(f, JSON.stringify({ plugin: 'solo', params: { a: 1 } }), 'utf8');
  const t = readTasks(f);
  assert.equal(t.length, 1);
  assert.equal(t[0].plugin, 'solo');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('readTasks 缺 plugin 报错', () => {
  const dir = tmpDir();
  const f = path.join(dir, 'bad.json');
  fs.writeFileSync(f, JSON.stringify([{ params: {} }]), 'utf8');
  assert.throws(() => readTasks(f), /缺少 plugin/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('readTasks 坏 JSONL 行报行号', () => {
  const dir = tmpDir();
  const f = path.join(dir, 'bad.jsonl');
  fs.writeFileSync(f, '{"plugin":"a"}\n{not json}\n', 'utf8');
  assert.throws(() => readTasks(f), /第 2 行/);
  fs.rmSync(dir, { recursive: true, force: true });
});

/* ---------------- 批量执行 ---------------- */

const mk = (n: number): BatchTask[] => Array.from({ length: n }, (_v, i) => ({ plugin: 'p', params: { i }, id: `t${i}` }));

test('runBatch 保持任务顺序', async () => {
  const tasks = mk(6);
  const out = await runBatch(tasks, async (t) => {
    await new Promise((r) => setTimeout(r, (6 - (t.params as any).i) * 3));
    return { ok: true, data: (t.params as any).i, ms: 1 };
  }, { concurrency: 3 });
  assert.deepEqual(out.map((r) => r.data), [0, 1, 2, 3, 4, 5]);
});

test('runBatch 并发不超限', async () => {
  let running = 0;
  let peak = 0;
  await runBatch(mk(10), async () => {
    running++;
    peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 12));
    running--;
    return { ok: true, data: 1, ms: 1 };
  }, { concurrency: 3 });
  assert.ok(peak <= 3, `峰值 ${peak}`);
  assert.ok(peak >= 2, `过低 ${peak}`);
});

test('runBatch 失败重试直到成功', async () => {
  let calls = 0;
  const out = await runBatch([{ plugin: 'flaky' }], async () => {
    calls++;
    if (calls < 3) return { ok: false, error: '临时失败', ms: 1 };
    return { ok: true, data: 'ok', ms: 1 };
  }, { retry: 3, retryDelayMs: 5 });
  assert.equal(out[0].ok, true);
  assert.equal(out[0].attempts, 3);
  assert.equal(calls, 3);
});

test('runBatch 用尽重试后记失败', async () => {
  const out = await runBatch([{ plugin: 'always-fail' }], async () => ({ ok: false, error: '永久失败', ms: 1 }), { retry: 2, retryDelayMs: 2 });
  assert.equal(out[0].ok, false);
  assert.equal(out[0].attempts, 2);
  assert.match(out[0].error!, /永久失败/);
});

test('runBatch 抛异常也算失败并可重试', async () => {
  let n = 0;
  const out = await runBatch([{ plugin: 'throws' }], async () => {
    n++;
    if (n === 1) throw new Error('boom');
    return { ok: true, data: 1, ms: 1 };
  }, { retry: 2, retryDelayMs: 2 });
  assert.equal(out[0].ok, true);
  assert.equal(out[0].attempts, 2);
});

test('runBatch 超时生效', async () => {
  const out = await runBatch([{ plugin: 'slow' }], async () => {
    await new Promise((r) => setTimeout(r, 200));
    return { ok: true, data: 1, ms: 200 };
  }, { timeoutMs: 30 });
  assert.equal(out[0].ok, false);
  assert.match(out[0].error!, /超时/);
});

test('runBatch 限速：间隔不小于 1000/rate', async () => {
  const start = Date.now();
  await runBatch(mk(4), async () => ({ ok: true, data: 1, ms: 1 }), { concurrency: 4, ratePerSec: 20 });
  const elapsed = Date.now() - start;
  // 4 个任务、20/s → 至少 3 个间隔 ≈ 150ms
  assert.ok(elapsed >= 120, `太快 ${elapsed}ms`);
});

test('runBatch 结果落盘 JSONL', async () => {
  const dir = tmpDir();
  const outFile = path.join(dir, 'out.jsonl');
  await runBatch(mk(3), async (t) => ({ ok: true, data: (t.params as any).i, ms: 1 }), { concurrency: 2, outFile });
  const lines = fs.readFileSync(outFile, 'utf8').trim().split('\n');
  assert.equal(lines.length, 3);
  const recs = lines.map((l) => JSON.parse(l));
  assert.ok(recs.every((r) => r.type === 'result' && r.ok === true));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('runBatch 进度回调覆盖 start/ok/fail', async () => {
  const events: string[] = [];
  await runBatch([{ plugin: 'a' }, { plugin: 'b' }], async (t) => (
    t.plugin === 'a' ? { ok: true, data: 1, ms: 1 } : { ok: false, error: 'x', ms: 1 }
  ), { concurrency: 1, onProgress: (ev) => events.push(`${ev.state}:${ev.task.plugin}`) });
  assert.ok(events.includes('start:a'));
  assert.ok(events.includes('ok:a'));
  assert.ok(events.includes('fail:b'));
});

test('summarizeBatch 汇总正确', () => {
  const results = [
    { index: 0, task: { plugin: 'a' }, ok: true, ms: 10, attempts: 1 },
    { index: 1, task: { plugin: 'a' }, ok: false, error: 'e1', ms: 5, attempts: 1 },
    { index: 2, task: { plugin: 'b' }, ok: true, ms: 20, attempts: 2 },
  ] as any;
  const s = summarizeBatch(results);
  assert.equal(s.total, 3);
  assert.equal(s.ok, 2);
  assert.equal(s.fail, 1);
  assert.equal(s.ms, 35);
  assert.deepEqual(s.byPlugin.a, { ok: 1, fail: 1 });
  assert.equal(s.failures.length, 1);
  assert.equal(s.failures[0].error, 'e1');
});

/* ---------------- 完整性校验 ---------------- */

test('hashPluginDir 稳定且敏感于内容', () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello', 'utf8');
  fs.writeFileSync(path.join(dir, 'sub', 'b.txt'), 'world', 'utf8');

  const h1 = hashPluginDir(dir);
  const h2 = hashPluginDir(dir);
  assert.equal(h1.hash, h2.hash, '同内容应稳定');
  assert.equal(h1.files.length, 2);

  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello!', 'utf8');
  const h3 = hashPluginDir(dir);
  assert.notEqual(h3.hash, h1.hash, '改内容应变化');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('hashPluginDir 跳过 node_modules 等运行期产物', () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, 'node_modules', 'x'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', 'x', 'i.js'), '1', 'utf8');
  fs.writeFileSync(path.join(dir, 'index.mjs'), 'export default {};', 'utf8');
  fs.writeFileSync(path.join(dir, 'package-lock.json'), '{}', 'utf8');

  const files = listPluginFiles(dir);
  assert.deepEqual(files, ['index.mjs']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('verify 无基线时报未记录', () => {
  const { paths, dir } = tmpWorkspace();
  const d = path.join(paths.plugins, 'p');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'index.mjs'), 'x', 'utf8');
  new Registry(paths).register({
    name: 'p', version: '1.0.0', dir: d, file: 'index.mjs',
    enabled: true, permissions: [], description: 'd', installedAt: new Date().toISOString(),
  });
  const v = verifyPlugin(paths, 'p')!;
  assert.equal(v.ok, false);
  assert.match(v.reason!, /未记录基线/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('lockBaseline + verify 通过；篡改后可定位文件', () => {
  const { paths, dir } = tmpWorkspace();
  const d = path.join(paths.plugins, 'p2');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'index.mjs'), 'v1', 'utf8');
  new Registry(paths).register({
    name: 'p2', version: '1.0.0', dir: d, file: 'index.mjs',
    enabled: true, permissions: [], description: 'd', installedAt: new Date().toISOString(),
  });

  const base = lockBaseline(paths, 'p2')!;
  assert.equal(base.files, 1);
  assert.equal(verifyPlugin(paths, 'p2')!.ok, true);

  fs.writeFileSync(path.join(d, 'index.mjs'), 'v2', 'utf8');
  const v = verifyPlugin(paths, 'p2')!;
  assert.equal(v.ok, false);
  assert.ok(v.changedFiles?.some((f) => f.includes('index.mjs') && f.includes('内容变更')), JSON.stringify(v.changedFiles));

  fs.writeFileSync(path.join(d, 'extra.js'), 'new', 'utf8');
  const v2 = verifyPlugin(paths, 'p2')!;
  assert.ok(v2.changedFiles?.some((f) => f.includes('extra.js') && f.includes('新增')), JSON.stringify(v2.changedFiles));

  fs.rmSync(dir, { recursive: true, force: true });
});

test('verify 目录缺失报错', () => {
  const { paths, dir } = tmpWorkspace();
  new Registry(paths).register({
    name: 'gone', version: '1.0.0', dir: path.join(paths.plugins, 'gone'), file: 'index.mjs',
    enabled: true, permissions: [], description: 'd', installedAt: new Date().toISOString(),
  });
  const v = verifyPlugin(paths, 'gone')!;
  assert.equal(v.ok, false);
  assert.match(v.reason!, /目录不存在/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('安装即写入基线，可立即校验通过', async () => {
  const { paths, dir } = tmpWorkspace();
  const src = path.join(dir, 'src');
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, 'index.mjs'), [
    'export default {',
    "  name: 'withhash', version: '1.0.0', description: 'd', permissions: [],",
    "  schema: { type: 'object', properties: {} },",
    '  async execute() { return { ok: true, data: 1 }; },',
    '};',
  ].join('\n'), 'utf8');

  const r = await installPlugin(paths, { source: src, force: true, yes: true });
  assert.ok(r.integrity, '应返回 integrity');
  const v = verifyPlugin(paths, r.name)!;
  assert.equal(v.ok, true, v.reason);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('verifyAll 覆盖全部插件', () => {
  const { paths, dir } = tmpWorkspace();
  for (const name of ['a', 'b']) {
    const d = path.join(paths.plugins, name);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'index.mjs'), name, 'utf8');
    new Registry(paths).register({
      name, version: '1.0.0', dir: d, file: 'index.mjs',
      enabled: true, permissions: [], description: 'd', installedAt: new Date().toISOString(),
    });
    lockBaseline(paths, name);
  }
  const all = verifyAll(paths);
  assert.equal(all.length, 2);
  assert.ok(all.every((x) => x.ok));
  fs.rmSync(dir, { recursive: true, force: true });
});

/* ---------------- 结果 diff ---------------- */

test('diffResults 识别新增/删除/变更/未变', () => {
  const before = [
    { url: 'a', title: 'A', price: 100 },
    { url: 'b', title: 'B', price: 200 },
    { url: 'c', title: 'C', price: 300 },
  ];
  const after = [
    { url: 'a', title: 'A', price: 100 },
    { url: 'b', title: 'B', price: 250 },
    { url: 'd', title: 'D', price: 400 },
  ];
  const d = diffResults({ before, after });
  assert.equal(d.added.length, 1);
  assert.equal((d.added[0] as any).url, 'd');
  assert.equal(d.removed.length, 1);
  assert.equal((d.removed[0] as any).url, 'c');
  assert.equal(d.changed.length, 1);
  assert.equal(d.changed[0].key, 'b');
  assert.deepEqual(d.changed[0].fields, ['price']);
  assert.equal(d.unchanged, 1);
  assert.deepEqual(d.counts, { before: 3, after: 3 });
});

test('diffResults 支持显式 key 与 fields 过滤', () => {
  const before = [{ id: 'x', v: 1, note: 'old' }];
  const after = [{ id: 'x', v: 1, note: 'new' }];
  // 只看 v → 无变更
  const d1 = diffResults({ before, after, key: 'id', fields: ['v'] });
  assert.equal(d1.changed.length, 0);
  assert.equal(d1.unchanged, 1);
  // 看全部 → note 变更
  const d2 = diffResults({ before, after, key: 'id' });
  assert.equal(d2.changed.length, 1);
  assert.deepEqual(d2.changed[0].fields, ['note']);
});

test('diffResults 键自动识别（url/title 优先级）', () => {
  assert.equal(pickKey({ url: 'u', title: 't' }), 'u');
  assert.equal(pickKey({ title: '标题值' }), '标题值');
  assert.equal(pickKey({ id: 5 }), '5');
  const structural = pickKey({ a: 1, b: 2 });
  assert.ok(structural && structural.startsWith('{'), '无候选键时用结构哈希');
});

test('diffResults 对象键顺序不影响结构哈希', () => {
  assert.equal(pickKey({ a: 1, b: 2 }), pickKey({ b: 2, a: 1 }));
});

test('diffResults 空集边界', () => {
  const d1 = diffResults({ before: [], after: [{ url: 'a' }] });
  assert.equal(d1.added.length, 1);
  assert.equal(d1.removed.length, 0);
  const d2 = diffResults({ before: [{ url: 'a' }], after: [] });
  assert.equal(d2.removed.length, 1);
  const d3 = diffResults({ before: [], after: [] });
  assert.equal(d3.added.length + d3.removed.length + d3.changed.length, 0);
});

test('快照读写', () => {
  const dir = tmpDir();
  assert.equal(readSnapshot(dir, 'x'), null);
  const f = writeSnapshot(dir, 'x', [{ url: 'a' }]);
  assert.equal(f, snapshotFile(dir, 'x'));
  assert.deepEqual(readSnapshot(dir, 'x'), [{ url: 'a' }]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('extractItems 从多种包装里取数组', () => {
  assert.deepEqual(extractItems([1, 2]), [1, 2]);
  assert.deepEqual(extractItems({ results: [3] }), [3]);
  assert.deepEqual(extractItems({ items: [4] }), [4]);
  assert.deepEqual(extractItems({ topics: [5] }), [5]);
  assert.deepEqual(extractItems({ other: [6] }), [6]);
  assert.deepEqual(extractItems({ a: 1 }), []);
  assert.deepEqual(extractItems(null), []);
});