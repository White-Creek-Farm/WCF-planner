// Weather data fetcher for the Home Weather card.
// Forecast: Netlify Functions proxy (Tomorrow.io current/hourly + Open-Meteo daily).
// Radar: RainViewer (free, no key, animated frames).

const FORECAST_URL = '/.netlify/functions/weather-forecast';
const RADAR_FRAMES_URL = '/.netlify/functions/weather-radar-frames';
const CACHE_MS = 30 * 60 * 1000;

let cached = null;
let cachedAt = 0;

export async function loadForecast({force = false} = {}) {
  if (!force && cached && Date.now() - cachedAt < CACHE_MS) return cached;
  const res = await fetch(FORECAST_URL);
  if (!res.ok) return null;
  const data = await res.json();
  if (data.error) return null;
  cached = data;
  cachedAt = Date.now();
  return data;
}

export async function loadRadarFrames() {
  const res = await fetch(RADAR_FRAMES_URL);
  if (!res.ok) return null;
  const data = await res.json();
  if (!data.host || !data.radar) return null;
  return data;
}

export function rainviewerTileUrl(host, framePath, z, x, y) {
  return `${host}${framePath}/256/${z}/${x}/${y}/2/1_1.png`;
}

const WEATHER_CODES = {
  0: 'Unknown',
  1000: 'Clear',
  1100: 'Mostly Clear',
  1101: 'Partly Cloudy',
  1102: 'Mostly Cloudy',
  1001: 'Cloudy',
  2000: 'Fog',
  2100: 'Light Fog',
  4000: 'Drizzle',
  4001: 'Rain',
  4200: 'Light Rain',
  4201: 'Heavy Rain',
  5000: 'Snow',
  5001: 'Flurries',
  5100: 'Light Snow',
  5101: 'Heavy Snow',
  6000: 'Freezing Drizzle',
  6001: 'Freezing Rain',
  6200: 'Lt Freezing Rain',
  6201: 'Hvy Freezing Rain',
  7000: 'Ice Pellets',
  7101: 'Heavy Ice Pellets',
  7102: 'Light Ice Pellets',
  8000: 'Thunderstorm',
};

export function weatherLabel(code) {
  return WEATHER_CODES[code] || '';
}

const WEATHER_ICONS = {
  1000: '☀️',
  1100: '🌤️',
  1101: '⛅',
  1102: '🌥️',
  1001: '☁️',
  2000: '🌫️',
  2100: '🌫️',
  4000: '🌧️',
  4001: '🌧️',
  4200: '🌦️',
  4201: '🌧️',
  5000: '🌨️',
  5001: '🌨️',
  5100: '🌨️',
  5101: '🌨️',
  6000: '🧊',
  6001: '🧊',
  6200: '🧊',
  6201: '🧊',
  7000: '🧊',
  7101: '🧊',
  7102: '🧊',
  8000: '⛈️',
};

export function weatherIcon(code) {
  return WEATHER_ICONS[code] || '☁️';
}

export function latLonToTile(lat, lon, zoom) {
  const n = Math.pow(2, zoom);
  const x = Math.floor(((lon + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n);
  return {x, y, z: zoom};
}
