/**
 * ForgeAPI 自验脚本：逐项跑通 CLI 全部能力并输出 PASS/FAIL。
 * 用法：node scripts/selftest.mjs
 * 环境：FORGE_HOME 指向独立工作区（脚本自动创建临时目录）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const CLI = path.join(ROOT, 'dist', 'cli', 'index.js');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-selftest-'));
const env = { ...process.env, FORGE_HOME: HOME };

const results = [];
function run(args, { timeout = 180000, expectFail = false } = {}) {
  try {
    const out = execFileSync(process.execPath, [CLI, ...args], {
      encoding: 'utf8', env, timeout, stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, code: 0, out: String(out), err: '' };
  } catch (e) {
    return {
      ok: false,
      code: e.status ?? 1,
      out: String(e.stdout ?? ''),
      err: String(e.stderr ?? e.message ?? ''),
    };
  }
}
function json(r) {
  const s = r.out.trim();
  if (!s) return null;
  // 结果可能是对象或数组：从首个 { 或 [ 开始尝试解析
  for (const start of [s.indexOf('{'), s.indexOf('[')].filter((i) => i >= 0).sort((a, b) => a - b)) {
    try { return JSON.parse(s.slice(start)); } catch { /* 继续尝试 */ }
  }
  return null;
}
function check(name, cond, detail = '') {
  results.push({ name, pass: Boolean(cond), detail });
  const mark = cond ? 'PASS' : 'FAIL';
  console.log(`[${mark}] ${name}${cond ? '' : '  <<< ' + detail}`);
  return Boolean(cond);
}

function writeJsonFile(dir, name, obj) {
  const f = path.join(dir, name);
  fs.writeFileSync(f, JSON.stringify(obj), 'utf8');
  return f;
}

console.log(`FORGE_HOME = ${HOME}\n`);

/* ---------- 1. 基础 ---------- */
const ver = run(['--version']);
check('CLI 版本可输出', /0\.\d+\.\d+/.test(ver.out), ver.out || ver.err);

const init = run(['init']);
const initJ = json(init);
check('init 安装内置插件', initJ?.ok === true && initJ.installed.length >= 9, JSON.stringify(initJ)?.slice(0, 200));
check('init 播种模板', initJ?.templates >= 3, `templates=${initJ?.templates}`);

const list = json(run(['list', '--json']));
check('list 返回 16 个内置插件', Array.isArray(list) && list.length >= 16, `len=${list?.length}`);
check('list 含 forum/webpage/weather', ['forum', 'webpage', 'weather'].every((n) => list?.some((p) => p.name === n)));

/* ---------- 2. 自检 ---------- */
const doc = json(run(['doctor']));
check('doctor playwright ok', doc?.playwright === 'ok', JSON.stringify(doc?.playwright));
check('doctor chromium launched', doc?.chromium === 'launched', String(doc?.chromium));

/* ---------- 3. 真实网络插件 ---------- */
const w = json(run(['run', 'weather', '-p', 'city=上海,days=2']));
check('weather 返回当前天气', w?.ok === true && typeof w.data?.当前?.温度 === 'number', JSON.stringify(w?.data)?.slice(0, 160));
check('weather 返回 2 天预报', w?.data?.预报?.length === 2, `len=${w?.data?.预报?.length}`);

const wg = json(run(['weather', 'geocode', '--params', 'city=Osaka,count=1']));
check('weather geocode 子命令直达', wg?.ok === true && wg.data?.[0]?.name?.includes('大阪'), JSON.stringify(wg?.data?.[0]?.name));

const hn = json(run(['run', 'hn-search', '-p', 'query=rust,limit=3']));
check('hn-search 返回 3 条', hn?.ok === true && hn.data?.results?.length === 3, `len=${hn?.data?.results?.length}`);

const agg = json(run(['run', 'search-aggregate', '-p', '{"query":"python","limit":2,"sources":"hn,wiki"}']));
check('search-aggregate 多源聚合', agg?.ok === true && agg.data?.sources?.length === 2 && agg.data?.total > 0, JSON.stringify(agg?.data?.sources));

const rss = json(run(['run', 'rss', '-p', 'url=https://news.ycombinator.com/rss,limit=3']));
check('rss 解析 HN feed', rss?.ok === true && rss.data?.items?.length === 3 && rss.data?.feeds?.[0]?.format === 'rss', `items=${rss?.data?.items?.length}`);

const httpApi = json(run(['run', 'http-api', '-p', 'endpoint=https://api.github.com/zen']));
check('http-api 通用请求可执行', httpApi?.ok === true || /rate limit|403|404/.test(String(httpApi?.error)), String(httpApi?.error).slice(0, 80));

/* ---------- 4. 浏览器插件 ---------- */
const wp = json(run(['run', 'webpage', '-p', 'url=https://example.com']));
check('webpage 提取标题', wp?.ok === true && wp.data?.title === 'Example Domain', JSON.stringify(wp?.data)?.slice(0, 120));
check('webpage 提取 links 数组', Array.isArray(wp?.data?.links) && wp.data.links.length >= 1, `len=${wp?.data?.links?.length}`);

/* 规则写入 + 规则提取 */
const ruleYaml = `fields:\n  - name: 页面标题\n    selector: title\n    type: text\n  - name: 首段\n    selector: //p[1]\n    kind: xpath\n    type: text\n`;
const ruleFile = path.join(HOME, 'rule.yaml');
fs.writeFileSync(ruleFile, ruleYaml, 'utf8');
const ruleWrite = json(run(['rule', 'webpage', 'selftest', '--file', ruleFile]));
check('rule 写入 YAML 规则', ruleWrite?.ok === true, JSON.stringify(ruleWrite));

