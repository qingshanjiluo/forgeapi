/**
 * guba —— 东方财富股吧（帖子列表 / 帖子正文）
 *
 * 实测（2026-11-20）：
 *  - 列表页 https://guba.eastmoney.com/list,600519.html  fetch ECONNRESET（代理拒），渲染 200 / 370KB
 *  - 帖子 href 形态 `//guba.eastmoney.com/news/600519,1234567890.html`（页面 DOM 实测 43 处命中）
 *  - 帖子正文页同域，渲染后取 `.newstext` / `#post_content`
 *
 * 通道：渲染列表 → 抓帖子 href → 逐帖取正文（可选）
 */

const GUBA = 'https://guba.eastmoney.com';
const TGB = 'https://www.taoguba.com.cn';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/* ---------- 淘股吧（等价通道：个股页=行情+讨论流，无验证码；帖子详情需登录） ---------- */
async function tgbRun(ctx, symbol, params) {
  const code = /^sh|^sz|^bj/.test(symbol) ? symbol : (symbol.startsWith('6') ? 'sh' : 'sz') + symbol;
  const url = `${TGB}/quotes/${code}`;
  ctx.progress(`淘股吧 ${url}`);
  const page = await ctx.browser.page();
  try {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40000 });
    const status = resp ? resp.status() : 0;
    if (status >= 400) return { ok: false, error: `淘股吧 HTTP ${status}` };
    await page.waitForTimeout(4500);

    const data = await page.evaluate(() => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const body = clean(document.body.innerText);
      // 行情块：从"加关注"起固定一段
      const qi = body.indexOf('加关注');
      const qb = qi >= 0 ? body.slice(qi + 3, qi + 420) : '';
      const num = (re) => { const m = re.exec(qb); return m ? m[1].trim() : null; };
      const quote = qb
        ? {
            price: num(/￥([\d.]+)/),
            changePct: num(/\(([-+][\d.]+)%\)/),
            // 页面形如 "￥1485.75 +25.54 (+1.75%)"：涨跌在价格后、括号百分比前
            change: num(/￥[\d.]+\s+([-+][\d.]+)\s+\(/),
            prevClose: num(/昨收：([\d.]+)/),
            open: num(/今开：([\d.]+)/),
            high: num(/最高：([\d.]+)/),
            low: num(/最低：([\d.]+)/),
            volume: num(/成交量：\s*([\d.]+\S+手)/),
            amount: num(/成交额：\s*([\d.]+\S+)/),
            turnover: num(/换手率：([\d.]+%)/),
            marketCap: num(/总市值\(亿\)：([\d.]+亿)/),
            time: num(/([\d]{4}-\d{2}-\d{2} [\d:]+)\(北京时间\)/),
            name: (body.match(/(贵州茅台|[\u4e00-\u9fa5]{2,8})\s*\(?(?:sh|sz)\d{6}\)/) || [])[1] || null,
          }
        : null;
      // 讨论流帖子（短链 /a/<base62Id>）
      const posts = [];
      const seen = new Set();
      for (const a of document.querySelectorAll('a[href*="/a/"]')) {
        const href = a.getAttribute('href') || '';
        const m = /\/a\/(\w+)/.exec(href);
        if (!m || seen.has(m[1])) continue;
        const title = clean(a.textContent);
        if (title.length < 6) continue;
        seen.add(m[1]);
        const row = a.closest('[class*=Rlink], [class*=related], li, tr, div');
        posts.push({
          title: title.slice(0, 120),
          url: href.startsWith('http') ? href.split('#')[0] : 'https://www.tgb.cn/a/' + m[1],
          postId: m[1],
          rowText: row ? clean(row.innerText).slice(0, 200) : '',
        });
      }
      return { pageTitle: document.title, quote, posts, bodyLen: body.length };
    });

    const posts = data.posts.slice(0, Math.max(1, Number(params.limit ?? 20)));
    for (const p of posts) {
      const t = p.rowText || '';
      const author = /来自\s+(\S{2,20})/.exec(t);
      // 行文本形如 "4:49:12【上证50翻红…"：小时可能 1~2 位，不能从任意数字对切
      const time = /(?:^|\s)((?:[01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d)?|\d{4}-\d{2}-\d{2})\b/.exec(t);
      if (author) p.author = author[1];
      if (time) p.time = time[1];
      delete p.rowText;
    }

    const out = {
      source: 'taoguba',
      symbol: code,
      url,
      pageTitle: data.pageTitle,
      quote: data.quote,
      count: posts.length,
      posts,
      note: '淘股吧帖子详情页需登录，本插件只取个股页可读的列表与摘要',
    };

    if (params.includeBody === true) {
      out.note += '；includeBody=true 需登录会话，暂不可用（详情页 302 到登录）';
    }
    return { ok: posts.length > 0 || Boolean(data.quote), data: out, meta: { source: 'taoguba' } };
  } finally {
    await page.close().catch(() => {});
  }
}

/* ---------- 东方财富股吧（主通道，间歇性风控） ---------- */

