const PRIVATE_V4 = [/^127\./, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^169\.254\./];

/**
 * True when a URL points at this machine or a private network. Single-label hostnames
 * (`ollama`, `whisper`) count as local: that is how docker compose services address each other.
 */
export function isLocalUrl(url: string | URL): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host.startsWith("[")) host = host.slice(1, -1);
  if (host === "localhost" || host === "::1" || host === "0.0.0.0") return true;
  if (host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal"))
    return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return PRIVATE_V4.some((re) => re.test(host));
  if (host.includes(":")) return /^f[cd]/.test(host) || host.startsWith("fe80");
  return !host.includes(".");
}
