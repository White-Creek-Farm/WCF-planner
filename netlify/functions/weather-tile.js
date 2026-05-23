// Netlify Function: radar tile proxy for Tomorrow.io precipitation map.
// Locked to a fixed zoom and the 3×3 tile grid around the farm location
// to prevent arbitrary map browsing and API call burn.

const DEFAULT_LAT = 30.833938;
const DEFAULT_LON = -86.43003;
const ALLOWED_ZOOM = 7;

function latLonToTile(lat, lon, zoom) {
  const n = Math.pow(2, zoom);
  const x = Math.floor(((lon + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n);
  return {x, y};
}

function buildAllowedTiles() {
  const lat = parseFloat(process.env.WCF_WEATHER_LAT) || DEFAULT_LAT;
  const lon = parseFloat(process.env.WCF_WEATHER_LON) || DEFAULT_LON;
  const center = latLonToTile(lat, lon, ALLOWED_ZOOM);
  const allowed = new Set();
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      allowed.add(`${ALLOWED_ZOOM}/${center.x + dx}/${center.y + dy}`);
    }
  }
  return allowed;
}

export async function handler(event) {
  const apiKey = process.env.TOMORROW_IO_API_KEY;
  if (!apiKey) {
    return {statusCode: 503, body: 'Weather not configured'};
  }

  const {z, x, y} = event.queryStringParameters || {};

  const zi = Number(z);
  const xi = Number(x);
  const yi = Number(y);

  if (!Number.isInteger(zi) || !Number.isInteger(xi) || !Number.isInteger(yi)) {
    return {statusCode: 400, body: 'Invalid tile coordinates'};
  }
  if (xi < 0 || yi < 0) {
    return {statusCode: 400, body: 'Invalid tile coordinates'};
  }

  const key = `${zi}/${xi}/${yi}`;
  const allowed = buildAllowedTiles();
  if (!allowed.has(key)) {
    return {statusCode: 403, body: 'Tile outside allowed farm area'};
  }

  try {
    const url =
      `https://api.tomorrow.io/v4/map/tile/${zi}/${xi}/${yi}/` + `precipitationIntensity/now.png?apikey=${apiKey}`;

    const res = await fetch(url);
    if (!res.ok) {
      return {statusCode: 502, body: 'Tile fetch failed'};
    }

    const buffer = await res.arrayBuffer();

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'image/png',
        'Cache-Control': 'public, max-age=300, s-maxage=300',
      },
      body: Buffer.from(buffer).toString('base64'),
      isBase64Encoded: true,
    };
  } catch (e) {
    console.error('weather-tile error:', e);
    return {statusCode: 500, body: 'Tile proxy error'};
  }
}
