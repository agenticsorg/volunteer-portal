//! Discord OAuth2 (ADR-0007). The real flow is implemented against
//! Discord's actual endpoints via the `oauth2` crate; a `DiscordOAuthClient`
//! port keeps the callback handler's logic (CSRF/PKCE verification,
//! volunteer lookup-or-signup, audit wiring, session issuance) testable
//! without a live Discord app — no Discord credentials are available in
//! this environment, so integration tests exercise the real handler logic
//! against a `FakeDiscordOAuthClient`, per the project's stated approach
//! for missing external credentials.

use async_trait::async_trait;
use oauth2::basic::BasicClient;
use oauth2::{
    AuthUrl, AuthorizationCode, ClientId, ClientSecret, CsrfToken, EndpointNotSet, EndpointSet,
    PkceCodeChallenge, PkceCodeVerifier, RedirectUrl, Scope, TokenResponse, TokenUrl,
};
use serde::Deserialize;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiscordUserInfo {
    pub id: String,
    pub username: String,
    pub email: Option<String>,
    pub verified: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum OAuthError {
    #[error("csrf state mismatch")]
    StateMismatch,
    #[error("no pending oauth flow for this session")]
    NoPendingFlow,
    #[error("oauth token exchange failed: {0}")]
    TokenExchange(String),
    #[error("failed to fetch user info: {0}")]
    UserInfo(String),
}

/// Everything the axum handlers need from a Discord OAuth flow, behind a
/// port so the handler logic is testable without a live Discord app.
#[async_trait]
pub trait DiscordOAuthClient: Send + Sync {
    /// Builds the URL to redirect the browser to, plus the CSRF token and
    /// PKCE verifier the caller must persist (in the session) to validate
    /// the callback.
    fn authorize_url(&self) -> (oauth2::url::Url, CsrfToken, PkceCodeVerifier);

    async fn exchange_code(
        &self,
        code: String,
        pkce_verifier: PkceCodeVerifier,
    ) -> Result<String, OAuthError>;

    async fn fetch_user(&self, access_token: &str) -> Result<DiscordUserInfo, OAuthError>;
}

type ConfiguredClient =
    BasicClient<EndpointSet, EndpointNotSet, EndpointNotSet, EndpointNotSet, EndpointSet>;

pub struct RealDiscordOAuthClient {
    client: ConfiguredClient,
    http_client: reqwest::Client,
}

impl RealDiscordOAuthClient {
    pub fn new(client_id: String, client_secret: String, redirect_uri: String) -> Self {
        let client = BasicClient::new(ClientId::new(client_id))
            .set_client_secret(ClientSecret::new(client_secret))
            .set_auth_uri(
                AuthUrl::new("https://discord.com/api/oauth2/authorize".to_string())
                    .expect("static Discord authorize URL must be valid"),
            )
            .set_token_uri(
                TokenUrl::new("https://discord.com/api/oauth2/token".to_string())
                    .expect("static Discord token URL must be valid"),
            )
            .set_redirect_uri(
                RedirectUrl::new(redirect_uri).expect("DISCORD_REDIRECT_URI must be a valid URL"),
            );

        let http_client = reqwest::ClientBuilder::new()
            // Following redirects on the token endpoint opens the client
            // up to SSRF; matches the oauth2 crate's own documented
            // guidance in its examples.
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("reqwest client must build");

        Self { client, http_client }
    }
}

#[derive(Deserialize)]
struct DiscordUserResponse {
    id: String,
    username: String,
    email: Option<String>,
    #[serde(default)]
    verified: bool,
}

#[async_trait]
impl DiscordOAuthClient for RealDiscordOAuthClient {
    fn authorize_url(&self) -> (oauth2::url::Url, CsrfToken, PkceCodeVerifier) {
        let (pkce_challenge, pkce_verifier) = PkceCodeChallenge::new_random_sha256();
        let (url, csrf_token) = self
            .client
            .authorize_url(CsrfToken::new_random)
            .add_scope(Scope::new("identify".to_string()))
            .add_scope(Scope::new("email".to_string()))
            .set_pkce_challenge(pkce_challenge)
            .url();
        (url, csrf_token, pkce_verifier)
    }

    async fn exchange_code(
        &self,
        code: String,
        pkce_verifier: PkceCodeVerifier,
    ) -> Result<String, OAuthError> {
        let token = self
            .client
            .exchange_code(AuthorizationCode::new(code))
            .set_pkce_verifier(pkce_verifier)
            .request_async(&self.http_client)
            .await
            .map_err(|e| OAuthError::TokenExchange(e.to_string()))?;
        Ok(token.access_token().secret().clone())
    }

    async fn fetch_user(&self, access_token: &str) -> Result<DiscordUserInfo, OAuthError> {
        let resp = self
            .http_client
            .get("https://discord.com/api/users/@me")
            .bearer_auth(access_token)
            .send()
            .await
            .map_err(|e| OAuthError::UserInfo(e.to_string()))?
            .error_for_status()
            .map_err(|e| OAuthError::UserInfo(e.to_string()))?
            .json::<DiscordUserResponse>()
            .await
            .map_err(|e| OAuthError::UserInfo(e.to_string()))?;

        Ok(DiscordUserInfo {
            id: resp.id,
            username: resp.username,
            email: resp.email,
            verified: resp.verified,
        })
    }
}

// --- Google OIDC (Prompt 2.2, ADR-0007) -------------------------------

use openidconnect::core::{CoreClient, CoreIdTokenClaims, CoreProviderMetadata};
use openidconnect::{
    AuthenticationFlow, ClientId as OidcClientId, ClientSecret as OidcClientSecret,
    CsrfToken as OidcCsrfToken, IssuerUrl, Nonce, RedirectUrl as OidcRedirectUrl, Scope as OidcScope,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GoogleUserInfo {
    pub subject: String,
    pub email: Option<String>,
    pub email_verified: bool,
    pub name: Option<String>,
}

/// Mirrors `DiscordOAuthClient`'s shape. `nonce` (Google/OIDC's
/// replay-protection value, checked against the ID token's own `nonce`
/// claim during verification) plays the same session-persisted role PKCE
/// plays for Discord's plain-OAuth2 flow.
#[async_trait]
pub trait GoogleOAuthClient: Send + Sync {
    fn authorize_url(&self) -> (oauth2::url::Url, CsrfToken, Nonce);

    /// Exchanges the code, verifies the returned ID token's signature
    /// against Google's JWKS and its `aud`/`iss`/`exp`/`nonce` claims
    /// (ADR-0007's named Phase 1/2 security-review priority — this is
    /// the entire reason `openidconnect`, not a bare `oauth2` token
    /// exchange, is used for Google), and returns the verified claims.
    async fn exchange_code(&self, code: String, nonce: Nonce) -> Result<GoogleUserInfo, OAuthError>;
}

pub struct RealGoogleOAuthClient {
    client: CoreClient<
        oauth2::EndpointSet,
        oauth2::EndpointNotSet,
        oauth2::EndpointNotSet,
        oauth2::EndpointNotSet,
        oauth2::EndpointMaybeSet,
        oauth2::EndpointMaybeSet,
    >,
    http_client: reqwest::Client,
}

impl RealGoogleOAuthClient {
    /// Async because it performs OpenID Connect Discovery (fetching
    /// Google's `.well-known/openid-configuration` document and its
    /// JWKS) at construction time, once, at application startup — not
    /// per-request.
    pub async fn new(
        client_id: String,
        client_secret: String,
        redirect_uri: String,
    ) -> Result<Self, String> {
        let http_client = reqwest::ClientBuilder::new()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|e| e.to_string())?;

        let issuer_url = IssuerUrl::new("https://accounts.google.com".to_string())
            .expect("static Google issuer URL must be valid");

        let provider_metadata = CoreProviderMetadata::discover_async(issuer_url, &http_client)
            .await
            .map_err(|e| format!("Google OIDC discovery failed: {e}"))?;

        let client = CoreClient::from_provider_metadata(
            provider_metadata,
            OidcClientId::new(client_id),
            Some(OidcClientSecret::new(client_secret)),
        )
        .set_redirect_uri(
            OidcRedirectUrl::new(redirect_uri).map_err(|e| e.to_string())?,
        );

        Ok(Self { client, http_client })
    }
}

#[async_trait]
impl GoogleOAuthClient for RealGoogleOAuthClient {
    fn authorize_url(&self) -> (oauth2::url::Url, CsrfToken, Nonce) {
        let (url, csrf_token, nonce) = self
            .client
            .authorize_url(
                AuthenticationFlow::<openidconnect::core::CoreResponseType>::AuthorizationCode,
                OidcCsrfToken::new_random,
                Nonce::new_random,
            )
            .add_scope(OidcScope::new("email".to_string()))
            .add_scope(OidcScope::new("profile".to_string()))
            .url();
        (url, csrf_token, nonce)
    }

    async fn exchange_code(&self, code: String, nonce: Nonce) -> Result<GoogleUserInfo, OAuthError> {
        let token_response = self
            .client
            .exchange_code(openidconnect::AuthorizationCode::new(code))
            .map_err(|e| OAuthError::TokenExchange(e.to_string()))?
            .request_async(&self.http_client)
            .await
            .map_err(|e| OAuthError::TokenExchange(e.to_string()))?;

        let id_token = token_response
            .extra_fields()
            .id_token()
            .ok_or_else(|| OAuthError::TokenExchange("Google did not return an ID token".to_string()))?;

        let verifier = self.client.id_token_verifier();
        let claims: &CoreIdTokenClaims = id_token
            .claims(&verifier, &nonce)
            .map_err(|e| OAuthError::TokenExchange(format!("ID token verification failed: {e}")))?;

        Ok(GoogleUserInfo {
            subject: claims.subject().to_string(),
            email: claims.email().map(|e| e.to_string()),
            email_verified: claims.email_verified().unwrap_or(false),
            name: claims
                .name()
                .and_then(|n| n.get(None))
                .map(|n| n.to_string()),
        })
    }
}
