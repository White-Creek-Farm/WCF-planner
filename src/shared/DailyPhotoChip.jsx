// Camera-icon-with-count badge rendered on daily-report list tiles. No
// thumbnails here — list views can hold hundreds of rows and we don't want
// a thumbnail storm. Thumbnails live in the edit/detail modal via
// DailyPhotoThumbnails.

import React from 'react';

export default function DailyPhotoChip({photos}) {
  const count = Array.isArray(photos) ? photos.length : 0;
  if (count === 0) return null;
  return (
    <span
      data-photo-chip="1"
      data-photo-count={count}
      title={count + ' photo' + (count === 1 ? '' : 's')}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 3,
        fontSize: 10,
        fontWeight: 700,
        padding: '1px 6px',
        borderRadius: 10,
        background: '#eef2ff',
        color: '#4338ca',
        border: '1px solid #c7d2fe',
        flexShrink: 0,
      }}
    >
      📷 {count}
    </span>
  );
}
