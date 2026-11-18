import { spawn } from 'node:child_process';
import path from 'node:path';

const CLI = path.resolve('dist', 'mcp', 'index.js');
const child = spawn(process.execPath, [CLI, '--only', 'weather,webpage'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, FORGE_HOME: path.resolve('.forge-local') },
});

let buf = '';
const pending = new Map();
child.stdout.on('data', (b) => {
  buf += b.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { console.log('非 JSON:', line.slice(0, 80)); continue; }
    if (pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    else console.log('未匹配:', line.slice(0, 120));
  }
});
child.stderr.on('data', (b) => process.stderr.write(`[mcp] ${b}`));

let seq = 1;
const rpc = (method, params) => {
  const id = seq++;
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }) + '\n');
  return new Promise((r) => pending.set(id, r));
};

await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } });
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

/* 1) resources/list */
const rl = await rpc('resources/list', {});
const resources = rl.result?.resources || [];
console.log(`[1] resources/list -> ${resources.length} 个资源`);
for (const r of resources.slice(0, 6)) console.log(`    ${r.uri}  (${r.mimeType})`);

/* 2) resources/templates/list */
const rt = await rpc('resources/templates/list', {});
console.log('[2] resourceTemplates ->', (rt.result?.resourceTemplates || []).map((t) => t.uriTemplate).join(', '));

/* 3) resources/read skill */
const rd = await rpc('resources/read', { uri: 'forge://plugin/weather/skill' });
const skillText = rd.result?.contents?.[0]?.text || '';
console.log(`[3] read weather/skill -> ${skillText.length} 字符, mime=${rd.result?.contents?.[0]?.mimeType}, 含标题=${skillText.includes('# weather')}`);

/* 4) resources/read 未知 */
const bad = await rpc('resources/read', { uri: 'forge://plugin/nope/skill' });
console.log('[4] 未知资源 -> error.code=', bad.error?.code);

/* 5) prompts/list */
const pl = await rpc('prompts/list', {});
console.log('[5] prompts/list ->', (pl.result?.prompts || []).map((p) => p.name).join(', '));

/* 6) prompts/get */
const pg = await rpc('prompts/get', { name: 'search_multi', arguments: { query: 'rust async', limit: '5' } });
const first = pg.result?.messages?.[0]?.content?.text || '';
console.log('[6] prompts/get search_multi ->', pg.result?.description);
console.log('    ', first.split('\n').filter(Boolean).slice(0, 2).join(' | ').slice(0, 140));

/* 7) prompts/get 未知 */
const pbad = await rpc('prompts/get', { name: 'nope' });
console.log('[7] 未知 prompt -> error.code=', pbad.error?.code);

/* 8) initialize 的 capabilities */
const init2 = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
console.log('[8] capabilities ->', JSON.stringify(init2.result?.capabilities));

child.stdin.end();
child.kill();