import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  generateKeyPair, keyIdOf, createKeys, defaultKeyPaths, signPlugin, readSignature,
  verifySignature, signatureStatusAll, exportPublicKey, importPublicKey,
  listTrustedKeys, verifyWithTrusted, SIG_FILE,
} from '../core/signing.js';
import {
  parseCron, cronMatches, nextCronTime, computeNext, addSchedule, removeSchedule,
  setEnabled, markRun, dueEntries, loadSchedules, scheduleFile,
} from '../core/schedule.js';
import { resolvePaths, ensureDirs } from '../core/workspace.js';
import { Registry } from '../core/registry.js';

function tmpWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-5x-'));
  const paths = resolvePaths(dir);
  ensureDirs(paths);
  return { paths, dir };
}

function addPlugin(paths: ReturnType<typeof resolvePaths>, name: string, body = 'v1') {
  const d = path.join(paths.plugins, name);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'index.mjs'), [
    'export default {',
    `  name: '${name}', version: '1.0.0', description: 'd', permissions: [],`,
    "  schema: { type: 'object', properties: {} },",
    `  async execute() { return { ok: true, data: '${body}' }; },`,
    '};',
  ].join('\n'), 'utf8');
  new Registry(paths).register({
    name, version: '1.0.0', dir: d, file: 'index.mjs',
    enabled: true, permissions: [], description: 'd', installedAt: new Date().toISOString(),
  });
  return d;
}

/* ---------------- 密钥 ---------------- */

test('generateKeyPair 产出可用的 Ed25519 对与 keyId', () => {
  const kp = generateKeyPair();
  assert.match(kp.publicKeyPem, /BEGIN PUBLIC KEY/);
  assert.match(kp.privateKeyPem, /BEGIN PRIVATE KEY/);
  assert.equal(kp.keyId.length, 16);
  assert.equal(kp.keyId, keyIdOf(kp.publicKeyPem));
});

test('createKeys 落盘且不覆盖已有密钥', () => {
  const { paths, dir } = tmpWorkspace();
  const first = createKeys(paths, { signer: 'tester' });
  assert.equal(first.created, true);
  const p = defaultKeyPaths(paths);
  assert.ok(fs.existsSync(p.privateKey));
  assert.ok(fs.existsSync(p.publicKey));

  const second = createKeys(paths);
  assert.equal(second.created, false);
  assert.equal(second.keyId, first.keyId);

  const forced = createKeys(paths, { force: true });
  assert.equal(forced.created, true);
  assert.notEqual(forced.keyId, first.keyId);
  fs.rmSync(dir, { recursive: true, force: true });
});

/* ---------------- 签名与验签 ---------------- */

