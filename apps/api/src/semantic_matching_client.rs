//! ADR-0013 / Prompt 9.1: the Rust-side client for the isolated
//! `services/semantic-matching` TypeScript service (the second and last
//! sanctioned TypeScript exception, per that ADR). A trait, not a bare
//! HTTP struct, specifically so `apps/api/tests/semantic_matching.rs`
//! can inject a fake that returns an attacker-chosen suggestion --
//! proving the authorization re-check in
//! `apps/api/src/semantic_matching.rs` actually filters it, per Prompt
//! 9.1's explicit exit criterion ("a test specifically attempts to leak
//! a suggestion result to a user unauthorized to see the underlying
//! project/volunteer").
//!
//! This client (and the service behind it) is read-only and carries no
//! authorization context whatsoever -- every id it returns is
//! re-validated by the caller under that caller's own RLS-scoped
//! transaction before ever reaching an HTTP response.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("semantic matching service error: {0}")]
pub struct SemanticMatchError(pub String);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Collection {
    Projects,
    Volunteers,
}

impl Collection {
    fn as_str(self) -> &'static str {
        match self {
            Collection::Projects => "projects",
            Collection::Volunteers => "volunteers",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MatchItem {
    pub id: Uuid,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct MatchResult {
    pub id: Uuid,
    pub score: f64,
}

/// The deterministic SQL directory search (`projects::list_open_projects`,
/// unchanged and unaware this trait exists) must remain fully functional
/// with this layer disabled or erroring, per Prompt 9.1 -- every caller
/// of this trait maps `Err` to a clean failure of *only* the new
/// suggestion endpoint, never anything the deterministic search depends
/// on.
#[async_trait]
pub trait SemanticMatchClient: Send + Sync {
    async fn index(&self, collection: Collection, items: &[MatchItem]) -> Result<(), SemanticMatchError>;

    async fn match_query(
        &self,
        collection: Collection,
        query: &str,
        limit: usize,
    ) -> Result<Vec<MatchResult>, SemanticMatchError>;

    /// Ranks a caller-supplied, already-authorized candidate set --
    /// backs the "which of your own open assignments should you log
    /// hours against" suggestion, where the candidate set is the
    /// caller's own approved assignments, resolved before this is ever
    /// called.
    async fn match_candidates(
        &self,
        query: &str,
        candidates: &[MatchItem],
        limit: usize,
    ) -> Result<Vec<MatchResult>, SemanticMatchError>;
}

/// Always returns no suggestions, never errors -- the concrete proof
/// that this layer is additive, not load-bearing (ADR-0013): every test
/// file that doesn't exercise semantic matching directly wires this in,
/// and the rest of the application (including
/// `projects::list_open_projects`'s deterministic SQL search) works
/// identically regardless. Also a legitimate production option for an
/// operator who wants the feature off without running
/// `services/semantic-matching` at all.
pub struct NullSemanticMatchClient;

#[async_trait]
impl SemanticMatchClient for NullSemanticMatchClient {
    async fn index(&self, _collection: Collection, _items: &[MatchItem]) -> Result<(), SemanticMatchError> {
        Ok(())
    }

    async fn match_query(
        &self,
        _collection: Collection,
        _query: &str,
        _limit: usize,
    ) -> Result<Vec<MatchResult>, SemanticMatchError> {
        Ok(Vec::new())
    }

    async fn match_candidates(
        &self,
        _query: &str,
        _candidates: &[MatchItem],
        _limit: usize,
    ) -> Result<Vec<MatchResult>, SemanticMatchError> {
        Ok(Vec::new())
    }
}

pub struct HttpSemanticMatchClient {
    client: reqwest::Client,
    base_url: String,
}

impl HttpSemanticMatchClient {
    pub fn new(base_url: String) -> Self {
        Self {
            client: reqwest::Client::new(),
            base_url,
        }
    }
}

#[derive(Serialize)]
struct WireItem<'a> {
    id: Uuid,
    text: &'a str,
}

#[derive(Deserialize)]
struct WireMatchResult {
    id: String,
    score: f64,
}

#[derive(Serialize)]
struct IndexRequest<'a> {
    collection: &'static str,
    items: Vec<WireItem<'a>>,
}

#[derive(Deserialize)]
struct IndexResponse {
    #[allow(dead_code)]
    count: usize,
}

#[derive(Serialize)]
struct MatchRequest<'a> {
    collection: &'static str,
    query: &'a str,
    limit: usize,
}

#[derive(Serialize)]
struct MatchCandidatesRequest<'a> {
    query: &'a str,
    candidates: Vec<WireItem<'a>>,
    limit: usize,
}

#[derive(Deserialize)]
struct MatchResponse {
    results: Vec<WireMatchResult>,
}

fn parse_results(results: Vec<WireMatchResult>) -> Result<Vec<MatchResult>, SemanticMatchError> {
    results
        .into_iter()
        .map(|r| {
            Uuid::parse_str(&r.id)
                .map(|id| MatchResult { id, score: r.score })
                .map_err(|e| SemanticMatchError(format!("service returned a non-UUID id: {e}")))
        })
        .collect()
}

#[async_trait]
impl SemanticMatchClient for HttpSemanticMatchClient {
    async fn index(&self, collection: Collection, items: &[MatchItem]) -> Result<(), SemanticMatchError> {
        let body = IndexRequest {
            collection: collection.as_str(),
            items: items.iter().map(|i| WireItem { id: i.id, text: &i.text }).collect(),
        };
        self.client
            .post(format!("{}/index", self.base_url))
            .json(&body)
            .send()
            .await
            .map_err(|e| SemanticMatchError(format!("index request failed: {e}")))?
            .error_for_status()
            .map_err(|e| SemanticMatchError(format!("index request returned an error status: {e}")))?
            .json::<IndexResponse>()
            .await
            .map_err(|e| SemanticMatchError(format!("index response was not valid JSON: {e}")))?;
        Ok(())
    }

    async fn match_query(
        &self,
        collection: Collection,
        query: &str,
        limit: usize,
    ) -> Result<Vec<MatchResult>, SemanticMatchError> {
        let body = MatchRequest {
            collection: collection.as_str(),
            query,
            limit,
        };
        let response = self
            .client
            .post(format!("{}/match", self.base_url))
            .json(&body)
            .send()
            .await
            .map_err(|e| SemanticMatchError(format!("match request failed: {e}")))?
            .error_for_status()
            .map_err(|e| SemanticMatchError(format!("match request returned an error status: {e}")))?
            .json::<MatchResponse>()
            .await
            .map_err(|e| SemanticMatchError(format!("match response was not valid JSON: {e}")))?;
        parse_results(response.results)
    }

    async fn match_candidates(
        &self,
        query: &str,
        candidates: &[MatchItem],
        limit: usize,
    ) -> Result<Vec<MatchResult>, SemanticMatchError> {
        let body = MatchCandidatesRequest {
            query,
            candidates: candidates.iter().map(|i| WireItem { id: i.id, text: &i.text }).collect(),
            limit,
        };
        let response = self
            .client
            .post(format!("{}/match-candidates", self.base_url))
            .json(&body)
            .send()
            .await
            .map_err(|e| SemanticMatchError(format!("match-candidates request failed: {e}")))?
            .error_for_status()
            .map_err(|e| SemanticMatchError(format!("match-candidates request returned an error status: {e}")))?
            .json::<MatchResponse>()
            .await
            .map_err(|e| SemanticMatchError(format!("match-candidates response was not valid JSON: {e}")))?;
        parse_results(response.results)
    }
}
