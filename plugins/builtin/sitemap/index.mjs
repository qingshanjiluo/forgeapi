/**
 * sitemap —— 站点地图解析与 URL 发现
 *
 * 支持：sitemap.xml / sitemap index（嵌套）/ gzip（.gz）/ 纯文本 URL 列表
 * 能力：按 lastmod 过滤、按 URL 前缀过滤、正则过滤、数量上限、并发抓取子图。
 */

function decodeXmlEntities(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');
}

/** 解析一个 sitemap 文档：返回 { type: 'urlset'|'index'|'text', entries } */
export function parseSitemap(xml) {
  const text = String(xml).trim();
  if (!text.startsWith('<')) {
    // 纯文本 URL 列表
    const urls = text.split(/\r?\n/).map((s) => s.trim()).filter((s) => /^https?:/i.test(s));
    return { type: 'text', entries: urls.map((u) => ({ loc: u })), children: [] };
  }

  const isIndex = /<sitemapindex[\s>]/i.test(text);
  const blockRe = isIndex ? /<sitemap[\s>][\s\S]*?<\/sitemap>/gi : /<url[\s>][\s\S]*?<\/url>/gi;
  const blocks = text.match(blockRe) || [];

  const entries = [];
  const children = [];
  for (const b of blocks) {
    const loc = decodeXmlEntities((/<loc>([\s\S]*?)<\/loc>/i.exec(b) || [])[1] || '').trim();
    if (!loc) continue;
    if (isIndex) { children.push(loc); continue; }
    entries.push({
      loc,
      lastmod: (/<lastmod>([\s\S]*?)<\/lastmod>/i.exec(b) || [])[1]?.trim() || null,
      changefreq: (/<changefreq>([\s\S]*?)<\/changefreq>/i.exec(b) || [])[1]?.trim() || null,
      priority: (/<priority>([\s\S]*?)<\/priority>/i.exec(b) || [])[1]?.trim() || null,
    });
  }
  return { type: isIndex ? 'index' : 'urlset', entries, children };
}

/** 抓取（自动处理 gzip 与 Content-Encoding） */
async function fetchSitemap(url, timeoutMs = 20000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      headers: {
        'user-agent': 'ForgeAPI/0.7 (+local)',
        accept: 'application/xml, text/xml, */*',
        'accept-encoding': 'gzip, deflate, br',
      },
      signal: ctl.signal,
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);

    const buf = Buffer.from(await r.arrayBuffer());
    // 注意：fetch 已按 Content-Encoding 解压；这里只处理 .gz 后缀的实体
    if (/\.gz($|\?)/i.test(url) || (buf[0] === 0x1f && buf[1] === 0x8b)) {
      const zlib = await import('node:zlib');
      return zlib.gunzipSync(buf).toString('utf8');
    }
    return buf.toString('utf8');
  } finally {
    clearTimeout(timer);
  }
}

/** 从 robots.txt 找 Sitemap: 行 */
async function discoverFromRobots(origin) {
  try {
    const r = await fetch(`${origin}/robots.txt`, { headers: { 'user-agent': 'ForgeAPI/0.7' } });
    if (!r.ok) return [];
    const text = await r.text();
    return text.split(/\r?\n/)
      .map((l) => /^\s*sitemap:\s*(\S+)/i.exec(l)?.[1])
      .filter(Boolean);
  } catch {
    return [];
  }
}

