use serde::{Deserialize, Serialize};

/// A free-text skill label (e.g. "React", "Figma"). Shared vocabulary
/// between `identity-access` (`Volunteer.skills`) and
/// `projects-assignments` (`Project.needed_skills`) — lives in `kernel`
/// rather than being duplicated per crate.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Skill(String);

impl Skill {
    pub fn new(value: impl Into<String>) -> Result<Self, SkillError> {
        let value = value.into();
        let trimmed = value.trim();
        if trimmed.is_empty() {
            return Err(SkillError::Empty);
        }
        Ok(Self(trimmed.to_string()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for Skill {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum SkillError {
    #[error("skill label must not be empty")]
    Empty,
}