const wpRule = json(run(['run', 'webpage', '-p', 'url=https://example.com,rule=selftest']));
check('webpage 用自定义规则 + XPath', wpRule?.ok === true && wpRule.data?.['页面标题'] === 'Example Domain' && String(wpRule.data?.['首段'] ?? '').length > 5, JSON.stringify(wpRule?.data)?.slice(0, 200));

/* blog-list：用本地静态页验证列表抓取（不依赖外部站点稳定性） */
const { spawn: spawnSrv } = await import('node:child_process');
const fixturePort = 8900 + Math.floor(Math.random() * 90);
const listSrv = spawnSrv(process.execPath, [path.join(ROOT, 'scripts', 'fixture-server.mjs'), String(fixturePort), '300000'], {
  stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 800));

const bl = json(run(['run', 'blog-list', '--params-file', writeJsonFile(HOME, 'bl.json', {
  url: `http://127.0.0.1:${fixturePort}/`, limit: 3, item: 'article.item', title: 'h3 a', link: 'h3 a',
})]));
listSrv.kill();
check('blog-list 抓列表条目', bl?.ok === true && bl.data?.items?.length === 3 && bl.data.items[0].title.length > 10,
  JSON.stringify(bl?.data?.items?.[0] ?? bl?.error)?.slice(0, 160));

const fm = json(run(['run', 'forum', '-p', 'base=https://news.ycombinator.com,action=me']));
check('forum action=me 可执行', fm?.ok === true && typeof fm.data?.hasCookies === 'boolean', JSON.stringify(fm?.data));

/* ---------- 5. 模板 ---------- */
const tpl = json(run(['template', 'list']));
check('template list 有模板', Array.isArray(tpl) && tpl.length >= 3, `len=${tpl?.length}`);

const tplSearch = json(run(['template', 'search', 'weather']));
check('template search 命中', Array.isArray(tplSearch) && tplSearch.length >= 1, `len=${tplSearch?.length}`);

const tplInstall = json(run(['template', 'install', 'demo-hn']));
check('template install 成功', tplInstall?.ok === true && tplInstall.name === 'demo-hn', JSON.stringify(tplInstall));

const demoRun = json(run(['run', 'demo-hn', '-p', 'limit=2']));
check('安装后的模板可执行', demoRun?.ok === true && demoRun.data?.total === 2, JSON.stringify(demoRun?.data)?.slice(0, 120));

const tplExport = json(run(['template', 'export', 'weather']));
check('template export 成功', tplExport?.ok === true && typeof tplExport.file === 'string' && fs.existsSync(tplExport.file), JSON.stringify(tplExport?.file));

/* ---------- 6. 凭据 ---------- */
const vInit = json(run(['config', '--vault', 'init', '--password', 'testpass']));
check('vault init', vInit?.initialized === true, JSON.stringify(vInit));

const vSet = json(run(['config', '--vault', 'set', '--plugin', 'forum', '--key', 'USERNAME', '--value', 'demo', '--password', 'testpass']));
check('vault set', vSet?.ok === true, JSON.stringify(vSet));

const vGet = json(run(['config', '--vault', 'get', '--plugin', 'forum', '--key', 'USERNAME', '--password', 'testpass']));
check('vault get 取回明文', vGet?.value === 'demo', JSON.stringify(vGet));

const vBad = json(run(['config', '--vault', 'unlock', '--password', 'wrong']));
check('vault 错误密码被拒', vBad?.unlocked === false, JSON.stringify(vBad));

const vIsolation = json(run(['config', '--vault', 'get', '--plugin', 'weather', '--key', 'USERNAME', '--password', 'testpass']));
check('vault 插件隔离（weather 读不到 forum 键）', vIsolation?.value === null, JSON.stringify(vIsolation));

const credFile = fs.readFileSync(path.join(HOME, 'credentials.json'), 'utf8');
check('凭据落盘为密文（不含明文）', !credFile.includes('demo"') && credFile.includes('"ct"'), credFile.slice(0, 80));

/* ---------- 7. 安装 / 卸载 / 启停 ---------- */
const reinstall = json(run(['install', 'plugins/builtin/hn-search', '--force', '--yes']));
check('install 目录覆盖安装', reinstall?.ok === true && reinstall.name === 'hn-search', JSON.stringify(reinstall));

const dis = json(run(['disable', 'rss']));
check('disable', dis?.disabled === 'rss', JSON.stringify(dis));
const disRun = json(run(['run', 'rss', '-p', 'url=https://x']));
check('禁用插件被拦截', disRun?.ok === false && /禁用/.test(disRun.error), String(disRun?.error));
run(['enable', 'rss']);
const enRun = json(run(['run', 'rss', '-p', 'url=https://news.ycombinator.com/rss,limit=1']));
check('重新启用后恢复', enRun?.ok === true, String(enRun?.error).slice(0, 80));

/* ---------- 8. Skill / Schema ---------- */
const schema = json(run(['schema', 'weather']));
check('schema 输出 JSON Schema', schema?.type === 'object' && !!schema.properties?.city, JSON.stringify(schema)?.slice(0, 100));

const skill = run(['skill', 'weather']);
check('skill 输出 Markdown', skill.out.includes('# weather') && skill.out.includes('```bash') && skill.out.includes('| `city`'), skill.out.slice(0, 80));

const info = json(run(['info', 'forum']));
check('info 含子命令与权限', info?.ok !== false && Array.isArray(info?.commands) && info.permissions.includes('browser'), JSON.stringify(info)?.slice(0, 160));

