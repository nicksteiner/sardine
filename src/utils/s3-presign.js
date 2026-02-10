/**
 * S3 Pre-signed URL generation — pure JavaScript, no AWS SDK.
 *
 * Uses Web Crypto API (HMAC-SHA256) to implement AWS Signature Version 4
 * pre-signed URLs. Works in any modern browser.
 *
 * Usage:
 *   const url = await presignS3Url({
 *     bucket: 'my-bucket',
 *     key: 'path/to/file.h5',
 *     region: 'us-west-2',
 *     accessKeyId: 'AKIA...',
 *     secretAccessKey: 'wJalr...',
 *     sessionToken: 'FwoGZX...',  // optional, for temporary credentials
 *     expires: 3600,              // seconds, default 1 hour
 *   });
 */

// ─── Crypto helpers (Web Crypto API) ────────────────────────────────────

const encoder = new TextEncoder();

async function hmacSHA256(key, data) {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    typeof key === 'string' ? encoder.encode(key) : key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return new Uint8Array(
    await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(data))
  );
}

async function sha256Hex(data) {
  const hash = await crypto.subtle.digest('SHA-256', encoder.encode(data));
  return hex(new Uint8Array(hash));
}

function hex(buf) {
  return Array.from(buf, b => b.toString(16).padStart(2, '0')).join('');
}

// ─── AWS SigV4 signing key derivation ───────────────────────────────────

async function getSigningKey(secretKey, dateStamp, region, service) {
  let key = await hmacSHA256('AWS4' + secretKey, dateStamp);
  key = await hmacSHA256(key, region);
  key = await hmacSHA256(key, service);
  key = await hmacSHA256(key, 'aws4_request');
  return key;
}

// ─── Formatting helpers ─────────────────────────────────────────────────

function toAmzDate(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

function toDateStamp(date) {
  return toAmzDate(date).slice(0, 8);
}

function uriEncode(str) {
  return encodeURIComponent(str).replace(/%2F/g, '/');
}

function uriEncodeComponent(str) {
  return encodeURIComponent(str);
}

// ─── Main: generate pre-signed S3 URL ───────────────────────────────────

/**
 * Generate an AWS S3 pre-signed URL using SigV4.
 *
 * @param {Object} opts
 * @param {string} opts.bucket      — S3 bucket name
 * @param {string} opts.key         — Object key (path within bucket)
 * @param {string} opts.region      — AWS region (e.g. 'us-west-2')
 * @param {string} opts.accessKeyId — AWS access key ID
 * @param {string} opts.secretAccessKey — AWS secret access key
 * @param {string} [opts.sessionToken] — STS session token (for temp credentials)
 * @param {number} [opts.expires=3600] — URL validity in seconds (max 604800 = 7 days)
 * @param {string} [opts.method='GET'] — HTTP method
 * @returns {Promise<string>} Pre-signed HTTPS URL
 */
export async function presignS3Url({
  bucket,
  key,
  region,
  accessKeyId,
  secretAccessKey,
  sessionToken,
  expires = 3600,
  method = 'GET',
}) {
  const service = 's3';
  const host = `${bucket}.s3.${region}.amazonaws.com`;
  const now = new Date();
  const amzDate = toAmzDate(now);
  const dateStamp = toDateStamp(now);
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const credential = `${accessKeyId}/${credentialScope}`;

  // Canonical URI: /<key> with each path segment percent-encoded
  const canonicalUri = '/' + key.split('/').map(uriEncodeComponent).join('/');

  // Query parameters (sorted)
  const params = new Map([
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', credential],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', String(expires)],
    ['X-Amz-SignedHeaders', 'host'],
  ]);
  if (sessionToken) {
    params.set('X-Amz-Security-Token', sessionToken);
  }

  // Sort and encode query string
  const sortedKeys = [...params.keys()].sort();
  const canonicalQueryString = sortedKeys
    .map(k => `${uriEncodeComponent(k)}=${uriEncodeComponent(params.get(k))}`)
    .join('&');

  // Canonical headers
  const canonicalHeaders = `host:${host}\n`;
  const signedHeaders = 'host';

  // For pre-signed URLs, payload hash is always UNSIGNED-PAYLOAD
  const payloadHash = 'UNSIGNED-PAYLOAD';

  // Canonical request
  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  // String to sign
  const canonicalRequestHash = await sha256Hex(canonicalRequest);
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    canonicalRequestHash,
  ].join('\n');

  // Signing key + signature
  const signingKey = await getSigningKey(secretAccessKey, dateStamp, region, service);
  const signature = hex(await hmacSHA256(signingKey, stringToSign));

  // Build final URL
  return `https://${host}${canonicalUri}?${canonicalQueryString}&X-Amz-Signature=${signature}`;
}

/**
 * Batch-presign multiple S3 keys in the same bucket/region.
 *
 * @param {Object} opts — Same as presignS3Url, but `key` is replaced by `keys` (string[])
 * @returns {Promise<Map<string, string>>} Map of key → pre-signed URL
 */
export async function presignMultiple({ keys, ...opts }) {
  const entries = await Promise.all(
    keys.map(async key => [key, await presignS3Url({ ...opts, key })])
  );
  return new Map(entries);
}

/**
 * Parse an s3:// URI into {bucket, key}.
 * @param {string} uri — e.g. 's3://my-bucket/path/to/file.h5'
 * @returns {{bucket: string, key: string}}
 */
export function parseS3Uri(uri) {
  if (!uri.startsWith('s3://')) throw new Error(`Not an S3 URI: ${uri}`);
  const rest = uri.slice(5);
  const idx = rest.indexOf('/');
  if (idx < 0) return { bucket: rest, key: '' };
  return { bucket: rest.slice(0, idx), key: rest.slice(idx + 1) };
}

/**
 * Add pre-signed URLs to a GeoJSON FeatureCollection.
 * Each feature must have `properties.s3_uri` or `properties.s3_key` + `properties.bucket`.
 *
 * @param {Object} geojson — GeoJSON FeatureCollection
 * @param {Object} credentials — { accessKeyId, secretAccessKey, sessionToken?, region, bucket? }
 * @param {number} [expires=3600]
 * @returns {Promise<Object>} Same GeoJSON with `properties.presigned_url` added
 */
export async function presignGeoJSON(geojson, credentials, expires = 3600) {
  const { accessKeyId, secretAccessKey, sessionToken, region } = credentials;
  const defaultBucket = credentials.bucket;

  const features = await Promise.all(
    geojson.features.map(async feature => {
      const props = feature.properties || {};
      let bucket, key;

      if (props.s3_uri) {
        ({ bucket, key } = parseS3Uri(props.s3_uri));
      } else if (props.s3_key) {
        bucket = props.bucket || defaultBucket;
        key = props.s3_key;
      } else {
        return feature; // no S3 reference, skip
      }

      if (!bucket || !key) return feature;

      const presigned_url = await presignS3Url({
        bucket, key, region, accessKeyId, secretAccessKey, sessionToken, expires,
      });

      return {
        ...feature,
        properties: { ...props, presigned_url },
      };
    })
  );

  return { ...geojson, features };
}
