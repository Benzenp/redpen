/**
 * MVP URL policy (docs/ARCHITECTURE.md §4.1, docs/PRODUCT_INTENT.md §9):
 * only `localhost`/`127.0.0.1` targets are accepted.
 */
export class UnsupportedUrlError extends Error {
  constructor(public readonly url: string) {
    super(`only localhost/127.0.0.1 URLs are supported in the MVP: ${url}`);
    this.name = 'UnsupportedUrlError';
  }
}

const ALLOWED_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function assertLoopbackUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new UnsupportedUrlError(rawUrl);
  }
  if (!ALLOWED_HOSTS.has(parsed.hostname)) {
    throw new UnsupportedUrlError(rawUrl);
  }
  return parsed;
}
