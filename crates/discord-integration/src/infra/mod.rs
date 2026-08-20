//! The one place in this crate allowed to name a `twilight_model`/
//! `twilight_http` type -- discord-integration.md's ACL boundary rule.
//! Everything outside this module speaks only this crate's own domain
//! vocabulary (`discord_client.rs`, `ids.rs`).

mod twilight_client;

pub use twilight_client::TwilightDiscordClient;
