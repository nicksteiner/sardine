/**
 * jsx-scan.mjs — a tiny, dependency-free JSX opening-tag scanner.
 *
 * Static a11y checks need to know, for every <button>/<input>/<div …> in the
 * source, which attributes it carries and what literal text sits between its
 * tags. A full parser is overkill; this walks the text tracking string and
 * brace state, which is enough to slice out opening tags and element bodies.
 *
 * Not a general JSX parser — it makes two assumptions that hold across this
 * codebase: tags are not nested inside their own attribute values, and an
 * element's closing tag is the first unbalanced `</tag>` after it.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/** Walk a directory tree, returning every file whose name matches `test`. */
export function walk(dir, test = f => f.endsWith('.jsx'), out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, test, out);
    else if (test(entry)) out.push(p);
  }
  return out;
}

/**
 * Scan forward from the `<` of an opening tag and return its extent.
 * Returns { attrs, end, selfClosing } or null if the tag never closes.
 */
function readOpenTag(src, start) {
  let i = start;
  let depth = 0;      // {} nesting inside attribute values
  let quote = null;   // ' " or ` while inside a string literal
  while (i < src.length) {
    const c = src[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'" || c === '`') {
      quote = c;
    } else if (c === '{') {
      depth++;
    } else if (c === '}') {
      depth--;
    } else if (c === '>' && depth === 0) {
      const selfClosing = src[i - 1] === '/';
      return { attrs: src.slice(start, i + (selfClosing ? 0 : 1)), end: i + 1, selfClosing };
    }
    i++;
  }
  return null;
}

/** Find the body text of an element whose open tag ended at `from`. */
function readBody(src, from, tag) {
  const open = new RegExp(`<${tag}[\\s/>]`, 'g');
  const close = new RegExp(`</${tag}\\s*>`, 'g');
  let depth = 1;
  let i = from;
  while (i < src.length) {
    open.lastIndex = i; close.lastIndex = i;
    const o = open.exec(src);
    const c = close.exec(src);
    if (!c) return src.slice(from);
    if (o && o.index < c.index) { depth++; i = o.index + 1; continue; }
    depth--;
    if (depth === 0) return src.slice(from, c.index);
    i = c.index + 1;
  }
  return src.slice(from);
}

/**
 * Yield every element of the given tag names in `src`.
 * Each entry: { tag, attrs, body, line, index }.
 */
export function findElements(src, tags) {
  const found = [];
  const set = new Set(tags);
  const re = /<([A-Za-z][A-Za-z0-9]*)(?=[\s/>])/g;
  let m;
  while ((m = re.exec(src))) {
    const tag = m[1];
    if (!set.has(tag)) continue;
    const open = readOpenTag(src, m.index);
    if (!open) continue;
    const body = open.selfClosing ? '' : readBody(src, open.end, tag);
    found.push({
      tag,
      attrs: open.attrs,
      body,
      bodyStart: open.end,
      bodyEnd: open.end + body.length,
      index: m.index,
      line: src.slice(0, m.index).split('\n').length,
    });
  }
  return found;
}

/** True if the opening tag carries the named JSX attribute. */
export function hasAttr(attrs, name) {
  return new RegExp(`(^|[\\s{])${name}\\s*=`).test(attrs) ||
    new RegExp(`(^|\\s)${name}(\\s|$|/)`).test(attrs);
}

/** Literal value of a string attribute, or null when absent/dynamic. */
export function attrValue(attrs, name) {
  const m = attrs.match(new RegExp(`(^|\\s)${name}\\s*=\\s*(["'])((?:[^\\\\]|\\\\.)*?)\\2`));
  return m ? m[3] : null;
}

/**
 * Visible literal text of an element body: JSX expressions, nested tags and
 * comments removed. Used to decide whether an element already has a name.
 */
export function literalText(body) {
  let out = '';
  let depth = 0;
  let i = 0;
  while (i < body.length) {
    const c = body[i];
    if (c === '{') { depth++; i++; continue; }
    if (c === '}') { depth = Math.max(0, depth - 1); i++; continue; }
    if (depth === 0 && c === '<') {
      const close = body.indexOf('>', i);
      i = close === -1 ? body.length : close + 1;
      continue;
    }
    if (depth === 0) out += c;
    i++;
  }
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * True if `el` sits inside the body of a <label> that carries literal text.
 * A wrapping label names its control implicitly — no htmlFor needed.
 */
/**
 * Every string a body could render: its literal text plus the string and
 * template literals inside its JSX expressions. `{playing ? '⏸' : '▶'}` yields
 * only glyphs — unnamed; `{n ? 'None' : 'Reset'}` yields words — named.
 */
export function accessibleText(body) {
  // Walk the body once, collecting top-level text and the string literals
  // inside top-level expressions. Nested tags are skipped whole — their
  // attribute values ("none", "currentColor" on an <svg>) are markup, not
  // text a screen reader would ever read out.
  const out = [];
  let depth = 0;
  let i = 0;
  while (i < body.length) {
    const c = body[i];
    if (c === '<') {                       // skip a tag, at any depth
      const close = body.indexOf('>', i);
      i = close === -1 ? body.length : close + 1;
      continue;
    }
    if (c === '{') { depth++; i++; continue; }
    if (c === '}') { depth = Math.max(0, depth - 1); i++; continue; }
    if (depth > 0 && (c === '"' || c === "'" || c === '`')) {
      let j = i + 1;
      let lit = '';
      while (j < body.length && body[j] !== c) {
        if (body[j] === '\\') j++;
        else lit += body[j];
        j++;
      }
      out.push(' ' + lit + ' ');
      i = j + 1;
      continue;
    }
    if (depth === 0) out.push(c);   // plain text char
    i++;
  }
  return out.join('').replace(/\s+/g, ' ').trim();
}

export function insideTextLabel(el, all) {
  return all.some(l => l.tag === 'label'
    && el.index > l.bodyStart && el.index < l.bodyEnd
    && /[A-Za-z]{2}/.test(literalText(l.body)));
}

export function rel(p, root) { return relative(root, p); }
export { readFileSync };
