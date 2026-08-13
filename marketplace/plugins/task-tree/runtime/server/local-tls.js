/**
 * TLS for the loopback UI.
 *
 * The Codex desktop widget runs under a policy whose `frame-src` allows `https:` and nothing over
 * plain http, so the only way to embed the real page is to serve it over TLS. Everything here is
 * read-only: certificates are created by `scripts/enable-local-https.ps1`, which is where the user
 * gets asked to trust one. No certificate on disk simply means no https listener.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/** Kept out of the project so several projects share one certificate and one trust decision. */
export function tlsDir(env = process.env) {
  const base = env.LOCALAPPDATA || env.APPDATA || env.HOME || "";
  return path.join(base, "LLMTaskTree", "tls");
}

/**
 * The https port is derived from the http one so a project keeps a single fixed pair of
 * addresses. Stable http ports live in 5178..5977, so this range cannot collide with them.
 */
export function httpsPortFor(httpPort) {
  return Number(httpPort) + 1000;
}

/**
 * Returns what `https.createServer` needs, or null when no usable certificate is installed.
 * An expired certificate counts as absent: serving it would fail in the browser anyway.
 */
export function loadLocalTls(dir = tlsDir()) {
  const pfxFile = path.join(dir, "local.pfx");
  const metaFile = path.join(dir, "local.json");
  if (!existsSync(pfxFile) || !existsSync(metaFile)) return null;
  try {
    const meta = JSON.parse(readFileSync(metaFile, "utf8").replace(/^\uFEFF/, ""));
    if (meta.notAfter && Date.parse(meta.notAfter) <= Date.now()) return null;
    return {
      pfx: readFileSync(pfxFile),
      passphrase: String(meta.passphrase || ""),
      thumbprint: String(meta.thumbprint || ""),
      notAfter: String(meta.notAfter || "")
    };
  } catch {
    return null;
  }
}
