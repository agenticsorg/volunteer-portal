use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum OAuthProvider {
    Discord,
    Google,
}

impl OAuthProvider {
    pub fn as_str(&self) -> &'static str {
        match self {
            OAuthProvider::Discord => "discord",
            OAuthProvider::Google => "google",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "discord" => Some(OAuthProvider::Discord),
            "google" => Some(OAuthProvider::Google),
            _ => None,
        }
    }
}

/// One row per linked provider identity. Per ADR-0007, `email_verified`
/// is captured at link time from the provider (Discord's `verified`
/// field / Google's OIDC `email_verified` claim) and is never treated as
/// mutable after the fact — a later change to the provider's own email
/// verification state does not retroactively alter this snapshot.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OAuthLink {
    pub provider: OAuthProvider,
    pub provider_user_id: String,
    pub email_at_link_time: String,
    pub email_verified: bool,
    pub linked_at: DateTime<Utc>,
}
