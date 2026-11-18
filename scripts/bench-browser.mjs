/**
 * 浏览器池复用基准：同一进程内连续两次网页提取，比较耗时。
 * 输出最后一行 JSON：{ first, second }
 */
import { ForgeEngine } from '../dist/core/engine.js';
import { resolvePaths, ensureDirs, loadConfig } from '../dist/core/workspace.js';
import { Registry } from '../dist/core/registry.js';
import { Logger } from '../dist/core/log.js';

const paths = resolvePaths();
ensureDirs(paths);

const reg = new Registry(paths);
if (!reg.get('webpage')) {
  console.error(JSON.stringify({ error: 'webpage 插件未安装，先跑 forge init' }));
  process.exit(2);
}

const engine = new ForgeEngine(paths);
const logger = new Logger({ quiet: true });

const t1 = Date.now();
const r1 = await engine.run('webpage', {
  params: { url: 'https://example.com' }, logger, reuseBrowser: true,
});
const first = Date.now() - t1;

const t2 = Date.now();
const r2 = await engine.run('webpage', {
  params: { url: 'https://example.com' }, logger, reuseBrowser: true,
});
const second = Date.now() - t2;

if (!r1.ok || !r2.ok) {
  console.error(JSON.stringify({ error: r1.error || r2.error, first, second }));
  process.exit(3);
}

const { disposePool } = await import('../dist/core/browserpool.js');
await disposePool();

console.log(JSON.stringify({ first, second }));