/* ---------- 9. 日志 ---------- */
const logs = json(run(['log', '-n', '50', '--json']));
check('log 记录调用', Array.isArray(logs) && logs.length > 5, `len=${logs?.length}`);
check('log 含失败记录', logs.some((l) => l.ok === false), 'no failure logged');

const logsErr = json(run(['log', '-n', '50', '--error', '--json']));
check('log --error 只返回失败', Array.isArray(logsErr) && logsErr.every((l) => !l.ok), `len=${logsErr?.length}`);

/* ---------- 10. 配置 ---------- */
const cfgSet = json(run(['config', '--set', 'browser.headless=true', '--set', 'server.port=7899']));
check('config 补丁写入', cfgSet?.server?.port === 7899 && cfgSet?.browser?.headless === true, JSON.stringify(cfgSet?.server));
const cfgGet = json(run(['config']));
check('config 读回一致', cfgGet?.server?.port === 7899, JSON.stringify(cfgGet?.server));

const cfgPlugin = json(run(['cfg', 'forum', '--set', '{"selectors":{"topicItem":"tr.athing"}}']));
check('插件私有配置写入', cfgPlugin?.ok === true && cfgPlugin.config?.selectors?.topicItem === 'tr.athing', JSON.stringify(cfgPlugin));

/* ---------- 11. Web 控制台 ---------- */
const { spawn } = await import('node:child_process');
const port = 7921;
const srv = spawn(process.execPath, [CLI, 'serve', '--port', String(port)], {
  env: { ...process.env, FORGE_HOME: HOME },
  stdio: 'ignore',
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(3000);

let apiOk = false, runOk = false, pageOk = false, openApiOk = false, pipelineApiOk = false;
try {
  const h = await fetch(`http://127.0.0.1:${port}/api/health`);
  apiOk = (await h.json()).ok === true;
  const p = await fetch(`http://127.0.0.1:${port}/api/plugins`);
  const pj = await p.json();
  apiOk = apiOk && pj.data.length >= 10;
  const r = await fetch(`http://127.0.0.1:${port}/api/run`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ plugin: 'weather', params: { lat: 31.23, lon: 121.47, days: 1 } }),
  });
  const rj = await r.json();
  runOk = rj.ok === true && typeof rj.data?.当前?.温度 === 'number' && Array.isArray(rj.logs);

  const oa = await fetch(`http://127.0.0.1:${port}/api/openapi.json`);
  const oaj = await oa.json();
  openApiOk = oaj.openapi === '3.0.3' && Object.keys(oaj.paths || {}).length >= 15;

  const pl = await fetch(`http://127.0.0.1:${port}/api/pipeline`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      def: {
        name: 'api-pl',
        steps: [
          { id: 'w', plugin: 'weather', params: { lat: 31.23, lon: 121.47, days: 1 } },
        ],
        output: { temp: '${steps.w.data.当前.温度}' },
      },
    }),
  });
  const plj = await pl.json();
  pipelineApiOk = plj.ok === true && typeof plj.output?.temp === 'number';

  const page = await fetch(`http://127.0.0.1:${port}/`);
  const html = await page.text();
  pageOk = page.status === 200 && html.includes('ForgeAPI');
} catch (e) {
  check('Web 控制台请求异常', false, e.message);
} finally {
  srv.kill();
}
check('Web /api/health + /api/plugins', apiOk, 'health or plugins failed');
check('Web /api/run 执行插件并回传日志', runOk, 'run failed');
check('Web /api/openapi.json 输出描述', openApiOk, 'openapi failed');
check('Web /api/pipeline 执行工作流', pipelineApiOk, 'pipeline api failed');
check('Web 首页可访问', pageOk, 'page failed');

/* ---------- 12. 单元测试 ---------- */
try {
  execFileSync(process.execPath, ['--test',
    path.join(ROOT, 'dist', 'test', 'extract.test.js'),
    path.join(ROOT, 'dist', 'test', 'aggregate.test.js'),
    path.join(ROOT, 'dist', 'test', 'core.test.js'),
    path.join(ROOT, 'dist', 'test', 'mcp.test.js'),
    path.join(ROOT, 'dist', 'test', 'v3.test.js'),
    path.join(ROOT, 'dist', 'test', 'v4.test.js'),
    path.join(ROOT, 'dist', 'test', 'v5.test.js'),
    path.join(ROOT, 'dist', 'test', 'v6.test.js')],
  { encoding: 'utf8', stdio: 'pipe', timeout: 240000 });
  check('单元测试 154/154 通过', true);
} catch (e) {
  check('单元测试 154/154 通过', false, String(e.stdout || '').slice(-400));
}

/* ---------- 13. MCP 服务端 ---------- */
try {
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'mcp-selftest.mjs')], {
    encoding: 'utf8', stdio: 'pipe', timeout: 180000, env: { ...process.env, FORGE_HOME: HOME },
  });
  check('MCP stdio 协议端到端', true);
} catch (e) {
  check('MCP stdio 协议端到端', false, String(e.stdout || e.stderr || '').slice(-400));
}

const mcpList = run(['mcp', '--list']);
let mcpTools = null;
try { mcpTools = JSON.parse(mcpList.out.trim()); } catch { /* ignore */ }
check('forge mcp --list 输出工具表', Array.isArray(mcpTools) && mcpTools.length >= 9, `len=${mcpTools?.length}`);
check('MCP 工具含 inputSchema', Boolean(mcpTools?.[0]?.inputSchema?.type === 'object'), JSON.stringify(mcpTools?.[0]?.inputSchema)?.slice(0, 80));

