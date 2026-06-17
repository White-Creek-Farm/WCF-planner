import React from 'react';
import {
  loadForecast,
  loadRadarFrames,
  weatherIcon,
  weatherLabel,
  rainviewerTileUrl,
  latLonToTile,
} from '../lib/weather.js';

export default function HomeWeatherCard() {
  const [forecast, setForecast] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [expanded, setExpanded] = React.useState(false);
  const [radarOpen, setRadarOpen] = React.useState(false);
  const [radarFrames, setRadarFrames] = React.useState(null);
  const [radarError, setRadarError] = React.useState(false);
  const [frameIdx, setFrameIdx] = React.useState(0);
  const [playing, setPlaying] = React.useState(false);
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

  async function handleLoadRadar() {
    setRadarOpen(true);
    setRadarError(false);
    try {
      const data = await loadRadarFrames();
      if (!data || !data.radar || data.radar.length === 0) {
        setRadarError(true);
        return;
      }
      setRadarFrames(data);
      setFrameIdx(0);
      setPlaying(true);
    } catch (_e) {
      setRadarError(true);
    }
  }

  React.useEffect(() => {
    if (!playing || !radarFrames) return;
    const total = radarFrames.radar.length;
    setFrameIdx(0);
    const timer = setInterval(() => {
      setFrameIdx((i) => {
        const next = i + 1;
        return next >= total ? 0 : next;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [playing, radarFrames]);

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

  const nowMs = Date.now();
  const end48h = nowMs + 48 * 3600 * 1000;
  const rainHours = (hourly || []).filter((h) => {
    if (!h.time) return false;
    const t = new Date(h.time).getTime();
    return t >= nowMs && t <= end48h;
  });

  const loc = forecast.location || {};
  const ZOOM = 7;
  const farmTile = loc.lat && loc.lon ? latLonToTile(loc.lat, loc.lon, ZOOM) : null;
  const radarTiles = [];
  if (farmTile) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        radarTiles.push({x: farmTile.x + dx, y: farmTile.y + dy, z: ZOOM});
      }
    }
  }
  const osmTileUrl = (t) => `https://tile.openstreetmap.org/${t.z}/${t.x}/${t.y}.png`;
  const currentFrame = radarFrames && radarFrames.radar[frameIdx];
  const frameTimeLabel = currentFrame
    ? (() => {
        const d = new Date(currentFrame.time * 1000);
        const h = d.getHours();
        const m = d.getMinutes();
        const suffix = h >= 12 ? 'PM' : 'AM';
        const h12 = h % 12 || 12;
        return `${h12}:${String(m).padStart(2, '0')} ${suffix}`;
      })()
    : '';
  const dailyLabel =
    forecast.dailySource === 'open-meteo' || (daily && daily.length >= 10)
      ? '10-Day Forecast'
      : (daily ? daily.length : 0) + '-Day Forecast';

  return React.createElement(
    'div',
    null,
    // ── Collapsed card ──
    // Approved home treatment: a real <button> carrying the design's
    // `card weather-card lift` classes (homeRedesign.css owns the surface,
    // border, radius, shadow, and hover lift; native button semantics give
    // keyboard activation). flexWrap stays inline so the rain summary and
    // freeze badge can wrap on narrow screens; width/text props neutralize
    // button UA defaults inside the flex card.
    React.createElement(
      'button',
      {
        type: 'button',
        onClick: () => setExpanded(true),
        'data-weather-card': 'collapsed',
        className: 'card weather-card lift',
        style: {
          width: '100%',
          textAlign: 'left',
          color: 'inherit',
          flexWrap: 'wrap',
        },
      },
      React.createElement('span', {style: {fontSize: 22}}, weatherIcon(current.weatherCode)),
      React.createElement(
        'span',
        {style: {fontSize: 20, fontWeight: 700, color: '#000000'}},
        Math.round(current.temp) + '°',
      ),
      React.createElement(
        'span',
        {style: {fontSize: 12, color: 'var(--text-muted)'}},
        'H:' + Math.round(today.high) + '° L:' + Math.round(today.low) + '°',
      ),
      today.precipProb > 10 &&
        React.createElement(
          'span',
          {style: {fontSize: 12, color: '#2563eb', fontWeight: 600}},
          Math.round(today.precipProb) + '% rain',
        ),
      React.createElement('span', {style: {fontSize: 12, color: '#000000', flex: 1, minWidth: 120}}, rainSummary),
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
              borderRadius: 10,
            },
          },
          freezeWarning,
        ),
      // Hover-revealed chevron (design `.go` affordance inside `.lift`).
      React.createElement(
        'svg',
        {
          className: 'go',
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 2.2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        React.createElement('path', {d: 'M9 6l6 6-6 6'}),
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
              {style: {fontSize: 18, fontWeight: 700, color: '#000000'}},
              weatherIcon(current.weatherCode) + ' ' + Math.round(current.temp) + '°F',
              React.createElement(
                'span',
                {style: {fontSize: 13, fontWeight: 400, color: 'var(--text-muted)', marginLeft: 8}},
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
                    borderRadius: 10,
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
                    color: 'var(--text-muted)',
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
                color: '#000000',
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

          // Hourly rain timing — stable 48-slot grid
          React.createElement(
            'div',
            {style: {marginBottom: 16}},
            React.createElement(
              'div',
              {style: {fontSize: 13, fontWeight: 700, color: '#000000', marginBottom: 8}},
              'Rain Timing — Next 48h',
            ),
            React.createElement(
              'div',
              {'data-weather-rain-chart': true, style: {overflowX: 'auto', WebkitOverflowScrolling: 'touch'}},
              React.createElement(
                'div',
                {
                  style: {
                    display: 'grid',
                    gridTemplateColumns: 'repeat(48, minmax(0, 1fr))',
                    minWidth: 360,
                    height: 32,
                    gap: 1,
                  },
                },
                Array.from({length: 48}, (_, i) => {
                  const h = rainHours[i];
                  const prob = h ? h.precipProb || 0 : 0;
                  return React.createElement('div', {
                    key: i,
                    title: h ? fmtHour(h.time) + ': ' + Math.round(prob) + '%' : '',
                    style: {
                      borderRadius: 1 /* radius-allow: thin rain-probability bar in dense 48-cell grid */,
                      background: prob > 70 ? '#2563eb' : prob > 40 ? '#60a5fa' : prob > 20 ? '#bfdbfe' : '#f3f4f6',
                    },
                  });
                }),
              ),
              React.createElement(
                'div',
                {
                  style: {
                    display: 'flex',
                    justifyContent: 'space-between',
                    fontSize: 10,
                    color: 'var(--text-muted)',
                    marginTop: 2,
                    minWidth: 360,
                  },
                },
                React.createElement('span', null, 'Now'),
                React.createElement('span', null, '+24h'),
                React.createElement('span', null, '+48h'),
              ),
            ),
          ),

          // 10-day forecast
          React.createElement(
            'div',
            {style: {marginBottom: 16}},
            React.createElement(
              'div',
              {style: {fontSize: 13, fontWeight: 700, color: '#000000', marginBottom: 8}},
              dailyLabel,
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
                      borderRadius: 10,
                      background: d.tempMin != null && d.tempMin <= 33 ? '#eff6ff' : i % 2 === 0 ? '#fafafa' : 'white',
                      fontSize: 13,
                    },
                  },
                  React.createElement(
                    'span',
                    {style: {width: 36, fontWeight: 600, color: '#000000'}},
                    i === 0 ? 'Today' : fmtDay(d.date),
                  ),
                  React.createElement('span', {style: {width: 24, textAlign: 'center'}}, weatherIcon(d.weatherCodeMax)),
                  React.createElement(
                    'span',
                    {style: {width: 60, textAlign: 'right', color: '#000000', fontWeight: 600}},
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
                          borderRadius: 10,
                          marginLeft: 'auto',
                        },
                      },
                      'Freeze',
                    ),
                ),
              ),
            ),
          ),

          // Radar — RainViewer animated
          React.createElement(
            'div',
            null,
            React.createElement(
              'div',
              {style: {display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8}},
              React.createElement('span', {style: {fontSize: 13, fontWeight: 700, color: '#000000'}}, 'Radar'),
              !radarOpen
                ? React.createElement(
                    'button',
                    {
                      onClick: handleLoadRadar,
                      style: {
                        background: 'none',
                        border: '1px solid #d1d5db',
                        borderRadius: 10,
                        padding: '3px 10px',
                        fontSize: 11,
                        cursor: 'pointer',
                        fontFamily: 'inherit',
                      },
                    },
                    'Load Radar',
                  )
                : React.createElement(
                    'div',
                    {style: {display: 'flex', gap: 6, alignItems: 'center'}},
                    radarFrames &&
                      React.createElement(
                        'button',
                        {
                          onClick: () => setPlaying((p) => !p),
                          style: {
                            background: 'none',
                            border: '1px solid #d1d5db',
                            borderRadius: 10,
                            padding: '3px 10px',
                            fontSize: 11,
                            cursor: 'pointer',
                            fontFamily: 'inherit',
                          },
                        },
                        playing ? 'Pause' : 'Play',
                      ),
                    radarFrames &&
                      React.createElement(
                        'span',
                        {style: {fontSize: 11, color: 'var(--text-muted)', minWidth: 40}},
                        frameTimeLabel,
                      ),
                    React.createElement(
                      'button',
                      {
                        onClick: () => {
                          setRadarOpen(false);
                          setPlaying(false);
                          setRadarFrames(null);
                        },
                        style: {
                          background: 'none',
                          border: '1px solid #d1d5db',
                          borderRadius: 10,
                          padding: '3px 10px',
                          fontSize: 11,
                          cursor: 'pointer',
                          fontFamily: 'inherit',
                        },
                      },
                      'Hide',
                    ),
                  ),
            ),
            radarOpen &&
              radarError &&
              React.createElement(
                'div',
                {style: {fontSize: 12, color: 'var(--text-muted)', padding: '16px 0'}},
                'Radar unavailable',
              ),
            radarOpen &&
              radarFrames &&
              farmTile &&
              React.createElement(
                'div',
                null,
                React.createElement(
                  'div',
                  {
                    style: {
                      position: 'relative',
                      width: '100%',
                      paddingBottom: '100%',
                      borderRadius: 10,
                      overflow: 'hidden',
                      background: '#e5e7eb',
                    },
                  },
                  // OSM base
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
                        key: `osm-${t.x}-${t.y}`,
                        src: osmTileUrl(t),
                        alt: '',
                        style: {width: '100%', height: '100%', objectFit: 'cover', display: 'block'},
                        onError: (e) => {
                          e.target.style.opacity = 0;
                        },
                      }),
                    ),
                  ),
                  // RainViewer precipitation overlay
                  currentFrame &&
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
                          opacity: 0.7,
                        },
                      },
                      radarTiles.map((t) =>
                        React.createElement('img', {
                          key: `rv-${t.x}-${t.y}-${currentFrame.time}`,
                          src: rainviewerTileUrl(radarFrames.host, currentFrame.path, t.z, t.x, t.y),
                          alt: '',
                          style: {width: '100%', height: '100%', objectFit: 'cover', display: 'block'},
                          onError: (e) => {
                            e.target.style.display = 'none';
                          },
                        }),
                      ),
                    ),
                  // Center marker
                  React.createElement('div', {
                    style: {
                      position: 'absolute',
                      top: '50%',
                      left: '50%',
                      transform: 'translate(-50%, -50%)',
                      width: 12,
                      height: 12,
                      borderRadius: '50%',
                      background: '#dc2626',
                      border: '2px solid white',
                      boxShadow: '0 0 4px rgba(0,0,0,.5)',
                      zIndex: 2,
                    },
                  }),
                  // Label
                  React.createElement(
                    'div',
                    {
                      style: {
                        position: 'absolute',
                        bottom: 8,
                        left: 8,
                        fontSize: 10,
                        color: '#000000',
                        background: 'rgba(255,255,255,.8)',
                        padding: '2px 6px',
                        borderRadius: 10,
                        zIndex: 2,
                      },
                    },
                    (loc.label || 'Farm') + ' area',
                  ),
                ),
                // Legend + attribution
                React.createElement(
                  'div',
                  {
                    style: {
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      marginTop: 6,
                      flexWrap: 'wrap',
                      gap: 4,
                    },
                  },
                  React.createElement(
                    'div',
                    {style: {display: 'flex', gap: 10, fontSize: 10, color: 'var(--text-muted)'}},
                    React.createElement(
                      'span',
                      null,
                      React.createElement('span', {
                        style: {
                          display: 'inline-block',
                          width: 8,
                          height: 8,
                          borderRadius: '50%',
                          background: '#22c55e',
                          marginRight: 3,
                        },
                      }),
                      'Light',
                    ),
                    React.createElement(
                      'span',
                      null,
                      React.createElement('span', {
                        style: {
                          display: 'inline-block',
                          width: 8,
                          height: 8,
                          borderRadius: '50%',
                          background: '#eab308',
                          marginRight: 3,
                        },
                      }),
                      'Moderate',
                    ),
                    React.createElement(
                      'span',
                      null,
                      React.createElement('span', {
                        style: {
                          display: 'inline-block',
                          width: 8,
                          height: 8,
                          borderRadius: '50%',
                          background: '#dc2626',
                          marginRight: 3,
                        },
                      }),
                      'Heavy',
                    ),
                  ),
                  React.createElement(
                    'span',
                    {style: {fontSize: 9, color: 'var(--text-muted)'}},
                    '© OpenStreetMap · Weather data by RainViewer',
                  ),
                ),
              ),
          ),
        ),
      ),
  );
}
