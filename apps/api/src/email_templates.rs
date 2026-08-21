//! ADR-0010: the five brand-compliant HTML email templates, compile-time
//! checked via `askama`. Rendering happens here, at the composition
//! root, not in `crates/notifications` -- that crate names *which*
//! template and *what* data (`notifications::EmailTemplate`/
//! `TemplateData`); turning that into markup is infra.
//!
//! Brand compliance (concept.md section 7): cream `#faf8f3` page
//! background, orange `#ff5a1f` CTA buttons, navy `#1a2a3a` content
//! card, cyan `#5cb8e8` accent label, no palette substitutions, no
//! em/en dashes in copy -- verified by this module's own tests against
//! every template file's raw source.

use askama::Template;
use notifications::{EmailTemplate, TemplateData};

#[derive(Template)]
#[template(path = "email/signup_confirmation.html")]
struct SignupConfirmation<'a> {
    name: &'a str,
}

#[derive(Template)]
#[template(path = "email/assignment_approved.html")]
struct AssignmentApproved<'a> {
    name: &'a str,
    project_name: &'a str,
}

#[derive(Template)]
#[template(path = "email/hours_approved.html")]
struct HoursApproved<'a> {
    name: &'a str,
    hours: &'a str,
    date: &'a str,
}

#[derive(Template)]
#[template(path = "email/meeting_reminder.html")]
struct MeetingReminder<'a> {
    name: &'a str,
    project_name: &'a str,
    next_occurrence_at: &'a str,
}

#[derive(Template)]
#[template(path = "email/verification_letter_ready.html")]
struct VerificationLetterReady<'a> {
    name: &'a str,
    range_start: &'a str,
    range_end: &'a str,
}

#[derive(Debug, thiserror::Error)]
#[error("template rendering failed: {0}")]
pub struct TemplateRenderError(String);

fn field<'a>(data: &'a TemplateData, key: &str) -> &'a str {
    data.get(key).unwrap_or_default()
}

/// Renders `template` against `data`, returning `(subject, html_body)`.
/// The only place `notifications::EmailTemplate`'s five variants are
/// matched against actual markup.
pub fn render(template: EmailTemplate, data: &TemplateData) -> Result<(String, String), TemplateRenderError> {
    let (subject, html) = match template {
        EmailTemplate::SignupConfirmation => (
            "Welcome to the Agentics Foundation".to_string(),
            SignupConfirmation { name: field(data, "name") }.render(),
        ),
        EmailTemplate::AssignmentApproved => (
            "Your assignment has been approved".to_string(),
            AssignmentApproved {
                name: field(data, "name"),
                project_name: field(data, "project_name"),
            }
            .render(),
        ),
        EmailTemplate::HoursApproved => (
            "Your volunteer hours have been approved".to_string(),
            HoursApproved {
                name: field(data, "name"),
                hours: field(data, "hours"),
                date: field(data, "date"),
            }
            .render(),
        ),
        EmailTemplate::MeetingReminder => (
            format!("Reminder: {}", field(data, "project_name")),
            MeetingReminder {
                name: field(data, "name"),
                project_name: field(data, "project_name"),
                next_occurrence_at: field(data, "next_occurrence_at"),
            }
            .render(),
        ),
        EmailTemplate::VerificationLetterReady => (
            "Your verification letter is ready".to_string(),
            VerificationLetterReady {
                name: field(data, "name"),
                range_start: field(data, "range_start"),
                range_end: field(data, "range_end"),
            }
            .render(),
        ),
    };
    Ok((subject, html.map_err(|e| TemplateRenderError(e.to_string()))?))
}

#[cfg(test)]
mod tests {
    use super::*;

    const TEMPLATE_SOURCES: &[&str] = &[
        include_str!("../templates/email/signup_confirmation.html"),
        include_str!("../templates/email/assignment_approved.html"),
        include_str!("../templates/email/hours_approved.html"),
        include_str!("../templates/email/meeting_reminder.html"),
        include_str!("../templates/email/verification_letter_ready.html"),
    ];

    #[test]
    fn every_template_uses_exact_brand_colors_and_no_em_en_dashes() {
        for source in TEMPLATE_SOURCES {
            for hex in ["#faf8f3", "#ff5a1f", "#1a2a3a", "#5cb8e8"] {
                assert!(source.contains(hex), "every email template must use brand color {hex} verbatim: {source}");
            }
            assert!(!source.contains('\u{2013}'), "template copy must not contain an en dash: {source}");
            assert!(!source.contains('\u{2014}'), "template copy must not contain an em dash: {source}");
            assert!(!source.contains("--"), "template copy must not contain \"--\": {source}");
        }
    }

    #[test]
    fn every_template_renders_successfully_with_placeholder_data() {
        let data = TemplateData::new()
            .insert("name", "Jordan Rivera")
            .insert("project_name", "Trail Cleanup")
            .insert("hours", "3.00")
            .insert("date", "2026-01-15")
            .insert("next_occurrence_at", "2026-02-01T18:00:00Z")
            .insert("range_start", "2026-01-01")
            .insert("range_end", "2026-01-31");

        for template in [
            EmailTemplate::SignupConfirmation,
            EmailTemplate::AssignmentApproved,
            EmailTemplate::HoursApproved,
            EmailTemplate::MeetingReminder,
            EmailTemplate::VerificationLetterReady,
        ] {
            let (subject, html) = render(template, &data).expect("every template must render against complete data");
            assert!(!subject.is_empty());
            assert!(html.contains("Jordan Rivera"));
        }
    }
}
