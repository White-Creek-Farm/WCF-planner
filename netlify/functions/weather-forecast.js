// Netlify Function: weather forecast proxy.
// Current + hourly from Tomorrow.io (rain timing, radar).
// 10-day daily from Open-Meteo (free, no key, reliable 10 rows).
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
  const loc = {lat: parseFloat(lat), lon: parseFloat(lon), label};

  try {
    const [tomorrowRes, openMeteoDaily] = await Promise.all([
      fetchTomorrow(lat, lon, apiKey),
      fetchOpenMeteoDaily(lat, lon),
    ]);

    if (!tomorrowRes) {
      return {statusCode: 502, body: JSON.stringify({error: 'upstream_error', message: 'Forecast provider error'})};
    }

    const normalized = normalize(tomorrowRes, openMeteoDaily, loc);

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

async function fetchTomorrow(lat, lon, apiKey) {
  const url =
    `https://api.tomorrow.io/v4/weather/forecast?location=${encodeURIComponent(lat + ',' + lon)}` +
    `&timesteps=1h,1d&units=imperial&apikey=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) {
    console.error('Tomorrow.io error:', res.status, await res.text());
    return null;
  }
  return res.json();
}

async function fetchOpenMeteoDaily(lat, lon) {
  try {
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code,wind_speed_10m_max,sunrise,sunset` +
      `&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=America%2FChicago&forecast_days=10`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const raw = await res.json();
    const d = raw.daily;
    if (!d || !d.time) return null;
    return d.time.map((date, i) => ({
      date,
      tempMax: round1(d.temperature_2m_max?.[i]),
      tempMin: round1(d.temperature_2m_min?.[i]),
      precipProbMax: round1(d.precipitation_probability_max?.[i]),
      weatherCodeMax: mapWmoToTomorrow(d.weather_code?.[i]),
      windSpeedMax: round1(d.wind_speed_10m_max?.[i]),
      sunriseTime: d.sunrise?.[i] || null,
      sunsetTime: d.sunset?.[i] || null,
    }));
  } catch (e) {
    console.error('Open-Meteo error:', e);
    return null;
  }
}

function normalize(raw, openMeteoDaily, loc) {
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

  const tomorrowDaily = (raw.timelines?.daily || []).map((d) => ({
    date: d.time ? d.time.split('T')[0] : null,
    tempMax: round1(d.values?.temperatureMax),
    tempMin: round1(d.values?.temperatureMin),
    precipProbMax: round1(d.values?.precipitationProbabilityMax),
    weatherCodeMax: d.values?.weatherCodeMax,
    windSpeedMax: round1(d.values?.windSpeedMax),
    sunriseTime: d.values?.sunriseTime,
    sunsetTime: d.values?.sunsetTime,
  }));

  const daily = openMeteoDaily && openMeteoDaily.length >= 10 ? openMeteoDaily : tomorrowDaily;
  const dailySource = openMeteoDaily && openMeteoDaily.length >= 10 ? 'open-meteo' : 'tomorrow';

  const now = hourly[0] || null;
  const today = daily[0] || null;

  let rainSummary = 'No rain expected today';
  if (today && today.precipProbMax > 30) {
    const todayDate = today.date;
    const rainHours = hourly.filter((h) => {
      if (!h.time || !todayDate) return false;
      return h.time.startsWith(todayDate) && h.precipProb > 30;
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
    dailySource,
    hourly,
    fetchedAt: new Date().toISOString(),
  };
}

// WMO weather codes (Open-Meteo) → Tomorrow.io codes for icon/label reuse.
function mapWmoToTomorrow(wmo) {
  if (wmo == null) return 0;
  if (wmo === 0) return 1000;
  if (wmo <= 1) return 1100;
  if (wmo === 2) return 1101;
  if (wmo === 3) return 1001;
  if (wmo >= 45 && wmo <= 48) return 2000;
  if (wmo >= 51 && wmo <= 55) return 4000;
  if (wmo >= 56 && wmo <= 57) return 6000;
  if (wmo >= 61 && wmo <= 63) return 4001;
  if (wmo === 65) return 4201;
  if (wmo >= 66 && wmo <= 67) return 6001;
  if (wmo >= 71 && wmo <= 75) return 5000;
  if (wmo === 77) return 7000;
  if (wmo >= 80 && wmo <= 82) return 4001;
  if (wmo >= 85 && wmo <= 86) return 5100;
  if (wmo >= 95 && wmo <= 99) return 8000;
  return 1001;
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
