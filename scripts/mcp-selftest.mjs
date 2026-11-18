import { spawn } from 'node:child_process';
import path from 'node:path';

const CLI = path.resolve('dist', 'mcp', 'index.js');
const child = spawn(process.execPath, [CLI, '--only', 'weather,rss'], {
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
    try { msg = JSON.parse(line); } catch { console.log('非 JSON 输出:', line.slice(0, 100)); continue; }
    const key = msg.id;
    if (pending.has(key)) { pending.get(key)(msg); pending.delete(key); }
    else console.log('未匹配响应:', line.slice(0, 120));
  }
});
child.stderr.on('data', (b) => process.stderr.write(`[mcp] ${b}`));

let seq = 1;
function rpc(method, params) {
  const id = seq++;
  const req = { jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) };
  child.stdin.write(JSON.stringify(req) + '\n');
  return new Promise((resolve) => pending.set(id, resolve));
}

const t0 = Date.now();

// 1) initialize
const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'selftest', version: '0' } });
console.log('[1] initialize ->', init.result?.serverInfo, 'protocol', init.result?.protocolVersion);
console.log('    instructions:', (init.result?.instructions || '').slice(0, 60) + '…');

// 2) notifications/initialized（无 id，不应有响应）
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

// 3) tools/list
const list = await rpc('tools/list', {});
const tools = list.result?.tools || [];
console.log('[2] tools/list ->', tools.length, '个工具:', tools.map((t) => t.name).join(', '));

// 4) tools/call —— weather（真实网络）
const w = await rpc('tools/call', {
  name: 'weather',
  arguments: { lat: 31.23, lon: 121.47, days: 1 },
});
const wj = JSON.parse(w.result?.content?.[0]?.text || '{}');
console.log('[3] tools/call weather -> ok=', wj.ok, '温度=', wj.data?.当前?.温度, 'isError=', w.result?.isError);

// 5) tools/call 子命令工具
const hasGeo = tools.some((t) => t.name === 'weather__geocode');
if (hasGeo) {
  const g = await rpc('tools/call', { name: 'weather__geocode', arguments: { city: 'Kyoto', count: 1 } });
  const gj = JSON.parse(g.result?.content?.[0]?.text || '{}');
  console.log('[4] tools/call weather__geocode -> ok=', gj.ok, 'name=', gj.data?.[0]?.name);
} else {
  console.log('[4] weather__geocode 未暴露（--flat 或插件无命令）');
}

// 6) 未知工具 → 错误
const bad = await rpc('tools/call', { name: 'nope-nope', arguments: {} });
console.log('[5] 未知工具 → error.code=', bad.error?.code, 'msg=', bad.error?.message);

// 7) ping
const ping = await rpc('ping', {});
console.log('[6] ping ->', JSON.stringify(ping.result));

console.log(`\n总耗时 ${Date.now() - t0}ms`);
child.stdin.end();
child.kill();