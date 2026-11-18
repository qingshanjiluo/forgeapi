# weather v0.1.0

> 天气：城市名或经纬度查询当前天气与多日预报（Open-Meteo，免密钥）。

## 调用

```bash
forge run weather --params '{"city":"上海","days":3}'
forge weather geocode --params '{"city":"Tokyo","count":3}'
```

## 参数

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `city` | string | 否 | 城市名（中文/英文）；与 lat/lon 二选一 |
| `lat` | number | 否 | 纬度 |
| `lon` | number | 否 | 经度 |
| `days` | integer | 否 | 预报天数 1-16，默认 3 |

## 输出

```json
{
  "ok": true,
  "data": {
    "地点": "上海,上海市 中国",
    "当前": { "温度": 13.4, "体感": 12.8, "湿度": 85, "风速": 6.4, "天气": "多云" },
    "预报": [
      { "日期": "2026-11-17", "最高": 18, "最低": 12.7, "降水": 0, "天气": "阴" }
    ]
  },
  "meta": { "lat": 31.22, "lon": 121.46, "source": "open-meteo" }
}
```

## 子命令

### weather geocode

只做地理编码，返回候选城市列表（name/latitude/longitude/country/admin1）。

## 注意

- 数据源 Open-Meteo，非商业用途免费，无需 API Key。
- 天气码按 WMO 4677 映射为中文描述。