/* ---------- 14. 二期模板 ---------- */
const tplAll = json(run(['template', 'list']));
check('模板库 ≥9 个', Array.isArray(tplAll) && tplAll.length >= 9, `len=${tplAll?.length}`);

for (const name of ['exchange-rate', 'translate', 'news-digest', 'price-compare', 'github-trending', 'wiki-summary']) {
  const inst = json(run(['template', 'install', name, '--force']));
  check(`模板安装 ${name}`, inst?.ok === true, JSON.stringify(inst)?.slice(0, 120));
}

const rate = json(run(['run', 'exchange-rate', '--params-file', writeJsonFile(HOME, 'rate.json', { from: 'USD', to: 'CNY' })]));
check('exchange-rate 返回汇率', rate?.ok === true && typeof rate.data?.results?.[0]?.rates?.CNY === 'number', JSON.stringify(rate?.data?.results?.[0])?.slice(0, 120));

const tr = json(run(['run', 'translate', '--params-file', writeJsonFile(HOME, 'tr.json', { text: 'Hello world', to: 'zh-CN' })]));
check('translate 返回译文', tr?.ok === true && String(tr.data?.results?.[0]?.text || '').length > 0, JSON.stringify(tr?.data?.results?.[0])?.slice(0, 120));

const news = json(run(['run', 'news-digest', '--params-file', writeJsonFile(HOME, 'news.json', { limit: 3, total: 5 })]));
check('news-digest 合并多源', news?.ok === true && news.data?.results?.length > 0 && news.data?.sources?.length >= 2, JSON.stringify(news?.data?.sources)?.slice(0, 160));

const price = json(run(['run', 'price-compare', '--params-file', writeJsonFile(HOME, 'price.json', { query: '键盘', demos: true })]));
check('price-compare demo 排序正确', price?.ok === true && price.data?.results?.[0]?.price === 189 && price.data?.lowest?.price === 189, JSON.stringify(price?.data?.lowest));

const wiki = json(run(['run', 'wiki-summary', '--params-file', writeJsonFile(HOME, 'wiki.json', { title: '图灵机', sentences: 2 })]));
check('wiki-summary 返回摘要', wiki?.ok === true && String(wiki.data?.results?.[0]?.description || '').includes('图灵'), JSON.stringify(wiki?.data?.results?.[0]?.title));

const ghTrend = json(run(['run', 'github-trending', '--params-file', writeJsonFile(HOME, 'ght.json', { limit: 2 })]));
check('github-trending 可用（或限流）', ghTrend?.ok === true || /rate limit|403/.test(String(ghTrend?.error)), String(ghTrend?.error).slice(0, 80));

/* ---------- 15. 并发 / 缓存 ---------- */
const aggConc = json(run(['run', 'search-aggregate', '--params-file', writeJsonFile(HOME, 'agg.json', { query: 'go', limit: 2, sources: 'hn,wiki' })]));
check('聚合并发仍保顺序', aggConc?.ok === true && aggConc.data?.sources?.length === 2, JSON.stringify(aggConc?.data?.sources));

/* ---------- 17. 0.3.0：MCP resources / prompts ---------- */
try {
  const rsrc = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'mcp-resources-test.mjs')], {
    encoding: 'utf8', stdio: 'pipe', timeout: 180000, env: { ...process.env, FORGE_HOME: HOME },
  });
  const so = String(rsrc);
  check('MCP resources/list 有资源', /\【1\] resources\/list -> (\d+) 个资源/.test(so) || /resources\/list -> [1-9]/.test(so), so.split('\n')[1]);
  check('MCP resources/read 返回 skill 正文', /read .*\/skill -> [1-9]\d* 字符/.test(so), '');
  check('MCP prompts/list 有 4 个模板', /prompts\/list -> webpage_extract, search_multi, news_brief, data_service/.test(so), '');
} catch (e) {
  check('MCP resources/prompts 端到端', false, String(e.stdout || e.stderr || '').slice(-300));
}

const rlist = run(['mcp', '--list']);
const mcpOk = Boolean(json(rlist));
check('MCP 工具表仍可用（回归）', mcpOk);

/* ---------- 18. 0.3.0：远端模板 ---------- */
const remoteAll = json(run(['template', 'remote', '--json']));
check('template remote 返回索引', Array.isArray(remoteAll) && remoteAll.length >= 9 && String(remoteAll[0].url).startsWith('https://'), `len=${remoteAll?.length}`);

const remoteSearch = json(run(['template', 'remote', 'rate', '--json']));
check('template remote 关键词过滤', Array.isArray(remoteSearch) && remoteSearch.length === 1 && remoteSearch[0].name === 'exchange-rate',
  JSON.stringify(remoteSearch)?.slice(0, 120));

const remoteAdd = json(run(['template', 'add', 'builtin:wiki-summary']));
check('template add builtin: 安装成功', remoteAdd?.ok === true && remoteAdd.name === 'wiki-summary', JSON.stringify(remoteAdd)?.slice(0, 120));

/* ---------- 19. 0.3.0：依赖自动安装 ---------- */
const depSrc = path.join(HOME, 'dep-plug');
fs.mkdirSync(depSrc, { recursive: true });
fs.writeFileSync(path.join(depSrc, 'package.json'), JSON.stringify({
  name: 'dep-demo', version: '0.3.0', description: '依赖自动安装演示',
  dependencies: { 'is-number': '^7.0.0' },
}), 'utf8');
fs.writeFileSync(path.join(depSrc, 'index.mjs'), [
  "import isNumber from 'is-number';",
  'export default {',
  "  name: 'dep-demo', version: '0.3.0', description: '依赖自动安装演示', permissions: [],",
  "  schema: { type: 'object', properties: {} },",
  '  async execute() { return { ok: true, data: { isNumber: isNumber(42) } }; },',
  '};',
].join('\n'), 'utf8');

