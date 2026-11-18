# demo-forum-pack v0.1.0

> 模板演示：论坛封装包（登录 + 板块 + 列表 + 详情四步会话）。

## 用途

演示声明式 `type: flow`：整条会话写成一串 `steps`，由引擎顺序执行，
不需要写 JS。凭据通过 `${cred:USERNAME}` / `${cred:PASSWORD}` 从加密库注入。

## 调用

```bash
forge template install demo-forum-pack
forge config --vault init --password PASS
forge config --vault set --plugin demo-forum-pack --key USERNAME --value U --password PASS
forge config --vault set --plugin demo-forum-pack --key PASSWORD --value P --password PASS
forge run demo-forum-pack --params '{"base":"https://forum.example.com"}'
```

## 步骤格式

```yaml
steps:
  - action: goto        # goto/fill/type/click/press/wait/waitFor/scroll/eval/extract/screenshot/cookie-save/cookie-load/sleep
    url: "https://..."
  - action: fill
    selector: "#user"
    value: "${USERNAME}"
  - action: waitFor
    selector: ".dashboard"
  - action: extract
    key: "items"
    fields:
      - { name: 标题, selector: "h1" }
```

## 输出

`{ ok, data: { <extract 的 key>: {...}, _finalUrl, _title } }`

## 注意

- `cookie-save` 落到 `<dataDir>/cookies.json`，下次自动加载。
- 选择器随论坛程序差异变化，改模板里的 selector 即可。