/**
 * share-link.js — compatibility shim. The share-link schema moved to
 * deep-link.js (W008) when the generic `?url=` param and long-form aliases
 * were added. Import from './deep-link.js' in new code.
 */
export { parseShareLink, buildShareLink, clearShareLinkParams, inferDataTypeFromUrl } from './deep-link.js';
