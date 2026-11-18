/**
 * weather 插件 —— 代码型示例（演示 execute + commands + 凭据 + 进度回调）
 * 数据源：Open-Meteo（免密钥）
 */

const WMO = {
  0: '晴', 1: '基本晴', 2: '多云', 3: '阴', 45: '雾', 48: '雾凇',
  51: '小毛毛雨', 53: '毛毛雨', 55: '大毛毛雨', 61: '小雨', 63: '中雨', 65: '大雨',
  66: '冻雨', 67: '强冻雨', 71: '小雪', 73: '中雪', 75: '大雪', 77: '雪粒',
  80: '阵雨', 81: '强阵雨', 82: '暴雨', 85: '阵雪', 86: '强阵雪',
  95: '雷暴', 96: '雷暴伴小冰雹', 99: '雷暴伴大冰雹',
};

async function geocode(city) {
  const u = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=zh&format=json`;
  const r = await fetch(u);
  if (!r.ok) throw new Error(`地理编码 HTTP ${r.status}`);
  const j = await r.json();
  const hit = j.results?.[0];
  if (!hit) throw new Error(`未找到城市: ${city}`);
  return { lat: hit.latitude, lon: hit.longitude, name: hit.name, country: hit.country, admin: hit.admin1 };
}

async function forecast(lat, lon, days) {
  const u = new URL('https://api.open-meteo.com/v1/forecast');
  u.searchParams.set('latitude', String(lat));
  u.searchParams.set('longitude', String(lon));
  u.searchParams.set('current', 'temperature_2m,relative_humidity_2m,apparent_temperature,wind_speed_10m,weather_code');
  u.searchParams.set('daily', 'temperature_2m_max,temperature_2m_min,precipitation_sum,weather_code');
  u.searchParams.set('forecast_days', String(days ?? 3));
  u.searchParams.set('timezone', 'auto');
  const r = await fetch(u);
  if (!r.ok) throw new Error(`天气 HTTP ${r.status}`);
  return r.json();
}

function readable(j) {
  const cur = j.current || {};
  const daily = j.daily || {};
  const out = {
    当前: {
      温度: cur.temperature_2m,
      体感: cur.apparent_temperature,
      湿度: cur.relative_humidity_2m,
      风速: cur.wind_speed_10m,
      天气: WMO[cur.weather_code] || `code:${cur.weather_code}`,
    },
    预报: [],
  };
  const dates = daily.time || [];
  for (let i = 0; i < dates.length; i++) {
    out.预报.push({
      日期: dates[i],
      最高: daily.temperature_2m_max?.[i],
      最低: daily.temperature_2m_min?.[i],
      降水: daily.precipitation_sum?.[i],
      天气: WMO[daily.weather_code?.[i]] || `code:${daily.weather_code?.[i]}`,
    });
  }
  return out;
}

export default {
  name: 'weather',
  version: '0.1.0',
  description: '天气：城市名或经纬度查询当前天气与多日预报（Open-Meteo，免密钥）',
  permissions: ['net'],
  schema: {
    type: 'object',
    properties: {
      city: { type: 'string', description: '城市名（中文/英文）' },
      lat: { type: 'number', description: '纬度' },
      lon: { type: 'number', description: '经度' },
      days: { type: 'integer', description: '预报天数 1-16', default: 3 },
    },
  },

  async execute(params, ctx) {
    let lat = params.lat;
    let lon = params.lon;
    let place = null;

    if ((lat === undefined || lon === undefined) && params.city) {
      ctx.progress(`地理编码: ${params.city}`);
      place = await geocode(params.city);
      lat = place.lat;
      lon = place.lon;
    }
    if (lat === undefined || lon === undefined) {
      return { ok: false, error: '需要 city，或同时提供 lat/lon' };
    }

    ctx.progress(`拉取预报 lat=${lat} lon=${lon}`);
    const raw = await forecast(lat, lon, Number(params.days ?? 3));
    return {
      ok: true,
      data: { 地点: place ? `${place.name}${place.admin ? ',' + place.admin : ''} ${place.country || ''}`.trim() : `${lat},${lon}`, ...readable(raw) },
      meta: { lat, lon, source: 'open-meteo' },
    };
  },

  commands: [
    {
      name: 'geocode',
      description: '只做地理编码，返回候选城市列表',
      schema: {
        type: 'object',
        properties: {
          city: { type: 'string', description: '城市名' },
          count: { type: 'integer', default: 5 },
        },
        required: ['city'],
      },
      async handler(params) {
        const u = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(params.city)}&count=${params.count ?? 5}&language=zh&format=json`;
        const r = await fetch(u);
        const j = await r.json();
        return { ok: true, data: j.results || [] };
      },
    },
  ],
};
