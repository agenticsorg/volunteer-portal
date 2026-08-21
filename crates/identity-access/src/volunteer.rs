use chrono::{DateTime, Utc};
use kernel::{DataSubjectRequestId, DomainEvent, Skill, VolunteerId};
use serde::{Deserialize, Serialize};

use crate::events::{OAuthAccountLinked, RoleChanged, VolunteerAnonymized, VolunteerApproved, VolunteerOnboarded};
use crate::oauth::{OAuthLink, OAuthProvider};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum VolunteerStatus {
    PendingApproval,
    Approved,
    Suspended,
}

impl VolunteerStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            VolunteerStatus::PendingApproval => "pending_approval",
            VolunteerStatus::Approved => "approved",
            VolunteerStatus::Suspended => "suspended",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "pending_approval" => Some(VolunteerStatus::PendingApproval),
            "approved" => Some(VolunteerStatus::Approved),
            "suspended" => Some(VolunteerStatus::Suspended),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Role {
    Volunteer,
    Lead,
    Admin,
}

impl Role {
    pub fn as_str(&self) -> &'static str {
        match self {
            Role::Volunteer => "volunteer",
            Role::Lead => "lead",
            Role::Admin => "admin",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "volunteer" => Some(Role::Volunteer),
            "lead" => Some(Role::Lead),
            "admin" => Some(Role::Admin),
            _ => None,
        }
    }
}

/// concept.md's "availability" is not specified beyond a free-text/
/// structured slot summary; kept as an opaque JSON value object rather
/// than an exhaustively-enumerated shape, per identity-access.md.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Availability(pub serde_json::Value);

impl Availability {
    pub fn empty() -> Self {
        Self(serde_json::json!({}))
    }
}

/// All three fields are written once, together, at signup (concept.md
/// section 3's form captures them in one submission). The age
/// attestation is a timestamp of *confirmation*, not a stored date of
/// birth — this is a checkbox attestation, not age verification
/// (identity-access.md).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Agreements {
    pub code_of_conduct_accepted_at: Option<DateTime<Utc>>,
    pub ip_agreement_accepted_at: Option<DateTime<Utc>>,
    pub age_attestation_confirmed_at: Option<DateTime<Utc>>,
}

impl Agreements {
    pub fn is_complete(&self) -> bool {
        self.code_of_conduct_accepted_at.is_some()
            && self.ip_agreement_accepted_at.is_some()
            && self.age_attestation_confirmed_at.is_some()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum VolunteerError {
    #[error("invalid email address")]
    InvalidEmail,
    #[error("volunteer is not pending approval")]
    NotPendingApproval,
    #[error("cannot approve: agreements are incomplete")]
    IncompleteAgreements,
    #[error("volunteer is not approved")]
    NotApproved,
    #[error("volunteer is not suspended")]
    NotSuspended,
    #[error("cannot change role while suspended")]
    SuspendedCannotChangeRole,
    #[error("an authenticated session for the existing account is required to link a second provider")]
    LinkingRequiresAuthenticatedSession,
}

/// The Identity & Access aggregate root. Every mutating method returns
/// its own typed error on invariant violation and, on success, appends
/// the resulting domain event to an internal buffer drained by
/// `take_events()` — the repository's `save()` calls this to hand events
/// to the `apps/api` audit/outbox framework (ADR-0005), per
/// identity-access.md's repository port shape.
pub struct Volunteer {
    id: VolunteerId,
    name: String,
    email: String,
    discord_id: Option<String>,
    timezone: String,
    skills: Vec<Skill>,
    availability: Availability,
    /// ADR-0014's Phase 2 addition: self-reported country/region,
    /// collected on the signup form so Phase 10's GDPR Art. 27
    /// EU-volunteer-count monitoring trigger has data to check against.
    /// Not required at OAuth signup time (Prompt 1.5) — set when the
    /// volunteer completes onboarding (`complete_onboarding`, below).
    country_region: Option<String>,
    status: VolunteerStatus,
    role: Role,
    agreements: Agreements,
    oauth_links: Vec<OAuthLink>,
    created_at: DateTime<Utc>,
    pending_events: Vec<Box<dyn DomainEvent>>,
}

impl std::fmt::Debug for Volunteer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Box<dyn DomainEvent> isn't Debug, so pending_events is reported
        // only as a count rather than deriving this impl.
        f.debug_struct("Volunteer")
            .field("id", &self.id)
            .field("name", &self.name)
            .field("email", &self.email)
            .field("discord_id", &self.discord_id)
            .field("timezone", &self.timezone)
            .field("skills", &self.skills)
            .field("availability", &self.availability)
            .field("country_region", &self.country_region)
            .field("status", &self.status)
            .field("role", &self.role)
            .field("agreements", &self.agreements)
            .field("oauth_links", &self.oauth_links)
            .field("created_at", &self.created_at)
            .field("pending_events_count", &self.pending_events.len())
            .finish()
    }
}