const depInstall = json(run(['install', depSrc, '--force', '--yes'], { timeout: 240000 }));
check('install 自动安装依赖', depInstall?.ok === true && Array.isArray(depInstall.dependencies) && depInstall.dependencies.includes('is-number'),
  JSON.stringify(depInstall)?.slice(0, 160));

const depRun = json(run(['run', 'dep-demo']));
check('依赖插件可执行', depRun?.ok === true && depRun.data?.isNumber === true, JSON.stringify(depRun)?.slice(0, 120));

const noInstall = json(run(['install', depSrc, '--force', '--yes', '--no-install']));
check('--no-install 跳过依赖', noInstall?.ok === true && Array.isArray(noInstall.dependencies) && noInstall.dependencies.length === 0,
  JSON.stringify(noInstall)?.slice(0, 120));

/* ---------- 20. 0.3.0：流式输出 ---------- */
const streamRes = run(['run', 'demo-hn', '--stream', '--params-file', writeJsonFile(HOME, 'st.json', { limit: 3 })]);
const lines = String(streamRes.out).trim().split('\n').filter(Boolean);
let parsed = [];
try { parsed = lines.map((l) => JSON.parse(l)); } catch { /* ignore */ }
const meta = parsed.find((x) => x.type === 'meta');
const items = parsed.filter((x) => x.type === 'item');
const end = parsed.find((x) => x.type === 'end');
check('--stream 输出 NDJSON', parsed.length >= 5, `lines=${lines.length}`);
check('--stream 首行 meta 带 count', meta?.count === 3, JSON.stringify(meta)?.slice(0, 100));
check('--stream 逐条 item', items.length === 3, `items=${items.length}`);
check('--stream 末行 end 闭合', end?.ok === true && end?.count === 3, JSON.stringify(end));

const streamErr = run(['run', 'rss', '--stream', '-p', 'url=']);
const errLine = String(streamErr.out).trim().split('\n')[0];
let errObj = null;
try { errObj = JSON.parse(errLine); } catch { /* ignore */ }
check('--stream 失败输出 error 行', errObj?.type === 'error' && !errObj.ok, errLine?.slice(0, 120));

/* ---------- 22. 0.4.0：批量 / 校验 / 监视 ---------- */
// 任务用纯本地插件（out / json-query），避免网络波动污染断言
const batchFile = path.join(HOME, 'batch.json');
fs.writeFileSync(batchFile, JSON.stringify([
  { id: 'a', plugin: 'out', params: { data: [{ k: 1 }, { k: 2 }], format: 'csv' } },
  { id: 'b', plugin: 'json-query', params: { json: { items: [1, 2, 3] }, path: '$..*', limit: 2 } },
  { id: 'bad', plugin: 'no-such-plugin', params: {} },
]), 'utf8');

const batchJson = json(run(['batch', batchFile, '--json', '-c', '2'], { timeout: 240000 }));
check('batch 汇总正确', batchJson?.summary?.total === 3 && batchJson?.summary?.ok === 2 && batchJson?.summary?.fail === 1,
  JSON.stringify(batchJson?.summary)?.slice(0, 160));

const batchStream = run(['batch', batchFile, '--stream', '-c', '2'], { timeout: 240000 });
const bLines = String(batchStream.out).trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
check('batch --stream 有 start/result/end',
  bLines.some((x) => x.type === 'batch-start') && bLines.some((x) => x.type === 'result') && bLines.some((x) => x.type === 'batch-end'),
  `lines=${bLines.length}`);

const batchOutFile = path.join(HOME, 'batch-out.jsonl');
run(['batch', batchFile, '-c', '2', '--out', batchOutFile], { timeout: 240000 });
check('batch --out 落盘 JSONL', fs.existsSync(batchOutFile) && fs.readFileSync(batchOutFile, 'utf8').trim().split('\n').length >= 3,
  `exists=${fs.existsSync(batchOutFile)}`);

/* verify：安装即有基线 → 通过 */
const v1 = json(run(['verify', 'weather', '--json']));
check('verify 安装后即有基线且通过', v1?.ok === true && v1.items?.[0]?.ok === true, JSON.stringify(v1)?.slice(0, 160));

/* verify：篡改后能被发现 */
const tamperTarget = path.join(HOME, 'plugins', 'weather', 'index.mjs');
const orig = fs.readFileSync(tamperTarget, 'utf8');
fs.appendFileSync(tamperTarget, '\n// tampered by selftest\n', 'utf8');
const v2 = json(run(['verify', 'weather', '--json']));
check('verify 发现篡改', v2?.ok === false && v2.items?.[0]?.ok === false, JSON.stringify(v2?.items?.[0]?.reason));
fs.writeFileSync(tamperTarget, orig, 'utf8');

/* verify --fix 恢复基线 */
const v3 = json(run(['verify', 'weather', '--fix']));
check('verify --fix 重建基线', v3?.ok === true && v3.baseline?.length === 1, JSON.stringify(v3)?.slice(0, 120));
const v4 = json(run(['verify', 'weather', '--json']));
check('fix 后校验通过', v4?.ok === true, JSON.stringify(v4?.items?.[0]?.reason));

