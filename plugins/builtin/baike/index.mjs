/**
 * baike —— 百度百科词条
 *
 * 通道一（默认，快）：baike.baidu.com openapi（实测 200，16KB JSON，含 title/desc/abstract/card）
 * 通道二（render:true）：Playwright 渲染词条页，取正文与目录（openapi 拿不到的）
 *
 * 实测（2026-11-20）：openapi 可用；/item/ 裸 fetch 403（百度安全验证），渲染走浏览器可过。
 */

const openapiUrl = (key) =>
  'https://baike.baidu.com/api/openapi/BaikeLemmaCardApi?scope=103&format=json&appid=379020&bk_key=' + encodeURIComponent(key);

/** 去掉 value 里的 <sup>/<a> 噪声，只留文字 */
function stripValue(v) {
  if (Array.isArray(v)) return v.map(stripValue);
  if (typeof v !== 'string') return v ?? null;
  return v
    .replace(/<sup[^>]*>[\s\S]*?<\/sup>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/ /g, ' ')
    .replace(/&/g, '&')
    .replace(/</g, '<')
    .replace(/>/g, '>')
    .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number(d)))
    .replace(/\s+/g, ' ')
    .trim();
}

function parseOpenapi(j) {
  const fields = {};
  for (const c of j.card || []) {
    const val = stripValue(Array.isArray(c.value) ? c.value[0] : c.value);
    if (val === null || val === '' || val === undefined) continue;
    const k = String(c.name || c.key || '').trim();
    if (k && !(k in fields)) fields[k] = val;
  }
  return {
    title: j.title || j.key || null,
    desc: j.desc || null,
    abstract: stripValue(j.abstract || '') || null,
    fields,
    fieldCount: Object.keys(fields).length,
    url: j.url || (j.title ? 'https://baike.baidu.com/item/' + encodeURIComponent(j.title) : null),
    lemmaId: j.id ?? null,
  };
}

