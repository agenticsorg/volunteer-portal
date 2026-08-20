use identity_access::VolunteerRepository;
use kernel::RepoError;
use sqlx::{Postgres, Transaction};

use crate::ids::DiscordUserId;

/// **Corrected design** (discord-integration.md, amended 2026-08-20,
/// Phase 5 architecture-consistency review): `handle_link` performs no
/// mutation and calls no Identity & Access linking port. A bare,
/// cryptographically-verified Discord interaction proves control of the
/// Discord account issuing `/link`, but nothing about which `Volunteer`
/// the invoker is already authenticated as on the web, and it is not
/// itself an OAuth handshake for a second provider --
/// `Volunteer::link_additional_provider` requires both, per ADR-0007.
/// Every actual linking mutation continues to flow exclusively through
/// the existing, already-reviewed web flow (Prompts 1.5/2.2); this
/// handler only tells the volunteer whether they're already linked.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkStatus {
    AlreadyLinked,
    NotLinked,
}

pub struct LinkCommandHandler<V> {
    volunteers: V,
}

impl<V: VolunteerRepository> LinkCommandHandler<V> {
    pub fn new(volunteers: V) -> Self {
        Self { volunteers }
    }

    /// `discord_user_id` is already extracted from an interaction
    /// verified (Ed25519 signature check) at the Axum HTTP layer per
    /// Discord's interactions webhook contract -- that verification is
    /// infra, not domain, and never reaches this method. The read is
    /// System-actor-scoped (`kernel::ScopedDb::begin_system_scoped`,
    /// Prompt 5.1) -- a raw Discord interaction has no corresponding
    /// authenticated web session to scope the transaction as.
    pub async fn handle_link(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        discord_user_id: &DiscordUserId,
    ) -> Result<LinkStatus, RepoError> {
        let existing = self.volunteers.find_by_discord_id(tx, &discord_user_id.0).await?;
        Ok(if existing.is_some() {
            LinkStatus::AlreadyLinked
        } else {
            LinkStatus::NotLinked
        })
    }
}
