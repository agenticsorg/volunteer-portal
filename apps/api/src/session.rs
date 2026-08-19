//! Session cookie configuration per ADR-0012's same-parent-domain
//! subdomain architecture (`app.example.org` / `api.example.org`, cookie
//! `Domain=.example.org`) — configured now, in Prompt 1.5, even though
//! the actual frontend/backend split isn't deployed yet, per that
//! prompt's explicit instruction to get the cookie scoping right from
//! the start rather than retrofitting it once a cross-subdomain bug
//! appears.

use tower_sessions::cookie::SameSite;
use tower_sessions::{Expiry, SessionManagerLayer, SessionStore};
use time::Duration;

/// Reads `SESSION_COOKIE_DOMAIN` (unset in local/dev — a `Domain`
/// attribute must match a real reachable domain, so it's opt-in) and
/// `SESSION_COOKIE_SECURE` (defaults to `true`; only ever set to `false`
/// for local plain-HTTP development, never in a deployed environment,
/// since `Secure` cookies are dropped by browsers over `http://`).
pub fn configure<Store: SessionStore + Clone>(store: Store) -> SessionManagerLayer<Store> {
    let mut layer = SessionManagerLayer::new(store)
        .with_http_only(true)
        // `Lax`, not `Strict`: the Discord OAuth callback is a top-level
        // GET navigation originating from discord.com back to our own
        // origin. `Strict` would drop the session cookie (and with it
        // the CSRF state / PKCE verifier written just before the
        // redirect) on exactly that request.
        .with_same_site(SameSite::Lax)
        .with_secure(
            std::env::var("SESSION_COOKIE_SECURE")
                .map(|v| v != "false")
                .unwrap_or(true),
        )
        .with_expiry(Expiry::OnInactivity(Duration::hours(24)));

    if let Ok(domain) = std::env::var("SESSION_COOKIE_DOMAIN") {
        layer = layer.with_domain(domain);
    }

    layer
}
