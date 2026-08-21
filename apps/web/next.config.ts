import type { NextConfig } from "next";

// Server-side-only (no NEXT_PUBLIC_ prefix): where Next's own server
// forwards proxied /api/* requests to. Defaults to the api crate's local
// dev port. Not used at all when a component's fetch is given an
// explicit absolute NEXT_PUBLIC_API_BASE_URL (e.g. a real deployed
// api.example.org per ADR-0012) -- this proxy exists only to make the
// relative-path "/api" default work.
const API_PROXY_TARGET = process.env.API_PROXY_TARGET ?? "http://localhost:8080";

const nextConfig: NextConfig = {
  // The browser only ever talks to this page's own origin -- Next's
  // server does the actual cross-host fetch to the api crate. This
  // sidesteps two real problems with the frontend calling
  // http://localhost:8080 directly from the browser: (1) when the page
  // is loaded through a forwarded/tunneled HTTPS origin (e.g. a
  // Codespace's *.app.github.dev URL) rather than raw localhost,
  // Chrome's Private Network Access policy blocks a public-origin page
  // from reaching a loopback address at all; (2) even once that's
  // worked around, the session cookie's SameSite=Lax attribute
  // (session.rs) wouldn't be sent on a genuinely cross-origin fetch/XHR
  // request. Proxying makes every request same-origin from the
  // browser's perspective, so neither issue applies.
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${API_PROXY_TARGET}/:path*`,
      },
    ];
  },
};

export default nextConfig;
