export default async function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    response.status(405).json({ error: "Method not allowed" });
    return;
  }

  const { key, query } = request.body || {};
  if (!key || !query) {
    response.status(400).json({ error: "Missing key or query" });
    return;
  }

  try {
    const location = await resolveAmapPoint(String(key), String(query));
    response.status(200).json(location);
  } catch (error) {
    response.status(502).json({ error: error?.message || "Amap request failed" });
  }
}

async function resolveAmapPoint(key, query) {
  const geocode = await fetchJson(
    `https://restapi.amap.com/v3/geocode/geo?key=${encodeURIComponent(key)}&address=${encodeURIComponent(query)}`,
  );
  if (geocode?.status === "1" && Array.isArray(geocode.geocodes) && geocode.geocodes.length) {
    const item = geocode.geocodes[0];
    return {
      source: "geocode",
      name: item.formatted_address || query,
      address: item.formatted_address || query,
      location: parseLocation(item.location),
    };
  }

  const search = await fetchJson(
    `https://restapi.amap.com/v3/place/text?key=${encodeURIComponent(key)}&keywords=${encodeURIComponent(query)}&offset=1&page=1&extensions=base`,
  );
  if (search?.status === "1" && Array.isArray(search.pois) && search.pois.length) {
    const item = search.pois[0];
    return {
      source: "place",
      name: item.name || query,
      address: item.address || item.pname || query,
      location: parseLocation(item.location),
    };
  }

  throw new Error(`没有找到「${query}」的地点。`);
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`高德接口请求失败：${response.status}`);
  }
  return response.json();
}

function parseLocation(raw) {
  const [lng, lat] = String(raw || "").split(",");
  if (!lng || !lat) {
    throw new Error("高德返回的坐标不完整。");
  }
  return {
    lng: Number(lng),
    lat: Number(lat),
  };
}
