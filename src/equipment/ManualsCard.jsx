// Expandable "Manuals & Videos" card used on both /fueling/<slug> and
// /equipment/<slug>. Collapsed by default; operator taps the header to
// expand. Hidden entirely when the piece has no manuals. PDFs open in a new
// tab; YouTube videos show a thumbnail that links out (no inline player —
// too much space on mobile, and saves bandwidth).

import React from 'react';

function youtubeId(url) {
  if (!url) return null;
  const patterns = [
    /youtu\.be\/([A-Za-z0-9_-]{6,})/,
    /youtube\.com\/watch\?.*v=([A-Za-z0-9_-]{6,})/,
    /youtube\.com\/embed\/([A-Za-z0-9_-]{6,})/,
    /youtube\.com\/shorts\/([A-Za-z0-9_-]{6,})/,
  ];
  for (const re of patterns) {
    const m = re.exec(url);
    if (m) return m[1];
  }
  return null;
}

export default function ManualsCard({equipment}) {
  const [open, setOpen] = React.useState(false);
  const manuals = Array.isArray(equipment?.manuals) ? equipment.manuals : [];
  const pdfs = manuals.filter((m) => m.type === 'pdf');
  const videos = manuals.filter((m) => m.type === 'video');
  const isEmpty = manuals.length === 0;

  return (
    <div
      style={{background: 'white', border: '1px solid #e5e7eb', borderRadius: 12, marginBottom: 12, overflow: 'hidden'}}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{
          width: '100%',
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          padding: '12px 16px',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          fontFamily: 'inherit',
          textAlign: 'left',
        }}
      >
        <span style={{fontSize: 16}}>📖</span>
        <span style={{flex: 1, fontSize: 13, fontWeight: 700, color: '#4b5563'}}>
          Manuals &amp; Videos{' '}
          <span style={{color: '#9ca3af', fontWeight: 500, marginLeft: 6}}>({manuals.length})</span>
        </span>
        <span style={{fontSize: 12, color: '#9ca3af'}}>{open ? '▾' : '▸'}</span>
      </button>
      {open && isEmpty && (
        <div style={{padding: '0 16px 14px'}}>
          <div
            style={{
              fontSize: 12,
              color: '#9ca3af',
              fontStyle: 'italic',
              padding: '10px 12px',
              background: '#fafafa',
              borderRadius: 6,
              border: '1px dashed #e5e7eb',
            }}
          >
            No instructional manuals or videos added for this piece yet. Admins can add them via{' '}
            <code style={{background: 'white', padding: '1px 5px', borderRadius: 3, border: '1px solid #e5e7eb'}}>
              /admin
            </code>{' '}
            → Equipment → (click piece) → Manuals &amp; Videos.
          </div>
        </div>
      )}
      {open && !isEmpty && (
        <div style={{padding: '0 16px 14px'}}>
          {pdfs.length > 0 && (
            <div style={{marginBottom: videos.length > 0 ? 12 : 0}}>
              <div
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  color: '#92400e',
                  textTransform: 'uppercase',
                  letterSpacing: 0.4,
                  marginBottom: 6,
                }}
              >
                Manuals &amp; PDFs
              </div>
              <div style={{display: 'flex', flexDirection: 'column', gap: 5}}>
                {pdfs.map((m, i) => (
                  <a
                    key={i}
                    href={m.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      padding: '8px 10px',
                      background: '#fffbeb',
                      border: '1px solid #fde68a',
                      borderRadius: 6,
                      textDecoration: 'none',
                      color: '#92400e',
                      fontSize: 13,
                    }}
                  >
                    <span style={{fontSize: 16}}>📄</span>
                    <span style={{fontWeight: 600, flex: 1}}>{m.title || 'Untitled PDF'}</span>
                    <span style={{fontSize: 10, color: '#a16207'}}>Open ↗</span>
                  </a>
                ))}
              </div>
            </div>
          )}
          {videos.length > 0 && (
            <div>
              <div
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  color: '#991b1b',
                  textTransform: 'uppercase',
                  letterSpacing: 0.4,
                  marginBottom: 6,
                }}
              >
                Videos
              </div>
              <div style={{display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 8}}>
                {videos.map((m, i) => {
                  const vid = m.youtube_id || youtubeId(m.url);
                  const thumb = vid ? `https://img.youtube.com/vi/${vid}/hqdefault.jpg` : null;
                  return (
                    <a
                      key={i}
                      href={m.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{
                        display: 'block',
                        background: '#fef2f2',
                        border: '1px solid #fecaca',
                        borderRadius: 6,
                        overflow: 'hidden',
                        textDecoration: 'none',
                        color: '#991b1b',
                      }}
                    >
                      {thumb ? (
                        <div style={{position: 'relative', width: '100%', paddingBottom: '56.25%', background: '#111'}}>
                          <img
                            src={thumb}
                            alt=""
                            aria-hidden="true"
                            style={{
                              position: 'absolute',
                              top: 0,
                              left: 0,
                              width: '100%',
                              height: '100%',
                              objectFit: 'cover',
                            }}
                          />
                          <div
                            style={{
                              position: 'absolute',
                              top: '50%',
                              left: '50%',
                              transform: 'translate(-50%,-50%)',
                              width: 46,
                              height: 46,
                              borderRadius: 23,
                              background: 'rgba(0,0,0,.65)',
                              color: 'white',
                              fontSize: 22,
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              paddingLeft: 3,
                            }}
                          >
                            ▶
                          </div>
                        </div>
                      ) : (
                        <div style={{padding: '18px 12px', textAlign: 'center', background: '#fafafa'}}>▶</div>
                      )}
                      <div style={{padding: '8px 10px', fontSize: 12, fontWeight: 600}}>
                        {m.title || 'YouTube video'}
                      </div>
                    </a>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
