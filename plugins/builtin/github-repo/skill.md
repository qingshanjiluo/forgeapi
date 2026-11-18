# github-repo v0.1.0

> GitHub 仓库信息 / Issue / 搜索 / README / Release / 目录树。

## 调用

```bash
forge run github-repo --params '{"repo":"microsoft/vscode","action":"info"}'
forge run github-repo --params '{"repo":"microsoft/vscode","action":"issues","state":"open","limit":5}'
forge run github-repo --params '{"repo":"x","action":"search","query":"language:rust cli","limit":10}'
forge run github-repo --params '{"repo":"microsoft/vscode","action":"readme"}'
forge run github-repo --params '{"repo":"microsoft/vscode","action":"releases","limit":3}'
forge run github-repo --params '{"repo":"microsoft/vscode","action":"tree","path":"HEAD"}'
```

## 参数

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `repo` | string | 是 | `owner/name`，也接受完整 URL |
| `action` | string | 否 | `info` / `issues` / `search` / `readme` / `releases` / `tree` |
| `query` | string | 否 | search 动作的查询串（GitHub 搜索语法） |
| `state` | string | 否 | issues 状态：open/closed/all |
| `path` | string | 否 | tree 动作的子路径 |
| `limit` | integer | 否 | 条数，默认 10 |

## 子命令

### github-repo set-token

把 GitHub Token 写入本插件凭据库，提升 API 限额至 5000/h：

```bash
forge config --vault unlock --password PASS
forge github-repo set-token --params '{"token":"ghp_xxx"}'
```

## 输出（info）

```json
{
  "ok": true,
  "data": {
    "全名": "microsoft/vscode", "描述": "...", "星标": 160000, "Fork": 28000,
    "语言": "TypeScript", "开放Issue": 9000, "默认分支": "main",
    "许可": "MIT", "创建": "2015-09-03T...", "更新": "2026-11-17T...",
    "主页": "https://code.visualstudio.com", "归档": false, "大小KB": 900000, "主题": ["editor"]
  }
}
```

## 注意

- 未认证限 60 次/小时；带 TOKEN 5000 次/小时。
- `readme` 截断到 20000 字符。