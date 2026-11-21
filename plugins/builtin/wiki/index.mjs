/**
 * wiki —— 维基百科（搜索 / 摘要 / 章节 / 正文）
 *
 * 全部走官方 API（实测 2026-11-20，200/465ms）：
 *  - REST  /api/rest_v1/page/summary/<title>          摘要 + 缩略图 + 链接
 *  - api.php action=query&list=search                  搜索
 *  - api.php action=query&prop=extracts|sections       正文/章节
 *
 * 与模板 wiki-summary 的区别：这个是内置插件，带 search/sections/full 三模式，
 * 支持 zh/en/ja 多语种与多语言搜索（srsearch 可跨语种）。
 */

const UA = 'ForgeAPI/0.15 (+local wiki)';
const apiBase = (lang) => `https://${lang}.wikipedia.org/w/api.php`;
const restBase = (lang) => `https://${lang}.wikipedia.org/api/rest_v1`;

function clean(s) {
  return String(s || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

async function apiJson(lang, params) {
  const u = new URL(apiBase(lang));
  u.searchParams.set('format', 'json');
  u.searchParams.set('origin', '*');
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  const r = await fetch(u, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function restJson(lang, path) {
  const r = await fetch(`${restBase(lang)}${path}`, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

export default {
  name: 'wiki',
  version: '0.1.0',
  description: '维基百科：search 检索 / summary 摘要 / sections 章节 / full 正文，多语种，官方 API',
  permissions: ['net'],
  schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['search', 'summary', 'sections', 'full'], description: '模式', default: 'summary' },
      query: { type: 'string', description: 'action=search 时的关键词' },
      title: { type: 'string', description: 'action=summary/sections/full 时的词条标题' },
      lang: { type: 'string', description: '语言：zh/en/ja/fr…', default: 'zh' },
      limit: { type: 'integer', description: 'search 结果条数', default: 10 },
      sentences: { type: 'integer', description: 'summary 摘要句数（0=全文）', default: 3 },
      charLimit: { type: 'integer', description: 'full 正文字符上限', default: 6000 },
      explain: { type: 'boolean', description: 'full 是否带 wiki 标记的解释性文本', default: false },
    },
  },

  async execute(params, ctx) {
    const lang = String(params.lang || 'zh').trim() || 'zh';
    const action = String(params.action || 'summary');
    const limit = Number(params.limit ?? 10);

    try {
      /* ---------- search ---------- */
      if (action === 'search') {
        const q = String(params.query || params.title || '').trim();
        if (!q) return { ok: false, error: 'search 需要 query' };
        ctx.progress(`wiki ${lang} 搜索: ${q}`);
        const j = await apiJson(lang, { action: 'query', list: 'search', srsearch: q, srlimit: limit, srprop: 'snippet|wordcount|timestamp|title' });
        const items = ((j.query && j.query.search) || []).map((s) => ({
          title: s.title,
          url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(String(s.title).replace(/ /g, '_'))}`,
          snippet: clean(s.snippet),
          wordcount: s.wordcount ?? null,
          timestamp: s.timestamp || null,
        }));
        return {
          ok: items.length > 0,
          data: { query: q, lang, total: items.length, results: items },
          ...(items.length ? {} : { error: `无结果: ${q}` }),
        };
      }

      /* ---------- summary（REST） ---------- */
      if (action === 'summary') {
        const title = String(params.title || params.query || '').trim();
        if (!title) return { ok: false, error: 'summary 需要 title' };
        ctx.progress(`wiki ${lang} 摘要: ${title}`);
        const j = await restJson(lang, `/page/summary/${encodeURIComponent(title.replace(/ /g, '_'))}`);
        const extract = String(j.extract || '');
        const n = Number(params.sentences ?? 3);
        const desc = n > 0
          ? extract.split(/(?<=[。！？.!?])/).filter((x) => x.trim()).slice(0, n).join('').trim() || extract.slice(0, 500)
          : extract;
        return {
          ok: true,
          data: {
            title: j.title || title,
            displayTitle: clean(j.displaytitle) || undefined,
            description: j.description || null,
            extract: desc,
            extractFull: extract || null,
            lang,
            url: (j.content_urls && j.content_urls.desktop && j.content_urls.desktop.page) || null,
            thumbnail: (j.thumbnail && j.thumbnail.source) || null,
            langlinks: (j.langlinks || []).slice(0, 5).map((l) => ({ lang: l.lang, title: l.title })),
            wikibaseItem: j.wikibase_item || null,
            type: j.type || null,
          },
        };
      }

      /* ---------- sections ---------- */
      if (action === 'sections') {
        const title = String(params.title || params.query || '').trim();
        if (!title) return { ok: false, error: 'sections 需要 title' };
        const j = await apiJson(lang, { action: 'parse', page: title, prop: 'sections', redirects: 1 });
        const secs = (j.parse && j.parse.sections) || [];
        if (!secs.length && !j.parse) return { ok: false, error: `词条不存在: ${title}` };
        return {
          ok: true,
          data: {
            title: (j.parse && j.parse.title) || title,
            lang,
            count: secs.length,
            sections: secs.map((s) => ({ index: s.index, toclevel: s.toclevel, level: s.level, line: clean(s.line), anchor: s.anchor })),
          },
        };
      }

      /* ---------- full（extracts） ---------- */
      const title = String(params.title || params.query || '').trim();
      if (!title) return { ok: false, error: 'full 需要 title' };
      const j = await apiJson(lang, {
        action: 'query',
        prop: 'extracts',
        titles: title,
        explaintext: String(params.explain !== true),
        exsectionformat: 'wiki',
        exchars: Math.min(Number(params.charLimit ?? 6000), 12000),
        redirects: 1,
      });
      const pages = (j.query && j.query.pages) || {};
      const first = Object.values(pages)[0];
      if (!first || first.missing !== undefined) return { ok: false, error: `词条不存在: ${title}（lang=${lang}）` };
      return {
        ok: true,
        data: {
          pageid: first.pageid,
          title: first.title,
          lang,
          chars: String(first.extract || '').length,
          extract: String(first.extract || ''),
          url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(String(first.title).replace(/ /g, '_'))}`,
        },
      };
    } catch (e) {
      const msg = (e && e.message) || String(e);
      if (/HTTP 404/.test(msg)) return { ok: false, error: `词条不存在（404）: ${params.title || params.query}（lang=${lang}）` };
      return { ok: false, error: `wiki ${action} 失败: ${msg}` };
    }
  },
};