#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum HourEntryError {
    #[error("hours must be a positive value")]
    NonPositiveHours,
    #[error("a single entry cannot exceed 24 hours")]
    ExceedsSingleEntryMax,
    /// The concrete, binding answer to research-findings.md's event-hours
    /// question: an `HourEntry` structurally cannot be constructed against
    /// an `Attendee`-mode assignment, regardless of what the frontend
    /// allows (hours-verification.md).
    #[error("this assignment is not eligible to log hours (not a contributor-mode assignment)")]
    AssignmentNotEligibleForHours,
    #[error("this assignment is not currently approved")]
    AssignmentNotActive,
    #[error("a description is required")]
    DescriptionRequired,
    #[error("only pending entries can be approved or rejected")]
    NotPending,
    #[error("only approved entries can be adjusted")]
    NotApproved,
    #[error("an adjustment reason is required")]
    AdjustmentReasonRequired,
    #[error("actor is not a lead of this entry's project, or an admin")]
    NotAuthorized,
}
