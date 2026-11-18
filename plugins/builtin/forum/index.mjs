/**
 * forum 插件 —— 完整会话流程示例
 * 登录 → 板块列表 → 帖子列表 → 帖子详情，含 cookie 持久化与凭据读取。
 * 适配对象：Discourse / phpBB / XenForo 常见 DOM；未知站点请用 cfg 覆盖选择器。
 */
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_SELECTORS = {
  loginPath: '/login',
  userField: 'input[name=username], input[name=login], input[name=email], #username',
  passField: 'input[name=password], #password',
  submit: 'button[type=submit], input[type=submit], .btn-login',
  loginOk: '.user-menu, .avatar, .logged-in, #current-user',
  boardItem: '.board-list .board, .forums .forum, .node-list .node, .board',
  topicItem: '.topic-list .topic, .topic-list-item, .thread, .topic',
  postItem: '.post, .message, .comment, article',
};

function sel(ctx, key) {
  // 允许在 ~/.forgeapi/data/forum/config.json 覆盖选择器
  try {
    const f = path.join(ctx.dataDir, 'config.json');
    const cfg = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
    if (cfg.selectors?.[key]) return cfg.selectors[key];
  } catch { /* ignore */ }
  return DEFAULT_SELECTORS[key];
}

function abs(base, href) {
  try { return new URL(href, base).toString(); } catch { return href; }
}