export default {
  name: 'baike',
  version: '0.1.0',
  description: '百度百科词条：openapi 拿标题/摘要/信息框，render 模式渲染正文（词条页裸 fetch 有百度安全验证）',
  permissions: ['net', 'browser'],
  schema: {
    type: 'object',
    properties: {
      key: { type: 'string', description: '词条名，如 拼多多 / 上海市 / 贵州茅台' },
      fieldsOnly: { type: 'boolean', description: '只要信息框字段（丢掉摘要）', default: false },
      abstractChars: { type: 'integer', description: '摘要截断字符', default: 600 },
      render: { type: 'boolean', description: '渲染词条页取正文与目录（慢，约 12s）', default: false },
      waitFor: { type: 'string', description: 'render 模式的等待选择器', default: '#lemmaContent' },
      includeSections: { type: 'boolean', description: 'render 模式返回目录章节名', default: true },
      maxTextChars: { type: 'integer', description: 'render 模式正文截断', default: 4000 },
    },
    required: ['key'],
  },

  async execute(params, ctx) {
    const key = String(params.key || '').trim();
    if (!key) return { ok: false, error: '需要 key（词条名）' };

    /* ---------- openapi（主通道） ---------- */
    let data = null;
    let openapiError = null;
    try {
      ctx.progress(`openapi 取「${key}」`);
      const r = await fetch(openapiUrl(key), {
        headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', accept: 'application/json' },
        signal: AbortSignal.timeout(15000),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      data = parseOpenapi(j);
      // 明确"词条不存在"（openapi 会 200 但返回空 card）
      if (!data.title && !data.abstract) openapiError = 'openapi 返回空（词条可能不存在，试全名或 render:true）';
    } catch (e) {
      openapiError = (e && e.message) || String(e);
      ctx.log('warn', `openapi 失败: ${openapiError}`);
    }

    /* ---------- render（增强 / 兜底） ---------- */
    let rendered = null;
    if (params.render === true || !data) {
      ctx.progress(`渲染词条页 https://baike.baidu.com/item/${encodeURIComponent(key)}`);
      try {
        const page = await ctx.browser.page();
        const resp = await page.goto(`https://baike.baidu.com/item/${encodeURIComponent(key)}`, {
          waitUntil: 'domcontentloaded',
          timeout: 40000,
        });
        const status = resp ? resp.status() : 0;
        if (status === 403) {
          rendered = { blocked: true, status, hint: '百度安全验证：换 render 外的 openapi 通道，或稍后重试' };
        } else {
          if (params.waitFor) await page.waitForSelector(String(params.waitFor), { timeout: 15000 }).catch(() => {});
          await page.waitForTimeout(1200);
          const r = await page.evaluate((opts) => {
            const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
            const title = clean(
              (document.querySelector('.lemmaTitle, h1, [class*=lemma-title]') || {}).textContent,
            ) || document.title.replace(/_百度百科$/, '');
            // 信息框（右侧）：dl/ul 结构，抓 key-value
            const fields = {};
            const aside = document.querySelector('[class*=basicInfo], [class*=basic-info], aside, .right-container');
            if (aside) {
              const rows = Array.from(aside.querySelectorAll('dt, .basicInfoItem dt, li'));
              for (const el of rows) {
                const k = clean(el.textContent);
                const vEl = el.nextElementSibling;
                const v = clean(vEl && vEl.textContent);
                if (k && v && k.length < 24 && !fields[k]) fields[k] = v.slice(0, 200);
              }
            }
            // 正文段落
            const root = document.querySelector('#lemmaContent, .lemmaContent, [class*=summary-content], .main-content');
            const paras = Array.from((root || document).querySelectorAll('p'))
              .map((p) => clean(p.textContent))
              .filter((t) => t.length > 30);
            // 目录
            const sections = opts.sections
              ? Array.from(document.querySelectorAll('.catalog-list a, [class*=catalog] a, [class*=directory] a'))
                  .slice(0, 30)
                  .map((a) => clean(a.textContent))
                  .filter(Boolean)
              : [];
            return {
              title,
              fields,
              sections,
              paragraphs: paras.slice(0, 12),
              textChars: paras.join('').length,
            };
          }, { sections: params.includeSections !== false, maxChars: Number(params.maxTextChars ?? 4000) });
          rendered = { ...r, blocked: false, status, url: page.url() };
          await page.close();
        }
      } catch (e) {
        rendered = { error: (e && e.message) || String(e) };
        ctx.log('warn', `渲染失败: ${rendered.error}`);
      }
    }

    /* ---------- 合并 ---------- */
    if (!data && !rendered) {
      return { ok: false, error: `百度百科取「${key}」失败: openapi: ${openapiError || 'n/a'}; render: 未尝试` };
    }

    const base = data || {
      title: rendered?.title || key,
      desc: null,
      abstract: (rendered?.paragraphs || []).join('\n\n').slice(0, Number(params.abstractChars ?? 600)) || null,
      fields: {},
      fieldCount: 0,
      url: `https://baike.baidu.com/item/${encodeURIComponent(key)}`,
      lemmaId: null,
    };

    const out = {
      key,
      title: base.title,
      desc: base.desc,
      abstract: params.abstractChars ? String(base.abstract || '').slice(0, Number(params.abstractChars)) : base.abstract,
      fields: { ...base.fields, ...(rendered && !rendered.blocked ? rendered.fields : {}) },
      fieldCount: 0,
      url: base.url,
      lemmaId: base.lemmaId,
    };
    out.fieldCount = Object.keys(out.fields).length;
    if (params.fieldsOnly === true) {
      delete out.abstract;
    }
    if (rendered) {
      out.rendered = {
        ok: !rendered.error && !rendered.blocked,
        sections: rendered.sections || [],
        paragraphs: rendered.paragraphs || [],
        status: rendered.status ?? null,
        ...(rendered.hint ? { hint: rendered.hint } : {}),
        ...(rendered.error ? { error: rendered.error } : {}),
      };
    }
    if (openapiError && params.render !== true) out.warn = openapiError;

    return { ok: true, data: out, meta: { openapi: !openapiError, rendered: Boolean(rendered) } };
  },
};