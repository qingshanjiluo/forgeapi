import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapLimit, ResultCache, cacheKey } from '../core/concurrency.js';
import { ForgeMcpServer } from '../mcp/server.js';
import { ForgeEngine } from '../core/engine.js';
import { Registry } from '../core/registry.js';
import { resolvePaths, ensureDirs } from '../core/workspace.js';
import { Logger } from '../core/log.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* ---------------- mapLimit ---------------- */

test('mapLimit 保持输入顺序', async () => {
  const items = [5, 1, 3, 2, 4];
  const out = await mapLimit(items, 2, async (n) => {
    await new Promise((r) => setTimeout(r, n * 5));
    return n * 10;
  });
  assert.deepEqual(out, [50, 10, 30, 20, 40]);
});

test('mapLimit 并发不超限', async () => {
  let running = 0;
  let peak = 0;
  await mapLimit(Array.from({ length: 12 }, (_v, i) => i), 3, async () => {
    running++;
    peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 10));
    running--;
    return true;
  });
  assert.ok(peak <= 3, `峰值并发 ${peak} 超过限制`);
  assert.ok(peak >= 2, `并发过低 ${peak}`);
});

test('mapLimit 空数组 / 单元素', async () => {
  assert.deepEqual(await mapLimit([], 3, async () => 1), []);
  assert.deepEqual(await mapLimit([7], 3, async (n) => n), [7]);
});

test('mapLimit 错误向上抛', async () => {
  await assert.rejects(
    () => mapLimit([1, 2, 3], 2, async (n) => { if (n === 2) throw new Error('boom'); return n; }),
    /boom/,
  );
});

/* ---------------- ResultCache ---------------- */

test('ResultCache 存取与 TTL 过期', async () => {
  const c = new ResultCache({ ttlMs: 30 });
  c.set('a', { x: 1 });
  assert.deepEqual(c.get('a'), { x: 1 });
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(c.get('a'), undefined);
});

test('ResultCache LRU 容量淘汰', () => {
  const c = new ResultCache({ max: 2, ttlMs: 60_000 });
  c.set('a', 1); c.set('b', 2); c.set('c', 3);
  assert.equal(c.size, 2);
  assert.equal(c.get('a'), undefined);
  assert.equal(c.get('c'), 3);
});

test('ResultCache 触碰刷新 LRU 顺序', () => {
  const c = new ResultCache({ max: 2, ttlMs: 60_000 });
  c.set('a', 1); c.set('b', 2);
  c.get('a');      // a 变最近使用
  c.set('c', 3);   // 应淘汰 b
  assert.equal(c.get('b'), undefined);
  assert.equal(c.get('a'), 1);
});

test('cacheKey 对象键顺序无关', () => {
  assert.equal(cacheKey({ a: 1, b: 2 }), cacheKey({ b: 2, a: 1 }));
  assert.notEqual(cacheKey({ a: 1 }), cacheKey({ a: 2 }));
});

/* ---------------- MCP ---------------- */

function tmpWorkspace(): { paths: ReturnType<typeof resolvePaths>; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-mcp-'));
  const paths = resolvePaths(dir);
  ensureDirs(paths);
  return { paths, dir };
}

function installFakePlugin(paths: ReturnType<typeof resolvePaths>, name = 'echo'): void {
  const d = path.join(paths.plugins, name);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'index.mjs'), [
    'export default {',
    `  name: '${name}',`,
    "  version: '0.1.0',",
    "  description: '回显测试插件',",
    "  permissions: [],",
    "  schema: { type: 'object', properties: { msg: { type: 'string', description: '消息' } }, required: ['msg'] },",
    '  async execute(params) { return { ok: true, data: { echo: params.msg ?? null } }; },',
    '  commands: [',
    "    { name: 'upper', description: '转大写', schema: { type: 'object', properties: { msg: { type: 'string' } } },",
    '      async handler(p) { return { ok: true, data: { upper: String(p.msg ?? "").toUpperCase() } }; } },',
    '  ],',
    '};',
  ].join('\n'), 'utf8');
  new Registry(paths).register({
    name, version: '0.1.0', dir: d, file: 'index.mjs',
    enabled: true, permissions: [], description: '回显测试插件', installedAt: new Date().toISOString(),
  });
}

