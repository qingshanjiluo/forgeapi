import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ForgeMcpServer } from '../mcp/server.js';
import { Registry } from '../core/registry.js';
import { resolvePaths, ensureDirs } from '../core/workspace.js';
import { searchRemote, fetchRemoteIndex, installRemoteTemplate, registryCacheFile } from '../core/templates.js';
import { installPlugin } from '../core/installer.js';

function tmpWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-3x-'));
  const paths = resolvePaths(dir);
  ensureDirs(paths);
  return { paths, dir };
}

function addPlugin(paths: ReturnType<typeof resolvePaths>, name: string, skill?: string, rule?: { name: string; yaml: string }) {
  const d = path.join(paths.plugins, name);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'index.mjs'), [
    'export default {',
    `  name: '${name}', version: '0.1.0', description: '测试插件 ${name}', permissions: [],`,
    "  schema: { type: 'object', properties: { q: { type: 'string' } } },",
    '  async execute(p) { return { ok: true, data: { q: p.q ?? null } }; },',
    '};',
  ].join('\n'), 'utf8');
  if (skill) fs.writeFileSync(path.join(d, 'skill.md'), skill, 'utf8');
  new Registry(paths).register({
    name, version: '0.1.0', dir: d, file: 'index.mjs',
    enabled: true, permissions: [], description: `测试插件 ${name}`, installedAt: new Date().toISOString(),
  });
  void rule;
}

/* ---------------- MCP resources ---------------- */