fn validate_email(email: String) -> Result<String, VolunteerError> {
    let trimmed = email.trim();
    let at = trimmed.find('@');
    let valid = match at {
        Some(pos) => {
            let (local, domain) = trimmed.split_at(pos);
            let domain = &domain[1..];
            !local.is_empty()
                && domain.contains('.')
                && !domain.starts_with('.')
                && !domain.ends_with('.')
                && !trimmed.chars().any(char::is_whitespace)
        }
        None => false,
    };
    if valid {
        Ok(trimmed.to_string())
    } else {
        Err(VolunteerError::InvalidEmail)
    }
}

#[allow(clippy::too_many_arguments)]
impl Volunteer {
    /// The only constructor. Creates a new `Volunteer` with exactly one
    /// `OAuthLink` (whichever provider was used first), per
    /// identity-access.md's account-linking design.
    pub fn signup(
        name: String,
        email: String,
        timezone: String,
        skills: Vec<Skill>,
        availability: Availability,
        provider: OAuthProvider,
        provider_user_id: String,
        provider_email: String,
        provider_email_verified: bool,
    ) -> Result<Self, VolunteerError> {
        let email = validate_email(email)?;
        let id = VolunteerId::new();
        let now = Utc::now();

        let link = OAuthLink {
            provider,
            provider_user_id,
            email_at_link_time: provider_email,
            email_verified: provider_email_verified,
            linked_at: now,
        };

        let discord_id = match provider {
            OAuthProvider::Discord => Some(link.provider_user_id.clone()),
            OAuthProvider::Google => None,
        };

        let event = VolunteerOnboarded {
            volunteer_id: id,
            name: name.clone(),
            email: email.clone(),
            provider,
            occurred_at: now,
        };

        Ok(Self {
            id,
            name,
            email,
            discord_id,
            timezone,
            skills,
            availability,
            country_region: None,
            status: VolunteerStatus::PendingApproval,
            role: Role::Volunteer,
            agreements: Agreements::default(),
            oauth_links: vec![link],
            created_at: now,
            pending_events: vec![Box::new(event)],
        })
    }

    /// Rehydrates a `Volunteer` from persisted state. Never used to
    /// construct a *new* volunteer — that is `signup`'s job alone — and
    /// never produces pending events (loading is not a domain action).
    #[allow(clippy::too_many_arguments)]
    pub fn from_persisted(
        id: VolunteerId,
        name: String,
        email: String,
        discord_id: Option<String>,
        timezone: String,
        skills: Vec<Skill>,
        availability: Availability,
        country_region: Option<String>,
        status: VolunteerStatus,
        role: Role,
        agreements: Agreements,
        oauth_links: Vec<OAuthLink>,
        created_at: DateTime<Utc>,
    ) -> Self {
        Self {
            id,
            name,
            email,
            discord_id,
            timezone,
            skills,
            availability,
            country_region,
            status,
            role,
            agreements,
            oauth_links,
            created_at,
            pending_events: Vec::new(),
        }
    }

    pub fn id(&self) -> VolunteerId {
        self.id
    }
    pub fn name(&self) -> &str {
        &self.name
    }
    pub fn email(&self) -> &str {
        &self.email
    }
    pub fn discord_id(&self) -> Option<&str> {
        self.discord_id.as_deref()
    }
    pub fn timezone(&self) -> &str {
        &self.timezone
    }
    pub fn skills(&self) -> &[Skill] {
        &self.skills
    }
    pub fn availability(&self) -> &Availability {
        &self.availability
    }
    pub fn country_region(&self) -> Option<&str> {
        self.country_region.as_deref()
    }
    pub fn status(&self) -> VolunteerStatus {
        self.status
    }
    pub fn role(&self) -> Role {
        self.role
    }
    pub fn agreements(&self) -> &Agreements {
        &self.agreements
    }
    pub fn oauth_links(&self) -> &[OAuthLink] {
        &self.oauth_links
    }
    pub fn created_at(&self) -> DateTime<Utc> {
        self.created_at
    }

