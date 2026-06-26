// Structured-block renderer for the public newsletter.
//
// SECURITY: the AI generator and admin editor produce STRUCTURED blocks, never
// HTML. This renderer renders a fixed WHITELIST of known block types and emits
// only React text children (auto-escaped). There is no dangerouslySetInnerHTML
// anywhere in the newsletter surface — an unknown or malformed block renders
// nothing rather than leaking raw markup. This is the contract enforced by
// tests/static/newsletter_renderer_whitelist_static.test.js.

// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import React from 'react';

// The complete set of renderable block types. Anything outside this list is
// dropped. Keep in sync with the admin editor's block palette and the Edge
// Function's allowed output schema.
export const NEWSLETTER_BLOCK_TYPES = Object.freeze([
  'heading',
  'paragraph',
  'list',
  'stats',
  'quote',
  'callout',
  'photo',
  'gallery',
  'divider',
]);

const ALLOWED = new Set(NEWSLETTER_BLOCK_TYPES);

export function isAllowedBlockType(type) {
  return typeof type === 'string' && ALLOWED.has(type);
}

// Coerce to a trimmed display string. Non-strings (objects, arrays, numbers
// passed where text is expected) collapse to '' so nothing odd renders.
function asText(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return '';
}

function asStringArray(v) {
  return Array.isArray(v) ? v.map(asText).filter((s) => s.length > 0) : [];
}

// eslint-disable-next-line no-unused-vars -- JSX-only use (rendered as <PhotoFigure/>)
function PhotoFigure({photo, urlFor, caption}) {
  if (!photo) return null;
  const src = urlFor(photo.storagePath);
  if (!src) return null;
  const cap = asText(caption) || asText(photo.caption);
  const credit = asText(photo.creditFirstName);
  return (
    <figure className="nl-figure">
      <img className="nl-photo" src={src} alt={asText(photo.altText) || cap || 'Farm photo'} loading="lazy" />
      {(cap || credit) && (
        <figcaption className="nl-figcaption">
          {cap}
          {credit ? (
            <span className="nl-credit">
              {cap ? ' — ' : ''}Photo: {credit}
            </span>
          ) : null}
        </figcaption>
      )}
    </figure>
  );
}

// Render a single whitelisted block. `photosById` maps approved photo id ->
// photo row; `urlFor` turns a storage path into a public URL. Unknown types and
// malformed payloads return null.
export function renderNewsletterBlock(block, idx, {photosById, urlFor}) {
  if (!block || typeof block !== 'object' || !isAllowedBlockType(block.type)) return null;
  const key = `b${idx}`;

  switch (block.type) {
    case 'heading': {
      const text = asText(block.text);
      if (!text.trim()) return null;
      const level = block.level === 3 ? 3 : 2;
      return level === 3 ? (
        <h3 key={key} className="nl-h3">
          {text}
        </h3>
      ) : (
        <h2 key={key} className="nl-h2">
          {text}
        </h2>
      );
    }
    case 'paragraph': {
      const text = asText(block.text);
      if (!text.trim()) return null;
      return (
        <p key={key} className="nl-p">
          {text}
        </p>
      );
    }
    case 'list': {
      const items = asStringArray(block.items);
      if (items.length === 0) return null;
      // eslint-disable-next-line no-unused-vars -- JSX-only use (rendered as <ListTag>)
      const ListTag = block.ordered ? 'ol' : 'ul';
      return (
        <ListTag key={key} className="nl-list">
          {items.map((it, i) => (
            <li key={i}>{it}</li>
          ))}
        </ListTag>
      );
    }
    case 'stats': {
      const items = Array.isArray(block.items)
        ? block.items
            .map((it) => ({label: asText(it && it.label), value: asText(it && it.value)}))
            .filter((it) => it.value)
        : [];
      if (items.length === 0) return null;
      return (
        <div key={key} className="nl-stats">
          {items.map((it, i) => (
            <div key={i} className="nl-stat">
              <div className="nl-stat-value">{it.value}</div>
              {it.label ? <div className="nl-stat-label">{it.label}</div> : null}
            </div>
          ))}
        </div>
      );
    }
    case 'quote': {
      const text = asText(block.text);
      if (!text.trim()) return null;
      const attribution = asText(block.attribution);
      return (
        <blockquote key={key} className="nl-quote">
          <p>{text}</p>
          {attribution ? <cite className="nl-cite">— {attribution}</cite> : null}
        </blockquote>
      );
    }
    case 'callout': {
      const text = asText(block.text);
      if (!text.trim()) return null;
      const tone = block.tone === 'note' ? 'note' : 'good';
      return (
        <div key={key} className={`nl-callout nl-callout-${tone}`}>
          {text}
        </div>
      );
    }
    case 'photo': {
      const photo = photosById && photosById.get ? photosById.get(block.photoId) : null;
      if (!photo) return null;
      return <PhotoFigure key={key} photo={photo} urlFor={urlFor} caption={block.caption} />;
    }
    case 'gallery': {
      const ids = Array.isArray(block.photoIds) ? block.photoIds : [];
      const photos = ids.map((id) => (photosById && photosById.get ? photosById.get(id) : null)).filter(Boolean);
      if (photos.length === 0) return null;
      return (
        <div key={key} className="nl-gallery">
          {photos.map((p) => (
            <PhotoFigure key={p.id} photo={p} urlFor={urlFor} caption={p.caption} />
          ))}
        </div>
      );
    }
    case 'divider':
      return <hr key={key} className="nl-divider" />;
    default:
      return null;
  }
}

// Render a payload's block list. `payload` is the sanitized render payload
// (`{ payload: { blocks: [...] }, photos: [...] }`). Everything is defensive:
// a missing/empty block list renders nothing.
export default function NewsletterBlocks({blocks, photosById, urlFor}) {
  const list = Array.isArray(blocks) ? blocks : [];
  if (list.length === 0) return null;
  return <>{list.map((block, idx) => renderNewsletterBlock(block, idx, {photosById, urlFor}))}</>;
}