test('resources/list 列出有 skill 或 schema 的插件', async () => {
  const { paths, dir } = tmpWorkspace();
  addPlugin(paths, 'alpha', '# alpha skill\n内容');
  addPlugin(paths, 'beta'); // 无 skill，但有 schema → 也应列出
  const s = new ForgeMcpServer({ paths });
  const res: any = await s.handle({ jsonrpc: '2.0', id: 1, method: 'resources/list' });
  const uris = res.result.resources.map((r: any) => r.uri);
  assert.ok(uris.includes('forge://plugin/alpha/skill'), uris.join(','));
  assert.ok(uris.includes('forge://plugin/beta/skill'), uris.join(','));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('resources/read 返回磁盘 skill.md 原文', async () => {
  const { paths, dir } = tmpWorkspace();
  const md = '# alpha\n\n> 测试用\n';
  addPlugin(paths, 'alpha', md);
  const s = new ForgeMcpServer({ paths });
  const res: any = await s.handle({ jsonrpc: '2.0', id: 2, method: 'resources/read', params: { uri: 'forge://plugin/alpha/skill' } });
  assert.equal(res.result.contents[0].mimeType, 'text/markdown');
  assert.equal(res.result.contents[0].text, md);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('resources/read 无 skill.md 时即时生成', async () => {
  const { paths, dir } = tmpWorkspace();
  addPlugin(paths, 'noskill');
  const s = new ForgeMcpServer({ paths });
  const res: any = await s.handle({ jsonrpc: '2.0', id: 3, method: 'resources/read', params: { uri: 'forge://plugin/noskill/skill' } });
  const text = res.result.contents[0].text;
  assert.match(text, /# noskill v0\.1\.0/);
  assert.match(text, /forge run noskill/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('resources/read 声明式 manifest', async () => {
  const { paths, dir } = tmpWorkspace();
  const d = path.join(paths.plugins, 'decl');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'plugin.json'), JSON.stringify({
    name: 'decl', version: '0.1.0', description: '声明式', type: 'aggregate',
    schema: { type: 'object', properties: {} },
    sources: [{ name: 'x', type: 'code', code: 'return [{a:1}];' }],
    merge: { strategy: 'concat' },
  }), 'utf8');
  new Registry(paths).register({
    name: 'decl', version: '0.1.0', dir: d, file: 'plugin.json',
    enabled: true, permissions: [], description: '声明式', installedAt: new Date().toISOString(),
  });
  const s = new ForgeMcpServer({ paths });
  const res: any = await s.handle({ jsonrpc: '2.0', id: 4, method: 'resources/read', params: { uri: 'forge://plugin/decl/manifest' } });
  assert.equal(res.result.contents[0].mimeType, 'application/json');
  assert.equal(JSON.parse(res.result.contents[0].text).name, 'decl');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('resources/read 插件规则 YAML', async () => {
  const { paths, dir } = tmpWorkspace();
  addPlugin(paths, 'ruled');
  const rulesDir = path.join(paths.plugins, 'ruled', 'rules');
  fs.mkdirSync(rulesDir, { recursive: true });
  fs.writeFileSync(path.join(rulesDir, 'product.yaml'), 'fields:\n  - name: 标题\n    selector: h1\n', 'utf8');
  const s = new ForgeMcpServer({ paths });
  const list: any = await s.handle({ jsonrpc: '2.0', id: 5, method: 'resources/list' });
  const uris = list.result.resources.map((r: any) => r.uri);
  assert.ok(uris.includes('forge://plugin/ruled/rules/product'), uris.join(','));

  const res: any = await s.handle({ jsonrpc: '2.0', id: 6, method: 'resources/read', params: { uri: 'forge://plugin/ruled/rules/product' } });
  assert.match(res.result.contents[0].text, /selector: h1/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('resources/read 未知 URI → -32602', async () => {
  const { paths, dir } = tmpWorkspace();
  const s = new ForgeMcpServer({ paths });
  const res: any = await s.handle({ jsonrpc: '2.0', id: 7, method: 'resources/read', params: { uri: 'forge://nope' } });
  assert.equal(res.error.code, -32602);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('resources/templates/list 返回 URI 模板', async () => {
  const { paths, dir } = tmpWorkspace();
  const s = new ForgeMcpServer({ paths });
  const res: any = await s.handle({ jsonrpc: '2.0', id: 8, method: 'resources/templates/list' });
  const tpls = res.result.resourceTemplates.map((t: any) => t.uriTemplate);
  assert.ok(tpls.includes('forge://plugin/{plugin}/skill'));
  fs.rmSync(dir, { recursive: true, force: true });
});

/* ---------------- MCP prompts ---------------- */

test('prompts/list 返回 4 个工作流模板', async () => {
  const { paths, dir } = tmpWorkspace();
  const s = new ForgeMcpServer({ paths });
  const res: any = await s.handle({ jsonrpc: '2.0', id: 9, method: 'prompts/list' });
  const names = res.result.prompts.map((p: any) => p.name);
  assert.deepEqual(names, ['webpage_extract', 'search_multi', 'news_brief', 'data_service']);
  for (const p of res.result.prompts) assert.ok(p.arguments?.length > 0, `${p.name} 缺参数定义`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('prompts/get 渲染参数进文本', async () => {
  const { paths, dir } = tmpWorkspace();
  const s = new ForgeMcpServer({ paths });
  const res: any = await s.handle({
    jsonrpc: '2.0', id: 10, method: 'prompts/get',
    params: { name: 'webpage_extract', arguments: { url: 'https://example.com', fields: '标题,价格' } },
  });
  const text = res.result.messages[0].content.text;
  assert.match(text, /https:\/\/example\.com/);
  assert.match(text, /标题,价格/);
  assert.match(text, /forge_webpage/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('prompts/get 未知 name → -32602', async () => {
  const { paths, dir } = tmpWorkspace();
  const s = new ForgeMcpServer({ paths });
  const res: any = await s.handle({ jsonrpc: '2.0', id: 11, method: 'prompts/get', params: { name: 'nope' } });
  assert.equal(res.error.code, -32602);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('initialize 声明 resources/prompts 能力', async () => {
  const { paths, dir } = tmpWorkspace();
  const s = new ForgeMcpServer({ paths });
  const res: any = await s.handle({ jsonrpc: '2.0', id: 12, method: 'initialize', params: {} });
  assert.ok(res.result.capabilities.resources);
  assert.ok(res.result.capabilities.prompts);
  assert.match(res.result.instructions, /resources\/list/);
  fs.rmSync(dir, { recursive: true, force: true });
});

/* ---------------- 远端模板 ---------------- */

test('fetchRemoteIndex 读内置 registry.json', async () => {
  const { paths, dir } = tmpWorkspace();
  // 造一个 registry 文件，用 FORGE_REGISTRY 指定（隔离随包索引）
  const regFile = path.join(dir, 'registry-a.json');
  fs.writeFileSync(regFile, JSON.stringify([
    { name: 'tpl-a', version: '1.0.0', description: '模板A', tags: ['x'], url: 'builtin:tpl-a' },
    { name: 'tpl-b', version: '1.0.1', description: '模板B', tags: ['y'], url: 'https://example.com/b.tgz' },
  ]), 'utf8');

  const prev = process.env.FORGE_REGISTRY;
  process.env.FORGE_REGISTRY = `file://${regFile}`;
  try {
    const items = await fetchRemoteIndex(paths, { refresh: true });
    assert.equal(items.length, 2);
    assert.equal(items[0].name, 'tpl-a');
    assert.ok(fs.existsSync(registryCacheFile(paths)), '缓存文件应写入');
  } finally {
    if (prev === undefined) delete process.env.FORGE_REGISTRY;
    else process.env.FORGE_REGISTRY = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('searchRemote 按关键词过滤', async () => {
  const { paths, dir } = tmpWorkspace();
  const regFile = path.join(dir, 'registry-test.json');
  fs.writeFileSync(regFile, JSON.stringify([
    { name: 'weather-x', version: '1.0.0', description: '天气封装', tags: ['weather'], url: 'builtin:weather-x' },
    { name: 'news-y', version: '1.0.0', description: '新闻聚合', tags: ['news'], url: 'builtin:news-y' },
  ]), 'utf8');

  // 用环境变量隔离，避免读到随包 registry.json
  const prev = process.env.FORGE_REGISTRY;
  process.env.FORGE_REGISTRY = `file://${regFile}`;
  try {
    const hit = await searchRemote(paths, 'weather', { refresh: true });
    assert.equal(hit.length, 1, `实际: ${hit.map((h) => h.name).join(',')}`);
    assert.equal(hit[0].name, 'weather-x');

    const tagsHit = await searchRemote(paths, 'news', { refresh: false });
    assert.equal(tagsHit.length, 1);
    assert.equal(tagsHit[0].name, 'news-y');
  } finally {
    if (prev === undefined) delete process.env.FORGE_REGISTRY;
    else process.env.FORGE_REGISTRY = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('installRemoteTemplate 支持 builtin: 前缀', async () => {
  const { paths, dir } = tmpWorkspace();
  const tplDir = path.join(paths.templates, 'my-tpl');
  fs.mkdirSync(tplDir, { recursive: true });
  fs.writeFileSync(path.join(tplDir, 'plugin.json'), JSON.stringify({
    name: 'my-tpl', version: '0.1.0', description: '内置模板', type: 'aggregate',
    schema: { type: 'object', properties: {} },
    sources: [{ name: 's', type: 'code', code: 'return [{a:1}];' }],
    merge: { strategy: 'concat' },
  }), 'utf8');

  const r = await installRemoteTemplate(paths, 'builtin:my-tpl');
  assert.equal(r.name, 'my-tpl');
  assert.ok(new Registry(paths).has('my-tpl'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('installRemoteTemplate 支持相对路径', async () => {
  const { paths, dir } = tmpWorkspace();
  const tplDir = path.join(paths.templates, 'rel-tpl');
  fs.mkdirSync(tplDir, { recursive: true });
  fs.writeFileSync(path.join(tplDir, 'plugin.json'), JSON.stringify({
    name: 'rel-tpl', version: '0.1.0', description: '相对路径模板', type: 'aggregate',
    schema: { type: 'object', properties: {} },
    sources: [{ name: 's', type: 'code', code: 'return [{b:2}];' }],
    merge: { strategy: 'concat' },
  }), 'utf8');

  const r = await installRemoteTemplate(paths, 'rel-tpl');
  assert.equal(r.name, 'rel-tpl');
  fs.rmSync(dir, { recursive: true, force: true });
});

/* ---------------- 依赖自动安装 ---------------- */

test('依赖自动安装：无 package.json 时报可操作错误', async () => {
  const { paths, dir } = tmpWorkspace();
  const src = path.join(dir, 'src-plug');
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, 'index.mjs'), "import x from 'definitely-not-installed-pkg';\nexport default { name: 'np', version: '0.1.0', description: 'd', permissions: [], schema: { type: 'object', properties: {} }, async execute() { return { ok: true }; } };\n", 'utf8');

  await assert.rejects(
    () => installPlugin(paths, { source: src, force: true, yes: true }),
    /缺少运行时依赖|package\.json/,
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test('依赖自动安装：有 package.json 时退化为读元信息并注册', async () => {
  const { paths, dir } = tmpWorkspace();
  const src = path.join(dir, 'src-plug2');
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, 'package.json'), JSON.stringify({
    name: 'pkg-name-here', version: '9.9.9', description: '来自 package.json 的描述',
    // 本地不存在的 file: 依赖 → npm 立刻失败（不用等网络超时），验证"失败不阻断注册"
    dependencies: { 'local-missing-dep': 'file:./does-not-exist' },
  }), 'utf8');
  fs.writeFileSync(path.join(src, 'index.mjs'), "import x from 'local-missing-dep';\nexport default { name: 'pkg-name-here', version: '9.9.9', permissions: [], schema: { type: 'object', properties: {} }, async execute() { return { ok: true }; } };\n", 'utf8');

  const msgs: string[] = [];
  const r = await installPlugin(paths, { source: src, force: true, yes: true, onProgress: (m) => msgs.push(m) });
  assert.equal(r.name, 'pkg-name-here');
  assert.equal(r.version, '9.9.9');
  assert.ok(new Registry(paths).has('pkg-name-here'), '依赖装失败也应完成注册');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('--no-install 跳过依赖安装', async () => {
  const { paths, dir } = tmpWorkspace();
  const src = path.join(dir, 'src-plug3');
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, 'package.json'), JSON.stringify({
    name: 'skip-deps', version: '1.0.0', description: 'd', dependencies: { 'is-number': '^7.0.0' },
  }), 'utf8');
  fs.writeFileSync(path.join(src, 'index.mjs'), "export default { name: 'skip-deps', version: '1.0.0', permissions: [], schema: { type: 'object', properties: {} }, async execute() { return { ok: true }; } };\n", 'utf8');

  const r = await installPlugin(paths, { source: src, force: true, yes: true, noInstall: true });
  assert.deepEqual(r.dependencies, []);
  assert.ok(!fs.existsSync(path.join(r.dir, 'node_modules')));
  fs.rmSync(dir, { recursive: true, force: true });
});