/* watch：首跑建基线，二跑出差异 */
run(['watch', 'hn-search', 'selftest-watch', '-p', 'query=rust,limit=3'], { timeout: 120000 });
const w2 = json(run(['watch', 'hn-search', 'selftest-watch', '-p', 'query=rust,limit=6', '--json'], { timeout: 120000 }));
check('watch 二跑出差异', w2?.ok === true && w2.baseline === false && (w2.diff?.added?.length > 0 || w2.diff?.changed?.length > 0),
  JSON.stringify(w2?.diff?.counts)?.slice(0, 100));

/* watch --reset */
const wr = json(run(['watch', 'hn-search', 'selftest-watch', '--reset']));
check('watch --reset 清快照', wr?.ok === true && wr.reset === true, JSON.stringify(wr)?.slice(0, 100));

/* ---------- 24. 0.5.0：签名 / 可信公钥 / 调度 ---------- */
const kg = json(run(['keygen', '--signer', 'selftest']));
check('keygen 生成 Ed25519 密钥', kg?.ok === true && kg.created === true && String(kg.keyId).length === 16, JSON.stringify(kg)?.slice(0, 120));

const signAll = json(run(['sign'], { timeout: 240000 }));
check('sign 全部插件成功', signAll?.ok === true && signAll.signed?.length >= 9 && signAll.failed?.length === 0,
  JSON.stringify({ signed: signAll?.signed?.length, failed: signAll?.failed })?.slice(0, 160));

const sigList = json(run(['sign', '--list', '--json']));
check('sign --list 全部 signed', Array.isArray(sigList) && sigList.length >= 9 && sigList.every((x) => x.check.state === 'signed'),
  JSON.stringify(sigList?.filter((x) => x.check.state !== 'signed').map((x) => x.name)));

const tv1 = json(run(['trust', 'verify', '--json']));
check('trust verify 全部通过', tv1?.ok === true && tv1.items?.every((i) => i.check.state === 'signed'),
  JSON.stringify(tv1?.items?.filter((i) => i.check.state !== 'signed'))?.slice(0, 160));

/* 篡改内容 → digest-mismatch */
const sigTarget = path.join(HOME, 'plugins', 'webpage', 'plugin.json');
const sigOrig = fs.readFileSync(sigTarget, 'utf8');
fs.writeFileSync(sigTarget, sigOrig.replace('单页提取', '单页提取-篡改'), 'utf8');
const tv2 = json(run(['trust', 'verify', 'webpage', '--json']));
check('篡改内容 → digest-mismatch', tv2?.ok === false && tv2.items?.[0]?.check?.state === 'digest-mismatch',
  JSON.stringify(tv2?.items?.[0]?.check)?.slice(0, 160));
fs.writeFileSync(sigTarget, sigOrig, 'utf8');

/* 换私钥重签 → signed-invalid */
const evilKey = path.join(HOME, 'evil.key');
{
  const crypto = await import('node:crypto');
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  fs.writeFileSync(evilKey, privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), 'utf8');
}
run(['sign', 'rss', '--key', evilKey]);
const tv3 = json(run(['trust', 'verify', 'rss', '--json']));
check('伪造签名 → signed-invalid', tv3?.ok === false && tv3.items?.[0]?.check?.state === 'signed-invalid',
  JSON.stringify(tv3?.items?.[0]?.check?.reason)?.slice(0, 160));
run(['sign', 'rss']); // 恢复正确签名

/* 公钥导出 / 导入 / 可信验签 */
const pubOut = path.join(HOME, 'exported.pub');
const exp = json(run(['sign', '--export-pub', pubOut]));
check('sign --export-pub 导出公钥', exp?.exportedPublicKey === pubOut && fs.existsSync(pubOut), String(exp?.exportedPublicKey));
const imp = json(run(['trust', 'import', pubOut]));
check('trust import 导入公钥', imp?.ok === true && String(imp.keyId).length === 16, JSON.stringify(imp)?.slice(0, 120));
const tk = json(run(['trust', 'list']));
check('trust list 列出可信公钥', Array.isArray(tk) && tk.some((k) => k.keyId === imp.keyId), JSON.stringify(tk)?.slice(0, 120));

/* 调度：every / cron / list / run / enable / disable / remove */
const schAdd = json(run(['schedule', 'add', 'weather', '--name', 't1', '--every', '60', '-p', 'lat=31.23,lon=121.47,days=1']));
check('schedule add every', schAdd?.ok === true && schAdd.entry?.everySec === 60 && Boolean(schAdd.entry?.nextRun),
  JSON.stringify(schAdd?.entry)?.slice(0, 120));

const schCron = json(run(['schedule', 'add', 'exchange-rate', '--name', 'c1', '--cron', '*/10 * * * *', '-p', 'from=USD,to=CNY']));
check('schedule add cron', schCron?.ok === true && Boolean(schCron.entry?.cron) && Boolean(schCron.entry?.nextRun),
  JSON.stringify(schCron?.entry)?.slice(0, 120));

const schBad = json(run(['schedule', 'add', 'weather', '--name', 'bad', '--cron', '99 * * * *']));
check('schedule add 拒绝非法 cron', schBad?.ok === false && /越界/.test(String(schBad?.error)), String(schBad?.error).slice(0, 80));

const schList = json(run(['schedule', 'list', '--json']));
check('schedule list 有 2 条', Array.isArray(schList) && schList.length === 2, `len=${schList?.length}`);

const schRun = json(run(['schedule', 'run', 't1'], { timeout: 120000 }));
check('schedule run 立即执行', schRun?.ok === true && schRun.entry?.runs === 1 && schRun.entry?.lastStatus === 'ok',
  JSON.stringify({ runs: schRun?.entry?.runs, last: schRun?.entry?.lastStatus })?.slice(0, 120));

