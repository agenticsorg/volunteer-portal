use chrono::NaiveDate;
use rust_decimal::Decimal;

use crate::error::HourEntryError;

/// `rust_decimal`, never `f64` — hours feed verification letters and
/// legal/compliance-facing totals (hours-verification.md).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct Hours(Decimal);

impl Hours {
    pub fn new(value: Decimal) -> Result<Self, HourEntryError> {
        if value <= Decimal::ZERO {
            return Err(HourEntryError::NonPositiveHours);
        }
        if value > Decimal::from(24) {
            // Catches obvious fat-finger entry; does not block legitimate
            // multi-day rollups, which are always per-date rows.
            return Err(HourEntryError::ExceedsSingleEntryMax);
        }
        Ok(Hours(value))
    }

    pub fn value(&self) -> Decimal {
        self.0
    }
}

impl std::ops::Add for Hours {
    type Output = Decimal;
    fn add(self, rhs: Hours) -> Decimal {
        self.0 + rhs.0
    }
}

/// An inclusive date range, feeding `find_approved_by_volunteer_and_range`
/// (Prompt 4.1) and `VerificationLetterService::draft` (Prompt 6.1).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DateRange {
    pub start: NaiveDate,
    pub end: NaiveDate,
}
