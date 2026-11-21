/**
 * websearch —— 多引擎网页搜索
 *
 * 实测（2026-11-20，本机）：
 *  - Google      fetch 返回 94KB 拦截页（h3=0）；浏览器渲染也撞「unusual traffic」→ 自动降级
 *  - Bing        HTML fetch 可达但结果质量差；`format=rss` 返回结构化 RSS（真实可用）
 *  - DuckDuckGo  html.duckduckgo.com fetch 200 / 31KB，结果真实（title + 跳转链接可还原）
 *  - 百度        需渲染（本插件留作 source=baidu 走 render）
 *
 * 策略：按 sources 顺序并发，单源失败/空结果不影响其它源；自动跳过被拦截的源。
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const HEADERS = { 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8' };

function strip(s) {
  return String(s || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}
function decodeEntities(s) {
  return String(s || '')
    .replace(/&/g, '&').replace(/</g, '<').replace(/>/g, '>')
    .replace(/"/g, '"').replace(/'/g, "'").replace(/ /g, ' ')
    .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number(d)));
}

/* ---------- 各引擎实现（纯 fetch） ---------- */

async function bingRss(q, limit) {
  const u = `https://www.bing.com/search?q=${encodeURIComponent(q)}&format=rss&mkt=zh-CN&count=${limit}`;
  const r = await fetch(u, { headers: HEADERS, signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const xml = await r.text();
  const out = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    if (out.length >= limit) break;
    const g = (t) => new RegExp(`<${t}>([\\s\\S]*?)</${t}>`).exec(m[1]);
    const unwrap = (s) => decodeEntities((s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim());
    out.push({ title: unwrap(g('title') && g('title')[1]), url: unwrap(g('link') && g('link')[1]), snippet: unwrap(g('description') && g('description')[1]).slice(0, 240), pubDate: unwrap(g('pubDate') && g('pubDate')[1]) });
  }
  if (!out.length) throw new Error('RSS 无 item');
  return out;
}

async function duckduckgoOnce(url, q) {
  const r = await fetch(url, {
    headers: HEADERS,
    signal: AbortSignal.timeout(12000),
    redirect: 'follow',
  });
  if (!r.ok && r.status !== 202) throw new Error(`HTTP ${r.status}`);
  const html = await r.text();
  if (r.status === 202 || !html.includes('result__a')) return { challenged: true, html };
  const out = [];
  const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]*?)(?=<a[^>]*class="result__a"|<div class="nav-link|$)/g;
  let m;
  while ((m = re.exec(html))) {
    if (out.length >= 10) break;
    let url2 = m[1];
    const uddg = /uddg=([^&]+)/.exec(url2);
    if (uddg) url2 = decodeURIComponent(uddg[1]);
    const title = strip(m[2]);
    if (!title) continue;
    const tail = m[3] || '';
    const sn = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/.exec(tail);
    out.push({ title: decodeEntities(title), url: url2, snippet: strip(sn ? sn[1] : '').slice(0, 240) });
  }
  return { challenged: false, items: out };
}

async function duckduckgo(q, limit) {
  // DDG html 端点间歇返回 202 挑战页：重试 + lite 端点兜底
  const endpoints = [
    'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q),
    'https://lite.duckduckgo.com/lite/?q=' + encodeURIComponent(q),
  ];
  let challenged = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    const url = endpoints[attempt % endpoints.length];
    const res = await duckduckgoOnce(url, q);
    if (!res.challenged && res.items && res.items.length) return res.items.slice(0, limit);
    challenged = true;
    await new Promise((r) => setTimeout(r, 700 * (attempt + 1)));
  }
  throw new Error(challenged ? 'DDG 返回 202 挑战页（重试与 lite 兜底均未过）' : '无结果');
}