const schDis = json(run(['schedule', 'disable', 'c1']));
check('schedule disable', schDis?.ok === true && schDis.entry?.enabled === false, JSON.stringify(schDis?.entry?.enabled));
const schEn = json(run(['schedule', 'enable', 'c1']));
check('schedule enable', schEn?.ok === true && schEn.entry?.enabled === true, JSON.stringify(schEn?.entry?.enabled));

/* daemon --once：把 nextRun 调到过去，应触发执行 */
const schFile = path.join(HOME, 'schedules.json');
{
  const store = JSON.parse(fs.readFileSync(schFile, 'utf8'));
  const past = new Date(Date.now() - 5000).toISOString();
  store.entries = store.entries.map((e) => ({ ...e, nextRun: past }));
  fs.writeFileSync(schFile, JSON.stringify(store), 'utf8');
}
const daemon = run(['schedule', 'daemon', '--once'], { timeout: 180000 });
const afterDaemon = json(run(['schedule', 'list', '--json']));
const t1After = afterDaemon?.find((e) => e.name === 't1');
check('daemon --once 触发到期任务', Boolean(t1After) && t1After.runs >= 2, JSON.stringify(afterDaemon?.map((e) => ({ n: e.name, r: e.runs })))?.slice(0, 160));
void daemon;

const schRm = json(run(['schedule', 'remove', 't1']));
check('schedule remove', schRm?.ok === true, JSON.stringify(schRm)?.slice(0, 100));

/* ---------- 25. 0.6.0：pipeline 编排 ---------- */
const plFile = path.join(HOME, 'pl-demo.yaml');
fs.writeFileSync(plFile, [
  'name: selftest-pipeline',
  'onError: continue',
  'input:',
  '  q: rust',
  'steps:',
  '  - id: rate',
  '    plugin: exchange-rate',
  "    params:",
  "      from: USD",
  "      to: CNY",
  '  - id: search',
  '    plugin: hn-search',
  "    params:",
  '      query: "${input.q}"',
  '      limit: 2',
  '  - id: skipped',
  '    plugin: hn-search',
  '    when: false',
  "    params:",
  '      query: x',
  'output:',
  '  rate: "${steps.rate.data.results[0].rates.CNY}"',
  '  found: "${steps.search.data.total}"',
].join('\n'), 'utf8');

const plDry = json(run(['pipeline', plFile, '--dry-run']));
check('pipeline --dry-run 输出步骤计划', plDry?.ok === true && plDry.steps?.length === 3 && plDry.steps[2].when === true,
  JSON.stringify(plDry?.steps)?.slice(0, 160));

const plRun = json(run(['pipeline', plFile], { timeout: 240000 }));
check('pipeline 执行并组合输出',
  plRun?.ok === true && typeof plRun.output?.rate === 'number' && plRun.output?.found === 2,
  JSON.stringify(plRun?.output)?.slice(0, 160));

const skippedStep = plRun?.steps?.find((s) => s.id === 'skipped');
check('pipeline when 条件跳过', skippedStep?.skipped === true, JSON.stringify(skippedStep)?.slice(0, 120));

const plStream = run(['pipeline', plFile, '--stream'], { timeout: 240000 });
const plLines = String(plStream.out).trim().split('\n').filter(Boolean)
  .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
check('pipeline --stream 有 start/step/end/output',
  plLines.some((x) => x.type === 'pipeline-start') && plLines.some((x) => x.type === 'step') &&
  plLines.some((x) => x.type === 'pipeline-end') && plLines.some((x) => x.type === 'output'),
  `lines=${plLines.length}`);

/* pipeline 接入调度 */
const plSched = json(run(['schedule', 'add', '--kind', 'pipeline', '--name', 'pl1', '--file', plFile, '--every', '60']));
check('schedule add pipeline', plSched?.ok === true && plSched.entry?.kind === 'pipeline', JSON.stringify(plSched?.entry?.kind));

const plSchedRun = json(run(['schedule', 'run', 'pl1'], { timeout: 240000 }));
check('schedule 执行 pipeline', plSchedRun?.ok === true && /pipeline/.test(String(plSchedRun.result?.summary)),
  String(plSchedRun?.result?.summary).slice(0, 120));
run(['schedule', 'remove', 'pl1']);

/* ---------- 26. 0.7.0：screenshot / pdf / page-meta / sitemap ---------- */
const shot = json(run(['run', 'screenshot', '--params-file', writeJsonFile(HOME, 'shot.json', {
  url: 'https://example.com', fullPage: false,
})], { timeout: 180000 }));
check('screenshot 生成 PNG 文件',
  shot?.ok === true && Number(shot.data?.bytes) > 1000 && fs.existsSync(String(shot.data?.file)),
  JSON.stringify({ bytes: shot?.data?.bytes })?.slice(0, 120));

const shotB64 = json(run(['run', 'screenshot', '--params-file', writeJsonFile(HOME, 'shot2.json', {
  url: 'https://example.com', output: 'base64', type: 'jpeg', quality: 50,
})], { timeout: 180000 }));
check('screenshot base64 模式',
  shotB64?.ok === true && String(shotB64.data?.base64 || '').length > 1000 && shotB64.data?.type === 'jpeg',
  JSON.stringify({ len: String(shotB64?.data?.base64 || '').length })?.slice(0, 100));

const pdfOut = json(run(['run', 'pdf', '--params-file', writeJsonFile(HOME, 'pdf.json', {
  url: 'https://example.com',
})], { timeout: 180000 }));
check('pdf 生成文件且体积合理',
  pdfOut?.ok === true && Number(pdfOut.data?.bytes) > 5000 && fs.existsSync(String(pdfOut.data?.file)),
  JSON.stringify({ bytes: pdfOut?.data?.bytes })?.slice(0, 120));

