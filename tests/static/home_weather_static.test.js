import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';
import {weatherIcon, weatherLabel, latLonToTile} from '../../src/lib/weather.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const weatherLib = fs.readFileSync(path.join(ROOT, 'src/lib/weather.js'), 'utf8');
const cardSrc = fs.readFileSync(path.join(ROOT, 'src/weather/HomeWeatherCard.jsx'), 'utf8');
const dashSrc = fs.readFileSync(path.join(ROOT, 'src/dashboard/HomeDashboard.jsx'), 'utf8');
const forecastFn = fs.readFileSync(path.join(ROOT, 'netlify/functions/weather-forecast.js'), 'utf8');
const tileFn = fs.readFileSync(path.join(ROOT, 'netlify/functions/weather-tile.js'), 'utf8');

describe('weather helper (src/lib/weather.js)', () => {
  it('exports loadForecast, radarTileUrl, weatherIcon, weatherLabel, latLonToTile', () => {
    expect(weatherLib).toContain('export async function loadForecast');
    expect(weatherLib).toContain('export function radarTileUrl');
    expect(weatherLib).toContain('export function weatherIcon');
    expect(weatherLib).toContain('export function weatherLabel');
    expect(weatherLib).toContain('export function latLonToTile');
  });

  it('hits /.netlify/functions proxy, not Tomorrow.io directly', () => {
    expect(weatherLib).toContain('/.netlify/functions/weather-forecast');
    expect(weatherLib).toContain('/.netlify/functions/weather-tile');
    expect(weatherLib).not.toContain('api.tomorrow.io');
  });

  it('does NOT export hardcoded farm coordinates', () => {
    expect(weatherLib).not.toContain('export const FARM_LAT');
    expect(weatherLib).not.toContain('export const FARM_LON');
  });
});

describe('weather helper functions', () => {
  it('weatherIcon returns an emoji for known codes', () => {
    expect(weatherIcon(1000)).toBe('☀️');
    expect(weatherIcon(4001)).toBe('🌧️');
    expect(weatherIcon(8000)).toBe('⛈️');
  });

  it('weatherLabel returns descriptive text', () => {
    expect(weatherLabel(1000)).toBe('Clear');
    expect(weatherLabel(4001)).toBe('Rain');
    expect(weatherLabel(8000)).toBe('Thunderstorm');
  });

  it('latLonToTile computes valid tile coords', () => {
    const tile = latLonToTile(30.833938, -86.43003, 7);
    expect(tile.z).toBe(7);
    expect(tile.x).toBeGreaterThan(0);
    expect(tile.y).toBeGreaterThan(0);
  });
});

describe('HomeWeatherCard component', () => {
  it('imports from weather.js helper', () => {
    expect(cardSrc).toContain("from '../lib/weather.js'");
  });

  it('does NOT import hardcoded FARM_LAT/FARM_LON', () => {
    expect(cardSrc).not.toContain('FARM_LAT');
    expect(cardSrc).not.toContain('FARM_LON');
  });

  it('uses forecast.location for radar tiles', () => {
    expect(cardSrc).toContain('forecast.location');
    expect(cardSrc).toMatch(/loc\.lat[\s\S]*?loc\.lon[\s\S]*?latLonToTile/);
  });

  it('has collapsed and expanded states', () => {
    expect(cardSrc).toContain("data-weather-card': 'collapsed'");
    expect(cardSrc).toContain("data-weather-card': 'expanded'");
  });

  it('shows rain summary and freeze warning', () => {
    expect(cardSrc).toContain('rainSummary');
    expect(cardSrc).toContain('freezeWarning');
  });

  it('renders 10-day forecast and hourly rain timing', () => {
    expect(cardSrc).toContain('10-Day Forecast');
    expect(cardSrc).toContain('Rain Timing');
  });

  it('has manual refresh button', () => {
    expect(cardSrc).toContain('handleRefresh');
    expect(cardSrc).toContain('Refresh');
  });

  it('radar is behind a load button, not auto-loaded', () => {
    expect(cardSrc).toContain('Load Radar');
    expect(cardSrc).toContain('radarLoading');
  });

  it('soft-fails hidden when no forecast data', () => {
    expect(cardSrc).toMatch(/if \(!forecast\) return null/);
  });
});

describe('HomeDashboard integration', () => {
  it('imports HomeWeatherCard', () => {
    expect(dashSrc).toContain('HomeWeatherCard');
    expect(dashSrc).toContain("from '../weather/HomeWeatherCard.jsx'");
  });
});

describe('Netlify Functions — no API key exposure', () => {
  it('forecast function reads key from process.env only', () => {
    expect(forecastFn).toContain('process.env.TOMORROW_IO_API_KEY');
    expect(forecastFn).not.toMatch(/VITE_/);
  });

  it('forecast function returns clean error when key is missing', () => {
    expect(forecastFn).toContain('weather_unavailable');
    expect(forecastFn).toContain('503');
  });

  it('forecast function returns location in normalized response', () => {
    expect(forecastFn).toMatch(/location:\s*loc/);
  });

  it('forecast function uses updated default coords', () => {
    expect(forecastFn).toContain('30.833938');
    expect(forecastFn).toContain('-86.430030');
  });

  it('tile function reads key from process.env only', () => {
    expect(tileFn).toContain('process.env.TOMORROW_IO_API_KEY');
    expect(tileFn).not.toMatch(/VITE_/);
  });

  it('radar tile isolation — forecast works independently', () => {
    expect(forecastFn).not.toContain('weather-tile');
    expect(weatherLib).not.toContain('api.tomorrow.io');
  });
});

describe('Radar tile validation', () => {
  it('tile function validates z/x/y with Number.isInteger', () => {
    expect(tileFn).toContain('Number.isInteger(zi)');
    expect(tileFn).toContain('Number.isInteger(xi)');
    expect(tileFn).toContain('Number.isInteger(yi)');
  });

  it('tile function rejects negative x/y', () => {
    expect(tileFn).toMatch(/xi\s*<\s*0/);
    expect(tileFn).toMatch(/yi\s*<\s*0/);
  });

  it('tile function locks to fixed zoom and farm grid', () => {
    expect(tileFn).toContain('ALLOWED_ZOOM');
    expect(tileFn).toContain('buildAllowedTiles');
    expect(tileFn).toContain('allowed.has(key)');
    expect(tileFn).toContain('Tile outside allowed farm area');
  });

  it('tile function uses same env vars as forecast for location', () => {
    expect(tileFn).toContain('WCF_WEATHER_LAT');
    expect(tileFn).toContain('WCF_WEATHER_LON');
  });

  it('tile function uses updated default coords', () => {
    expect(tileFn).toContain('30.833938');
    expect(tileFn).toContain('-86.43003');
  });
});