    /// Records the three agreement acceptances captured together at
    /// signup submission (concept.md section 3). Does not itself emit a
    /// domain event distinct from `VolunteerOnboarded` — the acceptances
    /// are part of that same signup action, not a separate command.
    pub fn record_agreements(&mut self, agreements: Agreements) {
        self.agreements = agreements;
    }

    /// concept.md section 3's signup form, submitted as one action after
    /// the initial OAuth round-trip (Prompt 1.5) has already created the
    /// bare `Volunteer` row: profile fields plus all three agreement
    /// acceptances together, in one submission — matching `Agreements`'
    /// own "written once, together" design. Does not change `status`;
    /// approval remains a separate, admin-only action (`approve`).
    #[allow(clippy::too_many_arguments)]
    pub fn complete_onboarding(
        &mut self,
        name: String,
        timezone: String,
        skills: Vec<Skill>,
        availability: Availability,
        country_region: Option<String>,
        agreements: Agreements,
    ) {
        self.name = name;
        self.timezone = timezone;
        self.skills = skills;
        self.availability = availability;
        self.country_region = country_region;
        self.agreements = agreements;
    }

    /// Invariant 1: `status` can only become `Approved` if all three
    /// `Agreements` fields are `Some`. Invariant 5: only meaningful from
    /// `PendingApproval` — a `Suspended` volunteer must go through
    /// `reactivate`, not this method, to return to `Approved`.
    pub fn approve(&mut self, approved_by: VolunteerId) -> Result<(), VolunteerError> {
        if self.status != VolunteerStatus::PendingApproval {
            return Err(VolunteerError::NotPendingApproval);
        }
        if !self.agreements.is_complete() {
            return Err(VolunteerError::IncompleteAgreements);
        }
        self.status = VolunteerStatus::Approved;
        self.pending_events.push(Box::new(VolunteerApproved {
            volunteer_id: self.id,
            approved_by,
            occurred_at: Utc::now(),
        }));
        Ok(())
    }

    /// Invariant 5: `Approved ⇄ Suspended` only.
    pub fn suspend(&mut self) -> Result<(), VolunteerError> {
        if self.status != VolunteerStatus::Approved {
            return Err(VolunteerError::NotApproved);
        }
        self.status = VolunteerStatus::Suspended;
        Ok(())
    }

    /// The `Suspended -> Approved` half of invariant 5's `Approved ⇄
    /// Suspended` transition — distinct from `approve`, which is only
    /// the initial `PendingApproval -> Approved` admin action.
    pub fn reactivate(&mut self) -> Result<(), VolunteerError> {
        if self.status != VolunteerStatus::Suspended {
            return Err(VolunteerError::NotSuspended);
        }
        self.status = VolunteerStatus::Approved;
        Ok(())
    }

    /// Invariant 3: `role` changes only via this explicit command, never
    /// as a side effect of another operation. Invariant 5: refused while
    /// `Suspended`.
    pub fn change_role(
        &mut self,
        new_role: Role,
        changed_by: VolunteerId,
    ) -> Result<(), VolunteerError> {
        if self.status == VolunteerStatus::Suspended {
            return Err(VolunteerError::SuspendedCannotChangeRole);
        }
        let previous_role = self.role;
        self.role = new_role;
        self.pending_events.push(Box::new(RoleChanged {
            volunteer_id: self.id,
            previous_role,
            new_role,
            changed_by,
            occurred_at: Utc::now(),
        }));
        Ok(())
    }

    /// The **only** way a second `OAuthLink` is added (identity-access.md).
    /// `confirming_session_volunteer_id` is the caller's *own* already-
    /// authenticated identity — the caller must already be signed in as
    /// this exact volunteer for the link to be accepted, never triggered
    /// by an unauthenticated callback matching on email alone (ADR-0007's
    /// manual-linking policy).
    pub fn link_additional_provider(
        &mut self,
        provider: OAuthProvider,
        provider_user_id: String,
        provider_email: String,
        provider_email_verified: bool,
        confirming_session_volunteer_id: VolunteerId,
    ) -> Result<(), VolunteerError> {
        if confirming_session_volunteer_id != self.id {
            return Err(VolunteerError::LinkingRequiresAuthenticatedSession);
        }
        let now = Utc::now();
        let link = OAuthLink {
            provider,
            provider_user_id: provider_user_id.clone(),
            email_at_link_time: provider_email,
            email_verified: provider_email_verified,
            linked_at: now,
        };
        if provider == OAuthProvider::Discord {
            self.discord_id = Some(provider_user_id);
        }
        self.oauth_links.push(link);
        self.pending_events.push(Box::new(OAuthAccountLinked {
            volunteer_id: self.id,
            provider,
            occurred_at: now,
        }));
        Ok(())
    }

