use chrono::{DateTime, Utc};
use kernel::{DataSubjectRequestId, DomainEvent, VolunteerId};
use serde::{Deserialize, Serialize};

use crate::events::{CompletionMethod, DataSubjectRequestCompleted, DataSubjectRequestReceived};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum RequestType {
    Export,
    Deletion,
}

impl RequestType {
    pub fn as_str(&self) -> &'static str {
        match self {
            RequestType::Export => "export",
            RequestType::Deletion => "deletion",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "export" => Some(RequestType::Export),
            "deletion" => Some(RequestType::Deletion),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum RequestStatus {
    Received,
    InProgress,
    Completed,
    Rejected,
}

impl RequestStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            RequestStatus::Received => "received",
            RequestStatus::InProgress => "in_progress",
            RequestStatus::Completed => "completed",
            RequestStatus::Rejected => "rejected",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "received" => Some(RequestStatus::Received),
            "in_progress" => Some(RequestStatus::InProgress),
            "completed" => Some(RequestStatus::Completed),
            "rejected" => Some(RequestStatus::Rejected),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum DataSubjectRequestError {
    #[error("request is not in the Received status")]
    NotReceived,
    #[error("request is not InProgress")]
    NotInProgress,
    #[error("request is already resolved (Completed or Rejected)")]
    AlreadyResolved,
    #[error("a rejection requires a non-empty rejection_reason")]
    EmptyRejectionReason,
}

/// compliance-audit.md's `DataSubjectRequest` aggregate: models a
/// PIPEDA/GDPR export or deletion request as a first-class process with
/// a lifecycle, not an ad hoc admin action run once and forgotten.
pub struct DataSubjectRequest {
    id: DataSubjectRequestId,
    volunteer_id: VolunteerId,
    request_type: RequestType,
    status: RequestStatus,
    requested_at: DateTime<Utc>,
    completed_at: Option<DateTime<Utc>>,
    handled_by: Option<VolunteerId>,
    rejection_reason: Option<String>,
    pending_events: Vec<Box<dyn DomainEvent>>,
}

impl std::fmt::Debug for DataSubjectRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DataSubjectRequest")
            .field("id", &self.id)
            .field("volunteer_id", &self.volunteer_id)
            .field("request_type", &self.request_type)
            .field("status", &self.status)
            .field("requested_at", &self.requested_at)
            .field("completed_at", &self.completed_at)
            .field("handled_by", &self.handled_by)
            .field("rejection_reason", &self.rejection_reason)
            .field("pending_events_count", &self.pending_events.len())
            .finish()
    }
}

impl DataSubjectRequest {
    /// The only constructor for a *new* request -- a volunteer filing
    /// their own export or deletion request. Always starts `Received`
    /// (invariant 1).
    pub fn receive(volunteer_id: VolunteerId, request_type: RequestType) -> Self {
        let id = DataSubjectRequestId::new();
        let now = Utc::now();
        Self {
            id,
            volunteer_id,
            request_type,
            status: RequestStatus::Received,
            requested_at: now,
            completed_at: None,
            handled_by: None,
            rejection_reason: None,
            pending_events: vec![Box::new(DataSubjectRequestReceived {
                request_id: id,
                volunteer_id,
                request_type,
                occurred_at: now,
            })],
        }
    }

    /// Rehydrates from persisted state. Never produces pending events --
    /// loading is not a domain action.
    #[allow(clippy::too_many_arguments)]
    pub fn from_persisted(
        id: DataSubjectRequestId,
        volunteer_id: VolunteerId,
        request_type: RequestType,
        status: RequestStatus,
        requested_at: DateTime<Utc>,
        completed_at: Option<DateTime<Utc>>,
        handled_by: Option<VolunteerId>,
        rejection_reason: Option<String>,
    ) -> Self {
        Self {
            id,
            volunteer_id,
            request_type,
            status,
            requested_at,
            completed_at,
            handled_by,
            rejection_reason,
            pending_events: Vec::new(),
        }
    }

    pub fn id(&self) -> DataSubjectRequestId {
        self.id
    }
    pub fn volunteer_id(&self) -> VolunteerId {
        self.volunteer_id
    }
    pub fn request_type(&self) -> RequestType {
        self.request_type
    }
    pub fn status(&self) -> RequestStatus {
        self.status
    }
    pub fn requested_at(&self) -> DateTime<Utc> {
        self.requested_at
    }
    pub fn completed_at(&self) -> Option<DateTime<Utc>> {
        self.completed_at
    }
    pub fn handled_by(&self) -> Option<VolunteerId> {
        self.handled_by
    }
    pub fn rejection_reason(&self) -> Option<&str> {
        self.rejection_reason.as_deref()
    }

    /// An admin claims a `Received` request to begin working it.
    /// `handled_by` must already resolve to `Role::Admin` -- checked by
    /// the caller's `AdminUser` extractor before this runs (ADR-0002's
    /// pattern), not re-checked here. Emits no domain event: the row's
    /// own `status` is the record, and no event in compliance-audit.md's
    /// "Domain events" list corresponds to this transition.
    pub fn start(&mut self, handled_by: VolunteerId) -> Result<(), DataSubjectRequestError> {
        if self.status != RequestStatus::Received {
            return Err(DataSubjectRequestError::NotReceived);
        }
        self.status = RequestStatus::InProgress;
        self.handled_by = Some(handled_by);
        Ok(())
    }

