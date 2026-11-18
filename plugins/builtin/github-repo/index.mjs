/**
 * github-repo 插件 —— GitHub REST API 封装（可选 TOKEN 提高限额）
 * action: info | issues | search | readme | releases | tree
 */

const API = 'https://api.github.com';

export default {
  name: 'github-repo',
  version: '0.1.0',
  description: 'GitHub 仓库信息 / Issue / 搜索 / README / Release / 目录树',
  permissions: ['net', 'credential'],
  schema: {
    type: 'object',
    properties: {
      repo: { type: 'string', description: 'owner/name，如 microsoft/vscode' },
      action: { type: 'string', enum: ['info', 'issues', 'search', 'readme', 'releases', 'tree'], default: 'info' },
      query: { type: 'string', description: 'search 的查询串（GitHub 搜索语法）' },
      state: { type: 'string', enum: ['open', 'closed', 'all'], default: 'open' },
      path: { type: 'string', description: 'tree 动作的子路径' },
      limit: { type: 'integer', default: 10 },
    },
    required: ['repo'],
  },

  async execute(params, ctx) {
    const token = ctx.getCredential('GITHUB_TOKEN') || process.env.GITHUB_TOKEN;
    const headers = {
      accept: 'application/vnd.github+json',
      'user-agent': 'ForgeAPI/0.1',
      'x-github-api-version': '2022-11-28',
    };
    if (token) headers.authorization = `Bearer ${token}`;

    const call = async (url, raw = false) => {
      ctx.progress(`GET ${url}`);
      const r = await fetch(url, { headers });
      const text = await r.text();
      if (!r.ok) throw new Error(`GitHub ${r.status}: ${text.slice(0, 200)}`);
      if (raw) return text;
      try { return JSON.parse(text); } catch { return text; }
    };

    const repo = String(params.repo || '').replace(/^https?:\/\/github\.com\//, '').replace(/\/$/, '');
    const action = params.action || 'info';
    const limit = Number(params.limit ?? 10);

    if (action === 'info') {
      const j = await call(`${API}/repos/${repo}`);
      return {
        ok: true,
        data: {
          全名: j.full_name, 描述: j.description, 星标: j.stargazers_count, Fork: j.forks_count,
          语言: j.language, 开放Issue: j.open_issues_count, 默认分支: j.default_branch,
          许可: j.license?.spdx_id ?? null, 创建: j.created_at, 更新: j.pushed_at,
          主页: j.homepage, 归档: j.archived, 大小KB: j.size, 主题: j.topics,
        },
      };
    }

    if (action === 'issues') {
      const j = await call(`${API}/repos/${repo}/issues?state=${params.state || 'open'}&per_page=${limit}`);
      return {
        ok: true,
        data: (Array.isArray(j) ? j : []).map((i) => ({
          number: i.number, title: i.title, state: i.state,
          user: i.user?.login, comments: i.comments,
          labels: (i.labels || []).map((l) => (typeof l === 'string' ? l : l.name)),
          created: i.created_at, url: i.html_url,
        })),
      };
    }

    if (action === 'search') {
      if (!params.query) return { ok: false, error: 'search 需要 query' };
      const j = await call(`${API}/search/repositories?q=${encodeURIComponent(params.query)}&per_page=${limit}`);
      return {
        ok: true,
        data: {
          total: j.total_count,
          items: (j.items || []).map((it) => ({
            全名: it.full_name, 描述: it.description, 星标: it.stargazers_count,
            语言: it.language, 更新: it.pushed_at, 链接: it.html_url,
          })),
        },
      };
    }

    if (action === 'readme') {
      const text = await call(`${API}/repos/${repo}/readme`, true);
      let content = text;
      try {
        const j = JSON.parse(text);
        content = Buffer.from(j.content || '', 'base64').toString('utf8');
      } catch { /* 已是纯文本 */ }
      return { ok: true, data: { repo, readme: content.slice(0, 20000), length: content.length } };
    }

    if (action === 'releases') {
      const j = await call(`${API}/repos/${repo}/releases?per_page=${limit}`);
      return {
        ok: true,
        data: (Array.isArray(j) ? j : []).map((r) => ({
          tag: r.tag_name, name: r.name, published: r.published_at,
          prerelease: r.prerelease, assets: (r.assets || []).map((a) => ({ name: a.name, size: a.size, downloads: a.download_count })),
        })),
      };
    }

    if (action === 'tree') {
      const j = await call(`${API}/repos/${repo}/git/trees/${params.path || 'HEAD'}?recursive=1`);
      return {
        ok: true,
        data: {
          truncated: j.truncated,
          entries: (j.tree || []).slice(0, 2000).map((e) => ({ path: e.path, type: e.type, size: e.size })),
        },
      };
    }

    return { ok: false, error: `未知 action: ${action}` };
  },

  commands: [
    {
      name: 'set-token',
      description: '把 GitHub Token 写入本插件凭据库',
      schema: { type: 'object', properties: { token: { type: 'string' } }, required: ['token'] },
      async handler(params, ctx) {
        ctx.setCredential('GITHUB_TOKEN', String(params.token));
        return { ok: true, data: { saved: 'GITHUB_TOKEN' } };
      },
    },
  ],
};