test('签名后可验签通过', () => {
  const { paths, dir } = tmpWorkspace();
  addPlugin(paths, 'signed-plug');
  createKeys(paths, { signer: 'alice' });

  const r = signPlugin(paths, 'signed-plug')!;
  assert.ok(r.digest);
  assert.ok(fs.existsSync(r.sigFile));

  const sig = readSignature(path.dirname(r.sigFile))!;
  assert.equal(sig.algorithm, 'ed25519');
  assert.equal(sig.signer, 'alice');
  assert.equal(sig.digest, r.digest);

  const check = verifySignature(path.dirname(r.sigFile), { publicKeyPath: defaultKeyPaths(paths).publicKey });
  assert.equal(check.state, 'signed');
  assert.equal(check.ok, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('FORGE.SIG 不计入内容哈希（签完仍可通过）', () => {
  const { paths, dir } = tmpWorkspace();
  const d = addPlugin(paths, 'p1');
  createKeys(paths);
  const r1 = signPlugin(paths, 'p1')!;
  // 再签一次：digest 应稳定（签名文件本身不参与）
  const r2 = signPlugin(paths, 'p1')!;
  assert.equal(r1.digest, r2.digest);
  assert.ok(fs.existsSync(path.join(d, SIG_FILE)));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('内容被改 → digest-mismatch', () => {
  const { paths, dir } = tmpWorkspace();
  const d = addPlugin(paths, 'p2');
  createKeys(paths);
  signPlugin(paths, 'p2');

  fs.appendFileSync(path.join(d, 'index.mjs'), '\n// tampered\n', 'utf8');
  const check = verifySignature(d, { publicKeyPath: defaultKeyPaths(paths).publicKey });
  assert.equal(check.state, 'digest-mismatch');
  assert.equal(check.ok, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('用别的私钥重签 → signed-invalid（keyId 不匹配）', () => {
  const { paths, dir } = tmpWorkspace();
  const d = addPlugin(paths, 'p3');
  createKeys(paths);

  // 攻击者密钥
  const evil = generateKeyPair();
  const evilKey = path.join(dir, 'evil.key');
  fs.writeFileSync(evilKey, evil.privateKeyPem, 'utf8');
  signPlugin(paths, 'p3', { privateKeyPath: evilKey });

  const check = verifySignature(d, { publicKeyPath: defaultKeyPaths(paths).publicKey });
  assert.equal(check.state, 'signed-invalid');
  assert.match(check.reason!, /公钥指纹不匹配/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('未签名 → unsigned', () => {
  const { paths, dir } = tmpWorkspace();
  const d = addPlugin(paths, 'p4');
  const check = verifySignature(d);
  assert.equal(check.state, 'unsigned');
  assert.equal(check.ok, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('无公钥时只做摘要一致性检查', () => {
  const { paths, dir } = tmpWorkspace();
  const d = addPlugin(paths, 'p5');
  createKeys(paths);
  signPlugin(paths, 'p5');
  const check = verifySignature(d); // 不传公钥
  assert.equal(check.state, 'signed');
  assert.equal(check.ok, true);
  assert.match(check.reason!, /未提供公钥/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('签名内容非法（伪造 base64）→ signed-invalid', () => {
  const { paths, dir } = tmpWorkspace();
  const d = addPlugin(paths, 'p6');
  createKeys(paths);
  const r = signPlugin(paths, 'p6')!;

  // 改签名值但保持 digest 不变
  const sigFile = path.join(d, SIG_FILE);
  const rec = JSON.parse(fs.readFileSync(sigFile, 'utf8'));
  rec.signature = crypto.randomBytes(64).toString('base64');
  fs.writeFileSync(sigFile, JSON.stringify(rec), 'utf8');

  const check = verifySignature(d, { publicKeyPath: defaultKeyPaths(paths).publicKey });
  assert.equal(check.state, 'signed-invalid');
  assert.match(check.reason!, /签名验证失败/);
  void r;
  fs.rmSync(dir, { recursive: true, force: true });
});

test('signatureStatusAll 汇总多插件', () => {
  const { paths, dir } = tmpWorkspace();
  addPlugin(paths, 'a');
  addPlugin(paths, 'b');
  createKeys(paths);
  signPlugin(paths, 'a');
  const list = signatureStatusAll(paths, { publicKeyPath: defaultKeyPaths(paths).publicKey });
  assert.equal(list.length, 2);
  assert.equal(list.find((x) => x.name === 'a')!.check.state, 'signed');
  assert.equal(list.find((x) => x.name === 'b')!.check.state, 'unsigned');
  fs.rmSync(dir, { recursive: true, force: true });
});

/* ---------------- 可信公钥 ---------------- */

test('export / import 公钥，按 keyId 归档', () => {
  const { paths, dir } = tmpWorkspace();
  createKeys(paths);
  const out = path.join(dir, 'exported.pub');
  exportPublicKey(paths, out);
  assert.ok(fs.existsSync(out));

  const imp = importPublicKey(paths, out);
  assert.equal(imp.keyId.length, 16);
  assert.ok(fs.existsSync(imp.target));

  const trusted = listTrustedKeys(paths);
  assert.ok(trusted.some((k) => k.keyId === imp.keyId));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('verifyWithTrusted 用导入的公钥验签', () => {
  const { paths, dir } = tmpWorkspace();
  addPlugin(paths, 'p7');
  const kp = createKeys(paths);
  signPlugin(paths, 'p7');

  // 导出并导入同一公钥 → 信任链闭合
  const pubOut = path.join(dir, 'pub.pub');
  exportPublicKey(paths, pubOut);
  importPublicKey(paths, pubOut);

  const d = path.join(paths.plugins, 'p7');
  const check = verifyWithTrusted(paths, d);
  assert.equal(check.state, 'signed');
  assert.equal(check.keyId, kp.keyId);
  fs.rmSync(dir, { recursive: true, force: true });
});

/* ---------------- cron 解析 ---------------- */

test('parseCron 展开通配与区间', () => {
  const s = parseCron('*/15 0-2 * * 1');
  assert.deepEqual(s.minutes, [0, 15, 30, 45]);
  assert.deepEqual(s.hours, [0, 1, 2]);
  assert.equal(s.days.length, 31);
  assert.deepEqual(s.weekdays, [1]);
});

test('parseCron 支持逗号列表', () => {
  const s = parseCron('5,10,20 * * * *');
  assert.deepEqual(s.minutes, [5, 10, 20]);
});

test('parseCron 拒绝越界与字段数错误', () => {
  assert.throws(() => parseCron('99 * * * *'), /越界/);
  assert.throws(() => parseCron('* * *'), /5 个字段/);
  assert.throws(() => parseCron('*/0 * * * *'), /步长非法/);
});

test('cronMatches 精确匹配分钟与小时', () => {
  const spec = parseCron('30 14 * * *');
  assert.equal(cronMatches(spec, new Date(2026, 10, 18, 14, 30)), true);
  assert.equal(cronMatches(spec, new Date(2026, 10, 18, 14, 31)), false);
  assert.equal(cronMatches(spec, new Date(2026, 10, 18, 15, 30)), false);
});

test('cronMatches 日/周都受限时取或', () => {
  // 每月 1 日 或 每周一
  const spec = parseCron('0 0 1 * 1');
  // 2026-11-01 是周日，但日=1 → 命中
  assert.equal(cronMatches(spec, new Date(2026, 10, 1, 0, 0)), true);
  // 2026-11-02 是周一，日≠1 但周=1 → 命中
  assert.equal(cronMatches(spec, new Date(2026, 10, 2, 0, 0)), true);
  // 2026-11-03 周二 → 不命中
  assert.equal(cronMatches(spec, new Date(2026, 10, 3, 0, 0)), false);
});

test('nextCronTime 给出未来时间', () => {
  const spec = parseCron('*/5 * * * *');
  const from = new Date(2026, 10, 18, 10, 2, 30);
  const next = nextCronTime(spec, from);
  assert.equal(next.getMinutes(), 5);
  assert.equal(next.getSeconds(), 0);
  assert.ok(next.getTime() > from.getTime());
});

/* ---------------- 调度条目 ---------------- */

test('addSchedule every：写入 nextRun', () => {
  const { paths, dir } = tmpWorkspace();
  const e = addSchedule(paths, { name: 's1', kind: 'run', args: { plugin: 'p' }, everySec: 60 });
  assert.ok(e.nextRun);
  assert.equal(e.enabled, true);
  assert.ok(fs.existsSync(scheduleFile(paths)));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('addSchedule cron：nextRun 落在 cron 点上', () => {
  const { paths, dir } = tmpWorkspace();
  const e = addSchedule(paths, { name: 's2', kind: 'run', args: {}, cron: '*/10 * * * *' });
  const next = new Date(e.nextRun!);
  assert.equal(next.getMinutes() % 10, 0);
  assert.equal(next.getSeconds(), 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('addSchedule 校验：缺时间 / 二者同给 / 间隔过小 / 重名', () => {
  const { paths, dir } = tmpWorkspace();
  assert.throws(() => addSchedule(paths, { name: 'x', kind: 'run', args: {} }), /--every.*--cron/);
  assert.throws(() => addSchedule(paths, { name: 'x', kind: 'run', args: {}, everySec: 60, cron: '* * * * *' }), /二选一/);
  assert.throws(() => addSchedule(paths, { name: 'x', kind: 'run', args: {}, everySec: 5 }), /需 ≥10 秒/);
  addSchedule(paths, { name: 'dup', kind: 'run', args: {}, everySec: 60 });
  assert.throws(() => addSchedule(paths, { name: 'dup', kind: 'run', args: {}, everySec: 60 }), /同名调度/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('removeSchedule / setEnabled', () => {
  const { paths, dir } = tmpWorkspace();
  addSchedule(paths, { name: 'r1', kind: 'run', args: {}, everySec: 60 });
  assert.equal(setEnabled(paths, 'r1', false)!.enabled, false);
  assert.equal(loadSchedules(paths).entries[0].nextRun, undefined);
  assert.equal(removeSchedule(paths, 'r1'), true);
  assert.equal(removeSchedule(paths, 'r1'), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('markRun 更新 runs/failures/lastStatus 并重算 nextRun', () => {
  const { paths, dir } = tmpWorkspace();
  addSchedule(paths, { name: 'm1', kind: 'run', args: {}, everySec: 60 });
  const e1 = markRun(paths, 'm1', { ok: true, summary: 'fine' })!;
  assert.equal(e1.runs, 1);
  assert.equal(e1.failures, 0);
  assert.equal(e1.lastStatus, 'ok');
  assert.equal(e1.lastSummary, 'fine');
  assert.ok(e1.nextRun);

  const e2 = markRun(paths, 'm1', { ok: false, summary: 'boom' })!;
  assert.equal(e2.runs, 2);
  assert.equal(e2.failures, 1);
  assert.equal(e2.lastStatus, 'fail');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('dueEntries 只返回到期的启用条目', () => {
  const { paths, dir } = tmpWorkspace();
  const e = addSchedule(paths, { name: 'd1', kind: 'run', args: {}, everySec: 3600 });
  // 未到期
  assert.equal(dueEntries(paths).filter((x) => x.name === 'd1').length, 0);

  // 手动把 nextRun 调到过去
  const store = loadSchedules(paths);
  const item = store.entries.find((x) => x.name === 'd1')!;
  item.nextRun = new Date(Date.now() - 5000).toISOString();
  fs.writeFileSync(scheduleFile(paths), JSON.stringify(store), 'utf8');
  assert.equal(dueEntries(paths).filter((x) => x.name === 'd1').length, 1);

  // 禁用后不算到期
  setEnabled(paths, 'd1', false);
  assert.equal(dueEntries(paths).filter((x) => x.name === 'd1').length, 0);
  void e;
  fs.rmSync(dir, { recursive: true, force: true });
});

test('computeNext：cron 优先于 every', () => {
  const base = {
    id: 'x', name: 'x', kind: 'run' as const, args: {}, enabled: true,
    createdAt: new Date().toISOString(), runs: 0, failures: 0,
    everySec: 3600, cron: '0 3 * * *',
  };
  const next = computeNext(base)!;
  assert.equal(next.getHours(), 3);
  assert.equal(next.getMinutes(), 0);
});

test('computeNext：禁用返回 null', () => {
  const base = {
    id: 'y', name: 'y', kind: 'run' as const, args: {}, enabled: false,
    createdAt: new Date().toISOString(), runs: 0, failures: 0, everySec: 60,
  };
  assert.equal(computeNext(base), null);
});