/**
 * page-meta —— 页面元信息全量提取
 *
 * 覆盖：title/description/canonical/robots、OpenGraph、Twitter Card、
 *      JSON-LD（schema.org）、h1-h3 结构、图片/链接统计、语言/字符集、
 *      favicon、RSS/Atom 自动发现、hreflang 多语言版本。
 *
 * 用途：给 AI 一条 URL 就能拿到"这页是什么"的完整画像，不必再猜。
 */

export default {
  name: 'page-meta',
  version: '0.1.0',
  description: '页面元信息画像：OG/Twitter/JSON-LD/标题层级/链接统计/多语言版本/订阅源发现',
  permissions: ['browser', 'net'],
  schema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: '目标网页地址' },
      waitFor: { type: 'string', description: '等待选择器出现再提取' },
      includeJsonLd: { type: 'boolean', description: '包含 JSON-LD 结构数据', default: true },
      maxHeadings: { type: 'integer', description: '标题层级最多取几条', default: 20 },
    },
    required: ['url'],
  },

  async execute(params, ctx) {
    const url = String(params.url || '');
    if (!url) return { ok: false, error: '需要 url' };

    const page = await ctx.browser.page();
    ctx.progress(`打开 ${url}`);
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded' });
    if (resp && !resp.ok() && resp.status() >= 400) ctx.log('warn', `HTTP ${resp.status()}`);
    if (params.waitFor) {
      await page.waitForSelector(String(params.waitFor), { timeout: 30000 }).catch(() => {});
    }

    const maxHeadings = Number(params.maxHeadings || 20);

    const meta = await page.evaluate((maxH) => {
      const q = (sel) => document.querySelector(sel);
      const attr = (sel, name) => q(sel)?.getAttribute(name) || null;
      const text = (sel) => (q(sel)?.textContent || '').replace(/\s+/g, ' ').trim() || null;

      // OpenGraph / Twitter / 普通 meta 一次性收集
      const named = {};
      const propertyOg = {};
      const propertyTwitter = {};
      for (const el of document.querySelectorAll('meta[name], meta[property], meta[itemprop]')) {
        const name = el.getAttribute('name') || el.getAttribute('itemprop');
        const prop = el.getAttribute('property');
        const content = el.getAttribute('content');
        if (content === null) continue;
        if (name) named[name.toLowerCase()] = content;
        if (prop?.startsWith('og:')) propertyOg[prop.slice(3)] = content;
        if (prop?.startsWith('twitter:')) propertyTwitter[prop.slice(8)] = content;
      }

      // JSON-LD
      const jsonLd = [...document.querySelectorAll('script[type="application/ld+json"]')]
        .map((s) => s.textContent || '')
        .filter(Boolean);

      // 标题层级
      const headings = [...document.querySelectorAll('h1,h2,h3')]
        .slice(0, maxH)
        .map((h) => ({
          level: Number(h.tagName.slice(1)),
          text: (h.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160),
        }));

      // 链接统计
      const links = [...document.querySelectorAll('a[href]')];
      const internal = links.filter((a) => {
        try { return new URL(a.getAttribute('href'), location.href).origin === location.origin; }
        catch { return false; }
      });

      // 订阅源 / favicon / 多语言
      const feeds = [...document.querySelectorAll('link[rel="alternate"]')]
        .filter((l) => /rss|atom|json/i.test(l.getAttribute('type') || ''))
        .map((l) => ({ href: l.getAttribute('href'), type: l.getAttribute('type') }));

      const hreflang = [...document.querySelectorAll('link[rel="alternate"][hreflang]')]
        .map((l) => ({ lang: l.getAttribute('hreflang'), href: l.getAttribute('href') }));

      const favicon = attr('link[rel="icon"]', 'href') || attr('link[rel="shortcut icon"]', 'href');

      // 结构化摘要：正文首段
      const firstPara = (q('article p, main p, .content p, p')?.textContent || '')
        .replace(/\s+/g, ' ').trim().slice(0, 300) || null;

      return {
        title: document.title || null,
        description: named['description'] || null,
        canonical: attr('link[rel="canonical"]', 'href'),
        robots: named['robots'] || null,
        lang: document.documentElement.getAttribute('lang') || null,
        charset: document.characterSet || null,
        og: propertyOg,
        twitter: propertyTwitter,
        jsonLdCount: jsonLd.length,
        jsonLd: jsonLd,
        headings,
        counts: {
          links: links.length,
          internal: internal.length,
          external: links.length - internal.length,
          images: document.querySelectorAll('img[src]').length,
        },
        feeds,
        hreflang,
        favicon,
        firstParagraph: firstPara,
        finalUrl: location.href,
      };
    }, maxHeadings);

    if (!params.includeJsonLd) {
      meta.jsonLd = [];
      meta.jsonLdCount = 0;
    } else {
      // 尽量把 JSON-LD 解析成对象；单个非法不影响其它
      meta.jsonLd = meta.jsonLd.map((raw) => {
        try { return JSON.parse(raw); } catch { return { _unparsed: String(raw).slice(0, 500) }; }
      });
    }

    // h1 结构提示
    const h1s = meta.headings.filter((h) => h.level === 1);
    if (h1s.length === 0) ctx.log('warn', '页面无 h1');
    if (h1s.length > 1) ctx.log('warn', `页面有 ${h1s.length} 个 h1（SEO 通常应唯一）`);

    return { ok: true, data: meta, meta: { url: meta.finalUrl } };
  },
};