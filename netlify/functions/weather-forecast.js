// Netlify Function: weather forecast proxy for Tomorrow.io.
// Returns normalized forecast JSON for the farm location.
// API key stays server-side via process.env.TOMORROW_IO_API_KEY.

const DEFAULT_LAT = '30.833938';
const DEFAULT_LON = '-86.430030';
const DEFAULT_LABEL = 'WCF';

export async function handler() {
  const apiKey = process.env.TOMORROW_IO_API_KEY;
  if (!apiKey) {
    return {statusCode: 503, body: JSON.stringify({error: 'weather_unavailable', message: 'Weather not configured'})};
  }

  const lat = process.env.WCF_WEATHER_LAT || DEFAULT_LAT;
  const lon = process.env.WCF_WEATHER_LON || DEFAULT_LON;
  const label = process.env.WCF_WEATHER_LABEL || DEFAULT_LABEL;
  const location = `${lat},${lon}`;

  try {
    const url =
      `https://api.tomorrow.io/v4/weather/forecast?location=${encodeURIComponent(location)}` +
      `&timesteps=1h,1d&units=imperial&apikey=${apiKey}`;

    const res = await fetch(url);
    if (!res.ok) {
      const text = await res.text();
      console.error('Tomorrow.io error:', res.status, text);
      return {statusCode: 502, body: JSON.stringify({error: 'upstream_error', message: 'Forecast provider error'})};
    }

    const raw = await res.json();
    const normalized = normalize(raw, {lat: parseFloat(lat), lon: parseFloat(lon), label});

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=1800, s-maxage=1800',
      },
      body: JSON.stringify(normalized),
    };
  } catch (e) {
    console.error('weather-forecast error:', e);
    return {statusCode: 500, body: JSON.stringify({error: 'internal', message: 'Weather fetch failed'})};
  }
}

function normalize(raw, loc) {
  const hourly = (raw.timelines?.hourly || []).slice(0, 48).map((h) => ({
    time: h.time,
    temp: round1(h.values?.temperature),
    humidity: round1(h.values?.humidity),
    precipProb: round1(h.values?.precipitationProbability),
    precipIntensity: round2(h.values?.precipitationIntensity),
    windSpeed: round1(h.values?.windSpeed),
    windGust: round1(h.values?.windGust),
    weatherCode: h.values?.weatherCode,
  }));

  const daily = (raw.timelines?.daily || []).slice(0, 10).map((d) => ({
    date: d.time ? d.time.split('T')[0] : null,
    tempMax: round1(d.values?.temperatureMax),
    tempMin: round1(d.values?.temperatureMin),
    precipProbMax: round1(d.values?.precipitationProbabilityMax),
    precipProbAvg: round1(d.values?.precipitationProbabilityAvg),
    weatherCodeMax: d.values?.weatherCodeMax,
    windSpeedMax: round1(d.values?.windSpeedMax),
    sunriseTime: d.values?.sunriseTime,
    sunsetTime: d.values?.sunsetTime,
  }));

  const now = hourly[0] || null;
  const today = daily[0] || null;

  let rainSummary = 'No rain expected today';
  if (today && today.precipProbMax > 30) {
    const rainHours = hourly.filter((h) => {
      if (!h.time || !today.date) return false;
      return h.time.startsWith(today.date) && h.precipProb > 30;
    });
    if (rainHours.length > 0) {
      const firstHour = new Date(rainHours[0].time).getHours();
      const maxProb = Math.max(...rainHours.map((h) => h.precipProb));
      const likelihood = maxProb > 70 ? 'likely' : 'possible';
      if (firstHour < 6) rainSummary = `Rain ${likelihood} early morning`;
      else if (firstHour < 12) rainSummary = `Rain ${likelihood} this morning`;
      else if (firstHour < 17) rainSummary = `Rain ${likelihood} after ${formatHour(firstHour)}`;
      else if (firstHour < 21) rainSummary = `Rain ${likelihood} this evening`;
      else rainSummary = `Showers ${likelihood} overnight`;
    }
  }

  let freezeWarning = null;
  for (const d of daily.slice(0, 3)) {
    if (d.tempMin != null && d.tempMin <= 33) {
      const dayLabel = d.date === today?.date ? 'tonight' : formatDayLabel(d.date);
      freezeWarning = `Low near ${Math.round(d.tempMin)}° ${dayLabel}`;
      break;
    }
  }

  return {
    location: loc,
    current: now
      ? {temp: now.temp, humidity: now.humidity, windSpeed: now.windSpeed, weatherCode: now.weatherCode}
      : null,
    today: today ? {high: today.tempMax, low: today.tempMin, precipProb: today.precipProbMax} : null,
    rainSummary,
    freezeWarning,
    daily,
    hourly,
    fetchedAt: new Date().toISOString(),
  };
}

function round1(v) {
  return v != null ? Math.round(v * 10) / 10 : null;
}
function round2(v) {
  return v != null ? Math.round(v * 100) / 100 : null;
}
function formatHour(h) {
  const suffix = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return `${h12} ${suffix}`;
}
function formatDayLabel(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'T12:00:00');
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  return days[d.getDay()] || '';
}
