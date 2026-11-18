/**
 * form —— 通用表单提交与交互
 *
 * 覆盖"填表 → 提交 → 取结果"这类站点（`crawl` 只做 GET，拿不到提交后的内容）。
 * 也支持一串点击/填写/等待动作，最后按规则提取。
 *
 * 与 forum 的区别：forum 是论坛专用（登录/板块/帖子固定流程），
 * form 是通用：任意 URL + 任意字段 + 任意提交按钮。
 */

function abs(base, href) {
  try { return new URL(href, base).toString(); } catch { return href; }
}

export default {
  name: 'form',
  version: '0.1.0',
  description: '通用表单提交与交互：填字段 → 提交 → 等结果 → 按规则提取（支持多步动作）',
  permissions: ['browser', 'net'],
  schema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: '表单页地址' },
      fields: {
        type: 'array',
        items: { type: 'object' },
        description: '要填的字段：[{selector, value}]，value 可含 ${cred:KEY}',
      },
      clicks: {
        type: 'array',
        items: { type: 'string' },
        description: '按顺序点击的选择器（如同意条、展开按钮）',
      },
      submit: { type: 'string', description: '提交按钮选择器；缺省按 Enter 提交' },
      waitFor: { type: 'string', description: '提交后等待的选择器（结果出现）' },
      delay: { type: 'integer', description: '提交后额外等待毫秒', default: 1000 },
      extract: {
        type: 'array',
        items: { type: 'object' },
        description: '结果提取规则 [{name, selector, type?, attr?, limit?}]',
      },
      takeText: { type: 'boolean', description: '同时返回结果页正文摘要', default: true },
      maxChars: { type: 'integer', description: '正文摘要最大字符', default: 2000 },
      saveCookies: { type: 'boolean', description: '提交后保存 cookie（后续调用复用）', default: false },
      screenshot: { type: 'boolean', description: '结果页截图存盘', default: false },
      method: { type: 'string', enum: ['browser', 'http'], description: 'http 模式直接 POST 表单（无 JS，快）', default: 'browser' },
      httpEnctype: { type: 'string', enum: ['form', 'json'], description: 'http 模式编码方式', default: 'form' },
    },
    required: ['url'],
  },

  async execute(params, ctx) {
    const url = String(params.url || '');
    if (!url) return { ok: false, error: '需要 url' };

    const fields = Array.isArray(params.fields) ? params.fields : [];
    const interpolateField = (v) => {
      const s = String(v ?? '');
      return s.replace(/\$\{cred:([^}]+)\}/g, (_m, k) => ctx.getCredential(String(k).trim()) ?? '');
    };

    /* ---------- http 模式：直接 POST，无需浏览器 ---------- */
    if (params.method === 'http') {
      const body = new URLSearchParams();
      for (const f of fields) {
        if (!f.selector) continue;
        body.set(String(f.selector), interpolateField(f.value));
      }
      const isJson = params.httpEnctype === 'json';
      ctx.progress(`POST ${url}`);
      const r = await fetch(url, {
        method: 'POST',
        headers: isJson
          ? { 'content-type': 'application/json', 'user-agent': 'ForgeAPI/0.11 (+local)' }
          : { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'ForgeAPI/0.11 (+local)' },
        body: isJson ? JSON.stringify(Object.fromEntries(body)) : body.toString(),
        redirect: 'follow',
      });
      const text = await r.text();
      let data = text;
      try { data = JSON.parse(text); } catch { /* 保留文本 */ }
      return {
        ok: r.ok,
        data: { status: r.status, url: r.url || url, body: typeof data === 'string' ? data.slice(0, Number(params.maxChars ?? 2000)) : data },
      };
    }

    /* ---------- browser 模式 ---------- */
    const page = await ctx.browser.page();
    ctx.progress(`打开 ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded' });

    // 前置点击（同意条、展开更多等）
    for (const sel of (Array.isArray(params.clicks) ? params.clicks : [])) {
      ctx.progress(`点击 ${sel}`);
      await page.click(String(sel), { timeout: 10000 }).catch((e) => {
        ctx.log('warn', `点击 ${sel} 失败: ${e.message}`);
      });
      await page.waitForTimeout(300);
    }

    // 填字段
    for (const f of fields) {
      if (!f.selector) continue;
      const sel = String(f.selector);
      const val = interpolateField(f.value);
      ctx.progress(`填 ${sel}`);
      try {
        const kind = await page.getAttribute(sel, 'type').catch(() => null);
        if (kind === 'checkbox' || kind === 'radio') {
          await page.check(sel).catch(() => page.click(sel));
        } else if ((await page.evaluate((s) => document.querySelector(s)?.tagName, sel).catch(() => '')) === 'SELECT') {
          await page.selectOption(sel, val);
        } else {
          await page.fill(sel, val);
        }
      } catch (e) {
        return { ok: false, error: `填写 ${sel} 失败: ${(e && e.message) || String(e)}` };
      }
    }

    // 提交
    ctx.progress('提交');
    if (params.submit) {
      await page.click(String(params.submit), { timeout: 15000 });
    } else {
      // 无提交按钮：在最后一个字段按 Enter
      const last = fields.filter((f) => f.selector).pop();
      await page.press(last ? String(last.selector) : 'input', 'Enter').catch(() => {});
    }

    // 等结果
    if (params.waitFor) {
      ctx.progress(`等待 ${params.waitFor}`);
      await page.waitForSelector(String(params.waitFor), { timeout: 30000 }).catch((e) => {
        ctx.log('warn', `等待超时: ${e.message}`);
      });
    }
    if (Number(params.delay ?? 1000) > 0) await page.waitForTimeout(Number(params.delay ?? 1000));

    const finalUrl = page.url();
    const html = await page.content();
    const title = await page.title().catch(() => '');

    // 提取（在页面内用 DOM API，不依赖插件外模块）
    let extracted = null;
    if (Array.isArray(params.extract) && params.extract.length) {
      extracted = await page.evaluate((reqs) => {
        const pick = (el) => (el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : null);
        const out = {};
        for (const r of reqs) {
          const nodes = r.selector ? Array.from(document.querySelectorAll(r.selector)) : [];
          if (r.type === 'list') {
            out[r.name] = nodes.slice(0, r.limit || 50).map(pick);
          } else if (r.type === 'attr') {
            out[r.name] = nodes[0] ? nodes[0].getAttribute(r.attr) : null;
          } else if (r.type === 'html') {
            out[r.name] = nodes[0] ? nodes[0].innerHTML : null;
          } else {
            out[r.name] = nodes[0] ? pick(nodes[0]) : null;
          }
        }
        return out;
      }, params.extract).catch(() => null);
    }

    // 正文摘要：取最长的几个段落（比整块 body 更能避开菜单/语言列表噪声）
    let text = null;
    if (params.takeText !== false) {
      text = await page.evaluate((max) => {
        const paras = Array.from(document.querySelectorAll('article p, main p, .content p, #mw-content-text p, p'))
          .map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim())
          .filter((s) => s.length > 30)
          .sort((a, b) => b.length - a.length)
          .slice(0, 3);
        if (paras.length) return paras.join('\n\n').slice(0, max);
        // 退化：取主体容器文本
        const root = ['article', 'main', '.content', '.result', '#content', 'body']
          .map((s) => document.querySelector(s))
          .find((el) => el && (el.textContent || '').trim().length > 40);
        return (root ? root.textContent : document.body.textContent || '')
          .replace(/\s+/g, ' ').trim().slice(0, max);
      }, Number(params.maxChars ?? 2000));
    }

    if (params.saveCookies) {
      ctx.progress('保存 cookie');
      await ctx.browser.saveCookies();
    }

    let shot = null;
    if (params.screenshot) {
      const path = await import('node:path');
      const f = path.join(ctx.dataDir, 'shots', `form-${Date.now()}.png`);
      const fs = await import('node:fs');
      fs.mkdirSync(path.dirname(f), { recursive: true });
      await page.screenshot({ path: f, fullPage: true });
      shot = f;
    }

    return {
      ok: true,
      data: {
        url: finalUrl,
        title,
        htmlLength: html.length,
        ...(extracted ? { extracted } : {}),
        ...(text !== null ? { text } : {}),
        ...(shot ? { screenshot: shot } : {}),
      },
      meta: { fields: fields.length, clicks: params.clicks?.length ?? 0 },
    };
  },
};