    /// Invariant 3: `handled_by` required before `Completed`. Only legal
    /// from `InProgress` (invariant 1: `Received -> InProgress ->
    /// Completed`). The actual export/anonymization work happens
    /// elsewhere (`apps/api`'s handler, per this file's module doc) --
    /// this method only records that resolution happened and how.
    pub fn complete(
        &mut self,
        handled_by: VolunteerId,
        method: CompletionMethod,
    ) -> Result<(), DataSubjectRequestError> {
        if self.status != RequestStatus::InProgress {
            return Err(DataSubjectRequestError::NotInProgress);
        }
        let now = Utc::now();
        self.status = RequestStatus::Completed;
        self.handled_by = Some(handled_by);
        self.completed_at = Some(now);
        self.pending_events.push(Box::new(DataSubjectRequestCompleted {
            request_id: self.id,
            handled_by,
            method,
            occurred_at: now,
        }));
        Ok(())
    }

    /// Invariant 2: narrow grounds (a live legal hold or unresolved
    /// dispute involving the volunteer's own records) -- guidance for the
    /// handling admin, not enforced here as a closed reason enum.
    /// Invariant 1: legal from `Received` or `InProgress`, never from a
    /// resolved state. Invariant 1: requires a non-empty
    /// `rejection_reason` -- enforced here *and* by the migration's CHECK
    /// constraint (defense in depth, matching this codebase's existing
    /// pattern of enforcing invariants at both the domain and schema
    /// layer where the schema can cheaply express them). Emits no domain
    /// event, matching `start` above -- the row's own `status` and
    /// `rejection_reason` are the record.
    pub fn reject(&mut self, handled_by: VolunteerId, reason: String) -> Result<(), DataSubjectRequestError> {
        if matches!(self.status, RequestStatus::Completed | RequestStatus::Rejected) {
            return Err(DataSubjectRequestError::AlreadyResolved);
        }
        if reason.trim().is_empty() {
            return Err(DataSubjectRequestError::EmptyRejectionReason);
        }
        self.status = RequestStatus::Rejected;
        self.handled_by = Some(handled_by);
        self.rejection_reason = Some(reason);
        Ok(())
    }

    /// Drains and returns every domain event recorded since the last
    /// call -- the repository's `save()` implementation calls this
    /// exactly once per persisted mutation.
    pub fn take_events(&mut self) -> Vec<Box<dyn DomainEvent>> {
        std::mem::take(&mut self.pending_events)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn receive_starts_in_received_and_emits_received_event() {
        let volunteer_id = VolunteerId::new();
        let mut req = DataSubjectRequest::receive(volunteer_id, RequestType::Export);
        assert_eq!(req.status(), RequestStatus::Received);
        assert_eq!(req.handled_by(), None);
        let events = req.take_events();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event_type(), "data_subject_request_received");
    }

    // Invariant 1: Received -> InProgress -> Completed.
    #[test]
    fn full_happy_path_reaches_completed() {
        let volunteer_id = VolunteerId::new();
        let admin_id = VolunteerId::new();
        let mut req = DataSubjectRequest::receive(volunteer_id, RequestType::Deletion);
        req.take_events();
        req.start(admin_id).unwrap();
        assert_eq!(req.status(), RequestStatus::InProgress);
        req.complete(admin_id, CompletionMethod::Anonymized).unwrap();
        assert_eq!(req.status(), RequestStatus::Completed);
        assert_eq!(req.handled_by(), Some(admin_id));
        assert!(req.completed_at().is_some());
        let events = req.take_events();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event_type(), "data_subject_request_completed");
    }

    #[test]
    fn cannot_complete_directly_from_received() {
        let mut req = DataSubjectRequest::receive(VolunteerId::new(), RequestType::Export);
        let err = req.complete(VolunteerId::new(), CompletionMethod::Exported).unwrap_err();
        assert_eq!(err, DataSubjectRequestError::NotInProgress);
    }

    // Invariant 1: Received/InProgress -> Rejected, both legal.
    #[test]
    fn reject_legal_from_received() {
        let mut req = DataSubjectRequest::receive(VolunteerId::new(), RequestType::Export);
        req.reject(VolunteerId::new(), "open code-of-conduct investigation".to_string()).unwrap();
        assert_eq!(req.status(), RequestStatus::Rejected);
    }

    #[test]
    fn reject_legal_from_in_progress() {
        let mut req = DataSubjectRequest::receive(VolunteerId::new(), RequestType::Export);
        let admin_id = VolunteerId::new();
        req.start(admin_id).unwrap();
        req.reject(admin_id, "open dispute".to_string()).unwrap();
        assert_eq!(req.status(), RequestStatus::Rejected);
    }

    // Invariant 1: a resolved request cannot be rejected again.
    #[test]
    fn cannot_reject_an_already_completed_request() {
        let mut req = DataSubjectRequest::receive(VolunteerId::new(), RequestType::Export);
        let admin_id = VolunteerId::new();
        req.start(admin_id).unwrap();
        req.complete(admin_id, CompletionMethod::Exported).unwrap();
        let err = req.reject(admin_id, "too late".to_string()).unwrap_err();
        assert_eq!(err, DataSubjectRequestError::AlreadyResolved);
    }

    // Invariant 1: Rejected requires a non-empty rejection_reason.
    #[test]
    fn reject_refuses_an_empty_reason() {
        let mut req = DataSubjectRequest::receive(VolunteerId::new(), RequestType::Export);
        let err = req.reject(VolunteerId::new(), "   ".to_string()).unwrap_err();
        assert_eq!(err, DataSubjectRequestError::EmptyRejectionReason);
        assert_eq!(req.status(), RequestStatus::Received);
    }

    // Invariant 3: handled_by is set by the transition that requires it.
    #[test]
    fn handled_by_is_none_until_first_admin_action() {
        let req = DataSubjectRequest::receive(VolunteerId::new(), RequestType::Export);
        assert_eq!(req.handled_by(), None);
    }
}
