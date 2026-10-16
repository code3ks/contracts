// Small, dependency-free helpers for keeping logs and health output bounded.
//
// RPC provider URLs routinely embed credentials — either as userinfo
// (`https://user:pass@host`) or as a secret in the path/query
// (`https://host/v1/<api-key>?token=...`). None of that belongs in a log line
// or an unauthenticated health response, so `redactUrl` reports only the
// scheme and host.

/**
 * Reduce a URL to `scheme://host`, dropping userinfo, path, query, and
 * fragment. Returns a stable placeholder for unset or unparsable values so
 * callers never accidentally echo the raw input.
 *
 * @param {unknown} rawUrl
 * @returns {string}
 */
export function redactUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0) {
    return '<unset>';
  }
  try {
    const url = new URL(rawUrl);
    return `${url.protocol}//${url.host}`;
  } catch {
    return '<invalid-url>';
  }
}

/**
 * Cap a value's string form at `maxLength` characters so provider-controlled
 * data cannot produce an unbounded log line.
 *
 * @param {unknown} value
 * @param {number} [maxLength]
 * @returns {string}
 */
export function truncate(value, maxLength = 512) {
  const text = typeof value === 'string' ? value : String(value);
  if (text.length <= maxLength) {
    return text;
  }
  const omitted = text.length - maxLength;
  return `${text.slice(0, maxLength)}… (${omitted} more chars)`;
}
