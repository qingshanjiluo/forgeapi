/**
 * crawl —— 站点爬取
 *
 * 从入口 URL 出发，按广度优先抓取 N 层，去重、限域、限页、控并发。
 * 默认走 fetch + 正则解析（零依赖，快）；页面依赖 JS 渲染时用 render=true 改走 Playwright。
 *
 * 说明：用正则而非 DOM 解析器，因为 crawl 的目标是"发现 URL + 粗摘要"，
 * 不是精提取（精提取用 webpage + 规则）。
 */

const UA = 'ForgeAPI/0.10 (+local crawl)';

function originOf(u) {
  try { return new URL(u).origin; } catch { return null; }
}

function normalizeUrl(href, base) {
  try {
    const u = new URL(href, base);
    u.hash = '';
    for (const k of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'spm', 'from']) {
      u.searchParams.delete(k);
    }
    return u.toString();
  } catch { return null; }
}

function decodeEntities(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');
}

function stripTags(html) {
  return decodeEntities(
    String(html)
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  );
}

/** 抓 robots.txt 的 Disallow 规则（简化实现：按前缀匹配） */
async function loadRobots(origin) {
  try {
    const r = await fetch(`${origin}/robots.txt`, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return [];
    const text = await r.text();
    const rules = [];
    let appliesToUs = false;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const idx = line.indexOf(':');
      if (idx < 0) continue;
      const key = line.slice(0, idx).trim().toLowerCase();
      const val = line.slice(idx + 1).trim();
      if (key === 'user-agent') {
        appliesToUs = val === '*' || val.toLowerCase().includes('forgeapi');
      } else if (key === 'disallow' && appliesToUs && val) {
        rules.push(val);
      }
    }
    return rules;
  } catch { return []; }
}

function disallowed(url, rules) {
  if (!rules.length) return false;
  try {
    const p = new URL(url).pathname;
    return rules.some((r) => (r === '/' ? true : p.startsWith(r.replace(/\*$/, ''))));
  } catch { return true; }
}

