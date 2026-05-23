// Netlify Function: RainViewer radar frame metadata proxy.
// Returns the most recent radar frame as "now" plus all available
// nowcast frames for forward-in-time animation.
// No API key required.

export async function handler() {
  try {
    const res = await fetch('https://api.rainviewer.com/public/weather-maps.json');
    if (!res.ok) {
      return {statusCode: 502, body: JSON.stringify({error: 'rainviewer_error'})};
    }
    const data = await res.json();
    const past = data.radar?.past || [];
    const nowcast = data.radar?.nowcast || [];
    const current = past.length > 0 ? past[past.length - 1] : null;
    const frames = [];
    if (current) frames.push({time: current.time, path: current.path});
    for (const f of nowcast) {
      frames.push({time: f.time, path: f.path});
    }

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=300, s-maxage=300',
      },
      body: JSON.stringify({host: data.host, radar: frames}),
    };
  } catch (e) {
    console.error('weather-radar-frames error:', e);
    return {statusCode: 500, body: JSON.stringify({error: 'internal'})};
  }
}