export default {
  name: 'sitemap',
  version: '0.1.0',
  description: '站点地图解析：sitemap/index/gzip/纯文本，按时间与前缀过滤，自动发现',
  permissions: ['net'],
  schema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'sitemap 地址；或站点根地址（自动发现 /sitemap.xml 与 robots.txt）' },
      discover: { type: 'boolean', description: '给根地址时自动发现 sitemap', default: true },
      followIndex: { type: 'boolean', description: '展开 sitemap index 的子图', default: true },
      maxSitemaps: { type: 'integer', description: '最多展开几个子图', default: 10 },
      limit: { type: 'integer', description: '最多返回多少条 URL', default: 200 },
      since: { type: 'string', description: '只保留 lastmod >= 该日期（YYYY-MM-DD 或 ISO）' },
      prefix: { type: 'string', description: '只保留 URL 前缀匹配的条目' },
      pattern: { type: 'string', description: '只保留 URL 正则匹配的条目' },
      concurrency: { type: 'integer', description: '展开子图并发数', default: 3 },
    },
    required: ['url'],
  },

  async execute(params, ctx) {
    let start = String(params.url || '');
    if (!start) return { ok: false, error: '需要 url' };
    if (!/^https?:\/\//i.test(start)) start = `https://${start}`;

    const limit = Number(params.limit || 200);
    const maxSitemaps = Number(params.maxSitemaps || 10);
    const since = params.since ? Date.parse(String(params.since)) : null;
    const prefix = params.prefix ? String(params.prefix) : null;
    const pattern = params.pattern ? new RegExp(String(params.pattern)) : null;

    const origin = new URL(start).origin;
    const isRootLike = !/\.xml|\.txt|\.gz/i.test(new URL(start).pathname);

    // 1) 自动发现
    const tried = [];
    let targets = [];
    if (isRootLike && params.discover !== false) {
      ctx.progress('发现 sitemap');
      const fromRobots = await discoverFromRobots(origin);
      tried.push(`${origin}/robots.txt`);
      if (fromRobots.length) {
        targets = fromRobots;
      } else {
        for (const p of ['/sitemap.xml', '/sitemap_index.xml', '/sitemap-index.xml', '/sitemap.txt']) {
          try {
            const xml = await fetchSitemap(`${origin}${p}`, 10000);
            if (/<urlset|<sitemapindex|^https?:/im.test(xml)) { targets = [`${origin}${p}`]; break; }
          } catch { tried.push(`${origin}${p}`); }
        }
      }
    }
    if (!targets.length) {
      // 给了具体 sitemap 地址：直接用它
      if (!isRootLike) {
        targets = [start];
      } else {
        // 根地址且自动发现失败：明确报"没找到"，不要把首页 HTML 当 sitemap 硬解析
        return {
          ok: false,
          error: `未在 ${origin} 发现 sitemap。已尝试：robots.txt 的 Sitemap 行、/sitemap.xml、/sitemap_index.xml、/sitemap-index.xml、/sitemap.txt`,
          data: { start, origin, tried, hint: '若已知具体地址，直接传 --url https://site/sitemap.xml' },
        };
      }
    }

    // 2) 抓取 + 解析
    const collected = [];
    const sitemapReports = [];
    const queue = [...targets];
    let processed = 0;

    while (queue.length && processed < maxSitemaps) {
      const batch = queue.splice(0, Math.max(1, Number(params.concurrency || 3)));
      const results = await Promise.all(batch.map(async (u) => {
        ctx.progress(`抓取 ${u}`);
        try {
          const xml = await fetchSitemap(u);
          const parsed = parseSitemap(xml);
          return { url: u, parsed, error: null };
        } catch (e) {
          return { url: u, parsed: null, error: (e && e.message) || String(e) };
        }
      }));

      for (const r of results) {
        processed++;
        if (r.error) {
          ctx.log('warn', `${r.url} 失败：${r.error}`);
          sitemapReports.push({ url: r.url, error: r.error, count: 0 });
          continue;
        }
        sitemapReports.push({ url: r.url, type: r.parsed.type, count: r.parsed.entries.length });
        collected.push(...r.parsed.entries);
        if (r.parsed.children?.length && params.followIndex !== false) {
          for (const child of r.parsed.children) {
            if (processed + queue.length < maxSitemaps) queue.push(child);
          }
        }
      }
    }

    // 3) 过滤
    let entries = collected;
    if (since) {
      entries = entries.filter((e) => {
        if (!e.lastmod) return false;
        const t = Date.parse(e.lastmod);
        return Number.isFinite(t) && t >= since;
      });
    }
    if (prefix) entries = entries.filter((e) => e.loc.startsWith(prefix));
    if (pattern) entries = entries.filter((e) => pattern.test(e.loc));

    // 按 lastmod 倒序（有时间的在前）
    entries.sort((a, b) => {
      const ta = Date.parse(a.lastmod || '') || 0;
      const tb = Date.parse(b.lastmod || '') || 0;
      return tb - ta;
    });

    const total = entries.length;
    const page = entries.slice(0, limit);

    return {
      ok: true,
      data: {
        start,
        discovered: targets,
        sitemaps: sitemapReports,
        urls: page,
        total,
        returned: page.length,
        filters: { since: params.since || null, prefix, pattern: params.pattern || null },
        tried,
      },
    };
  },
};