/** 从 HTML 提取标题、摘要、链接（正则） */
function parsePage(html, baseUrl, opts) {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  let title = titleMatch ? stripTags(titleMatch[1]) : '';
  if (!title) {
    const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
    if (h1) title = stripTags(h1[1]);
  }

  let description = '';
  const descMatch = /<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)["']/i.exec(html)
    || /<meta[^>]*content=["']([^"']*)["'][^>]*name=["']description["']/i.exec(html);
  if (descMatch) description = decodeEntities(descMatch[1]).trim();

  // 正文：优先 article/main，退化到 body
  let raw = '';
  for (const sel of ['article', 'main']) {
    const m = new RegExp(`<${sel}[^>]*>([\\s\\S]*?)</${sel}>`, 'i').exec(html);
    if (m && stripTags(m[1]).length > (opts.minTextLength || 0)) { raw = m[1]; break; }
  }
  if (!raw) {
    const body = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(html);
    raw = body ? body[1] : html;
  }
  const text = stripTags(raw);

  const links = [];
  const seen = new Set();
  const linkRe = /<a\s[^>]*href=["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let lm;
  while ((lm = linkRe.exec(html)) && links.length < 500) {
    const href = lm[1];
    if (/^(mailto:|javascript:|tel:|data:)/i.test(href)) continue;
    const abs = normalizeUrl(href, baseUrl);
    if (!abs || seen.has(abs)) continue;
    seen.add(abs);
    links.push({ href: abs, text: stripTags(lm[2]).slice(0, 80) });
  }

  const out = {
    title,
    description: description || null,
    textLength: text.length,
    text: text.slice(0, opts.maxChars || 2000),
    links,
  };

  // 自定义字段（正则版：selector 当正则用，或取 meta/link 的 attr）
  if (Array.isArray(opts.fields) && opts.fields.length) {
    out.fields = {};
    for (const f of opts.fields) {
      try {
        if (!f.selector) { out.fields[f.name] = null; continue; }
        const m = new RegExp(f.selector, 'i').exec(html);
        if (!m) { out.fields[f.name] = null; continue; }
        out.fields[f.name] = f.type === 'html' ? m[1] : stripTags(m[1]);
      } catch { out.fields[f.name] = null; }
    }
  }

  return out;
}

export default {
  name: 'crawl',
  version: '0.1.0',
  description: '站点爬取：从入口出发按层抓取，去重/限域/限页/控并发，可选 robots 遵循与 JS 渲染',
  permissions: ['browser', 'net'],
  schema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: '入口 URL' },
      maxDepth: { type: 'integer', description: '最大深度（0=只抓入口）', default: 1 },
      maxPages: { type: 'integer', description: '最多抓多少页', default: 20 },
      concurrency: { type: 'integer', description: '并发抓取数', default: 3 },
      sameOrigin: { type: 'boolean', description: '只抓同源链接', default: true },
      respectRobots: { type: 'boolean', description: '遵循 robots.txt 的 Disallow', default: true },
      urlPattern: { type: 'string', description: '只抓匹配该正则的 URL' },
      includeText: { type: 'boolean', description: '返回正文摘要', default: true },
      maxChars: { type: 'integer', description: '每页摘要最大字符', default: 2000 },
      includeLinks: { type: 'boolean', description: '返回每页发现的链接', default: true },
      render: { type: 'boolean', description: '用无头浏览器渲染（JS 站点）', default: false },
      delay: { type: 'integer', description: '每页间隔毫秒（礼貌抓取）', default: 0 },
      timeout: { type: 'integer', description: '单页超时毫秒', default: 20000 },
      fields: {
        type: 'array',
        items: { type: 'object' },
        description: '自定义字段：[{name, selector, type?: text|attr|html|list, attr?, limit?}]',
      },
    },
    required: ['url'],
  },

  async execute(params, ctx) {
    const start = normalizeUrl(String(params.url), String(params.url));
    if (!start) return { ok: false, error: `URL 非法: ${params.url}` };

    const maxDepth = Math.max(0, Number(params.maxDepth ?? 1));
    const maxPages = Math.max(1, Number(params.maxPages ?? 20));
    const concurrency = Math.max(1, Number(params.concurrency ?? 3));
    const sameOriginOnly = params.sameOrigin !== false;
    const origin = originOf(start);
    const pattern = params.urlPattern ? new RegExp(String(params.urlPattern)) : null;
    const includeText = params.includeText !== false;
    const includeLinks = params.includeLinks !== false;
    const delayMs = Math.max(0, Number(params.delay ?? 0));
    const timeout = Number(params.timeout ?? 20000);
    const render = Boolean(params.render);

    // robots
    let robotsRules = [];
    if (params.respectRobots !== false) {
      robotsRules = await loadRobots(origin);
      ctx.log('debug', `robots 规则 ${robotsRules.length} 条`);
    }

    const visited = new Set([start]);
    const results = [];
    const queue = [{ url: start, depth: 0 }];
    let fetched = 0;
    let skipped = { robots: 0, pattern: 0, origin: 0, error: 0 };

    const page = render ? await ctx.browser.page() : null;

    /** 抓一页 */
    const fetchPage = async (url) => {
      if (render) {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
        const html = await page.content();
        return { html, finalUrl: page.url() };
      }
      const r = await fetch(url, {
        headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' },
        signal: AbortSignal.timeout(timeout),
        redirect: 'follow',
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const ctype = r.headers.get('content-type') || '';
      if (!/text\/html|application\/xhtml/i.test(ctype)) throw new Error(`非 HTML: ${ctype}`);
      return { html: await r.text(), finalUrl: r.url || url };
    };

    const worker = async () => {
      for (;;) {
        const item = queue.shift();
        if (!item) return;
        if (fetched >= maxPages) return;
        if (disallowed(item.url, robotsRules)) { skipped.robots++; continue; }
        if (sameOriginOnly && originOf(item.url) !== origin) { skipped.origin++; continue; }
        // urlPattern 只约束"顺带抓到的链接"，入口本身豁免（否则入口不匹配时永远空结果）
        if (pattern && item.depth > 0 && !pattern.test(item.url)) { skipped.pattern++; continue; }

        fetched++;
        ctx.progress(`[${fetched}/${maxPages}] 深度 ${item.depth} ${item.url}`);
        try {
          const { html, finalUrl } = await fetchPage(item.url);
          const parsed = parsePage(html, finalUrl, {
            maxChars: params.maxChars,
            fields: params.fields,
            minTextLength: 40,
          });

          const record = {
            url: finalUrl,
            depth: item.depth,
            title: parsed.title,
            description: parsed.description,
            textLength: parsed.textLength,
            ...(includeText ? { text: parsed.text } : {}),
            ...(parsed.fields ? { fields: parsed.fields } : {}),
            linkCount: parsed.links.length,
            ...(includeLinks ? { links: parsed.links.slice(0, 50) } : {}),
          };
          results.push(record);

          // 入队下一层
          if (item.depth < maxDepth) {
            for (const l of parsed.links) {
              if (visited.has(l.href)) continue;
              visited.add(l.href);
              queue.push({ url: l.href, depth: item.depth + 1 });
            }
          }
        } catch (e) {
          skipped.error++;
          ctx.log('warn', `${item.url} → ${(e && e.message) || String(e)}`);
          results.push({
            url: item.url, depth: item.depth, error: (e && e.message) || String(e),
          });
        }
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      }
    };

    await Promise.all(Array.from({ length: Math.min(concurrency, maxPages) }, () => worker()));

    const okResults = results.filter((r) => !r.error);
    return {
      ok: okResults.length > 0,
      data: {
        start,
        origin,
        maxDepth,
        fetched: okResults.length,
        failed: skipped.error,
        queued: visited.size,
        skipped,
        pages: results.sort((a, b) => a.depth - b.depth || a.url.localeCompare(b.url)),
      },
      meta: { render, robotsRules: robotsRules.length },
    };
  },
};