export default {
  name: 'forum',
  version: '0.1.0',
  description: '论坛封装：登录 → 板块 → 帖子列表 → 帖子详情（多步骤会话 + cookie 保留）',
  permissions: ['browser', 'net', 'credential', 'fs-write'],
  schema: {
    type: 'object',
    properties: {
      base: { type: 'string', description: '论坛根地址，如 https://forum.example.com' },
      action: { type: 'string', enum: ['login', 'boards', 'list', 'detail', 'me'], default: 'list' },
      username: { type: 'string', description: '用户名（缺省读凭据 USERNAME）' },
      password: { type: 'string', description: '密码（缺省读凭据 PASSWORD）' },
      board: { type: 'string', description: '板块路径或完整 URL' },
      topic: { type: 'string', description: '帖子 ID 或完整 URL' },
      page: { type: 'integer', default: 1 },
      limit: { type: 'integer', default: 30 },
    },
    required: ['base'],
  },

  async execute(params, ctx) {
    const base = String(params.base).replace(/\/+$/, '');
    const action = String(params.action || 'list');
    const page = ctx.browser.page();

    // 1) 可选登录
    const user = params.username || ctx.getCredential('USERNAME');
    const pass = params.password || ctx.getCredential('PASSWORD');
    let loggedIn = false;

    if (action === 'login' || (user && pass)) {
      if (!user || !pass) return { ok: false, error: '登录需要 username/password（或凭据 USERNAME/PASSWORD）' };
      ctx.progress('打开登录页');
      await page;
      const p = await page;
      await p.goto(abs(base, sel(ctx, 'loginPath')), { waitUntil: 'domcontentloaded' });
      ctx.progress('填写凭据');
      await p.fill(sel(ctx, 'userField'), user);
      await p.fill(sel(ctx, 'passField'), pass);
      ctx.progress('提交登录');
      await Promise.all([
        p.waitForLoadState('domcontentloaded').catch(() => {}),
        p.click(sel(ctx, 'submit')).catch(async () => { await p.press(sel(ctx, 'passField'), 'Enter'); }),
      ]);
      await p.waitForTimeout(1200);
      loggedIn = await p.locator(sel(ctx, 'loginOk')).count().then((n) => n > 0).catch(() => false);
      if (!loggedIn) {
        const body = (await p.content()).slice(0, 500);
        ctx.log('warn', '登录态未确认，可能选择器不匹配或凭据错误');
        if (action === 'login') return { ok: false, error: '登录未成功（请检查凭据或选择器）', data: { url: p.url(), sample: body } };
      } else {
        ctx.progress('登录成功，保存 cookie');
        await ctx.browser.saveCookies();
      }
      if (action === 'login') return { ok: true, data: { loggedIn, url: p.url() } };
    }

    const html = async () => (await page).content();
    const p = await page;

    // 2) 板块列表
    if (action === 'boards') {
      ctx.progress(`打开 ${base}`);
      await p.goto(base, { waitUntil: 'domcontentloaded' });
      const boards = await p.$$eval(sel(ctx, 'boardItem'), (nodes) =>
        nodes.map((n) => {
          const a = n.querySelector('a[href]');
          return {
            name: (n.querySelector('.board-title, .title, h2, h3') || a || n).textContent?.trim().slice(0, 120) || '',
            href: a?.getAttribute('href') || '',
            desc: (n.querySelector('.description, .board-desc') || { textContent: '' }).textContent?.trim().slice(0, 200) || '',
            topics: (n.querySelector('.topics, .topic-count, .count') || { textContent: '' }).textContent?.trim() || '',
          };
        }).filter((b) => b.href),
      ).catch(() => []);
      return { ok: true, data: { base, boards: boards.map((b) => ({ ...b, url: abs(base, b.href) })), count: boards.length } };
    }

    // 3) 帖子列表
    if (action === 'list') {
      const boardUrl = params.board ? abs(base, String(params.board)) : base;
      const pg = Number(params.page || 1);
      const target = pg > 1 ? `${boardUrl}${boardUrl.includes('?') ? '&' : '?'}page=${pg}` : boardUrl;
      ctx.progress(`打开板块 ${target}`);
      await p.goto(target, { waitUntil: 'domcontentloaded' });
      const topics = await p.$$eval(sel(ctx, 'topicItem'), (nodes, limit) =>
        nodes.slice(0, limit).map((n) => {
          const a = n.querySelector('a[href]');
          const title = (n.querySelector('.title, .topic-title, .subject') || a || n).textContent?.trim() || '';
          const meta = (n.querySelector('.meta, .topic-meta, .author, time') || { textContent: '' }).textContent?.trim() || '';
          const replies = (n.querySelector('.replies, .posts, .reply-count') || { textContent: '' }).textContent?.trim() || '';
          return { title: title.slice(0, 200), href: a?.getAttribute('href') || '', meta: meta.slice(0, 120), replies };
        }).filter((t) => t.href && t.title), Number(params.limit || 30),
      ).catch(() => []);
      return {
        ok: true,
        data: { board: boardUrl, page: pg, topics: topics.map((t) => ({ ...t, url: abs(target, t.href) })), count: topics.length },
        meta: { loggedIn },
      };
    }

    // 4) 帖子详情
    if (action === 'detail') {
      if (!params.topic) return { ok: false, error: 'detail 需要 topic（帖子 URL 或 ID）' };
      const url = abs(base, String(params.topic));
      ctx.progress(`打开帖子 ${url}`);
      await p.goto(url, { waitUntil: 'domcontentloaded' });
      // 滚动加载更多楼层
      for (let i = 0; i < 3; i++) {
        await p.evaluate(() => window.scrollBy(0, window.innerHeight));
        await p.waitForTimeout(300);
      }
      const detail = await p.evaluate((postSel) => {
        const posts = [...document.querySelectorAll(postSel)].slice(0, 50).map((n) => ({
          author: (n.querySelector('.username, .author, .post-author') || { textContent: '' }).textContent?.trim() || '',
          time: (n.querySelector('time, .post-date, .date') || { textContent: '' }).textContent?.trim() || '',
          content: (n.querySelector('.post-content, .message-content, .content, .postbody') || n).textContent?.trim().slice(0, 4000) || '',
        }));
        return {
          title: (document.querySelector('h1, .topic-title') || { textContent: '' }).textContent?.trim() || document.title,
          posts,
        };
      }, sel(ctx, 'postItem')).catch(() => ({ title: '', posts: [] }));
      return { ok: true, data: { url, ...detail, count: detail.posts.length }, meta: { loggedIn } };
    }

    // 5) 当前登录态
    if (action === 'me') {
      await p.goto(base, { waitUntil: 'domcontentloaded' });
      const name = await p.$$eval(sel(ctx, 'loginOk'), (n) => n.map((x) => x.textContent?.trim()).filter(Boolean).slice(0, 3)).catch(() => []);
      return { ok: true, data: { url: p.url(), loggedInHints: name, hasCookies: fs.existsSync(path.join(ctx.dataDir, 'cookies.json')) } };
    }

    return { ok: false, error: `未知 action: ${action}` };
  },

  commands: [
    {
      name: 'save-credential',
      description: '把论坛账号写入本插件凭据库（需先 unlock）',
      schema: {
        type: 'object',
        properties: {
          username: { type: 'string' },
          password: { type: 'string' },
        },
        required: ['username', 'password'],
      },
      async handler(params, ctx) {
        ctx.setCredential('USERNAME', String(params.username));
        ctx.setCredential('PASSWORD', String(params.password));
        return { ok: true, data: { saved: ['USERNAME', 'PASSWORD'] } };
      },
    },
  ],
};
