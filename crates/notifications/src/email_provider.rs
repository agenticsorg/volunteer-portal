use std::collections::BTreeMap;

use async_trait::async_trait;

/// One template per trigger, per notifications.md's five-trigger
/// mapping. Rendering (askama, per ADR-0010) happens inside the concrete
/// `EmailProvider` implementation at the `apps/api` composition root --
/// this crate names *which* template, not its markup.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EmailTemplate {
    SignupConfirmation,
    AssignmentApproved,
    HoursApproved,
    MeetingReminder,
    VerificationLetterReady,
}

/// Plain string key/value pairs handed to the template renderer --
/// deliberately not a typed struct per template, since the one
/// `EmailProvider::send` call site (the dispatcher) is generic over
/// which of the five templates it's filling. Concrete keys per template
/// are documented on each template file itself
/// (`apps/api/src/email_templates/*.html`).
#[derive(Debug, Clone, Default)]
pub struct TemplateData(pub BTreeMap<String, String>);

impl TemplateData {
    pub fn new() -> Self {
        Self(BTreeMap::new())
    }

    pub fn insert(mut self, key: &str, value: impl Into<String>) -> Self {
        self.0.insert(key.to_string(), value.into());
        self
    }

    pub fn get(&self, key: &str) -> Option<&str> {
        self.0.get(key).map(String::as_str)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderMessageId(pub String);

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("email delivery failed: {0}")]
pub struct EmailError(pub String);

/// The one place a concrete provider SDK (Postmark preferred, Resend the
/// documented fallback, per ADR-0010) is referenced by type, and only at
/// the `apps/api` composition root -- nowhere else in this crate's
/// domain or application layer.
#[async_trait]
pub trait EmailProvider: Send + Sync {
    async fn send(
        &self,
        to: &str,
        template: EmailTemplate,
        data: TemplateData,
    ) -> Result<ProviderMessageId, EmailError>;
}
