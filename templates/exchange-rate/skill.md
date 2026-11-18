# exchange-rate v0.1.0

> 汇率查询与换算：Frankfurter 公开接口（欧洲央行数据，免密钥）。

## 调用

```bash
forge template install exchange-rate
forge run exchange-rate --params '{"from":"USD","to":"CNY"}'
forge run exchange-rate --params '{"from":"EUR","to":"JPY","amount":100}'
```

## 参数

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `from` | string | 是 | 源货币代码（ISO 4217） |
| `to` | string | 是 | 目标货币代码 |
| `amount` | number | 否 | 换算金额，默认 1 |

## 输出

```json
{
  "ok": true,
  "data": {
    "results": [
      { "amount": 1.0, "base": "USD", "date": "2026-11-17", "rates": { "CNY": 7.23 } }
    ],
    "total": 1,
    "sources": [{ "name": "frankfurter", "count": 1 }]
  }
}
```

## 注意

- 数据源为欧洲央行参考汇率，工作日更新一次，不含周末与节假日。
- 支持约 30 种主要货币（ECB 覆盖范围）。