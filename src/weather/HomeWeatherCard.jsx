import React from 'react';
import {loadForecast, officialRadarUrl, weatherIcon, weatherLabel} from '../lib/weather.js';

function round(value) {
  return value == null ? '--' : Math.round(value).toLocaleString();
}

function percent(value) {
  return value == null ? '--' : `${Math.round(value)}%`;
}

function inches(value) {
  if (value == null) return '--';
  if (value === 0) return '0';
  return (Math.round(value * 100) / 100).toFixed(2);
}

function fmtDay(dateStr) {
  if (!dateStr) return '';
  const d = new Date(`${dateStr}T12:00:00`);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return days[d.getDay()];
}

function fmtStamp(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'});
}

function fmtFarmPoint(location) {
  if (!location || location.lat == null || location.lon == null) return 'farm point';
  return `${location.label || 'Farm'} ${Number(location.lat).toFixed(6)}, ${Number(location.lon).toFixed(6)}`;
}

function MonthlyPrecipTable({monthlyPrecip}) {
  const months = monthlyPrecip?.months || [];
  const rows = monthlyPrecip?.years || [];
  return (
    <div className="wx-precip-wrap" data-weather-monthly-precip="1">
      <div className="wx-precip-table">
        <div className="wx-precip-row wx-precip-head">
          <span>Year</span>
          {months.map((month) => (
            <span key={month}>{month}</span>
          ))}
          <span>Total</span>
        </div>
        {rows.map((row) => (
          <div className="wx-precip-row" key={row.year}>
            <strong>{row.year}</strong>
            {row.values.map((value, idx) => (
              <span key={`${row.year}-${months[idx]}`}>{inches(value)}</span>
            ))}
            <strong>{inches(row.total)}</strong>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function HomeWeatherCard() {
  const [forecast, setForecast] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [expanded, setExpanded] = React.useState(false);
  const [refreshing, setRefreshing] = React.useState(false);

  const load = React.useCallback(async (force) => {
    try {
      const data = await loadForecast({force});
      setForecast(data);
    } catch (_e) {
      /* soft-fail */
    }
    setLoading(false);
  }, []);

  React.useEffect(() => {
    load(true);
  }, [load]);

  async function handleRefresh() {
    setRefreshing(true);
    await load(true);
    setRefreshing(false);
  }

  if (loading) return null;
  if (!forecast) return null;

  const {current, today, daily, monthlyPrecip, sources = {}, location} = forecast;
  if (!current || !today) return null;

  const radarUrl = officialRadarUrl(forecast);

  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded(true)}
        data-weather-card="collapsed"
        className="card weather-card lift"
        style={{width: '100%', textAlign: 'left', color: 'inherit', flexWrap: 'nowrap'}}
      >
        <span className="wx-ic" aria-hidden="true">
          {weatherIcon(current.weatherCode)}
        </span>
        <span className="wx-temp">{round(current.temp)}&deg;</span>
        <span className="wx-hilo">
          H:{round(today.high)}&deg; L:{round(today.low)}&deg;
        </span>
        <span className="wx-rain-pill">Rain {percent(today.precipProb)}</span>
        <svg
          className="go"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2.2}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M9 6l6 6-6 6" />
        </svg>
      </button>

      {expanded && (
        <div
          data-weather-card="expanded"
          className="wx-modal-backdrop"
          onClick={(e) => {
            if (e.target === e.currentTarget) setExpanded(false);
          }}
        >
          <div className="wx-modal">
            <div className="wx-modal-head">
              <div>
                <div className="wx-modal-title">
                  <span aria-hidden="true">{weatherIcon(current.weatherCode)}</span>
                  <span>{round(current.temp)}&deg;F</span>
                  <span className="wx-modal-condition">{weatherLabel(current.weatherCode)}</span>
                </div>
                <div className="wx-source-line">
                  Updated {fmtStamp(forecast.fetchedAt)} &middot; {sources.forecast || 'Open-Meteo'} &middot;{' '}
                  {sources.radar || 'NWS'}
                </div>
              </div>
              <div className="wx-modal-actions">
                <button type="button" className="btn-clear" onClick={handleRefresh} disabled={refreshing}>
                  {refreshing ? 'Refreshing...' : 'Refresh'}
                </button>
                <button
                  type="button"
                  className="btn-clear"
                  aria-label="Close weather"
                  onClick={() => setExpanded(false)}
                >
                  &times;
                </button>
              </div>
            </div>

            <section className="wx-panel wx-radar-panel">
              <div>
                <h2>Radar</h2>
                <div className="wx-source-line">{sources.radar || 'National Weather Service'}</div>
              </div>
              <a className="btn-clear wx-radar-link" href={radarUrl} target="_blank" rel="noreferrer">
                Open NWS Radar
              </a>
            </section>

            <section className="wx-panel">
              <h2>Precip by Month</h2>
              <div className="wx-source-line">
                Inches by month at {fmtFarmPoint(location)}: 2026 to date plus the last 9 years
              </div>
              <MonthlyPrecipTable monthlyPrecip={monthlyPrecip} />
            </section>

            <section className="wx-panel">
              <h2>10-Day Forecast</h2>
              <div className="wx-daily-list">
                {(daily || []).map((d, i) => (
                  <div className="wx-daily-row" key={d.date}>
                    <span>{i === 0 ? 'Today' : fmtDay(d.date)}</span>
                    <span aria-hidden="true">{weatherIcon(d.weatherCodeMax)}</span>
                    <strong>
                      {round(d.tempMax)}&deg;/{round(d.tempMin)}&deg;
                    </strong>
                    <span>{percent(d.precipProbMax)}</span>
                    <span title="Sustained wind">{round(d.windSpeedMax)} mph</span>
                    {d.tempMin != null && d.tempMin <= 33 ? <em>Freeze</em> : <em />}
                  </div>
                ))}
              </div>
            </section>
          </div>
        </div>
      )}
    </div>
  );
}
