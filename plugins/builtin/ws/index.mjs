/**
 * ws —— WebSocket 数据流采集
 *
 * AI 无法直接连 WS，但大量实时数据（行情、推送、聊天、进度）只走 WS。
 *
 * 流程：连接 → 可选发订阅消息 → 收集 N 帧 / 等 M 毫秒 → 输出
 * 依赖：Node 22+ 内置全局 WebSocket（undici），零外部依赖。
 */

function isJsonLike(s) {
  const t = String(s).trim();
  return (t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'));
}

export default {
  name: 'ws',
  version: '0.1.0',
  description: 'WebSocket 采集：连接→可选订阅→收 N 帧/等 M 毫秒→输出（Node 内置 WebSocket）',
  permissions: ['net'],
  schema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'ws:// 或 wss:// 地址' },
      headers: { type: 'object', description: '握手请求头（鉴权等），如 {"authorization":"Bearer ${cred:TOKEN}"}' },
      subscribe: { description: '连接后立即发送的消息（对象会 JSON 序列化；数组则依次发送）' },
      messages: { type: 'integer', description: '收集多少帧后结束', default: 10 },
      duration: { type: 'integer', description: '最长等待毫秒（到点即返回到手的数据）', default: 15000 },
      idleMs: { type: 'integer', description: '连续多久没新帧就提前结束', default: 5000 },
      parseJson: { type: 'boolean', description: '尝试把 JSON 帧解析成对象', default: true },
      maxFrameChars: { type: 'integer', description: '单帧最多保留多少字符', default: 4000 },
      filter: { type: 'string', description: '只保留包含该子串的帧' },
      binarySkip: { type: 'boolean', description: '跳过二进制帧', default: true },
    },
    required: ['url'],
  },

  async execute(params, ctx) {
    const url = String(params.url || '');
    if (!url) return { ok: false, error: '需要 url' };
    if (!/^wss?:\/\//i.test(url)) return { ok: false, error: `需要 ws:// 或 wss:// 地址，收到: ${url}` };

    const want = Math.max(1, Number(params.messages ?? 10));
    const duration = Math.max(100, Number(params.duration ?? 15000));
    const idleMs = Math.max(0, Number(params.idleMs ?? 5000));
    const parseJson = params.parseJson !== false;
    const maxChars = Number(params.maxFrameChars ?? 4000);
    const filter = params.filter ? String(params.filter) : null;

    // 插值 headers / subscribe 里的 ${cred:KEY}
    const interp = (v) => {
      if (typeof v === 'string') {
        return v.replace(/\$\{cred:([^}]+)\}/g, (_m, k) => ctx.getCredential(String(k).trim()) ?? '');
      }
      if (Array.isArray(v)) return v.map(interp);
      if (v && typeof v === 'object') {
        const o = {};
        for (const [k, val] of Object.entries(v)) o[k] = interp(val);
        return o;
      }
      return v;
    };

    const headers = params.headers ? interp(params.headers) : undefined;

    if (typeof WebSocket === 'undefined') {
      return { ok: false, error: '当前 Node 版本无内置 WebSocket（需 Node 22+）' };
    }

    const frames = [];
    let opened = false;
    let closeInfo = null;
    let errorMsg = null;

    ctx.progress(`连接 ${url}`);

    const ws = new WebSocket(url, headers ? { headers } : undefined);

    const done = new Promise((resolve) => {
      let idleTimer = null;
      let finished = false;

      const finish = (reason) => {
        if (finished) return;
        finished = true;
        if (idleTimer) clearTimeout(idleTimer);
        try { ws.close(); } catch { /* ignore */ }
        resolve(reason);
      };

      const touchIdle = () => {
        if (!idleMs) return;
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => finish('idle'), idleMs);
        idleTimer.unref?.();
      };

      const globalTimer = setTimeout(() => finish('duration'), duration);
      globalTimer.unref?.();

      ws.addEventListener('open', () => {
        opened = true;
        ctx.progress('已连接');
        ctx.log('debug', `readyState=${ws.readyState}`);
        if (params.subscribe !== undefined) {
          const payloads = Array.isArray(params.subscribe) ? params.subscribe : [params.subscribe];
          for (const p of payloads) {
            const msg = typeof p === 'string' ? p : JSON.stringify(interp(p));
            ctx.progress(`发送订阅: ${msg.slice(0, 100)}`);
            try { ws.send(msg); } catch (e) { ctx.log('warn', `发送失败: ${e.message}`); }
          }
        }
        touchIdle();
      });

      ws.addEventListener('message', (ev) => {
        const data = ev.data;
        if (typeof data !== 'string') {
          if (params.binarySkip !== false) return;
          frames.push({ type: 'binary', bytes: data?.byteLength ?? data?.length ?? 0 });
        } else {
          if (filter && !data.includes(filter)) { touchIdle(); return; }
          let value = data.slice(0, maxChars);
          if (parseJson && isJsonLike(value)) {
            try { value = JSON.parse(data); } catch { /* 保留字符串 */ }
          }
          frames.push({ type: 'text', value, at: new Date().toISOString() });
        }
        ctx.progress(`收到 ${frames.length}/${want} 帧`);
        touchIdle();
        if (frames.length >= want) finish('count');
      });

      ws.addEventListener('error', (ev) => {
        errorMsg = ev.message || 'WebSocket error';
        ctx.log('warn', `连接错误: ${errorMsg}`);
        finish('error');
      });

      ws.addEventListener('close', (ev) => {
        closeInfo = { code: ev.code, reason: ev.reason, wasClean: ev.wasClean };
        ctx.progress(`连接关闭 code=${ev.code}`);
        finish('close');
      });
    });

    const reason = await done;

    return {
      ok: frames.length > 0 || reason === 'close',
      data: {
        url,
        connected: opened,
        reason,
        frames,
        count: frames.length,
        close: closeInfo,
        ...(errorMsg ? { error: errorMsg } : {}),
      },
      meta: { want, duration, idleMs, filtered: filter !== null },
    };
  },
};