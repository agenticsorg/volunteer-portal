//! ADR-0010: Resend, the documented fallback `EmailProvider`, via the
//! official `resend-rs` SDK -- swapped in behind the exact same trait as
//! `PostmarkEmailProvider`, per that ADR's "a contained change behind a
//! single internal email-sending trait/module."

use async_trait::async_trait;
use notifications::{EmailError, EmailProvider, EmailTemplate, ProviderMessageId, TemplateData};
use resend_rs::types::CreateEmailBaseOptions;
use resend_rs::Resend;

use crate::email_templates;

pub struct ResendEmailProvider {
    client: Resend,
    from_address: String,
}

impl ResendEmailProvider {
    pub fn new(api_key: &str, from_address: String) -> Self {
        Self {
            client: Resend::new(api_key),
            from_address,
        }
    }
}

#[async_trait]
impl EmailProvider for ResendEmailProvider {
    async fn send(
        &self,
        to: &str,
        template: EmailTemplate,
        data: TemplateData,
    ) -> Result<ProviderMessageId, EmailError> {
        let (subject, html_body) =
            email_templates::render(template, &data).map_err(|e| EmailError(e.to_string()))?;

        let options = CreateEmailBaseOptions::new(self.from_address.clone(), [to.to_string()], subject)
            .with_html(&html_body);

        let response = self
            .client
            .emails
            .send(options)
            .await
            .map_err(|e| EmailError(format!("Resend request failed: {e}")))?;

        Ok(ProviderMessageId(response.id.to_string()))
    }
}
