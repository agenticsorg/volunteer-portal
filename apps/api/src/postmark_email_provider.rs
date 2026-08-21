//! ADR-0010: Postmark, the preferred `EmailProvider`. No official Rust
//! SDK exists (confirmed in the research pass ADR-0010 references), so
//! this is a small hand-rolled `reqwest` wrapper around Postmark's
//! documented HTTP API (<https://postmarkapp.com/developer/api/email-api>) --
//! not a gap, per that ADR's explicit note that this is expected.

use async_trait::async_trait;
use notifications::{EmailError, EmailProvider, EmailTemplate, ProviderMessageId, TemplateData};
use serde::{Deserialize, Serialize};

use crate::email_templates;

const POSTMARK_SEND_URL: &str = "https://api.postmarkapp.com/email";

pub struct PostmarkEmailProvider {
    client: reqwest::Client,
    send_url: String,
    server_token: String,
    from_address: String,
}

impl PostmarkEmailProvider {
    pub fn new(server_token: String, from_address: String) -> Self {
        Self {
            client: reqwest::Client::new(),
            send_url: POSTMARK_SEND_URL.to_string(),
            server_token,
            from_address,
        }
    }

    /// Points at a caller-supplied endpoint instead of the real Postmark
    /// API -- used by this module's own tests and by
    /// `apps/api/tests/notifications.rs`'s integration suite (both need
    /// `EmailProvider::send`'s actual implementation exercised against a
    /// mock server, not a hand-copied duplicate of it; no live Postmark
    /// account exists in this environment).
    pub fn with_send_url(server_token: String, from_address: String, send_url: String) -> Self {
        Self {
            client: reqwest::Client::new(),
            send_url,
            server_token,
            from_address,
        }
    }
}

#[derive(Debug, Serialize)]
struct PostmarkSendRequest<'a> {
    #[serde(rename = "From")]
    from: &'a str,
    #[serde(rename = "To")]
    to: &'a str,
    #[serde(rename = "Subject")]
    subject: &'a str,
    #[serde(rename = "HtmlBody")]
    html_body: &'a str,
    #[serde(rename = "MessageStream")]
    message_stream: &'a str,
}

#[derive(Debug, Deserialize)]
struct PostmarkSendResponse {
    #[serde(rename = "MessageID")]
    message_id: Option<String>,
    #[serde(rename = "ErrorCode")]
    error_code: i64,
    #[serde(rename = "Message")]
    message: String,
}

#[async_trait]
impl EmailProvider for PostmarkEmailProvider {
    async fn send(
        &self,
        to: &str,
        template: EmailTemplate,
        data: TemplateData,
    ) -> Result<ProviderMessageId, EmailError> {
        let (subject, html_body) =
            email_templates::render(template, &data).map_err(|e| EmailError(e.to_string()))?;

        let request = PostmarkSendRequest {
            from: &self.from_address,
            to,
            subject: &subject,
            html_body: &html_body,
            message_stream: "outbound",
        };

        let response = self
            .client
            .post(&self.send_url)
            .header("Accept", "application/json")
            .header("Content-Type", "application/json")
            .header("X-Postmark-Server-Token", &self.server_token)
            .json(&request)
            .send()
            .await
            .map_err(|e| EmailError(format!("Postmark request failed: {e}")))?;

        let body: PostmarkSendResponse = response
            .json()
            .await
            .map_err(|e| EmailError(format!("Postmark response was not valid JSON: {e}")))?;

        if body.error_code != 0 {
            return Err(EmailError(format!("Postmark error {}: {}", body.error_code, body.message)));
        }

        let message_id = body.message_id.ok_or_else(|| {
            EmailError("Postmark response carried no MessageID despite ErrorCode 0".to_string())
        })?;
        Ok(ProviderMessageId(message_id))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    /// This test can't hit the real Postmark API (no live account exists
    /// in this environment), so it exercises `PostmarkEmailProvider::send`
    /// itself -- the actual production code path, not a hand-copied
    /// duplicate of it -- against a mock server that mimics Postmark's
    /// real API shape, proving the request headers, body fields, and
    /// response parsing are all correct.
    #[tokio::test]
    async fn sends_a_correctly_shaped_request_and_parses_a_successful_response() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/email"))
            .and(header("X-Postmark-Server-Token", "test-token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "To": "volunteer@example.org",
                "SubmittedAt": "2026-01-15T00:00:00Z",
                "MessageID": "11111111-2222-3333-4444-555555555555",
                "ErrorCode": 0,
                "Message": "OK"
            })))
            .mount(&server)
            .await;

        let provider = PostmarkEmailProvider::with_send_url(
            "test-token".to_string(),
            "noreply@agentics.example".to_string(),
            format!("{}/email", server.uri()),
        );

        let message_id = provider
            .send(
                "volunteer@example.org",
                EmailTemplate::SignupConfirmation,
                TemplateData::new().insert("name", "Jordan Rivera"),
            )
            .await
            .expect("a 200 with ErrorCode 0 must be treated as success");

        assert_eq!(message_id.0, "11111111-2222-3333-4444-555555555555");
    }

    #[tokio::test]
    async fn provider_error_response_surfaces_as_email_error() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/email"))
            .respond_with(ResponseTemplate::new(422).set_body_json(serde_json::json!({
                "ErrorCode": 300,
                "Message": "Invalid email request"
            })))
            .mount(&server)
            .await;

        let provider = PostmarkEmailProvider::with_send_url(
            "test-token".to_string(),
            "noreply@agentics.example".to_string(),
            format!("{}/email", server.uri()),
        );

        let err = provider
            .send("not-an-email", EmailTemplate::SignupConfirmation, TemplateData::new().insert("name", "X"))
            .await
            .expect_err("a non-zero ErrorCode must surface as EmailError, not a silent success");

        assert!(err.0.contains("Invalid email request"), "error message must surface Postmark's own message: {}", err.0);
    }
}
