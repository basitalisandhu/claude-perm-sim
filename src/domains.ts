/**
 * WebFetch `domain:` rules match the hostname of the requested URL, case-insensitively, with a trailing
 * `.` stripped from both sides. `*.example.com` matches subdomains at any depth but not the apex, a bare
 * `*` matches every host, and a `*` anywhere else matches the text between two dots only.
 */

export function normaliseHost(host: string): string {
  let h = host.trim().toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  while (h.endsWith('.')) h = h.slice(0, -1);
  return h;
}

/**
 * Hostname of a URL as a WHATWG URL parser reads it: userinfo is dropped, IPv4 shorthand and hex forms
 * are normalised, ports are not part of the host. Returns undefined when the text is not a URL.
 */
export function hostOf(url: string): string | undefined {
  try {
    const u = new URL(url.includes('://') ? url : `https://${url}`);
    return normaliseHost(u.hostname);
  } catch {
    return undefined;
  }
}

export function domainPatternMatches(pattern: string, host: string): boolean {
  const p = normaliseHost(pattern);
  const h = normaliseHost(host);
  if (p === '*') return true;
  if (p.startsWith('*.')) {
    const rest = p.slice(2);
    if (!h.endsWith('.' + rest)) return false;
    return rest.includes('*') ? false : true;
  }
  if (!p.includes('*')) return p === h;
  const re = new RegExp('^' + p.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^.]*') + '$');
  return re.test(h);
}

/** Domain from a `WebFetch(domain:...)` specifier, or undefined for other specifiers. */
export function domainOfSpecifier(specifier: string | undefined): string | undefined {
  if (specifier === undefined) return undefined;
  const m = /^domain:\s*(.*)$/.exec(specifier.trim());
  return m ? m[1].trim() : undefined;
}
