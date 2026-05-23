// Netlify Function: RainViewer radar frame metadata proxy.
// Fetches and caches the current radar frame list from RainViewer.
// No API key required.

export async function handler() {
  try {
    const res = await fetch('https://api.rainviewer.com/public/weather-maps.json');
    if (!res.ok) {
      return {statusCode: 502, body: JSON.stringify({error: 'rainviewer_error'})};
    }
    const data = await res.json();
    const radar = (data.radar?.past || []).slice(-8).map((f) => ({
      time: f.time,
      path: f.path,
    }));
    const nowcast = (data.radar?.nowcast || []).slice(0, 2).map((f) => ({
      time: f.time,
      path: f.path,
    }));

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=300, s-maxage=300',
      },
      body: JSON.stringify({host: data.host, radar: [...radar, ...nowcast]}),
    };
  } catch (e) {
    console.error('weather-radar-frames error:', e);
    return {statusCode: 500, body: JSON.stringify({error: 'internal'})};
  }
}
