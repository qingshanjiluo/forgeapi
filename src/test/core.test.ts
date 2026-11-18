import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Vault } from '../core/credentials.js';
import { Registry } from '../core/registry.js';
import { ForgeEngine } from '../core/engine.js';
import { generateSkill } from '../core/skillgen.js';
import { CallLog } from '../core/calllog.js';
import { resolvePaths, ensureDirs, loadConfig, patchConfig, readJson, writeJson } from '../core/workspace.js';
import { Logger } from '../core/log.js';

function tmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'forge-test-'));
}

test('Vault init / unlock / set / get / delete', () => {
  const dir = tmpHome();
  const file = path.join(dir, 'cred.json');
  const v = new Vault(file);
  v.init('mypass');
  assert.equal(v.initialized, true);
  assert.equal(v.unlocked, true);
  v.set('plug', 'KEY', 'value-123');
  assert.equal(v.get('plug', 'KEY'), 'value-123');
  assert.deepEqual(v.listKeys('plug'), ['KEY']);

  const v2 = new Vault(file);
  assert.equal(v2.unlocked, false);
  assert.equal(v2.unlock('wrong'), false);
  assert.equal(v2.unlock('mypass'), true);
  assert.equal(v2.get('plug', 'KEY'), 'value-123');
  assert.equal(v2.delete('plug', 'KEY'), true);
  assert.equal(v2.get('plug', 'KEY'), undefined);
});

test('Vault 隔离：不同插件同名键互不可见', () => {
  const dir = tmpHome();
  const v = new Vault(path.join(dir, 'cred.json'));
  v.init('p');
  v.set('a', 'TOKEN', 'A');
  v.set('b', 'TOKEN', 'B');
  assert.equal(v.get('a', 'TOKEN'), 'A');
  assert.equal(v.get('b', 'TOKEN'), 'B');
});

test('Vault 未解锁时拒绝读写', () => {
  const dir = tmpHome();
  const v = new Vault(path.join(dir, 'cred.json'));
  v.init('p');
  v.lock();
  assert.throws(() => v.get('x', 'y'));
  assert.throws(() => v.set('x', 'y', 'z'));
});

test('Registry 注册/启用/禁用/注销', () => {
  const dir = tmpHome();
  const paths = resolvePaths(dir);
  ensureDirs(paths);
  const reg = new Registry(paths);
  reg.register({
    name: 'demo', version: '1.0.0', dir: path.join(dir, 'p', 'demo'), file: 'index.mjs',
    enabled: true, permissions: ['net'], description: 'demo', installedAt: new Date().toISOString(),
  });
  assert.equal(reg.has('demo'), true);
  assert.equal(reg.enabled().length, 1);
  assert.equal(reg.setEnabled('demo', false), true);
  assert.equal(new Registry(paths).enabled().length, 0);
  assert.equal(reg.unregister('demo'), true);
  assert.equal(reg.all().length, 0);
});

test('Engine 执行代码型插件 + 禁用拦截', async () => {
  const dir = tmpHome();
  const paths = resolvePaths(dir);
  ensureDirs(paths);
  const plugDir = path.join(paths.plugins, 'echo');
  fs.mkdirSync(plugDir, { recursive: true });
  fs.writeFileSync(path.join(plugDir, 'index.mjs'), [
    'export default {',
    "  name: 'echo', version: '0.0.1', description: 'echo',",
    "  schema: { type: 'object', properties: { msg: { type: 'string' } } },",
    '  permissions: [],',
    '  async execute(params, ctx) {',
    '    return { ok: true, data: { echo: params.msg ?? null, dir: ctx.dataDir } };',
    '  },',
    '};',
  ].join('\n'), 'utf8');

  const reg = new Registry(paths);
  reg.register({
    name: 'echo', version: '0.0.1', dir: plugDir, file: 'index.mjs',
    enabled: true, permissions: [], description: 'echo', installedAt: new Date().toISOString(),
  });

  const eng = new ForgeEngine(paths);
  const out = await eng.run('echo', { params: { msg: 'hi' }, logger: new Logger({ quiet: true }) });
  assert.equal(out.ok, true);
  assert.equal((out.data as any).echo, 'hi');
  assert.equal(fs.existsSync((out.data as any).dir), true);

  reg.setEnabled('echo', false);
  await assert.rejects(() => eng.run('echo', { params: {} }));
});

