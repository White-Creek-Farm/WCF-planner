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
const radarFramesFn = fs.readFileSync(path.join(ROOT, 'netlify/functions/weather-radar-frames.js'), 'utf8');

const tileFnExists = fs.existsSync(path.join(ROOT, 'netlify/functions/weather-tile.js'));

describe('weather helper (src/lib/weather.js)', () => {
  it('exports loadForecast, loadRadarFrames, rainviewerTileUrl, weatherIcon, weatherLabel, latLonToTile', () => {
    expect(weatherLib).toContain('export async function loadForecast');
    expect(weatherLib).toContain('export async function loadRadarFrames');
    expect(weatherLib).toContain('export function rainviewerTileUrl');
    expect(weatherLib).toContain('export function weatherIcon');
    expect(weatherLib).toContain('export function weatherLabel');
    expect(weatherLib).toContain('export function latLonToTile');
  });

  it('does not reference Tomorrow.io directly or export tile URL builder', () => {
    expect(weatherLib).not.toContain('api.tomorrow.io');
    expect(weatherLib).not.toContain('weather-tile');
  });

  it('uses RainViewer for radar frames', () => {
    expect(weatherLib).toContain('weather-radar-frames');
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

describe('10-day daily forecast via Open-Meteo', () => {
  it('forecast function fetches from Open-Meteo for daily rows', () => {
    expect(forecastFn).toContain('api.open-meteo.com');
    expect(forecastFn).toContain('forecast_days=10');
  });

  it('forecast function maps WMO weather codes to Tomorrow.io codes', () => {
    expect(forecastFn).toContain('mapWmoToTomorrow');
  });

  it('forecast returns dailySource field', () => {
    expect(forecastFn).toContain('dailySource');
    expect(forecastFn).toContain("'open-meteo'");
  });

  it('card uses dynamic daily label based on source/count', () => {
    expect(cardSrc).toContain('dailyLabel');
    expect(cardSrc).toContain('dailySource');
    expect(cardSrc).toContain("'10-Day Forecast'");
  });

  it('falls back to Tomorrow daily when Open-Meteo fails', () => {
    expect(forecastFn).toContain('tomorrowDaily');
  });
});

describe('RainViewer animated radar', () => {
  it('weather-tile.js is deleted (Tomorrow.io tiles retired)', () => {
    expect(tileFnExists).toBe(false);
  });

  it('weather-radar-frames.js fetches RainViewer metadata', () => {
    expect(radarFramesFn).toContain('rainviewer.com');
    expect(radarFramesFn).toContain('weather-maps.json');
  });

  it('card uses RainViewer tile URLs, not Tomorrow.io', () => {
    expect(cardSrc).toContain('rainviewerTileUrl');
    expect(cardSrc).not.toContain('radarTileUrl(t.z');
  });

  it('card renders OSM base map tiles', () => {
    expect(cardSrc).toContain('openstreetmap.org');
    expect(cardSrc).toContain('osmTileUrl');
  });

  it('tile loop order is dy outer, dx inner for row-major grid', () => {
    expect(cardSrc).toMatch(/for\s*\(\s*let dy/);
  });

  it('card has play/pause animation controls', () => {
    expect(cardSrc).toContain('playing');
    expect(cardSrc).toContain('Pause');
    expect(cardSrc).toContain('Play');
  });

  it('card shows frame time label', () => {
    expect(cardSrc).toContain('frameTimeLabel');
  });

  it('radar is gated behind Load Radar button', () => {
    expect(cardSrc).toContain('Load Radar');
    expect(cardSrc).toContain('handleLoadRadar');
  });

  it('card renders center crosshair marker', () => {
    expect(cardSrc).toContain('translate(-50%, -50%)');
  });

  it('card renders precipitation legend', () => {
    expect(cardSrc).toContain('Light');
    expect(cardSrc).toContain('Moderate');
    expect(cardSrc).toContain('Heavy');
  });

  it('card includes OSM and RainViewer attribution', () => {
    expect(cardSrc).toContain('OpenStreetMap');
    expect(cardSrc).toContain('RainViewer');
  });

  it('shows quiet error when radar unavailable', () => {
    expect(cardSrc).toContain('Radar unavailable');
    expect(cardSrc).toContain('radarError');
  });
});

describe('HomeWeatherCard component', () => {
  it('imports from weather.js helper', () => {
    expect(cardSrc).toContain("from '../lib/weather.js'");
  });

  it('uses forecast.location for radar tiles', () => {
    expect(cardSrc).toContain('forecast.location');
  });

  it('has collapsed and expanded states', () => {
    expect(cardSrc).toContain("data-weather-card': 'collapsed'");
    expect(cardSrc).toContain("data-weather-card': 'expanded'");
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
  });

  it('forecast function returns location in normalized response', () => {
    expect(forecastFn).toMatch(/location:\s*loc/);
  });

  it('no frontend Tomorrow.io direct URL', () => {
    expect(weatherLib).not.toContain('api.tomorrow.io');
    expect(cardSrc).not.toContain('api.tomorrow.io');
  });

  it('radar frame proxy needs no API key', () => {
    expect(radarFramesFn).not.toContain('TOMORROW_IO_API_KEY');
  });
});
