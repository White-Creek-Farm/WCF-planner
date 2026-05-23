import React from 'react';
import {loadForecast, weatherIcon, weatherLabel, radarTileUrl, latLonToTile} from '../lib/weather.js';

export default function HomeWeatherCard() {
  const [forecast, setForecast] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [expanded, setExpanded] = React.useState(false);
  const [radarLoading, setRadarLoading] = React.useState(false);
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
    load(false);
  }, [load]);

  async function handleRefresh() {
    setRefreshing(true);
    await load(true);
    setRefreshing(false);
  }

  if (loading) return null;
  if (!forecast) return null;

  const {current, today, rainSummary, freezeWarning, daily, hourly} = forecast;
  if (!current || !today) return null;

  const fmtDay = (dateStr) => {
    if (!dateStr) return '';
    const d = new Date(dateStr + 'T12:00:00');
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    return days[d.getDay()];
  };

  const fmtHour = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    const h = d.getHours();
    return h === 0 ? '12a' : h < 12 ? h + 'a' : h === 12 ? '12p' : h - 12 + 'p';
  };

  const todayStr = new Date().toISOString().split('T')[0];
  const tomorrowStr = new Date(Date.now() + 86400000).toISOString().split('T')[0];
  const rainHours = (hourly || []).filter(
    (h) => h.time && (h.time.startsWith(todayStr) || h.time.startsWith(tomorrowStr)),
  );

  const loc = forecast.location || {};
  const ZOOM = 7;
  const farmTile = loc.lat && loc.lon ? latLonToTile(loc.lat, loc.lon, ZOOM) : null;
  const radarTiles = [];
  if (farmTile) {
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        radarTiles.push({x: farmTile.x + dx, y: farmTile.y + dy, z: ZOOM});
      }
    }
  }

  return React.createElement(
    'div',
    null,
    // ── Collapsed card ──
    React.createElement(
      'div',
      {
        onClick: () => setExpanded(true),
        'data-weather-card': 'collapsed',
        style: {
          background: 'white',
          border: '1px solid #e5e7eb',
          borderRadius: 12,
          padding: '12px 18px',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          flexWrap: 'wrap',
        },
      },
      React.createElement('span', {style: {fontSize: 22}}, weatherIcon(current.weatherCode)),
      React.createElement(
        'span',
        {style: {fontSize: 20, fontWeight: 700, color: '#111827'}},
        Math.round(current.temp) + '°',
      ),
      React.createElement(
        'span',
        {style: {fontSize: 12, color: '#6b7280'}},
        'H:' + Math.round(today.high) + '° L:' + Math.round(today.low) + '°',
      ),
      today.precipProb > 10 &&
        React.createElement(
          'span',
          {style: {fontSize: 12, color: '#2563eb', fontWeight: 600}},
          Math.round(today.precipProb) + '% rain',
        ),
      React.createElement('span', {style: {fontSize: 12, color: '#374151', flex: 1, minWidth: 120}}, rainSummary),
      freezeWarning &&
        React.createElement(
          'span',
          {
            style: {
              fontSize: 11,
              fontWeight: 700,
              color: '#1e40af',
              background: '#dbeafe',
              padding: '2px 8px',
              borderRadius: 6,
            },
          },
          freezeWarning,
        ),
    ),

    // ── Expanded modal ──
    expanded &&
      React.createElement(
        'div',
        {
          'data-weather-card': 'expanded',
          style: {
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'rgba(0,0,0,.4)',
            zIndex: 9999,
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'flex-start',
            padding: '40px 16px',
            overflowY: 'auto',
          },
          onClick: (e) => {
            if (e.target === e.currentTarget) setExpanded(false);
          },
        },
        React.createElement(
          'div',
          {
            style: {
              background: 'white',
              borderRadius: 16,
              padding: '24px',
              maxWidth: 600,
              width: '100%',
              maxHeight: 'calc(100vh - 80px)',
              overflowY: 'auto',
              boxShadow: '0 8px 32px rgba(0,0,0,.15)',
            },
          },

          // Header
          React.createElement(
            'div',
            {style: {display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16}},
            React.createElement(
              'div',
              {style: {fontSize: 18, fontWeight: 700, color: '#111827'}},
              weatherIcon(current.weatherCode) + ' ' + Math.round(current.temp) + '°F',
              React.createElement(
                'span',
                {style: {fontSize: 13, fontWeight: 400, color: '#6b7280', marginLeft: 8}},
                weatherLabel(current.weatherCode),
              ),
            ),
            React.createElement(
              'div',
              {style: {display: 'flex', gap: 8}},
              React.createElement(
                'button',
                {
                  onClick: handleRefresh,
                  disabled: refreshing,
                  style: {
                    background: 'none',
                    border: '1px solid #d1d5db',
                    borderRadius: 6,
                    padding: '4px 10px',
                    fontSize: 11,
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                    opacity: refreshing ? 0.5 : 1,
                  },
                },
                refreshing ? 'Refreshing...' : 'Refresh',
              ),
              React.createElement(
                'button',
                {
                  onClick: () => setExpanded(false),
                  style: {
                    background: 'none',
                    border: 'none',
                    fontSize: 20,
                    cursor: 'pointer',
                    color: '#6b7280',
                    padding: '0 4px',
                  },
                },
                '×',
              ),
            ),
          ),

          // Today summary
          React.createElement(
            'div',
            {
              style: {
                background: '#f9fafb',
                borderRadius: 10,
                padding: '12px 16px',
                marginBottom: 16,
                fontSize: 13,
                color: '#374151',
              },
            },
            React.createElement(
              'div',
              null,
              'High ' + Math.round(today.high) + '° · Low ' + Math.round(today.low) + '°',
              today.precipProb > 10 ? ' · ' + Math.round(today.precipProb) + '% rain' : '',
            ),
            React.createElement('div', {style: {fontWeight: 600, marginTop: 4}}, rainSummary),
            freezeWarning &&
              React.createElement('div', {style: {color: '#1e40af', fontWeight: 700, marginTop: 4}}, freezeWarning),
          ),

          // Hourly rain timing
          React.createElement(
            'div',
            {style: {marginBottom: 16}},
            React.createElement(
              'div',
              {style: {fontSize: 13, fontWeight: 700, color: '#111827', marginBottom: 8}},
              'Rain Timing — Next 48h',
            ),
            React.createElement(
              'div',
              {style: {display: 'flex', gap: 2, flexWrap: 'wrap'}},
              rainHours.map((h) =>
                React.createElement('div', {
                  key: h.time,
                  title: fmtHour(h.time) + ': ' + Math.round(h.precipProb) + '%',
                  style: {
                    width: 10,
                    height: 28,
                    borderRadius: 2,
                    background:
                      h.precipProb > 70
                        ? '#2563eb'
                        : h.precipProb > 40
                          ? '#60a5fa'
                          : h.precipProb > 20
                            ? '#bfdbfe'
                            : '#f3f4f6',
                  },
                }),
              ),
            ),
            React.createElement(
              'div',
              {style: {display: 'flex', justifyContent: 'space-between', fontSize: 10, color: '#9ca3af', marginTop: 2}},
              React.createElement('span', null, 'Now'),
              React.createElement('span', null, '+24h'),
              React.createElement('span', null, '+48h'),
            ),
          ),

          // 10-day forecast
          React.createElement(
            'div',
            {style: {marginBottom: 16}},
            React.createElement(
              'div',
              {style: {fontSize: 13, fontWeight: 700, color: '#111827', marginBottom: 8}},
              '10-Day Forecast',
            ),
            React.createElement(
              'div',
              {style: {display: 'flex', flexDirection: 'column', gap: 4}},
              (daily || []).map((d, i) =>
                React.createElement(
                  'div',
                  {
                    key: d.date,
                    style: {
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '6px 8px',
                      borderRadius: 6,
                      background: d.tempMin != null && d.tempMin <= 33 ? '#eff6ff' : i % 2 === 0 ? '#fafafa' : 'white',
                      fontSize: 13,
                    },
                  },
                  React.createElement(
                    'span',
                    {style: {width: 36, fontWeight: 600, color: '#374151'}},
                    i === 0 ? 'Today' : fmtDay(d.date),
                  ),
                  React.createElement('span', {style: {width: 24, textAlign: 'center'}}, weatherIcon(d.weatherCodeMax)),
                  React.createElement(
                    'span',
                    {style: {width: 60, textAlign: 'right', color: '#111827', fontWeight: 600}},
                    Math.round(d.tempMax) + '°/' + Math.round(d.tempMin) + '°',
                  ),
                  d.precipProbMax > 10 &&
                    React.createElement(
                      'span',
                      {style: {fontSize: 11, color: '#2563eb', fontWeight: 600, width: 40, textAlign: 'right'}},
                      Math.round(d.precipProbMax) + '%',
                    ),
                  d.tempMin != null &&
                    d.tempMin <= 33 &&
                    React.createElement(
                      'span',
                      {
                        style: {
                          fontSize: 10,
                          fontWeight: 700,
                          color: '#1e40af',
                          background: '#dbeafe',
                          padding: '1px 6px',
                          borderRadius: 4,
                          marginLeft: 'auto',
                        },
                      },
                      'Freeze',
                    ),
                ),
              ),
            ),
          ),

          // Radar
          React.createElement(
            'div',
            null,
            React.createElement(
              'div',
              {
                style: {
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginBottom: 8,
                },
              },
              React.createElement(
                'span',
                {style: {fontSize: 13, fontWeight: 700, color: '#111827'}},
                'Radar — Precipitation',
              ),
              React.createElement(
                'button',
                {
                  onClick: () => setRadarLoading((p) => !p),
                  style: {
                    background: 'none',
                    border: '1px solid #d1d5db',
                    borderRadius: 6,
                    padding: '3px 10px',
                    fontSize: 11,
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                  },
                },
                radarLoading ? 'Hide Radar' : 'Load Radar',
              ),
            ),
            radarLoading &&
              React.createElement(
                'div',
                {
                  style: {
                    position: 'relative',
                    width: '100%',
                    paddingBottom: '100%',
                    background: '#1a1a2e',
                    borderRadius: 10,
                    overflow: 'hidden',
                  },
                },
                React.createElement(
                  'div',
                  {
                    style: {
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      height: '100%',
                      display: 'grid',
                      gridTemplateColumns: 'repeat(3, 1fr)',
                      gridTemplateRows: 'repeat(3, 1fr)',
                    },
                  },
                  radarTiles.map((t) =>
                    React.createElement('img', {
                      key: `${t.z}-${t.x}-${t.y}`,
                      src: radarTileUrl(t.z, t.x, t.y),
                      alt: '',
                      style: {width: '100%', height: '100%', objectFit: 'cover', display: 'block'},
                      onError: (e) => {
                        e.target.style.display = 'none';
                      },
                    }),
                  ),
                ),
                React.createElement(
                  'div',
                  {
                    style: {
                      position: 'absolute',
                      bottom: 8,
                      left: 8,
                      fontSize: 10,
                      color: 'rgba(255,255,255,.6)',
                    },
                  },
                  (loc.label || 'Farm') + ' area',
                ),
              ),
          ),
        ),
      ),
  );
}