async function sogou(q, limit) {
  const r = await fetch('https://www.sogou.com/web?query=' + encodeURIComponent(q), {
    headers: HEADERS,
    signal: AbortSignal.timeout(12000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const html = await r.text();
  if (/antispider|verify/i.test(html)) throw new Error('sogou 反爬');
  const out = [];
  const re = /<h3[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html))) {
    if (out.length >= limit) break;
    let url = m[1];
    if (url.startsWith('/link?url=')) url = 'https://www.sogou.com' + url;
    out.push({ title: strip(m[2]), url, snippet: '' });
  }
  if (!out.length) throw new Error('无结果');
  return out;
}

/* ---------- Google：web 搜索被拦，走 news RSS（实测 200/34 条/命中 4/4） ---------- */
async function googleNewsRss(q, limit) {
  const u = 'https://news.google.com/rss/search?q=' + encodeURIComponent(q) + '&hl=zh-CN&gl=CN&ceid=CN:zh-Hans';
  const r = await fetch(u, { headers: HEADERS, signal: AbortSignal.timeout(12000), redirect: 'follow' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const xml = await r.text();
  const out = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    if (out.length >= limit) break;
    const g = (t) => new RegExp(`<${t}>([\\s\\S]*?)</${t}>`).exec(m[1]);
    const un = (s) => decodeEntities((s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim());
    out.push({
      title: un(g('title') && g('title')[1]),
      url: un(g('link') && g('link')[1]),
      snippet: un(g('source') && g('source')[1]),
      pubDate: un(g('pubDate') && g('pubDate')[1]),
    });
  }
  if (!out.length) throw new Error('无 item');
  return out;
}

const ENGINES = { bing: bingRss, ddg: duckduckgo, sogou, google: googleNewsRss };

export default {
  name: 'websearch',
  version: '0.1.0',
  description: '多引擎网页搜索：Bing RSS / DuckDuckGo / 搜狗并发（Google 本机被拦自动降级），按标题去重',
  permissions: ['net'],
  schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '查询词' },
      engines: { type: 'string', description: '逗号分隔：ddg,bing,sogou,google', default: 'ddg,bing' },
      limit: { type: 'integer', description: '每引擎条数', default: 10 },
      dedupe: { type: 'boolean', description: '按标题去重', default: true },
      lang: { type: 'string', description: '语言提示（传给引擎 hl）', default: 'zh-CN' },
    },
    required: ['query'],
  },

  async execute(params, ctx) {
    const q = String(params.query || '').trim();
    if (!q) return { ok: false, error: '需要 query' };
    const names = String(params.engines || 'ddg,bing').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    const limit = Number(params.limit ?? 10);

    const tasks = names.map(async (n) => {
      const fn = ENGINES[n];
      if (!fn) return { name: n, items: [], error: `未知引擎: ${n}（可选: ${Object.keys(ENGINES).join(',')}）` };
      ctx.progress(`查询 ${n}: ${q}`);
      try {
        const items = await fn(q, limit);
        return { name: n, items };
      } catch (e) {
        const msg = (e && e.message) || String(e);
        ctx.log('warn', `${n}: ${msg}`);
        return { name: n, items: [], error: msg };
      }
    });

    const results = await Promise.all(tasks);
    let flat = results.flatMap((r) => r.items.map((it) => ({ ...it, 来源: r.name, 源序: names.indexOf(r.name) })));

    if (params.dedupe !== false) {
      const seen = new Map();
      for (const it of flat) {
        const k = String(it.title || '').toLowerCase().replace(/\s+/g, ' ').trim();
        if (!k) continue;
        const prev = seen.get(k);
        if (!prev) seen.set(k, { ...it, 来源集合: [it.来源] });
        else if (!prev.来源集合.includes(it.来源)) prev.来源集合.push(it.来源);
      }
      flat = [...seen.values()].map((x) => ({ ...x, 来源: x.来源集合.join(',') }));
    }

    // 来源优先级 + 结果内顺序
    flat.sort((a, b) => a.源序 - b.源序);

    const usable = results.filter((r) => r.items.length);
    return {
      ok: usable.length > 0,
      data: {
        query: q,
        results: flat,
        total: flat.length,
        engines: results.map((r) => ({ name: r.name, count: r.items.length, error: r.error })),
      },
      ...(usable.length ? {} : { error: '全部引擎失败: ' + results.map((r) => `${r.name}: ${r.error}`).join('; ') }),
    };
  },
};