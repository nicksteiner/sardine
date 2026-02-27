/**
 * S3 URL normalization and acceleration utilities.
 *
 * Handles:
 *  - s3:// URI → HTTPS conversion
 *  - S3 Transfer Acceleration (*.s3-accelerate.amazonaws.com)
 *  - CloudFront distribution URL substitution
 */

/**
 * Normalize an S3 URI or URL into a standard HTTPS URL.
 *
 * @param {string} url - s3://bucket/key, HTTPS S3 URL, or any HTTPS URL
 * @param {object} [options]
 * @param {boolean} [options.useTransferAcceleration=false] - Rewrite to S3 Transfer Acceleration endpoint
 * @param {string}  [options.cloudfrontDomain] - If provided, rewrite S3 URLs to this CloudFront distribution
 * @returns {string} HTTPS URL ready for fetch()
 */
export function normalizeS3Url(url, { useTransferAcceleration = false, cloudfrontDomain } = {}) {
  if (!url) return url;

  // Pre-signed URLs contain a cryptographic signature over the exact host+path+query.
  // Any rewrite (host change, query strip) invalidates the signature → 403.
  if (url.includes('X-Amz-Signature') || url.includes('x-amz-signature')) {
    return url;
  }

  let bucket, key;

  // s3://bucket/key → extract parts
  if (url.startsWith('s3://')) {
    const parts = url.slice(5).split('/');
    bucket = parts[0];
    key = parts.slice(1).join('/');
  }
  // https://bucket.s3.amazonaws.com/key or https://bucket.s3.region.amazonaws.com/key
  else if (/^https?:\/\/([^.]+)\.s3[.-]/.test(url)) {
    const m = url.match(/^https?:\/\/([^.]+)\.s3[^/]*\/(.+)$/);
    if (m) {
      bucket = m[1];
      key = m[2];
    }
  }

  // Not an S3 URL — return as-is
  if (!bucket) return url;

  // CloudFront takes priority
  if (cloudfrontDomain) {
    const domain = cloudfrontDomain.replace(/^https?:\/\//, '').replace(/\/$/, '');
    return `https://${domain}/${key}`;
  }

  // S3 Transfer Acceleration
  if (useTransferAcceleration) {
    return `https://${bucket}.s3-accelerate.amazonaws.com/${key}`;
  }

  // Standard virtual-hosted S3
  return `https://${bucket}.s3.amazonaws.com/${key}`;
}

/**
 * Detect whether a URL points to an S3-compatible endpoint.
 * Useful for deciding whether to apply acceleration or CDN options.
 */
export function isS3Url(url) {
  if (!url) return false;
  return url.startsWith('s3://') || /^https?:\/\/[^.]+\.s3[.-]/.test(url);
}
