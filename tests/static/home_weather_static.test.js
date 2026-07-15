import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {officialRadarUrl, weatherIcon, weatherLabel} from '../../src/lib/weather.js';
import HomeWeatherCard from '../../src/weather/HomeWeatherCard.jsx';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const weatherLib = fs.readFileSync(path.join(ROOT, 'src/lib/weather.js'), 'utf8');
const cardSrc = fs.readFileSync(path.join(ROOT, 'src/weather/HomeWeatherCard.jsx'), 'utf8');
const dashSrc = fs.readFileSync(path.join(ROOT, 'src/dashboard/HomeDashboard.jsx'), 'utf8');
const forecastFn = fs.readFileSync(path.join(ROOT, 'netlify/functions/weather-forecast.js'), 'utf8');
const radarFramesPath = path.join(ROOT, 'netlify/functions/weather-radar-frames.js');
const tileFnPath = path.join(ROOT, 'netlify/functions/weather-tile.js');

describe('weather helper (src/lib/weather.js)', () => {
  it('exports the structured weather helpers only', () => {
    expect(weatherLib).toContain('export async function loadForecast');
    expect(weatherLib).toContain('export function officialRadarUrl');
    expect(weatherLib).toContain('export function weatherIcon');
    expect(weatherLib).toContain('export function weatherLabel');
    expect(weatherLib).not.toContain('loadRadarFrames');
    expect(weatherLib).not.toContain('rainviewerTileUrl');
    expect(weatherLib).not.toContain('latLonToTile');
  });

  it('does not reference RainViewer, OSM tiles, Tomorrow.io, or old tile functions', () => {
    expect(weatherLib).not.toMatch(/RainViewer|rainviewer|openstreetmap|api\.tomorrow\.io|weather-tile/);
    expect(cardSrc).not.toMatch(/RainViewer|rainviewer|openstreetmap|api\.tomorrow\.io|weather-tile/);
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

  it('officialRadarUrl points to NWS radar', () => {
    expect(officialRadarUrl({radarUrl: 'https://radar.weather.gov/'})).toBe('https://radar.weather.gov/');
    expect(officialRadarUrl(null)).toBe('https://radar.weather.gov/');
  });
});

describe('weather forecast proxy', () => {
  it('uses Open-Meteo forecast and archive data without a Tomorrow.io key gate', () => {
    expect(forecastFn).toContain('api.open-meteo.com/v1/gfs');
    expect(forecastFn).toContain('archive-api.open-meteo.com');
    expect(forecastFn).toContain('process.env.WCF_FARM_WEATHER_LAT || DEFAULT_LAT');
    expect(forecastFn).not.toContain('process.env.WCF_WEATHER_LAT || DEFAULT_LAT');
    expect(forecastFn).toContain("const DEFAULT_LAT = '30.844206';");
    expect(forecastFn).toContain("const DEFAULT_LON = '-86.436543';");
    expect(forecastFn).toContain('const PRECIP_HISTORY_YEARS = 10;');
    expect(forecastFn).toContain('Open-Meteo GFS/HRRR');
    expect(forecastFn).toContain('National Weather Service');
    expect(forecastFn).not.toContain('fetchNwsAlerts');
    expect(forecastFn).not.toContain('alerts/active?point=');
    expect(forecastFn).not.toContain('TOMORROW_IO_API_KEY');
    expect(forecastFn).not.toContain('api.tomorrow.io');
  });

  it('returns structured rain windows, monthly precip, and no generated rain summary prose', () => {
    expect(forecastFn).toContain('buildRainWindows');
    expect(forecastFn).toContain('buildMonthlyPrecip');
    expect(forecastFn).toContain('archive-api.open-meteo.com');
    expect(forecastFn).toContain('monthlyPrecip');
    expect(forecastFn).toContain('next6h');
    expect(forecastFn).toContain('next24h');
    expect(forecastFn).toContain('next48h');
    expect(forecastFn).not.toContain('rainSummary');
  });

  it('does not contain banned vague rain copy', () => {
    for (const banned of [
      'Showers possible overnight',
      'Showers likely overnight',
      'Rain chance present, timing unclear',
      'Low hourly rain signal today',
      'Rain timing uncertain',
      'Rain likely this evening',
      'Rain possible',
    ]) {
      expect(forecastFn).not.toContain(banned);
      expect(cardSrc).not.toContain(banned);
    }
  });
});

describe('HomeWeatherCard component', () => {
  it('imports from weather.js helper', () => {
    expect(cardSrc).toContain("from '../lib/weather.js'");
  });

  it('has collapsed and expanded states using a real button for the collapsed card', () => {
    expect(cardSrc).toContain('data-weather-card="collapsed"');
    expect(cardSrc).toContain('data-weather-card="expanded"');
    expect(cardSrc).toContain('className="card weather-card lift"');
    expect(cardSrc).toMatch(/<button[\s\S]*data-weather-card="collapsed"/);
  });

  it('does not render narrative rain summary or removed operations panels', () => {
    expect(cardSrc).not.toContain('rainSummary');
    expect(cardSrc).not.toContain('<h2>Now</h2>');
    expect(cardSrc).not.toContain('<h2>Rain</h2>');
    expect(cardSrc).not.toContain('<h2>Work</h2>');
    expect(cardSrc).not.toContain('NWS Alerts');
    expect(cardSrc).not.toContain('data-weather-rain-structured');
  });

  it('keeps only official radar, monthly precip, and 10-day forecast in the expanded card', () => {
    expect(cardSrc).toContain('Open NWS Radar');
    expect(cardSrc).toContain('officialRadarUrl');
    expect(cardSrc).toContain('Precip by Month');
    expect(cardSrc).toContain('data-weather-monthly-precip="1"');
    expect(cardSrc).toContain('fmtFarmPoint(location)');
    expect(cardSrc).toContain('last 9 years');
    expect(cardSrc).toContain('10-Day Forecast');
    expect(cardSrc).toContain('Updated');
  });

  it('shows sustained wind, not gusts, in the 10-day forecast rows', () => {
    expect(cardSrc).toContain('title="Sustained wind"');
    expect(cardSrc).toContain('d.windSpeedMax');
    expect(cardSrc).not.toContain('round(d.windGustMax)} mph');
  });

  it('keeps the collapsed weather card compact so the Pasture Map row does not stretch', () => {
    const css = fs.readFileSync(path.join(ROOT, 'src/dashboard/homeRedesign.css'), 'utf8');
    expect(cardSrc).toContain("flexWrap: 'nowrap'");
    expect(cardSrc).not.toContain('wx-chip');
    expect(cardSrc).not.toContain('wx-alert-chip');
    expect(css).toContain('height: 66px');
    expect(css).toContain('.home .field-map-card');
  });
});

describe('HomeWeatherCard immediate stable shell contract', () => {
  it('never returns null: no hidden-loading or hidden-failure path', () => {
    // The collapsed card must exist from the first Home render onward.
    expect(cardSrc).not.toMatch(/return null/);
    expect(cardSrc).not.toMatch(/if \(loading\) return/);
    expect(cardSrc).not.toMatch(/if \(!forecast\) return/);
  });

  it('renders the collapsed card shell during the initial pending request', () => {
    // Server render = the component's very first paint: effects have not run,
    // so the request is still pending. The collapsed button must already exist
    // in its loading state with the approved card treatment.
    const html = renderToStaticMarkup(React.createElement(HomeWeatherCard));
    expect(html).toContain('data-weather-card="collapsed"');
    expect(html).toContain('data-weather-state="loading"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('Loading weather');
    expect(html).toContain('card weather-card lift');
    expect(html).not.toContain('data-weather-card="expanded"');
  });

  it('exposes distinguishable loading, ready, and unavailable states on one stable button', () => {
    expect(cardSrc).toContain('data-weather-state={status}');
    expect(cardSrc).toContain("aria-busy={status === 'loading'}");
    expect(cardSrc).toContain('Loading weather...');
    expect(cardSrc).toContain('Weather unavailable');
    expect(cardSrc).toContain('Retry');
    // One collapsed button node: exactly one data-weather-card="collapsed" in source,
    // with state-dependent content inside it rather than sibling replacement cards.
    expect(cardSrc.match(/data-weather-card="collapsed"/g)).toHaveLength(1);
  });

  it('failure keeps the card and routes retry through the stable control', () => {
    expect(cardSrc).toMatch(/status === 'unavailable'/);
    expect(cardSrc).toMatch(/setStatus\('loading'\);\s*\n\s*load\(\{force: true\}\)/);
  });

  it('initial load is non-forced; refresh and retry are forced', () => {
    expect(cardSrc).toContain('load({force: false})');
    expect(cardSrc).toContain('load({force: true})');
    // The mount effect must use the non-forced path so HTTP/server caching helps.
    expect(cardSrc).toMatch(/useEffect\(\(\) => \{\s*\n\s*load\(\{force: false\}\);/);
  });

  it('guards against duplicate concurrent requests and settles loading in finally', () => {
    expect(cardSrc).toMatch(/if \(inFlightRef\.current\) return;/);
    expect(cardSrc).toMatch(/finally \{\s*\n\s*inFlightRef\.current = false;/);
    expect(cardSrc).toContain('mountedRef');
  });

  it('loading clicks are inert and the modal only renders when ready', () => {
    expect(cardSrc).toContain('{expanded && ready && (');
    // The collapsed click handler expands only from ready; loading is a no-op.
    expect(cardSrc).toMatch(/if \(status === 'ready'\) \{\s*\n\s*setExpanded\(true\);/);
  });

  it('a failed explicit refresh retains the last valid forecast instead of blanking the card', () => {
    expect(cardSrc).toMatch(/setStatus\(forecastRef\.current \? 'ready' : 'unavailable'\)/);
  });
});

describe('Radar contract', () => {
  it('deletes weak in-app radar endpoints and keeps only an official radar link', () => {
    expect(fs.existsSync(tileFnPath)).toBe(false);
    expect(fs.existsSync(radarFramesPath)).toBe(false);
    expect(weatherLib).toContain('https://radar.weather.gov/');
    expect(cardSrc).toContain('Open NWS Radar');
  });
});

describe('HomeDashboard integration', () => {
  it('imports HomeWeatherCard', () => {
    expect(dashSrc).toContain('HomeWeatherCard');
    expect(dashSrc).toContain("from '../weather/HomeWeatherCard.jsx'");
  });
});