test('Engine 执行声明式插件（extract 走 http fetch 路径）', async () => {
  const dir = tmpHome();
  const paths = resolvePaths(dir);
  ensureDirs(paths);
  const plugDir = path.join(paths.plugins, 'decl');
  fs.mkdirSync(plugDir, { recursive: true });
  fs.writeFileSync(path.join(plugDir, 'plugin.json'), JSON.stringify({
    name: 'decl', version: '0.0.1', description: '聚合示例', type: 'aggregate',
    schema: { type: 'object', properties: { q: { type: 'string' } } },
    sources: [{
      name: 'mock', type: 'code',
      code: "return [{ title: 'A: ' + params.q }, { title: 'B' }];",
    }],
    merge: { strategy: 'dedupe_by_title' },
  }), 'utf8');

  new Registry(paths).register({
    name: 'decl', version: '0.0.1', dir: plugDir, file: 'plugin.json',
    enabled: true, permissions: [], description: '聚合示例', installedAt: new Date().toISOString(),
  });

  const eng = new ForgeEngine(paths);
  const out = await eng.run('decl', { params: { q: 'X' }, logger: new Logger({ quiet: true }) });
  assert.equal(out.ok, true, out.error);
  const d = out.data as any;
  assert.equal(d.total, 2);
  assert.equal(d.results[0].title, 'A: X');
});

test('generateSkill 输出含参数表与 Schema', () => {
  const md = generateSkill({
    name: 'demo', version: '1.2.3', description: '演示插件',
    schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '目标地址' },
        n: { type: 'integer', description: '条数', default: 5 },
      },
      required: ['url'],
    },
    permissions: ['net', 'browser'],
  });
  assert.match(md, /# demo v1\.2\.3/);
  assert.match(md, /forge run demo/);
  assert.match(md, /\| `url` \| string \| 是 \|/);
  assert.match(md, /```json/);
  assert.match(md, /默认: `5`/);
  assert.match(md, /启动无头浏览器/);
});

test('CallLog 写入与读取', () => {
  const dir = tmpHome();
  const paths = resolvePaths(dir);
  ensureDirs(paths);
  const log = new CallLog(paths);
  log.append(log.newEntry({
    plugin: 'p', params: { a: 1 }, ok: true, ms: 12, summary: 'ok', exitCode: 0,
  }));
  log.append(log.newEntry({
    plugin: 'q', params: {}, ok: false, ms: 3, summary: 'fail', error: 'boom', exitCode: 1,
  }));
  assert.equal(log.list().length, 2);
  assert.equal(log.list({ plugin: 'p' }).length, 1);
  assert.equal(log.list({ onlyError: true }).length, 1);
});

test('config 补丁合并', () => {
  const dir = tmpHome();
  const paths = resolvePaths(dir);
  ensureDirs(paths);
  const base = loadConfig(paths);
  assert.equal(base.browser.headless, true);
  patchConfig(paths, { browser: { headless: false }, server: { port: 9999 } });
  const next = loadConfig(paths);
  assert.equal(next.browser.headless, false);
  assert.equal(next.server.port, 9999);
  assert.equal(next.browser.locale, base.browser.locale); // 未覆盖的保留
});

test('readJson / writeJson 原子写', () => {
  const dir = tmpHome();
  const f = path.join(dir, 'a.json');
  writeJson(f, { x: 1 });
  assert.deepEqual(readJson(f, {}), { x: 1 });
  assert.deepEqual(readJson(path.join(dir, 'none.json'), { d: true }), { d: true });
  fs.writeFileSync(f, '{bad json', 'utf8');
  assert.deepEqual(readJson(f, { fallback: 1 }), { fallback: 1 });
});