/** 600519 / sh600519 → 600519 */
function normSymbol(input) {
  const s = String(input || '').trim().toUpperCase();
  const m = /(\d{6})/.exec(s);
  if (m) return m[1];
  return s.replace(/^SH|^SZ|^BJ/, '').toLowerCase();
}

/** 列表页 URL：tab=all|hot|news */
function listUrl(symbol, tab) {
  const t = String(tab || 'all');
  if (t === 'hot') return `${GUBA}/list,${symbol},99.html`;
  if (t === 'news') return `${GUBA}/list,${symbol},1,f.html`;
  if (t === 'recommend') return `${GUBA}/list,${symbol},17,1.html`;
  return `${GUBA}/list,${symbol}.html`;
}

async function openList(ctx, url, opts = {}) {
  const maxTry = Number(opts.maxTry ?? 3);
  let last = { status: 0, posts: [], challenge: false };
  for (let attempt = 1; attempt <= maxTry; attempt++) {
    const page = await ctx.browser.page();
    try {
      const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40000 });
      const status = resp ? resp.status() : 0;
      if (status === 403 || status === 464) return { page, status, challenge: true, posts: [], attempt };

      // 关掉可能挡内容的弹层
      await page.evaluate(() => {
        for (const e of document.querySelectorAll('[class*=close], [class*=Close], .close, [aria-label*=close]')) {
          try { e.click(); } catch { /* ignore */ }
        }
      }).catch(() => {});
      if (opts.waitFor) {
        await page.waitForSelector(String(opts.waitFor), { timeout: 12000 }).catch(() => {});
      }
      await page.waitForTimeout(Number(opts.settle ?? 3500));
      // 轻滚一次触发懒加载
      await page.evaluate(() => window.scrollBy(0, 400)).catch(() => {});
      await page.waitForTimeout(2000);

      const res = await page.evaluate(() => {
        const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
        const anchors = Array.from(document.querySelectorAll('a[href]'));
        const posts = [];
        for (const a of anchors) {
          let href = a.getAttribute('href') || '';
          if (!href || href.startsWith('javascript') || href.startsWith('#')) continue;
          if (href.startsWith('//')) href = 'https:' + href;
          const m = /\/news\/(\d{6}),(\d+)\.html/.exec(href);
          const m2 = /\/talk\/(\d+)\.html/.exec(href);
          if (!m && !m2) continue;
          const title = clean(a.textContent) || clean(a.getAttribute('title'));
          if (title.length < 4) continue;
          const row = a.closest('li, tr, .listitem, [class*=row]');
          posts.push({
            title,
            url: href,
            code: m ? m[1] : null,
            postId: m ? m[2] : (m2 ? m2[1] : null),
            rowText: row ? clean(row.innerText).slice(0, 220) : '',
          });
        }
        const body = document.body ? document.body.innerText : '';
        const challenge = /访问验证|按住滑块|安全验证|请进行验证|异常流量|captcha|身份核实|身份验证|进行验证|人机验证/i.test(body)
          || /安全验证|身份核实|验证/.test(document.title);
        return { posts, challenge, title: document.title, anchors: anchors.length };
      });

      last = { page, status, posts: res.posts, challenge: res.challenge, attempt, pageTitle: res.title, anchors: res.anchors };
      if (res.posts.length && !res.challenge) return last;
      // 帖子没出来 / 撞验证码 → 关掉重试
      await page.close().catch(() => {});
    } catch (e) {
      await page.close().catch(() => {});
      last = { status: 0, posts: [], challenge: true, attempt, error: (e && e.message) || String(e) };
    }
    if (attempt < maxTry) await new Promise((r) => setTimeout(r, 1500 * attempt));
  }
  return last;
}

export default {
  name: 'guba',
  version: '0.2.0',
  description: '股票论坛：东财股吧（主）+ 淘股吧（等价通道，带行情），auto 自动切换，验证码如实报错',
  permissions: ['browser'],
  schema: {
    type: 'object',
    properties: {
      symbol: { type: 'string', description: '股票代码：600519 或 sh600519' },
      source: { type: 'string', enum: ['guba', 'tgb', 'auto'], description: 'guba=东财股吧(风控)；tgb=淘股吧(稳)；auto=东财失败自动切淘股吧', default: 'auto' },
      tab: { type: 'string', enum: ['all', 'hot', 'news', 'recommend'], description: '东财列表页签', default: 'all' },
      limit: { type: 'integer', description: '抓几条帖子', default: 20 },
      includeBody: { type: 'boolean', description: '逐帖抓正文（东财可用；淘股吧需登录）', default: false },
      maxBodyChars: { type: 'integer', description: '单帖正文截断', default: 3000 },
      waitFor: { type: 'string', description: '列表页等待选择器', default: '.list_ul li, table' },
      maxTry: { type: 'integer', description: '验证码/空列表时的重试次数', default: 3 },
      settle: { type: 'integer', description: '页面稳定等待毫秒', default: 3500 },
      skipStockBar: { type: 'boolean', description: '跳过「热门股吧」排行榜（它也是 list,*.html 链接）', default: true },
      symbolFilter: { type: 'boolean', description: '只保留本代码的帖子（过滤推荐栏外链）', default: true },
    },
    required: ['symbol'],
  },

  async execute(params, ctx) {
    const symbol = normSymbol(params.symbol);
    if (!symbol) return { ok: false, error: `代码无法解析: ${params.symbol}` };
    const want = String(params.source || 'auto');

    /* 淘股吧通道 */
    if (want === 'tgb') return tgbRun(ctx, symbol, params);

    /* auto：先东财，失败再淘股吧 */
    if (want === 'auto') {
      const first = await gubaRun(ctx, symbol, params);
      if (first.ok) return first;
      const err = (first.error && first.error.message) || first.error || '未知错误';
      ctx.log('warn', `东财股吧失败 → 切淘股吧: ${typeof err === 'string' ? err.slice(0, 80) : JSON.stringify(err).slice(0, 80)}`);
      return tgbRun(ctx, symbol, params);
    }
    return gubaRun(ctx, symbol, params);
  },
};