const pmeta = json(run(['run', 'page-meta', '--params-file', writeJsonFile(HOME, 'pmeta.json', {
  url: 'https://example.com',
})], { timeout: 180000 }));
check('page-meta 返回页面画像',
  pmeta?.ok === true && typeof pmeta.data?.title === 'string' && typeof pmeta.data?.counts?.links === 'number',
  JSON.stringify({ title: pmeta?.data?.title })?.slice(0, 120));

const sm = json(run(['run', 'sitemap', '--params-file', writeJsonFile(HOME, 'sm.json', {
  url: 'https://www.sitemaps.org', limit: 5,
})], { timeout: 180000 }));
check('sitemap 自动发现并解析',
  sm?.ok === true && Array.isArray(sm.data?.urls) && sm.data.urls.length > 0 && sm.data.total > 0,
  JSON.stringify({ total: sm?.data?.total })?.slice(0, 120));

const smMissing = json(run(['run', 'sitemap', '--params-file', writeJsonFile(HOME, 'sm2.json', {
  url: 'https://gitea.com',
})], { timeout: 120000 }));
check('sitemap 无发现时明确报错',
  smMissing?.ok === false && /发现 sitemap/.test(String(smMissing?.error)),
  String(smMissing?.error).slice(0, 100));

/* ---------- 27. 0.8.0：out / json-query / pdf-text ---------- */
const outRes = json(run(['run', 'out', '--params-file', writeJsonFile(HOME, 'out.json', {
  data: [{ 标题: 'A', 热度: 10 }, { 标题: 'B', 热度: 5 }],
  format: 'markdown',
})]));
check('out 生成 Markdown 表格',
  outRes?.ok === true && String(outRes.data?.text || '').includes('| 标题 | 热度 |') && outRes.data?.rows === 2,
  JSON.stringify(outRes?.data?.text)?.slice(0, 120));

const outCsv = json(run(['run', 'out', '--params-file', writeJsonFile(HOME, 'out2.json', {
  data: [{ a: 'x,y', b: 1 }],
  format: 'csv',
})]));
check('out CSV 正确转义', outCsv?.ok === true && String(outCsv.data?.text || '').includes('"x,y"'),
  JSON.stringify(outCsv?.data?.text));

const jq = json(run(['run', 'json-query', '--params-file', writeJsonFile(HOME, 'jq.json', {
  json: { results: [{ title: 'A', score: 10 }, { title: 'B', score: 30 }, { title: 'C', score: 20 }] },
  path: '$.results', sortBy: 'score', order: 'desc', limit: 2,
})]));
check('json-query 排序 + 限量',
  jq?.ok === true && Array.isArray(jq.data) && jq.data.length === 2 && jq.data[0].score === 30,
  JSON.stringify(jq?.data)?.slice(0, 140));

const jqFilter = json(run(['run', 'json-query', '--params-file', writeJsonFile(HOME, 'jq2.json', {
  json: { items: [{ p: 50 }, { p: 150 }, { p: 200 }] },
  path: '$.items[?(@.p>100)]',
})]));
check('json-query 谓词过滤',
  jqFilter?.ok === true && Array.isArray(jqFilter.data) && jqFilter.data.length === 2,
  JSON.stringify(jqFilter?.data)?.slice(0, 120));

/* pdf-text：先用 pdf 插件造样本，再提取 */
const pdfSample = json(run(['run', 'pdf', '--params-file', writeJsonFile(HOME, 'pdfgen.json', {
  url: 'https://example.com',
})], { timeout: 180000 }));
if (pdfSample?.ok && fs.existsSync(String(pdfSample.data?.file))) {
  const txt = json(run(['run', 'pdf-text', '--params-file', writeJsonFile(HOME, 'pdftxt.json', {
    file: String(pdfSample.data.file), maxPages: 1,
  })], { timeout: 240000 }));
  check('pdf-text 提取文本',
    txt?.ok === true && Number(txt.data?.chars) > 20,
    JSON.stringify({ chars: txt?.data?.chars, pages: txt?.data?.pages })?.slice(0, 120));
} else {
  check('pdf-text 提取文本', false, 'pdf 样本生成失败（跳过）');
}

/* ---------- 28. 浏览器复用（同进程两次调用） ---------- */
try {
  const bench = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'bench-browser.mjs')], {
    encoding: 'utf8', stdio: 'pipe', timeout: 180000, env: { ...process.env, FORGE_HOME: HOME },
  });
  const lastLine = String(bench).trim().split('\n').pop();
  const bj = JSON.parse(lastLine);
  check('浏览器池复用（第2次更快）', bj.second < bj.first && bj.second < 1500,
    `first=${bj.first}ms second=${bj.second}ms`);
} catch (e) {
  check('浏览器池复用（第2次更快）', false,
    `status=${e.status} msg=${e.message?.slice(0, 160)} out=${String(e.stdout || '').slice(-200)} err=${String(e.stderr || '').slice(-200)}`);
}

/* ---------- 汇总 ---------- */
const pass = results.filter((r) => r.pass).length;
const fail = results.length - pass;
console.log(`\n========== ${pass}/${results.length} PASS, ${fail} FAIL ==========`);
if (fail) {
  console.log('\n失败项：');
  for (const r of results.filter((x) => !x.pass)) console.log(` - ${r.name}: ${r.detail}`);
}
fs.rmSync(HOME, { recursive: true, force: true });
process.exit(fail ? 1 : 0);