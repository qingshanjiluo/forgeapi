/**
 * rss 插件 —— RSS 2.0 / Atom 解析（无第三方依赖，纯正则 + 手工状态机）
 * 支持 url 或 urls[]，多个 feed 合并排序。
 */

function decodeEntities(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

function stripTags(s) {
  return decodeEntities(String(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
}

function pick(block, tag) {
  const cdata = new RegExp(`<${tag}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</${tag}>`, 'i');
  const m1 = block.match(cdata);
  if (m1) return m1[1].trim();
  const plain = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i');
  const m2 = block.match(plain);
  return m2 ? m2[1].trim() : '';
}

function pickAttr(block, tag, attr) {
  const re = new RegExp(`<${tag}[^>]*\\b${attr}=["']([^"']+)["'][^>]*>`, 'i');
  const m = block.match(re);
  return m ? m[1] : '';
}

function parseFeed(xml, limit) {
  const isAtom = /<feed[\s>]/i.test(xml.slice(0, 2000));
  const items = [];
  const itemRe = isAtom ? /<entry[\s>][\s\S]*?<\/entry>/gi : /<item[\s>][\s\S]*?<\/item>/gi;
  const blocks = xml.match(itemRe) || [];

  for (const b of blocks.slice(0, limit)) {
    if (isAtom) {
      const link = pickAttr(b, 'link', 'href') || pick(b, 'link');
      items.push({
        title: stripTags(pick(b, 'title')),
        link,
        summary: stripTags(pick(b, 'summary') || pick(b, 'content')).slice(0, 500),
        published: pick(b, 'published') || pick(b, 'updated'),
        author: stripTags(pick(b, 'name')) || stripTags(pick(b, 'author')),
        id: pick(b, 'id'),
      });
    } else {
      items.push({
        title: stripTags(pick(b, 'title')),
        link: pick(b, 'link') || pickAttr(b, 'link', 'href'),
        summary: stripTags(pick(b, 'description') || pick(b, 'summary')).slice(0, 500),
        published: pick(b, 'pubDate') || pick(b, 'dc:date'),
        author: stripTags(pick(b, 'dc:creator') || pick(b, 'author')),
        id: pick(b, 'guid'),
        categories: [...b.matchAll(/<category[^>]*>([\s\S]*?)<\/category>/gi)].map((m) => stripTags(m[1])).slice(0, 8),
      });
    }
  }

  const feedTitle = stripTags(pick(xml, 'title')) || (isAtom ? 'atom feed' : 'rss feed');
  const feedLink = isAtom ? pickAttr(xml, 'link', 'href') : stripTags(pick(xml, 'link'));
  return { feedTitle, feedLink, format: isAtom ? 'atom' : 'rss', items };
}

export default {
  name: 'rss',
  version: '0.1.0',
  description: 'RSS/Atom 订阅解析：单/多 feed 拉取并归一化为统一条目结构',
  permissions: ['net'],
  schema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'feed 地址' },
      urls: { type: 'array', items: { type: 'string' }, description: '多个 feed 地址' },
      limit: { type: 'integer', description: '每个 feed 最多条数', default: 20 },
      sort: { type: 'boolean', description: '按发布时间倒序', default: true },
    },
  },

  async execute(params, ctx) {
    let list = [];
    if (Array.isArray(params.urls) && params.urls.length) list = params.urls;
    else if (params.url) list = [params.url];
    else return { ok: false, error: '需要 url 或 urls[]' };

    const limit = Number(params.limit ?? 20);
    const feeds = [];

    for (const u of list) {
      ctx.progress(`拉取 ${u}`);
      try {
        const res = await fetch(String(u), {
          headers: {
            'user-agent': 'ForgeAPI/0.1 (+local)',
            accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
          },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const xml = await res.text();
        const parsed = parseFeed(xml, limit);
        feeds.push({ source: String(u), ...parsed });
      } catch (e) {
        const msg = (e && e.message) || String(e);
        ctx.log('warn', `feed 失败 ${u}: ${msg}`);
        feeds.push({ source: String(u), error: msg, items: [] });
      }
    }

    let all = feeds.flatMap((f) => f.items.map((it) => ({ ...it, 来源feed: f.feedTitle || f.source })));
    if (params.sort !== false) {
      all.sort((a, b) => (Date.parse(b.published || '') || 0) - (Date.parse(a.published || '') || 0));
    }
    return {
      ok: true,
      data: {
        feeds: feeds.map((f) => ({ source: f.source, title: f.feedTitle, format: f.format, count: f.items.length, error: f.error })),
        items: all,
        total: all.length,
      },
    };
  },
};