// Outbound policy.
//
// Every request goes through here before a socket opens. The rules are few and
// absolute:
//
//   - HTTPS only, unless a host is explicitly allow-listed by a human;
//   - no credentials in the URL, because a URL ends up in logs and handles;
//   - no private or loopback targets, so a map cannot make the server talk to
//     its own network;
//   - a secret only goes to the host its binding names.

import type { Result } from '../view/result.ts';
import { err, ok } from '../view/result.ts';

export type PolicyCode =
  | 'blocked_scheme'
  | 'blocked_host'
  | 'bad_url'
  | 'url_has_credentials'
  | 'too_many_redirects';

export type PolicyRefusal = {
  readonly code: PolicyCode;
  readonly message: string;
  readonly hint?: string;
};

export type OutboundPolicy = {
  /** Hosts a human has approved for plain HTTP. Legacy internal targets. */
  readonly allowPlainHttpHosts: readonly string[];
  /** Escape hatch for loopback/private targets; off by default. */
  readonly allowPrivateHosts: boolean;
  readonly maxRedirects: number;
  readonly timeoutMs: number;
  readonly maxBytes: number;
};

export const DEFAULT_POLICY: OutboundPolicy = {
  allowPlainHttpHosts: [],
  allowPrivateHosts: false,
  maxRedirects: 3,
  timeoutMs: 20_000,
  maxBytes: 16 * 1024 * 1024,
};

export function normalisePolicy(partial: Partial<OutboundPolicy> = {}): OutboundPolicy {
  return {
    allowPlainHttpHosts: (partial.allowPlainHttpHosts ?? DEFAULT_POLICY.allowPlainHttpHosts).map((host) => host.toLowerCase()),
    allowPrivateHosts: partial.allowPrivateHosts ?? DEFAULT_POLICY.allowPrivateHosts,
    maxRedirects: Math.max(0, partial.maxRedirects ?? DEFAULT_POLICY.maxRedirects),
    timeoutMs: Math.max(1, partial.timeoutMs ?? DEFAULT_POLICY.timeoutMs),
    maxBytes: Math.max(1, partial.maxBytes ?? DEFAULT_POLICY.maxBytes),
  };
}

const PRIVATE_V4 = [
  /^0\./,
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^192\.168\./,
  /^172\.(?:1[6-9]|2[0-9]|3[01])\./,
];

/** Literal addresses only. A DNS answer is checked separately, because a
 * hostname can resolve to anything. */
export function isPrivateAddress(address: string): boolean {
  const value = address.trim().toLowerCase().replace(/^\[|\]$/g, '');

  if (value === '::1' || value === '::' || value === 'localhost') return true;
  if (value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe80')) return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(value)) return PRIVATE_V4.some((pattern) => pattern.test(value));

  return false;
}

/** Parse and check a URL against the policy. */
export function checkUrl(raw: string, policy: OutboundPolicy): Result<URL, PolicyRefusal> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return err({ code: 'bad_url', message: `not an absolute URL: ${raw}` });
  }

  if (url.username !== '' || url.password !== '') {
    return err({
      code: 'url_has_credentials',
      message: 'the URL carries credentials',
      hint: 'credentials belong in a binding and a provider, not in a URL that gets logged',
    });
  }

  const host = url.hostname.toLowerCase();

  if (url.protocol === 'http:') {
    if (!policy.allowPlainHttpHosts.includes(host)) {
      return err({
        code: 'blocked_scheme',
        message: `plain HTTP is refused for ${host}`,
        hint: 'a human may add the host to allowPlainHttpHosts after deciding the risk',
      });
    }
  } else if (url.protocol !== 'https:') {
    return err({ code: 'blocked_scheme', message: `scheme '${url.protocol}' is not http(s)` });
  }

  if (!policy.allowPrivateHosts) {
    if (isPrivateAddress(host)) {
      return err({
        code: 'blocked_host',
        message: `${host} is a private or loopback address`,
        hint: 'allowPrivateHosts is for local development and stays off by default',
      });
    }
    if (host === '') {
      return err({ code: 'blocked_host', message: 'the URL has no host' });
    }
  }

  return ok(url);
}

export type Lookup = (hostname: string) => Promise<readonly string[]>;

/**
 * Check where a hostname actually resolves. A literal address was checked by
 * `checkUrl`; this closes the DNS-rebinding gap and requires an injected
 * resolver so nothing here does implicit I/O.
 */
export async function checkResolvedHost(
  url: URL,
  policy: OutboundPolicy,
  lookup: Lookup | undefined,
): Promise<Result<void, PolicyRefusal>> {
  if (policy.allowPrivateHosts || lookup === undefined) return ok(undefined);
  if (/^\d+\.\d+\.\d+\.\d+$/.test(url.hostname) || url.hostname.includes(':')) return ok(undefined);

  let addresses: readonly string[];
  try {
    addresses = await lookup(url.hostname);
  } catch {
    return err({ code: 'blocked_host', message: `cannot resolve ${url.hostname}` });
  }

  for (const address of addresses) {
    if (isPrivateAddress(address)) {
      return err({
        code: 'blocked_host',
        message: `${url.hostname} resolves to the private address ${address}`,
        hint: 'if this is intentional local development, allowPrivateHosts must be set explicitly',
      });
    }
  }

  return ok(undefined);
}

/** Same origin, ignoring the port only when both are default. */
export function sameOrigin(a: URL, b: URL): boolean {
  return a.protocol === b.protocol && a.hostname.toLowerCase() === b.hostname.toLowerCase() && a.port === b.port;
}

export function resolveRedirect(from: URL, location: string): Result<URL, PolicyRefusal> {
  try {
    return ok(new URL(location, from));
  } catch {
    return err({ code: 'bad_url', message: `redirect target is not a URL: ${location}` });
  }
}
