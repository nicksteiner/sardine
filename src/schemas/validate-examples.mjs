#!/usr/bin/env node
/**
 * W010 acceptance: schemas validate example instances with a no-dep validator.
 *
 * Implements exactly the JSON Schema subset these schemas use:
 *   const, enum, type (string | string[]), required, properties, items,
 *   minItems, maxItems, minimum, maximum, anyOf,
 *   $ref → "#/$defs/<name>" (same file) and "./<file>.schema.json" (sibling).
 * Unknown keywords are ignored (documentation-only: description, title, $id).
 *
 * Plus SARdine-specific cross-field rules from SESSION_SCHEMA.md:
 *   §4   analysisArtifacts[].inline must serialize to <= 100 KB
 *   §A.4 every label-region class must appear in collection-level
 *        sardine:classes (required when any label-region is present)
 *   §A.1 rejecting an insitu/model label requires adjudication.reason
 *
 * Usage: node src/schemas/validate-examples.mjs   (exit 0 = all green)
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const INLINE_LIMIT = 100 * 1024;

const schemaCache = new Map();
function loadSchema(file) {
  if (!schemaCache.has(file)) {
    schemaCache.set(file, JSON.parse(readFileSync(join(HERE, file), 'utf8')));
  }
  return schemaCache.get(file);
}

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (Number.isInteger(v)) return 'integer'; // integer also satisfies "number"
  return typeof v;
}

function typeMatches(v, want) {
  const t = typeOf(v);
  const wants = Array.isArray(want) ? want : [want];
  return wants.some((w) => w === t || (w === 'number' && t === 'integer'));
}

function resolveRef(ref, rootSchema, rootFile) {
  if (ref.startsWith('#/$defs/')) {
    const name = ref.slice('#/$defs/'.length);
    const def = rootSchema.$defs?.[name];
    if (!def) throw new Error(`unresolvable $ref ${ref} in ${rootFile}`);
    return { schema: def, root: rootSchema, file: rootFile };
  }
  if (ref.startsWith('./')) {
    const file = ref.slice(2);
    const s = loadSchema(file);
    return { schema: s, root: s, file };
  }
  throw new Error(`unsupported $ref form: ${ref}`);
}

function validate(value, schema, root, file, path, errors) {
  if (schema.$ref) {
    const r = resolveRef(schema.$ref, root, file);
    validate(value, r.schema, r.root, r.file, path, errors);
    return;
  }
  if ('const' in schema && JSON.stringify(value) !== JSON.stringify(schema.const)) {
    errors.push(`${path}: expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`);
    return;
  }
  if (schema.enum && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) {
    errors.push(`${path}: ${JSON.stringify(value)} not in enum [${schema.enum.join(', ')}]`);
    return;
  }
  if (schema.type && !typeMatches(value, schema.type)) {
    errors.push(`${path}: expected type ${JSON.stringify(schema.type)}, got ${typeOf(value)}`);
    return;
  }
  if (typeMatches(value, 'number')) {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: ${value} < minimum ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: ${value} > maximum ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}: ${value.length} items < minItems ${schema.minItems}`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path}: ${value.length} items > maxItems ${schema.maxItems}`);
    if (schema.items) value.forEach((v, i) => validate(v, schema.items, root, file, `${path}[${i}]`, errors));
  }
  if (typeOf(value) === 'object') {
    for (const req of schema.required ?? []) {
      if (!(req in value)) errors.push(`${path}: missing required "${req}"`);
    }
    for (const [k, sub] of Object.entries(schema.properties ?? {})) {
      if (k in value) validate(value[k], sub, root, file, `${path}.${k}`, errors);
    }
  }
  if (schema.anyOf) {
    const ok = schema.anyOf.some((sub) => {
      const e = [];
      validate(value, sub, root, file, path, e);
      return e.length === 0;
    });
    if (!ok) errors.push(`${path}: matches no anyOf branch`);
  }
}

function checkInlineLimit(session, path, errors) {
  for (const [i, a] of (session.analysisArtifacts ?? []).entries()) {
    if (a.inline !== undefined) {
      const size = Buffer.byteLength(JSON.stringify(a.inline), 'utf8');
      if (size > INLINE_LIMIT) errors.push(`${path}.analysisArtifacts[${i}].inline: ${size} B exceeds 100 KB inline limit`);
    }
  }
}

function checkMarkupRules(session, path, errors) {
  const markup = session.markup;
  if (!markup?.features) return;
  const declared = markup['sardine:classes'];
  let hasLabelRegion = false;
  for (const [i, f] of markup.features.entries()) {
    const p = f?.properties ?? {};
    const fp = `${path}.markup.features[${i}]`;
    if (p['sardine:kind'] === 'label-region') {
      hasLabelRegion = true;
      if (declared && p.class !== undefined && !declared.includes(p.class)) {
        errors.push(`${fp}: class "${p.class}" not in sardine:classes [${declared.join(', ')}]`);
      }
    }
    if (p.adjudication?.status === 'rejected' &&
        (p.observer === 'insitu' || p.observer === 'model') &&
        !p.adjudication.reason) {
      errors.push(`${fp}: rejecting an ${p.observer} label requires adjudication.reason`);
    }
  }
  if (hasLabelRegion && !Array.isArray(declared)) {
    errors.push(`${path}.markup: label-region features present but no sardine:classes declared`);
  }
}

// example file → schema it must validate against
const MAP = {
  'session.example.json': 'session-state.schema.json',
  'calibration-record.example.json': 'calibration-record.schema.json',
};

let failed = false;
const exampleDir = join(HERE, 'examples');
for (const name of readdirSync(exampleDir).sort()) {
  if (!name.endsWith('.json')) continue;
  const schemaFile = MAP[name];
  if (!schemaFile) {
    console.error(`FAIL ${name}: no schema mapping in validate-examples.mjs`);
    failed = true;
    continue;
  }
  const instance = JSON.parse(readFileSync(join(exampleDir, name), 'utf8'));
  const schema = loadSchema(schemaFile);
  const errors = [];
  validate(instance, schema, schema, schemaFile, '$', errors);
  if (schemaFile === 'session-state.schema.json') {
    checkInlineLimit(instance, '$', errors);
    checkMarkupRules(instance, '$', errors);
  }
  if (errors.length) {
    failed = true;
    console.error(`FAIL ${name} vs ${schemaFile}:`);
    for (const e of errors) console.error(`  ${e}`);
  } else {
    console.log(`ok   ${name} vs ${schemaFile}`);
  }
}
process.exit(failed ? 1 : 0);