    /// compliance-audit.md's "Deletion invariant": anonymization in
    /// place, never physical row deletion. `id`, agreement timestamps,
    /// `role`, and `created_at` are retained -- the *fact* they once
    /// agreed to the code of conduct at a given time is itself a record
    /// worth keeping, distinct from their identity. Every other
    /// personally identifying field is overwritten with a tombstone
    /// value; `oauth_links` becomes empty so `VolunteerRepository::save`
    /// removes the corresponding `identity` rows (which carry
    /// `email_at_link_time`, itself PII) rather than orphaning them.
    ///
    /// Called only by the `DataSubjectRequest` completion flow
    /// (`apps/api`'s handler, orchestrating `compliance-audit`'s
    /// `DataSubjectRequest` and this repository's `save` in one
    /// transaction -- `compliance-audit` depends on `identity-access`
    /// but not the reverse, per context-map.md's acyclic graph, so the
    /// orchestration lives at the composition root, not inside either
    /// context), never as a general-purpose profile edit -- this is why
    /// it pushes a distinct `VolunteerAnonymized` event rather than
    /// reusing any other `Volunteer` mutation event above.
    pub fn anonymize(mut self, request_id: DataSubjectRequestId, anonymized_by: VolunteerId) -> Volunteer {
        self.name = "[deleted volunteer]".to_string();
        self.email = format!("deleted-{}@invalid", self.id);
        self.discord_id = None;
        self.timezone = "UTC".to_string();
        self.skills = Vec::new();
        self.availability = Availability::empty();
        self.country_region = None;
        self.oauth_links = Vec::new();
        self.status = VolunteerStatus::Suspended;
        self.pending_events.push(Box::new(VolunteerAnonymized {
            volunteer_id: self.id,
            request_id,
            anonymized_by,
            occurred_at: Utc::now(),
        }));
        self
    }

    /// Drains and returns every domain event recorded since the last
    /// call — the repository's `save()` implementation calls this
    /// exactly once per persisted mutation and hands the result to the
    /// `apps/api` audit/outbox framework.
    pub fn take_events(&mut self) -> Vec<Box<dyn DomainEvent>> {
        std::mem::take(&mut self.pending_events)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn signup() -> Volunteer {
        Volunteer::signup(
            "Ada Lovelace".to_string(),
            "ada@example.org".to_string(),
            "America/Toronto".to_string(),
            vec![],
            Availability::empty(),
            OAuthProvider::Discord,
            "discord-123".to_string(),
            "ada@example.org".to_string(),
            true,
        )
        .unwrap()
    }

    fn complete_agreements() -> Agreements {
        let now = Utc::now();
        Agreements {
            code_of_conduct_accepted_at: Some(now),
            ip_agreement_accepted_at: Some(now),
            age_attestation_confirmed_at: Some(now),
        }
    }

    // Invariant 1: status can only become Approved with complete Agreements.
    #[test]
    fn approve_refused_with_incomplete_agreements() {
        let mut v = signup();
        let err = v.approve(v.id()).unwrap_err();
        assert_eq!(err, VolunteerError::IncompleteAgreements);
        assert_eq!(v.status(), VolunteerStatus::PendingApproval);
    }

    #[test]
    fn approve_succeeds_with_complete_agreements() {
        let mut v = signup();
        v.record_agreements(complete_agreements());
        v.approve(v.id()).unwrap();
        assert_eq!(v.status(), VolunteerStatus::Approved);
    }

    // Invariant 2: email must be syntactically valid.
    #[test]
    fn signup_refused_with_invalid_email() {
        let err = Volunteer::signup(
            "Ada".to_string(),
            "not-an-email".to_string(),
            "UTC".to_string(),
            vec![],
            Availability::empty(),
            OAuthProvider::Discord,
            "d1".to_string(),
            "not-an-email".to_string(),
            true,
        )
        .unwrap_err();
        assert_eq!(err, VolunteerError::InvalidEmail);
    }

    // Invariant 3: role changes only via change_role, never as a side
    // effect of approve().
    #[test]
    fn approve_does_not_change_role() {
        let mut v = signup();
        v.record_agreements(complete_agreements());
        let admin_id = VolunteerId::new();
        v.approve(admin_id).unwrap();
        assert_eq!(v.role(), Role::Volunteer);
    }

    #[test]
    fn change_role_emits_role_changed_event() {
        let mut v = signup();
        v.record_agreements(complete_agreements());
        let admin_id = VolunteerId::new();
        v.approve(admin_id).unwrap();
        v.take_events();
        v.change_role(Role::Lead, admin_id).unwrap();
        assert_eq!(v.role(), Role::Lead);
        let events = v.take_events();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event_type(), "role_changed");
    }

