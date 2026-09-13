export default async function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    response.status(405).json({ error: "Method not allowed" });
    return;
  }

  const { city = "北京", apiKey, apiHost } = request.body || {};
  if (!apiKey || !city) {
    response.status(400).json({ error: "Missing weather config" });
    return;
  }

  try {
    const data = await fetchWeather({ city, apiKey, apiHost });
    response.status(200).json(data);
  } catch (error) {
    response.status(502).json({ error: normalizeErrorMessage(error) });
  }
}

async function fetchWeather({ city, apiKey, apiHost }) {
  const host = normalizeWeatherHost(apiHost);
  const headers = host ? { "X-QW-Api-Key": apiKey } : {};
  let locationId = getKnownWeatherLocationId(city);
  let cityName = city;
  if (!locationId) {
    const lookupUrl = host
      ? `${host}/geo/v2/city/lookup?location=${encodeURIComponent(city)}&range=cn&lang=zh`
      : `https://geoapi.qweather.com/v2/city/lookup?location=${encodeURIComponent(city)}&range=cn&lang=zh&key=${encodeURIComponent(apiKey)}`;
    const lookup = await fetchJson(lookupUrl, headers);
    const location = lookup.location?.[0];
    locationId = location?.id || "";
    cityName = location?.name || city;
  }
  if (!locationId) throw new Error("没有找到这个城市。");

  const nowUrl = host
    ? `${host}/v7/weather/now?location=${encodeURIComponent(locationId)}&lang=zh`
    : `https://devapi.qweather.com/v7/weather/now?location=${encodeURIComponent(locationId)}&lang=zh&key=${encodeURIComponent(apiKey)}`;
  const current = await fetchJson(nowUrl, headers);
  return normalizeWeatherData(cityName, current.now);
}

async function fetchJson(url, headers = {}) {
  const upstream = await fetch(url, { headers });
  const data = await upstream.json().catch(() => ({}));
  if (!upstream.ok || (data.code && data.code !== "200")) {
    throw new Error(formatWeatherApiError(data));
  }
  return data;
}

function formatWeatherApiError(data) {
  if (!data || typeof data !== "object") return String(data || "天气接口请求失败。");
  const parts = [data.error, data.message, data.code && `code ${data.code}`].filter(Boolean);
  return parts.length ? parts.join("，") : JSON.stringify(data);
}

function normalizeErrorMessage(error) {
  if (typeof error === "string") return error;
  return error?.message || (error && JSON.stringify(error)) || "Weather request failed";
}

function normalizeWeatherHost(value) {
  const host = String(value || "").trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  return host ? `https://${host}` : "";
}

function getKnownWeatherLocationId(city) {
  const normalized = String(city || "").trim().toLowerCase();
  const known = {
    北京: "101010100",
    beijing: "101010100",
  };
  return known[normalized] || "";
}

function normalizeWeatherData(city, now = {}) {
  const temp = now.temp || "";
  const text = now.text || "";
  const feelsLike = now.feelsLike ? `体感${now.feelsLike}°` : "";
  const humidity = now.humidity ? `湿度${now.humidity}%` : "";
  const wind = now.windDir && now.windScale ? `${now.windDir}${windScaleText(now.windScale)}` : now.windDir || "";
  const parts = [`${city}`, text, temp ? `${temp}°` : "", feelsLike, humidity, wind].filter(Boolean);
  return {
    city,
    temp,
    text,
    display: [text, temp ? `${temp}°` : "", feelsLike, humidity].filter(Boolean).join("，"),
    summary: parts.join("，"),
  };
}

function windScaleText(value) {
  return String(value).endsWith("级") ? String(value) : `${value}级`;
}
