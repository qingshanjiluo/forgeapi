#!/usr/bin/env node
/**
 * CI smoke 验证：本地跑一遍 .github/workflows/ci.yml 里的关键断言，
 * 避免推上去才红。用独立 FORGE_HOME。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const CLI = path.join(ROOT, 'dist', 'cli', 'index.js');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-ci-smoke-'));
const env = { ...process.env, FORGE_HOME: HOME };

const results = [];
function run(args, opts = {}) {
  try {
    const out = execFileSync(process.execPath, [CLI, ...args], {
      encoding: 'utf8', env, timeout: opts.timeout ?? 180000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, out: String(out) };
  } catch (e) {
    return { ok: false, out: String(e.stdout ?? ''), err: String(e.stderr ?? e.message ?? '') };
  }
}
function check(name, cond, detail = '') {
  results.push({ name, pass: Boolean(cond), detail });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  <<< ' + detail}`);
}
function j(r) {
  const s = r.out.trim();
  const i = Math.min(...[s.indexOf('{'), s.indexOf('[')].filter((x) => x >= 0));
  if (!isFinite(i)) return null;
  try { return JSON.parse(s.slice(i)); } catch { return null; }
}

/* 1) init */
const init = run(['init']);
check('init', init.ok, init.err);

/* 1.5) doctor（确认 chromium 就绪） */
const doc = j(run(['doctor']));
check('doctor playwright ok', doc?.playwright === 'ok', String(doc?.playwright));
check('doctor chromium launched', doc?.chromium === 'launched', String(doc?.chromium));

/* 2) list >= 13 */
const list = j(run(['list', '--json']));
check('list >= 16 插件', Array.isArray(list) && list.length >= 16, `len=${list?.length}`);

/* 3) schema / skill */
check('schema weather', run(['schema', 'weather']).ok);
check('skill weather', run(['skill', 'weather']).ok);

/* 4) MCP tool table + schema 合规 */
const tools = j(run(['mcp', '--list']));
const bad = (tools || []).filter((t) => !t.inputSchema || t.inputSchema.type !== 'object');
check('mcp --list 非空', Array.isArray(tools) && tools.length > 0, `len=${tools?.length}`);
check('mcp schema 全为 object', bad.length === 0, JSON.stringify(bad.map((b) => b.name)));

/* 5) pipeline dry-run */
check('pipeline dry-run', run(['pipeline', 'examples/compose-multi.json', '--dry-run']).ok);

/* 6) vault 三步 */
run(['config', '--vault', 'init', '--password', 'cipass']);
run(['config', '--vault', 'set', '--plugin', 'weather', '--key', 'K', '--value', 'V', '--password', 'cipass']);
const got = j(run(['config', '--vault', 'get', '--plugin', 'weather', '--key', 'K', '--password', 'cipass']));
check('vault set/get', got?.value === 'V', JSON.stringify(got));

/* 7) install / verify */
check('install webpage', run(['install', 'plugins/builtin/webpage', '--force', '--yes']).ok);
const ver = j(run(['verify', 'webpage', '--json']));
check('verify 通过', ver?.ok === true, JSON.stringify(ver)?.slice(0, 120));

/* 8) keygen / sign / trust verify */
check('keygen', run(['keygen', '--signer', 'ci']).ok);
check('sign webpage', run(['sign', 'webpage']).ok);
const tv = j(run(['trust', 'verify', 'webpage', '--json']));
check('trust verify = signed', tv?.items?.[0]?.check?.state === 'signed', JSON.stringify(tv?.items?.[0]?.check)?.slice(0, 120));

/* 9) batch（离线安全：用 httpbin） */
const tfile = path.join(HOME, 'tasks.jsonl');
fs.writeFileSync(tfile, '{"id":"a","plugin":"http-api","params":{"endpoint":"https://httpbin.org/headers"}}\n', 'utf8');
const batch = j(run(['batch', tfile, '--json'], { timeout: 120000 }));
check('batch 可执行', batch?.summary?.total === 1, JSON.stringify(batch?.summary));

/* 10) 单元测试 */
try {
  execFileSync(process.execPath, ['--test', path.join(ROOT, 'dist', 'test', 'extract.test.js'),
    path.join(ROOT, 'dist', 'test', 'aggregate.test.js'), path.join(ROOT, 'dist', 'test', 'core.test.js'),
    path.join(ROOT, 'dist', 'test', 'mcp.test.js'), path.join(ROOT, 'dist', 'test', 'v3.test.js'),
    path.join(ROOT, 'dist', 'test', 'v4.test.js'), path.join(ROOT, 'dist', 'test', 'v5.test.js'),
    path.join(ROOT, 'dist', 'test', 'v6.test.js')],
  { encoding: 'utf8', stdio: 'pipe', timeout: 240000 });
  check('单元测试全过', true);
} catch (e) {
  check('单元测试全过', false, String(e.stdout || '').slice(-300));
}

const pass = results.filter((r) => r.pass).length;
console.log(`\n===== ${pass}/${results.length} PASS =====`);
fs.rmSync(HOME, { recursive: true, force: true });
process.exit(pass === results.length ? 0 : 1);