    // Invariant 4 (discord_id uniqueness) is enforced at the
    // repository/schema level (unique index), not exercised here.

    // Invariant 5: status transitions.
    #[test]
    fn suspended_volunteer_cannot_be_approved_directly() {
        let mut v = signup();
        v.record_agreements(complete_agreements());
        v.approve(v.id()).unwrap();
        v.suspend().unwrap();
        let err = v.approve(v.id()).unwrap_err();
        assert_eq!(err, VolunteerError::NotPendingApproval);
    }

    #[test]
    fn suspended_volunteer_reactivates_back_to_approved() {
        let mut v = signup();
        v.record_agreements(complete_agreements());
        v.approve(v.id()).unwrap();
        v.suspend().unwrap();
        v.reactivate().unwrap();
        assert_eq!(v.status(), VolunteerStatus::Approved);
    }

    #[test]
    fn suspended_volunteer_cannot_change_role() {
        let mut v = signup();
        v.record_agreements(complete_agreements());
        v.approve(v.id()).unwrap();
        v.suspend().unwrap();
        let err = v.change_role(Role::Lead, v.id()).unwrap_err();
        assert_eq!(err, VolunteerError::SuspendedCannotChangeRole);
    }

    #[test]
    fn pending_approval_cannot_be_suspended_directly() {
        let mut v = signup();
        let err = v.suspend().unwrap_err();
        assert_eq!(err, VolunteerError::NotApproved);
    }

    #[test]
    fn link_additional_provider_requires_own_authenticated_session() {
        let mut v = signup();
        let attacker_session = VolunteerId::new();
        let err = v
            .link_additional_provider(
                OAuthProvider::Google,
                "google-999".to_string(),
                "ada@example.org".to_string(),
                true,
                attacker_session,
            )
            .unwrap_err();
        assert_eq!(err, VolunteerError::LinkingRequiresAuthenticatedSession);
        assert_eq!(v.oauth_links().len(), 1);
    }

    #[test]
    fn link_additional_provider_succeeds_with_own_session() {
        let mut v = signup();
        let self_id = v.id();
        v.link_additional_provider(
            OAuthProvider::Google,
            "google-999".to_string(),
            "ada@example.org".to_string(),
            true,
            self_id,
        )
        .unwrap();
        assert_eq!(v.oauth_links().len(), 2);
    }

    #[test]
    fn anonymize_tombstones_every_identifying_field_and_emits_volunteer_anonymized() {
        let mut v = signup();
        v.record_agreements(complete_agreements());
        let admin_id = VolunteerId::new();
        v.approve(admin_id).unwrap();
        v.take_events();
        let request_id = kernel::DataSubjectRequestId::new();
        let original_id = v.id();
        let original_created_at = v.created_at();
        let original_agreements = v.agreements().clone();

        let anonymized = v.anonymize(request_id, admin_id);

        assert_eq!(anonymized.id(), original_id, "id must be retained");
        assert_eq!(anonymized.created_at(), original_created_at, "created_at must be retained");
        assert_eq!(anonymized.agreements(), &original_agreements, "agreement timestamps must be retained");
        assert_eq!(anonymized.name(), "[deleted volunteer]");
        assert!(anonymized.email().starts_with("deleted-") && anonymized.email().ends_with("@invalid"));
        assert_eq!(anonymized.discord_id(), None);
        assert!(anonymized.skills().is_empty());
        assert!(anonymized.oauth_links().is_empty());
        assert_eq!(anonymized.country_region(), None);
        assert_eq!(anonymized.status(), VolunteerStatus::Suspended);
    }

    #[test]
    fn anonymize_emits_exactly_one_volunteer_anonymized_event() {
        let mut v = signup();
        v.take_events();
        let admin_id = VolunteerId::new();
        let request_id = kernel::DataSubjectRequestId::new();

        let mut anonymized = v.anonymize(request_id, admin_id);
        let events = anonymized.take_events();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event_type(), "volunteer_anonymized");
    }

    #[test]
    fn signup_emits_volunteer_onboarded_event() {
        let mut v = signup();
        let events = v.take_events();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event_type(), "volunteer_onboarded");
    }
}