async function gubaRun(ctx, symbol, params) {
  const limit = Math.max(1, Number(params.limit ?? 20));
    const url = listUrl(symbol, params.tab);
    ctx.progress(`渲染列表 ${url}`);

    const opened = await openList(ctx, url, {
      waitFor: params.waitFor,
      maxTry: params.maxTry,
      settle: params.settle,
    });
    const page = opened.page;

    try {
      if (opened.status === 403 || opened.status === 464) {
        return { ok: false, error: `股吧被拦 HTTP ${opened.status}（触发反爬，稍后重试或换 IP）` };
      }

      let posts = opened.posts || [];

      if (opened.challenge || !posts.length) {
        // 验证码挡住 / 空列表：给出可操作的错误，不静默返回空
        const why = opened.challenge
          ? '页面返回「访问验证」验证码（东财对高频访问的滑块验证），本插件不做打码'
          : `页面未渲染出帖子（anchors=${opened.anchors ?? 0}，title=${opened.pageTitle || '?'}）`;
        return {
          ok: false,
          error: `抓取失败：${why}。重试 ${opened.attempt || 0} 次仍未通过。`,
          meta: { url, attempts: opened.attempt ?? 0, challenge: Boolean(opened.challenge) },
        };
      }

      // 去重（同 href 多处出现）
      const seen = new Set();
      posts = posts.filter((p) => {
        if (seen.has(p.url)) return false;
        seen.add(p.url);
        return true;
      });

      // 跳过「热门股吧」排行（href 是别的代码）
      if (params.skipStockBar !== false) {
        posts = posts.filter((p) => (p.code ? p.code === symbol : true));
      }
      // 只保留本代码
      if (params.symbolFilter !== false) {
        posts = posts.filter((p) => !p.code || p.code === symbol);
      }

      // 从行文本抠 阅读/评论/时间
      for (const p of posts) {
        const t = p.rowText || '';
        const nums = (t.match(/\b\d{1,9}\b/g) || []).map(Number);
        const timeM = /(\d{2}:\d{2}|\d{4}-\d{2}-\d{2}|\d{1,2}月\d{1,2}日)/.exec(t);
        if (nums.length >= 2) { p.read = nums[nums.length - 2]; p.reply = nums[nums.length - 1]; }
        if (timeM) p.time = timeM[1];
        delete p.rowText;
      }

      posts = posts.slice(0, limit);

      const data = {
        symbol,
        url,
        pageTitle: opened.pageTitle,
        count: posts.length,
        posts,
      };

      /* ---------- 可选：逐帖抓正文 ---------- */
      if (params.includeBody === true && posts.length && page) {
        ctx.progress(`抓 ${posts.length} 帖正文`);
        const maxChars = Number(params.maxBodyChars ?? 3000);
        for (const p of posts) {
          try {
            const dp = await ctx.browser.page();
            const dresp = await dp.goto(p.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
            if (dresp && dresp.ok()) {
              await dp.waitForSelector('#post_content, .newstext, .trump-viewport', { timeout: 8000 }).catch(() => {});
              await dp.waitForTimeout(800);
              const body = await dp.evaluate((max) => {
                const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
                const root = document.querySelector('#post_content, .newstext, [class*=post-content], .trump-viewport');
                const txt = clean(root ? root.textContent : document.body.innerText);
                const replies = Array.from(document.querySelectorAll('[class*=reply], [class*=floor]'))
                  .slice(0, 20)
                  .map((e) => clean(e.textContent))
                  .filter((t) => t.length > 10);
                return { text: txt.slice(0, max), chars: txt.length, replies: replies.slice(0, 5) };
              }, maxChars);
              p.body = body.text;
              p.bodyChars = body.chars;
              if (body.replies?.length) p.replies = body.replies;
            }
            await dp.close();
          } catch (e) {
            p.bodyError = (e && e.message) || String(e);
          }
        }
      }

      return { ok: posts.length > 0, data, meta: { tab: params.tab || 'all', includeBody: params.includeBody === true, attempts: opened.attempt ?? 1 } };
    } finally {
      if (page) await page.close().catch(() => {});
    }
}