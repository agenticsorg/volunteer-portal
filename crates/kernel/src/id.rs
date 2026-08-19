use std::fmt;
use std::hash::{Hash, Hasher};
use std::marker::PhantomData;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// A UUID-typed identifier tagged with the aggregate it identifies, so
/// `VolunteerId` and `ProjectId` are distinct types at compile time despite
/// sharing the same runtime representation. `PhantomData<fn() -> T>` keeps
/// `Id<T>` `Send`/`Sync`/variance-friendly regardless of `T`'s own bounds,
/// and every trait below is implemented manually (not derived) so that a
/// concrete `Id<T>` is `Copy`/`Eq`/etc. without requiring `T: Copy`/`T: Eq`
/// — the naive `#[derive(...)]` on a struct with a `PhantomData<T>` field
/// incorrectly propagates those bounds onto `T`.
pub struct Id<T> {
    value: Uuid,
    _marker: PhantomData<fn() -> T>,
}

impl<T> Id<T> {
    pub fn new() -> Self {
        Self {
            value: Uuid::new_v4(),
            _marker: PhantomData,
        }
    }

    pub fn from_uuid(value: Uuid) -> Self {
        Self {
            value,
            _marker: PhantomData,
        }
    }

    pub fn as_uuid(&self) -> Uuid {
        self.value
    }
}

impl<T> Default for Id<T> {
    fn default() -> Self {
        Self::new()
    }
}

impl<T> Clone for Id<T> {
    fn clone(&self) -> Self {
        *self
    }
}

impl<T> Copy for Id<T> {}

impl<T> PartialEq for Id<T> {
    fn eq(&self, other: &Self) -> bool {
        self.value == other.value
    }
}

impl<T> Eq for Id<T> {}

impl<T> PartialOrd for Id<T> {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

impl<T> Ord for Id<T> {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.value.cmp(&other.value)
    }
}

impl<T> Hash for Id<T> {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.value.hash(state);
    }
}

impl<T> fmt::Debug for Id<T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.value)
    }
}

impl<T> fmt::Display for Id<T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.value)
    }
}

impl<T> Serialize for Id<T> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        self.value.serialize(serializer)
    }
}

impl<'de, T> Deserialize<'de> for Id<T> {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        Ok(Self::from_uuid(Uuid::deserialize(deserializer)?))
    }
}

impl<T: Send + Sync> sqlx::Type<sqlx::Postgres> for Id<T> {
    fn type_info() -> sqlx::postgres::PgTypeInfo {
        <Uuid as sqlx::Type<sqlx::Postgres>>::type_info()
    }

    fn compatible(ty: &sqlx::postgres::PgTypeInfo) -> bool {
        <Uuid as sqlx::Type<sqlx::Postgres>>::compatible(ty)
    }
}

impl<'q, T: Send + Sync> sqlx::Encode<'q, sqlx::Postgres> for Id<T> {
    fn encode_by_ref(
        &self,
        buf: &mut sqlx::postgres::PgArgumentBuffer,
    ) -> Result<sqlx::encode::IsNull, sqlx::error::BoxDynError> {
        <Uuid as sqlx::Encode<'q, sqlx::Postgres>>::encode_by_ref(&self.value, buf)
    }
}

impl<'r, T: Send + Sync> sqlx::Decode<'r, sqlx::Postgres> for Id<T> {
    fn decode(value: sqlx::postgres::PgValueRef<'r>) -> Result<Self, sqlx::error::BoxDynError> {
        let value = <Uuid as sqlx::Decode<'r, sqlx::Postgres>>::decode(value)?;
        Ok(Id::from_uuid(value))
    }
}

/// Marker types for each aggregate's identifier. The aggregates themselves
/// are defined in later crates/prompts (per context-map.md's dependency
/// graph, those crates depend on `kernel`, not the reverse), but the typed
/// id aliases live here so `ActorId` and cross-context ports can reference
/// e.g. `VolunteerId` without creating a dependency cycle.
pub struct VolunteerMarker;
pub type VolunteerId = Id<VolunteerMarker>;

pub struct ProjectMarker;
pub type ProjectId = Id<ProjectMarker>;

pub struct AssignmentMarker;
pub type AssignmentId = Id<AssignmentMarker>;

pub struct HourEntryMarker;
pub type HourEntryId = Id<HourEntryMarker>;

pub struct DataSubjectRequestMarker;
pub type DataSubjectRequestId = Id<DataSubjectRequestMarker>;
