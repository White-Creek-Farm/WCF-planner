import {describe, it, expect} from 'vitest';
import {NEWSLETTER_BLOCK_TYPES, isAllowedBlockType, renderNewsletterBlock} from './NewsletterBlocks.jsx';

// The renderer is the security boundary between AI/admin content and the DOM:
// only whitelisted structured blocks render, text is passed as React children
// (auto-escaped), and unknown/malformed blocks render nothing. No block path
// uses dangerouslySetInnerHTML.

const ctx = {photosById: new Map(), urlFor: (p) => `https://cdn.example/${p}`};

// Recursively assert no element in the tree carries dangerouslySetInnerHTML.
function assertNoRawHtml(node) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) return node.forEach(assertNoRawHtml);
  if (node.props) {
    expect(node.props.dangerouslySetInnerHTML).toBeUndefined();
    assertNoRawHtml(node.props.children);
  }
}

describe('newsletter block whitelist', () => {
  it('exposes the frozen, known set of block types', () => {
    expect(NEWSLETTER_BLOCK_TYPES).toEqual([
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
    expect(Object.isFrozen(NEWSLETTER_BLOCK_TYPES)).toBe(true);
  });

  it('isAllowedBlockType accepts only whitelisted strings', () => {
    expect(isAllowedBlockType('paragraph')).toBe(true);
    expect(isAllowedBlockType('script')).toBe(false);
    expect(isAllowedBlockType('html')).toBe(false);
    expect(isAllowedBlockType(123)).toBe(false);
    expect(isAllowedBlockType(null)).toBe(false);
  });
});

describe('renderNewsletterBlock', () => {
  it('drops unknown and malformed blocks', () => {
    expect(renderNewsletterBlock({type: 'script', text: '<img onerror=steal()>'}, 0, ctx)).toBeNull();
    expect(renderNewsletterBlock({type: 'raw', html: '<b>x</b>'}, 0, ctx)).toBeNull();
    expect(renderNewsletterBlock(null, 0, ctx)).toBeNull();
    expect(renderNewsletterBlock('string-not-object', 0, ctx)).toBeNull();
    expect(renderNewsletterBlock({}, 0, ctx)).toBeNull();
  });

  it('renders a paragraph with text as escaped React children (never raw HTML)', () => {
    const el = renderNewsletterBlock({type: 'paragraph', text: '<script>steal()</script>'}, 0, ctx);
    expect(el).not.toBeNull();
    expect(el.type).toBe('p');
    // The string is a child of the element, not injected markup.
    expect(el.props.children).toBe('<script>steal()</script>');
    assertNoRawHtml(el);
  });

  it('honors heading level (h2 default, h3 when level=3)', () => {
    expect(renderNewsletterBlock({type: 'heading', text: 'A'}, 0, ctx).type).toBe('h2');
    expect(renderNewsletterBlock({type: 'heading', text: 'B', level: 3}, 0, ctx).type).toBe('h3');
  });

  it('drops empty text blocks', () => {
    expect(renderNewsletterBlock({type: 'paragraph', text: ''}, 0, ctx)).toBeNull();
    expect(renderNewsletterBlock({type: 'heading', text: '   '}, 0, ctx)).toBeNull();
    expect(renderNewsletterBlock({type: 'list', items: []}, 0, ctx)).toBeNull();
  });

  it('only renders photos that resolve to an approved photo row', () => {
    expect(renderNewsletterBlock({type: 'photo', photoId: 'missing'}, 0, ctx)).toBeNull();
    const withPhoto = {
      photosById: new Map([['p1', {id: 'p1', storagePath: 'newsletter/i/c.jpg', altText: 'alt'}]]),
      urlFor: ctx.urlFor,
    };
    expect(renderNewsletterBlock({type: 'photo', photoId: 'p1'}, 0, withPhoto)).not.toBeNull();
  });

  it('renders a divider', () => {
    expect(renderNewsletterBlock({type: 'divider'}, 0, ctx).type).toBe('hr');
  });
});
