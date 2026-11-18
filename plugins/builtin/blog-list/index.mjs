/**
 * blog-list 插件 —— 列表页批量提取（代码型）
 * 通用列表抓取：条目容器/标题/链接/摘要/时间全部可参数化，支持自动翻页。
 */

function abs(base, href) {
  if (!href) return '';
  try { return new URL(href, base).toString(); } catch { return href; }
}

export default {
  name: 'blog-list',
  version: '0.1.0',
  description: '列表页批量提取：博客/新闻/搜索结果列表抽条目，支持选择器参数化与翻页',
  permissions: ['browser', 'net'],
  schema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: '列表页地址' },
      item: { type: 'string', description: '条目容器选择器', default: 'article, .post, .item, li' },
      title: { type: 'string', description: '标题选择器（相对条目）', default: 'h1, h2, h3, .title, a' },
      link: { type: 'string', description: '链接选择器', default: 'a' },
      summary: { type: 'string', description: '摘要选择器', default: 'p, .summary, .excerpt, .desc' },
      time: { type: 'string', description: '时间选择器', default: 'time, .date, .published, .time' },
      limit: { type: 'integer', description: '最多条目', default: 30 },
      pages: { type: 'integer', description: '翻页数（按 ?page=N 递增）', default: 1 },
      pageParam: { type: 'string', description: '翻页参数名', default: 'page' },
      waitFor: { type: 'string', description: '等待选择器出现' },
      scroll: { type: 'integer', description: '滚动次数（懒加载列表）', default: 0 },
    },
    required: ['url'],
  },

  async execute(params, ctx) {
    const url = String(params.url);
    if (!url) return { ok: false, error: '需要 url' };
    const itemSel = params.item || 'article, .post, .item, li';
    const titleSel = params.title || 'h1, h2, h3, .title, a';
    const linkSel = params.link || 'a';
    const sumSel = params.summary || 'p, .summary, .excerpt, .desc';
    const timeSel = params.time || 'time, .date, .published, .time';
    const limit = Number(params.limit ?? 30);
    const pages = Math.max(1, Number(params.pages ?? 1));
    const pageParam = params.pageParam || 'page';
    const p = await ctx.browser.page();

    const all = [];
    for (let pg = 1; pg <= pages; pg++) {
      let target = url;
      if (pg > 1) {
        const u = new URL(url);
        u.searchParams.set(pageParam, String(pg));
        target = u.toString();
      }
      ctx.progress(`[page ${pg}/${pages}] ${target}`);
      await p.goto(target, { waitUntil: 'domcontentloaded' });
      if (params.waitFor) await p.waitForSelector(params.waitFor, { timeout: 20000 }).catch(() => {});
      for (let i = 0; i < Number(params.scroll ?? 0); i++) {
        await p.evaluate(() => window.scrollBy(0, window.innerHeight));
        await p.waitForTimeout(300);
      }

      const rows = await p.$$eval(itemSel, (nodes, cfg) => {
        const out = [];
        for (const n of nodes) {
          const q = (sel) => n.querySelector(sel);
          const t = q(cfg.title) || n;
          const a = q(cfg.link) || n.querySelector('a[href]');
          const s = q(cfg.summary);
          const tm = q(cfg.time);
          out.push({
            title: (t.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 240),
            href: a ? a.getAttribute('href') : '',
            summary: s ? (s.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 400) : '',
            time: tm ? (tm.getAttribute('datetime') || tm.textContent || '').trim().slice(0, 40) : '',
          });
        }
        return out;
      }, { title: titleSel, link: linkSel, summary: sumSel, time: timeSel }).catch(() => []);

      for (const r of rows) {
        if (!r.title && !r.href) continue;
        all.push({ ...r, url: abs(target, r.href), page: pg });
        if (all.length >= limit) break;
      }
      if (all.length >= limit) break;
    }

    return {
      ok: true,
      data: { source: url, items: all.slice(0, limit), total: Math.min(all.length, limit) },
      meta: { pages, itemSel },
    };
  },
};
