//! The concrete `notifications::DiscordDmSender` implementation --
//! delegates to `discord_integration::DiscordNotificationSender`
//! (`TwilightDiscordClient`, Prompt 5.1's `twilight-http`-backed client),
//! the same cross-sibling-crate adapter shape used throughout Phase 7.
//! Not called by this crate's v1 dispatch flow (see
//! `notifications::TriggerType`'s doc comment) -- wired here so the port
//! shape is proven end-to-end (`discord_dm_adapter.rs`'s own tests)
//! ahead of a later phase actually exercising it in the dispatcher.

use async_trait::async_trait;
use discord_integration::{DiscordNotificationSender, DiscordUserId};
use notifications::{DiscordDeliveryError, DiscordDmSender, DmContent};

pub struct TwilightDmAdapter<T: DiscordNotificationSender> {
    client: T,
}

impl<T: DiscordNotificationSender> TwilightDmAdapter<T> {
    pub fn new(client: T) -> Self {
        Self { client }
    }
}

#[async_trait]
impl<T: DiscordNotificationSender + Send + Sync> DiscordDmSender for TwilightDmAdapter<T> {
    async fn send_dm(&self, discord_user_id: &str, message: DmContent) -> Result<(), DiscordDeliveryError> {
        self.client
            .send_dm(&DiscordUserId(discord_user_id.to_string()), &message.0)
            .await
            .map_err(|err| DiscordDeliveryError(err.0))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use discord_integration::DiscordApiError;
    use std::sync::Mutex;

    /// No live Discord bot token exists in this environment (same
    /// constraint as Prompt 5.1's `reconcile_discord_roles.rs`), so this
    /// proves the adapter's plumbing -- id wrapping, message pass-
    /// through, error mapping -- without a real network call.
    struct FakeDiscordNotificationSender {
        calls: Mutex<Vec<(DiscordUserId, String)>>,
        result: Result<(), DiscordApiError>,
    }

    #[async_trait]
    impl DiscordNotificationSender for FakeDiscordNotificationSender {
        async fn send_dm(&self, discord_id: &DiscordUserId, content: &str) -> Result<(), DiscordApiError> {
            self.calls.lock().unwrap().push((discord_id.clone(), content.to_string()));
            self.result.clone()
        }
    }

    #[tokio::test]
    async fn forwards_the_id_and_message_and_maps_success() {
        let fake = FakeDiscordNotificationSender {
            calls: Mutex::new(Vec::new()),
            result: Ok(()),
        };
        let adapter = TwilightDmAdapter::new(fake);

        adapter
            .send_dm("123456789", DmContent("Your hours were approved.".to_string()))
            .await
            .expect("a successful send must map to Ok");

        let calls = adapter.client.calls.lock().unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].0, DiscordUserId("123456789".to_string()));
        assert_eq!(calls[0].1, "Your hours were approved.");
    }

    #[tokio::test]
    async fn maps_a_discord_api_error_to_discord_delivery_error() {
        let fake = FakeDiscordNotificationSender {
            calls: Mutex::new(Vec::new()),
            result: Err(DiscordApiError("user has DMs disabled".to_string())),
        };
        let adapter = TwilightDmAdapter::new(fake);

        let err = adapter
            .send_dm("123456789", DmContent("Reminder".to_string()))
            .await
            .expect_err("a failed send must map to Err, not panic or silently succeed");
        assert_eq!(err.0, "user has DMs disabled");
    }
}
