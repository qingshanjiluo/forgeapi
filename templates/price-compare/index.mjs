/**
 * price-compare —— 比价骨架：按站点配置抓取并归一化价格
 * 设计：站点配置（URL 模板 + 选择器）由用户填，抓取/归一化/排序由本模板负责。
 * 支持两种模式：
 *   1) 提供 sites[]（真实抓取，走浏览器）
 *   2) 提供 demo=true（内置样例，验证结构与排序逻辑）
 */

function parsePrice(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).replace(/\s/g, '');
  // 取第一个数字（含千分位），支持 ￥ / $ / € / ¥ 前缀与后缀
  const m = s.match(/\d[\d,]*(\.\d+)?/);
  if (!m) return null;
  return Number(m[0].replace(/,/g, ''));
}

function detectCurrency(raw, site) {
  if (site && site.currency) return site.currency;
  const s = String(raw || '');
  if (/[￥¥]|CNY|RMB/i.test(s)) return 'CNY';
  if (/\$|USD/i.test(s)) return 'USD';
  if (/€|EUR/i.test(s)) return 'EUR';
  if (/£|GBP/i.test(s)) return 'GBP';
  return null;
}

function money(n) {
  return n === null ? '无价' : String(n);
}

export default {
  name: 'price-compare',
  version: '0.1.0',
  description: '比价：按站点配置抓取同一商品价格，归一化为统一结构并排序（支持 demo 模式）',
  permissions: ['browser', 'net'],
  schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '商品关键词（用于标题校验与输出）' },
      sites: {
        type: 'array',
        description: '站点配置：[{name,url,priceSel,titleSel?,currency?}]；url 可用 ${query} 占位',
        items: { type: 'object' },
      },
      demos: { type: 'boolean', description: '用内置样例数据验证结构与排序（不联网）', default: false },
      limit: { type: 'integer', description: '每站点最多条数', default: 5 },
      sortBy: { type: 'string', description: '排序字段：price（缺省按价格升序）', default: 'price' },
    },
  },

  async execute(params, ctx) {
    const query = String(params.query || '');
    const limit = Number(params.limit ?? 5);

    /* ---------- demo 模式 ---------- */
    if (params.demos) {
      const sample = [
        { site: 'shop-A', title: `${query} 标准版`, price: 199, currency: 'CNY', url: 'https://a.example/item1' },
        { site: 'shop-B', title: `${query} 标准版`, price: 189, currency: 'CNY', url: 'https://b.example/item1' },
        { site: 'shop-C', title: `${query} 旗舰版`, price: 499, currency: 'CNY', url: 'https://c.example/item2' },
        { site: 'shop-A', title: `${query} 无货`, price: null, currency: 'CNY', url: 'https://a.example/item3' },
      ];
      const priced = sample.filter((x) => x.price !== null).sort((a, b) => a.price - b.price);
      const unpriced = sample.filter((x) => x.price === null);
      return {
        ok: true,
        data: {
          query,
          results: [...priced, ...unpriced],
          lowest: priced[0] ?? null,
          highLow: priced.length ? { low: priced[0].price, high: priced[priced.length - 1].price } : null,
          total: sample.length,
          mode: 'demo',
        },
      };
    }

    /* ---------- 真实抓取 ---------- */
    const sites = Array.isArray(params.sites) ? params.sites : [];
    if (!sites.length) {
      return { ok: false, error: '需要 sites[]（站点配置），或用 demos=true 看样例结构' };
    }

    const rows = [];
    for (const site of sites) {
      const name = String(site.name || new URL(String(site.url).replace('${query}', encodeURIComponent(query))).hostname);
      const url = String(site.url).replace('${query}', encodeURIComponent(query));
      const priceSel = site.priceSel || '.price, [itemprop=price], .product-price';
      const titleSel = site.titleSel || 'h1, .product-title, .title';

      ctx.progress(`抓取 ${name}: ${url}`);
      try {
        const page = await ctx.browser.page();
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: site.timeout ?? 30000 });
        if (site.waitFor) await page.waitForSelector(site.waitFor, { timeout: 20000 }).catch(() => {});

        const items = await page.$$eval(priceSel, (nodes, tSel) => {
          return nodes.slice(0, 20).map((n) => {
            const container = n.closest('li, article, .product, .item, tr') || n.parentElement;
            const t = container ? container.querySelector(tSel) : null;
            const a = container ? container.querySelector('a[href]') : null;
            return {
              priceRaw: n.textContent || '',
              title: (t && t.textContent ? t.textContent : '').replace(/\s+/g, ' ').trim().slice(0, 160),
              url: a ? a.getAttribute('href') : '',
            };
          });
        }, titleSel).catch(() => []);

        for (const it of items.slice(0, limit)) {
          rows.push({
            site: name,
            title: it.title || `${query}@${name}`,
            price: parsePrice(it.priceRaw),
            currency: detectCurrency(it.priceRaw, site),
            url: it.url,
          });
        }
        if (!items.length) ctx.log('warn', `${name} 价格选择器无命中：${priceSel}`);
      } catch (e) {
        const msg = (e && e.message) || String(e);
        ctx.log('warn', `${name} 失败: ${msg}`);
        rows.push({ site: name, title: `${query}@${name}`, price: null, currency: site.currency || null, url, error: msg });
      }
    }

    const priced = rows.filter((r) => typeof r.price === 'number' && !r.error).sort((a, b) => a.price - b.price);
    const rest = rows.filter((r) => !(typeof r.price === 'number' && !r.error));

    return {
      ok: true,
      data: {
        query,
        results: [...priced, ...rest],
        lowest: priced[0] ?? null,
        highLow: priced.length ? { low: priced[0].price, high: priced[priced.length - 1].price } : null,
        total: rows.length,
        priced: priced.length,
        mode: 'live',
      },
      meta: { sites: sites.length },
    };
  },
};