test('MCP initialize 返回协议版本与 serverInfo', async () => {
  const { paths, dir } = tmpWorkspace();
  installFakePlugin(paths);
  const s = new ForgeMcpServer({ paths, exposeCommands: true });
  const res: any = await s.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  assert.equal(res.result.protocolVersion, '2024-11-05');
  assert.equal(res.result.serverInfo.name, 'forgeapi');
  assert.ok(res.result.capabilities.tools);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('MCP tools/list 含插件与子命令工具', async () => {
  const { paths, dir } = tmpWorkspace();
  installFakePlugin(paths);
  const s = new ForgeMcpServer({ paths, exposeCommands: true });
  const res: any = await s.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const names = res.result.tools.map((t: any) => t.name);
  assert.ok(names.includes('echo'), names.join(','));
  assert.ok(names.includes('echo__upper'), names.join(','));
  const echoTool = res.result.tools.find((t: any) => t.name === 'echo');
  assert.equal(echoTool.inputSchema.type, 'object');
  assert.ok(echoTool.inputSchema.properties.msg);
  assert.deepEqual(echoTool.inputSchema.required, ['msg']);
  assert.equal(echoTool.inputSchema.additionalProperties, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('MCP --flat 不暴露子命令', async () => {
  const { paths, dir } = tmpWorkspace();
  installFakePlugin(paths);
  const s = new ForgeMcpServer({ paths, exposeCommands: false });
  const res: any = await s.handle({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
  const names = res.result.tools.map((t: any) => t.name);
  assert.ok(names.includes('echo'));
  assert.ok(!names.includes('echo__upper'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('MCP tools/call 执行插件并返回 text content', async () => {
  const { paths, dir } = tmpWorkspace();
  installFakePlugin(paths);
  const s = new ForgeMcpServer({ paths });
  const res: any = await s.handle({
    jsonrpc: '2.0', id: 4, method: 'tools/call',
    params: { name: 'echo', arguments: { msg: 'hello' } },
  });
  assert.equal(res.result.isError, false);
  const payload = JSON.parse(res.result.content[0].text);
  assert.equal(payload.ok, true);
  assert.equal(payload.data.echo, 'hello');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('MCP tools/call 子命令', async () => {
  const { paths, dir } = tmpWorkspace();
  installFakePlugin(paths);
  const s = new ForgeMcpServer({ paths });
  const res: any = await s.handle({
    jsonrpc: '2.0', id: 5, method: 'tools/call',
    params: { name: 'echo__upper', arguments: { msg: 'abc' } },
  });
  const payload = JSON.parse(res.result.content[0].text);
  assert.equal(payload.data.upper, 'ABC');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('MCP 未知工具返回 -32602', async () => {
  const { paths, dir } = tmpWorkspace();
  installFakePlugin(paths);
  const s = new ForgeMcpServer({ paths });
  const res: any = await s.handle({
    jsonrpc: '2.0', id: 6, method: 'tools/call',
    params: { name: 'does-not-exist', arguments: {} },
  });
  assert.equal(res.error.code, -32602);
  assert.match(res.error.message, /未知工具/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('MCP 未知方法返回 -32601', async () => {
  const { paths, dir } = tmpWorkspace();
  const s = new ForgeMcpServer({ paths });
  const res: any = await s.handle({ jsonrpc: '2.0', id: 7, method: 'bogus/method' });
  assert.equal(res.error.code, -32601);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('MCP 通知（无 id）返回 null', async () => {
  const { paths, dir } = tmpWorkspace();
  const s = new ForgeMcpServer({ paths });
  const res = await s.handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(res, null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('MCP ping 返回空结果', async () => {
  const { paths, dir } = tmpWorkspace();
  const s = new ForgeMcpServer({ paths });
  const res: any = await s.handle({ jsonrpc: '2.0', id: 9, method: 'ping' });
  assert.deepEqual(res.result, {});
  fs.rmSync(dir, { recursive: true, force: true });
});

test('MCP 插件执行失败时 isError=true 且 error 可读', async () => {
  const { paths, dir } = tmpWorkspace();
  const d = path.join(paths.plugins, 'bad');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'index.mjs'), [
    'export default {',
    "  name: 'bad', version: '0.1.0', description: '总是失败', permissions: [],",
    "  schema: { type: 'object', properties: {} },",
    "  async execute() { return { ok: false, error: '故意失败' }; },",
    '};',
  ].join('\n'), 'utf8');
  new Registry(paths).register({
    name: 'bad', version: '0.1.0', dir: d, file: 'index.mjs',
    enabled: true, permissions: [], description: '总是失败', installedAt: new Date().toISOString(),
  });
  const s = new ForgeMcpServer({ paths });
  const res: any = await s.handle({
    jsonrpc: '2.0', id: 10, method: 'tools/call',
    params: { name: 'bad', arguments: {} },
  });
  assert.equal(res.result.isError, true);
  const payload = JSON.parse(res.result.content[0].text);
  assert.equal(payload.ok, false);
  assert.match(payload.error, /故意失败/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('MCP only 过滤生效', async () => {
  const { paths, dir } = tmpWorkspace();
  installFakePlugin(paths, 'a');
  installFakePlugin(paths, 'b');
  const s = new ForgeMcpServer({ paths, only: ['a'] });
  const res: any = await s.handle({ jsonrpc: '2.0', id: 11, method: 'tools/list' });
  const names = res.result.tools.map((t: any) => t.name);
  // only 只筛插件；插件 a 的子命令 a__upper 一并保留，插件 b 及其子命令不出现
  assert.deepEqual(names, ['a', 'a__upper']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('MCP 禁用插件不出现在工具表', async () => {
  const { paths, dir } = tmpWorkspace();
  installFakePlugin(paths, 'off');
  new Registry(paths).setEnabled('off', false);
  const s = new ForgeMcpServer({ paths });
  const res: any = await s.handle({ jsonrpc: '2.0', id: 12, method: 'tools/list' });
  assert.ok(!res.result.tools.some((t: any) => t.name === 'off'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('MCP 工具表缓存（buildTools 幂等）', async () => {
  const { paths, dir } = tmpWorkspace();
  installFakePlugin(paths);
  const s = new ForgeMcpServer({ paths });
  const first: any = await s.handle({ jsonrpc: '2.0', id: 13, method: 'tools/list' });
  const second: any = await s.handle({ jsonrpc: '2.0', id: 14, method: 'tools/list' });
  assert.deepEqual(second.result.tools, first.result.tools);
  fs.rmSync(dir, { recursive: true, force: true });
});

/* ---------------- 聚合并发（声明式） ---------------- */

test('声明式 aggregate 支持 concurrency 且保持来源顺序', async () => {
  const { paths, dir } = tmpWorkspace();
  const d = path.join(paths.plugins, 'agg');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'plugin.json'), JSON.stringify({
    name: 'agg', version: '0.1.0', description: '并发聚合测试', type: 'aggregate', concurrency: 2,
    schema: { type: 'object', properties: {} },
    sources: [
      { name: 's1', type: 'code', code: 'await new Promise(r=>setTimeout(r,30)); return [{title:"a1"}];' },
      { name: 's2', type: 'code', code: 'await new Promise(r=>setTimeout(r,5)); return [{title:"b1"}];' },
      { name: 's3', type: 'code', code: 'return [{title:"c1"}];' },
    ],
    merge: { strategy: 'concat' },
  }), 'utf8');
  new Registry(paths).register({
    name: 'agg', version: '0.1.0', dir: d, file: 'plugin.json',
    enabled: true, permissions: [], description: '并发聚合测试', installedAt: new Date().toISOString(),
  });
  const eng = new ForgeEngine(paths);
  const out = await eng.run('agg', { params: {}, logger: new Logger({ quiet: true }) });
  assert.equal(out.ok, true, out.error);
  const data = out.data as any;
  assert.equal(data.sources.length, 3);
  assert.deepEqual(data.sources.map((s: any) => s.name), ['s1', 's2', 's3'], '来源顺序必须与声明一致');
  assert.equal(data.results.length, 3);
  fs.rmSync(dir, { recursive: true, force: true });
});