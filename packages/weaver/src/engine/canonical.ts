/**
 * The canonical form of a URL: what dedupe compares. Host in lower case, no fragment, no
 * tracking parameters, no trailing slash, parameters sorted; a YouTube video in any of its forms
 * is `https://www.youtube.com/watch?v=<id>`.
 */
const TRACKING =
  /^(utm_\w+|fbclid|gclid|dclid|msclkid|mc_[ce]id|yclid|igshid|ref|ref_src|_hsenc|_hsmi|si|feature)$/i;

const YT_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"]);

export function youtubeId(u: URL): string | null {
  if (u.hostname === "youtu.be") return u.pathname.slice(1).split("/")[0] || null;
  if (!YT_HOSTS.has(u.hostname)) return null;
  const v = u.searchParams.get("v");
  if (v) return v;
  const m = /^\/(?:shorts|live|embed|v)\/([\w-]{11})/.exec(u.pathname);
  return m?.[1] ?? null;
}

export function canonical(url: string): string {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return url.trim();
  }
  const id = youtubeId(u);
  if (id) return `https://www.youtube.com/watch?v=${id}`;
  u.hash = "";
  u.hostname = u.hostname.toLowerCase();
  if ((u.protocol === "https:" && u.port === "443") || (u.protocol === "http:" && u.port === "80"))
    u.port = "";
  const kept = [...u.searchParams.entries()].filter(([k]) => !TRACKING.test(k));
  kept.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  u.search = "";
  for (const [k, v] of kept) u.searchParams.append(k, v);
  if (u.pathname.length > 1 && u.pathname.endsWith("/")) u.pathname = u.pathname.slice(0, -1);
  return u.toString();
}
