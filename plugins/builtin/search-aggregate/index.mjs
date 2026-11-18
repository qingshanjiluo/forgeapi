/**
 * search-aggregate 插件 —— 多来源聚合（代码型，演示并发 + 去重 + 统一输出）
 * 来源：Hacker News / Wikipedia / GitHub / Bing 页面，并发拉取，按标题去重。
 */

const SOURCES = {
  hn: async (q, limit) => {
    const u = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(q)}&tags=story&hitsPerPage=${limit}`;
    const r = await fetch(u);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    return (j.hits || []).map((h) => ({
      title: h.title || h.story_title || '',
      url: h.url || (h.objectID ? `https://news.ycombinator.com/item?id=${h.objectID}` : ''),
      snippet: String(h.story_text || h.comment_text || '').replace(/<[^>]+>/g, ' ').slice(0, 300),
      score: h.points ?? 0,
    }));
  },

  wiki: async (q, limit) => {
    const u = new URL('https://zh.wikipedia.org/w/api.php');
    u.searchParams.set('action', 'query');
    u.searchParams.set('list', 'search');
    u.searchParams.set('srsearch', q);
    u.searchParams.set('format', 'json');
    u.searchParams.set('srlimit', String(limit));
    const r = await fetch(u, { headers: { 'user-agent': 'ForgeAPI/0.1' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    return ((j.query && j.query.search) || []).map((s) => ({
      title: s.title,
      url: `https://zh.wikipedia.org/wiki/${encodeURIComponent(String(s.title).replace(/ /g, '_'))}`,
      snippet: String(s.snippet || '').replace(/<[^>]+>/g, ' ').slice(0, 300),
      score: s.wordcount ?? 0,
    }));
  },

  github: async (q, limit) => {
    const u = `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&per_page=${limit}`;
    const r = await fetch(u, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'ForgeAPI/0.1' },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    return (j.items || []).map((i) => ({
      title: i.full_name,
      url: i.html_url,
      snippet: String(i.description || '').slice(0, 300),
      score: i.stargazers_count ?? 0,
    }));
  },

  bing: async (q, limit) => {
    const r = await fetch(`https://www.bing.com/search?q=${encodeURIComponent(q)}`, {
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const html = await r.text();
    const out = [];
    const re = /<li class="b_algo"[\s\S]*?<h2><a href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/h2>([\s\S]*?)<\/li>/g;
    let m;
    while ((m = re.exec(html)) && out.length < limit) {
      out.push({
        title: m[2].replace(/<[^>]+>/g, '').trim(),
        url: m[1],
        snippet: m[3].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300),
        score: 0,
      });
    }
    return out;
  },
};

function dedupe(items) {
  const seen = new Map();
  for (const it of items) {
    const k = String(it.title || it.url || '').toLowerCase().replace(/\s+/g, ' ').trim();
    if (!k) continue;
    const prev = seen.get(k);
    if (!prev) {
      seen.set(k, { ...it, 来源集合: [it.来源] });
      continue;
    }
    if (!prev.来源集合.includes(it.来源)) prev.来源集合.push(it.来源);
    if (!prev.snippet && it.snippet) prev.snippet = it.snippet;
    if ((it.score || 0) > (prev.score || 0)) prev.score = it.score;
  }
  return [...seen.values()].map((x) => ({ ...x, 来源: x.来源集合.join(',') }));
}

export default {
  name: 'search-aggregate',
  version: '0.1.0',
  description: '多来源搜索聚合：HN / Wikipedia / GitHub / Bing 并发检索，按标题去重合并',
  permissions: ['net'],
  schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '查询关键词' },
      sources: { type: 'string', description: '逗号分隔来源：hn,wiki,github,bing', default: 'hn,wiki,github' },
      limit: { type: 'integer', description: '每个来源条数', default: 10 },
      dedupe: { type: 'boolean', description: '是否按标题去重', default: true },
    },
    required: ['query'],
  },

  async execute(params, ctx) {
    const q = String(params.query || '').trim();
    if (!q) return { ok: false, error: '需要 query' };
    const names = String(params.sources || 'hn,wiki,github').split(',').map((s) => s.trim()).filter(Boolean);
    const limit = Number(params.limit ?? 10);

    const tasks = names.map(async (n) => {
      const fn = SOURCES[n];
      if (!fn) return { name: n, items: [], error: `未知来源: ${n}` };
      ctx.progress(`查询 ${n}: ${q}`);
      try {
        const items = await fn(q, limit);
        return { name: n, items };
      } catch (e) {
        const msg = (e && e.message) || String(e);
        ctx.log('warn', `${n} 失败: ${msg}`);
        return { name: n, items: [], error: msg };
      }
    });

    const results = await Promise.all(tasks);
    const flat = results.flatMap((r) => r.items.map((it) => ({ ...it, 来源: r.name })));
    const final = params.dedupe === false ? flat : dedupe(flat);

    const order = { hn: 0, github: 1, wiki: 2, bing: 3 };
    final.sort((a, b) => (b.score || 0) - (a.score || 0) || (order[a.来源] ?? 9) - (order[b.来源] ?? 9));

    return {
      ok: true,
      data: {
        query: q,
        results: final,
        total: final.length,
        sources: results.map((r) => ({ name: r.name, count: r.items.length, error: r.error })),
      },
    };
  },
};