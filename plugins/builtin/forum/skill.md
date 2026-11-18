# forum v0.1.0

> 论坛封装：登录 → 板块 → 帖子列表 → 帖子详情（多步骤会话 + cookie 保留）。

## 调用

```bash
# 登录（凭据可先用子命令写入 vault）
forge forum save-credential --params '{"username":"U","password":"P"}'
forge run forum --params '{"base":"https://forum.example.com","action":"login"}'

# 板块列表
forge run forum --params '{"base":"https://forum.example.com","action":"boards"}'

# 帖子列表（scoped to board）
forge run forum --params '{"base":"https://forum.example.com","action":"list","board":"/b/general","page":1}'

# 帖子详情
forge run forum --params '{"base":"https://forum.example.com","action":"detail","topic":"/t/12345"}'

# 登录态检查
forge run forum --params '{"base":"https://forum.example.com","action":"me"}'
```

## 参数

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `base` | string | 是 | 论坛根地址 |
| `action` | string | 否 | `login` / `boards` / `list` / `detail` / `me`，默认 `list` |
| `username` | string | 否 | 缺省读凭据 `USERNAME` |
| `password` | string | 否 | 缺省读凭据 `PASSWORD` |
| `board` | string | 否 | 板块路径或完整 URL |
| `topic` | string | 否 | 帖子路径/ID/URL |
| `page` | integer | 否 | 页码，默认 1 |
| `limit` | integer | 否 | 列表条数，默认 30 |

## 选择器覆盖

默认选择器覆盖 Discourse / phpBB / XenForo 常见结构。目标站不同则写
`~/.forgeapi/data/forum/config.json`：

```json
{
  "selectors": {
    "loginPath": "/ucp.php?mode=login",
    "userField": "#username",
    "passField": "#password",
    "submit": "input[type=submit]",
    "loginOk": ".user-profile",
    "boardItem": ".forums .forum",
    "topicItem": ".topic-list .topic",
    "postItem": ".post"
  }
}
```

## 输出

`boards` → `{ base, boards:[{name,href,url,desc,topics}], count }`
`list` → `{ board, page, topics:[{title,url,meta,replies}], count }`
`detail` → `{ url, title, posts:[{author,time,content}], count }`
`login` → `{ loggedIn, url }`

## 注意

- cookie 保存在 `~/.forgeapi/data/forum/cookies.json`，后续调用自动复用登录态。
- 凭据存于加密 vault，需先 `forge config --vault init --password ...`。
- 登录成功判定依赖 `loginOk` 选择器；登不上先核对这条。