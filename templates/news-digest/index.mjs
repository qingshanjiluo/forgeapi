/**
 * news-digest —— 新闻摘要聚合：多 RSS 源抓取 + 关键词过滤 + 去重排序
 * 自带轻量 RSS/Atom 解析（不依赖其它插件）。
 */

const DEFAULT_FEEDS = [
  { name: 'Hacker News', url: 'https://news.ycombinator.com/rss' },
  { name: 'The Verge', url: 'https://www.theverge.com/rss/index.xml' },
  { name: 'BBC World', url: 'https://feeds.bbci.co.uk/news/world/rss.xml' },
];

function decode(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');
}

function text(s) {
  return decode(String(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
}

function pick(block, tag) {
  const cd = new RegExp(`<${tag}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</${tag}>`, 'i').exec(block);
  if (cd) return cd[1].trim();
  const p = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(block);
  return p ? p[1].trim() : '';
}

function parse(xml, limit) {
  const atom = /<feed[\s>]/i.test(xml.slice(0, 2000));
  const re = atom ? /<entry[\s>][\s\S]*?<\/entry>/gi : /<item[\s>][\s\S]*?<\/item>/gi;
  const blocks = xml.match(re) || [];
  return blocks.slice(0, limit).map((b) => {
    const link = atom
      ? (/<link[^>]*href=["']([^"']+)["']/i.exec(b) || [])[1] || pick(b, 'link')
      : pick(b, 'link');
    return {
      title: text(pick(b, 'title')),
      url: link,
      summary: text(pick(b, atom ? 'summary' : 'description')).slice(0, 300),
      published: pick(b, atom ? 'published' : 'pubDate') || pick(b, 'updated'),
    };
  });
}

export default {
  name: 'news-digest',
  version: '0.1.0',
  description: '新闻摘要聚合：多 RSS/Atom 源头条合并、关键词过滤、按时间排序去重',
  permissions: ['net'],
  schema: {
    type: 'object',
    properties: {
      feeds: { type: 'string', description: '逗号分隔的 RSS 地址（缺省用内置 HN/Verge/BBC）' },
      keyword: { type: 'string', description: '关键词过滤（标题或摘要包含，忽略大小写）' },
      limit: { type: 'integer', description: '每源条数', default: 15 },
      total: { type: 'integer', description: '总条数上限', default: 30 },
    },
  },

  async execute(params, ctx) {
    const limit = Number(params.limit ?? 15);
    const total = Number(params.total ?? 30);
    let feeds = DEFAULT_FEEDS;
    if (params.feeds) {
      feeds = String(params.feeds).split(',').map((u) => u.trim()).filter(Boolean)
        .map((url) => ({ name: new URL(url).hostname, url }));
    }

    const kw = params.keyword ? String(params.keyword).toLowerCase() : '';

    const tasks = feeds.map(async (f) => {
      ctx.progress(`拉取 ${f.name}`);
      try {
        const r = await fetch(f.url, {
          headers: {
            'user-agent': 'ForgeAPI/0.1 (+local)',
            accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
          },
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const items = parse(await r.text(), limit).map((it) => ({ ...it, feed: f.name }));
        return { name: f.name, items };
      } catch (e) {
        const msg = (e && e.message) || String(e);
        ctx.log('warn', `${f.name} 失败: ${msg}`);
        return { name: f.name, items: [], error: msg };
      }
    });

    const results = await Promise.all(tasks);
    let all = results.flatMap((r) => r.items);
    const before = all.length;

    if (kw) {
      all = all.filter((it) => (it.title + ' ' + it.summary).toLowerCase().includes(kw));
    }

    // 按标题去重
    const seen = new Set();
    all = all.filter((it) => {
      const k = it.title.toLowerCase().replace(/\s+/g, ' ').trim();
      if (!k || seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    // 时间倒序
    all.sort((a, b) => (Date.parse(b.published || '') || 0) - (Date.parse(a.published || '') || 0));

    return {
      ok: true,
      data: {
        results: all.slice(0, total),
        total: Math.min(all.length, total),
        matched: kw ? all.length : undefined,
        fetched: before,
        sources: results.map((r) => ({ name: r.name, count: r.items.length, error: r.error })),
      },
    };
  },
};