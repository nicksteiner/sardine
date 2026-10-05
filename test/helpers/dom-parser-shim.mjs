/**
 * dom-parser-shim.mjs — just enough `DOMParser` for @developmentseed/geotiff
 * to run under Node. Its GDAL_METADATA parser only needs the root tag name
 * and `<Item name=… sample=…>text</Item>` elements, so a regex walk over the
 * flat tag list is sufficient. Import for its side effect before opening a
 * GeoTIFF in a test or benchmark.
 */
if (typeof globalThis.DOMParser === 'undefined') {
  const ENTITIES = { '&lt;': '<', '&gt;': '>', '&amp;': '&', '&quot;': '"', '&apos;': "'" };
  const decode = (s) => s.replace(/&(lt|gt|amp|quot|apos);/g, (m) => ENTITIES[m]);

  class Elem {
    constructor(tagName, attrs, text) {
      this.tagName = tagName;
      this._attrs = attrs;
      this.textContent = text;
    }
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this._attrs, name) ? this._attrs[name] : null;
    }
  }

  const parseAttrs = (s) => {
    const attrs = {};
    for (const m of s.matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) attrs[m[1]] = decode(m[2]);
    return attrs;
  };

  globalThis.DOMParser = class DOMParser {
    parseFromString(xml) {
      const rootMatch = /<([\w:.-]+)[\s>]/.exec(xml.replace(/^\s*<\?xml[^>]*\?>/, ''));
      const items = [];
      for (const m of xml.matchAll(/<Item\b([^>]*?)(?:\/>|>([\s\S]*?)<\/Item>)/g)) {
        items.push(new Elem('Item', parseAttrs(m[1]), decode(m[2] ?? '').trim()));
      }
      return {
        documentElement: {
          tagName: rootMatch ? rootMatch[1] : '',
          querySelectorAll: (sel) => (sel === 'Item' ? items : []),
        },
      };
    }
  };
}
