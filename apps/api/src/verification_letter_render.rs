//! ADR-0009: the Typst-based infra-layer PDF renderer for Prompt 6.1's
//! verification letters. Compiles `templates/verification_letter.typ`
//! in-process against a `VerificationLetterDraft` and exports PDF/UA-1
//! tagged PDF bytes -- the `apps/api` handler that calls this streams
//! the result directly in the HTTP response, never to disk or object
//! storage (ADR-0009's "rendered on demand ... never stored").
//!
//! `typst-as-lib`'s `TypstEngine` (font book, standard library, resolved
//! template source) is expensive to build and immutable once built, so
//! it's constructed once per process via `OnceLock`, not per request.

use std::sync::OnceLock;

use chrono::SecondsFormat;
use hours_verification::VerificationLetterDraft;
use typst::foundations::{Array, Dict, IntoValue};
use typst_as_lib::{TypstEngine, TypstTemplateMainFile};
use typst_layout::PagedDocument;
use typst_pdf::{PdfOptions, PdfStandard, PdfStandards};

const TEMPLATE: &str = include_str!("templates/verification_letter.typ");

#[derive(Debug, thiserror::Error)]
pub enum RenderError {
    #[error("verification letter template failed to compile: {0}")]
    Compile(String),
    #[error("verification letter PDF export failed: {0}")]
    Export(String),
}

fn engine() -> &'static TypstEngine<TypstTemplateMainFile> {
    static ENGINE: OnceLock<TypstEngine<TypstTemplateMainFile>> = OnceLock::new();
    ENGINE.get_or_init(|| {
        TypstEngine::builder()
            .main_file(TEMPLATE)
            .fonts(typst_assets::fonts())
            .build()
    })
}

/// All values pre-formatted to plain strings on the Rust side (dates as
/// ISO 8601, `Hours`/totals via `rust_decimal::Decimal::to_string`)
/// rather than handed to Typst as native numeric/date values -- keeps
/// the template's own logic to layout only, and matches this codebase's
/// existing rule that `Hours` never round-trips through anything
/// float-shaped (hours-verification.md).
fn draft_to_inputs(draft: &VerificationLetterDraft) -> Dict {
    let mut projects = Array::new();
    for row in &draft.project_breakdown {
        let mut project = Dict::new();
        project.insert("name".into(), row.project_name.clone().into_value());
        project.insert("hours".into(), row.hours.to_string().into_value());
        projects.push(project.into_value());
    }

    let mut inputs = Dict::new();
    inputs.insert("volunteer_name".into(), draft.volunteer_name.clone().into_value());
    inputs.insert("range_start".into(), draft.range.start.to_string().into_value());
    inputs.insert("range_end".into(), draft.range.end.to_string().into_value());
    inputs.insert("total_hours".into(), draft.total_hours.to_string().into_value());
    inputs.insert(
        "generated_at".into(),
        draft
            .generated_at
            .to_rfc3339_opts(SecondsFormat::Secs, true)
            .into_value(),
    );
    inputs.insert("projects".into(), projects.into_value());
    inputs
}

/// Compiles the letterhead template against `draft` and exports a
/// PDF/UA-1 tagged PDF. Per ADR-0009, the `--pdf-standard ua-1`-
/// equivalent flag here (`PdfStandard::Ua_1`) is not itself sufficient
/// proof of conformance -- the output is validated against a real
/// conformance checker (veraPDF) in
/// `apps/api/tests/verification_letter.rs`.
pub fn render_verification_letter_pdf(draft: &VerificationLetterDraft) -> Result<Vec<u8>, RenderError> {
    let inputs = draft_to_inputs(draft);
    let warned = engine().compile_with_input::<Dict, PagedDocument>(inputs);
    let doc = warned.output.map_err(|err| RenderError::Compile(format!("{err:?}")))?;

    let standards =
        PdfStandards::new(&[PdfStandard::Ua_1]).map_err(|err| RenderError::Export(format!("{err:?}")))?;
    let options = PdfOptions {
        standards,
        ..Default::default()
    };
    typst_pdf::pdf(&doc, &options).map_err(|err| RenderError::Export(format!("{err:?}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn template_uses_exact_brand_colors_and_no_em_en_dashes() {
        for hex in ["#faf8f3", "#ff5a1f", "#1a2a3a", "#5cb8e8"] {
            assert!(
                TEMPLATE.contains(hex),
                "template must use brand color {hex} verbatim, no substitutions (concept.md section 7)"
            );
        }

        // `//`-prefixed lines are Typst comments -- never compiled into
        // rendered copy, so they're outside the "no em/en dash in copy"
        // rule's scope (this codebase's own Rust doc comments freely use
        // "--"). Everything else in this file is markup that reaches the
        // PDF, and gets the real check.
        let rendered_source: String = TEMPLATE
            .lines()
            .filter(|line| !line.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n");

        assert!(
            !rendered_source.contains('\u{2013}'),
            "template's rendered copy must not contain a literal en dash"
        );
        assert!(
            !rendered_source.contains('\u{2014}'),
            "template's rendered copy must not contain a literal em dash"
        );
        // Typst's smart-typography feature auto-converts a literal "--"/
        // "---" in markup text into an en/em dash at compile time -- guard
        // the rendered source against that too, not just the characters.
        assert!(
            !rendered_source.contains("--"),
            "template's rendered markup must not contain \"--\" (Typst renders this as an en/em dash)"
        );
    }

    #[test]
    fn renders_a_real_pdf_for_an_empty_breakdown() {
        let draft = VerificationLetterDraft {
            volunteer_id: kernel::VolunteerId::new(),
            volunteer_name: "Jordan Rivera".to_string(),
            range: hours_verification::DateRange {
                start: chrono::NaiveDate::from_ymd_opt(2026, 1, 1).unwrap(),
                end: chrono::NaiveDate::from_ymd_opt(2026, 1, 31).unwrap(),
            },
            total_hours: rust_decimal::Decimal::ZERO,
            project_breakdown: Vec::new(),
            generated_at: chrono::Utc::now(),
        };
        let bytes = render_verification_letter_pdf(&draft).expect("template must compile against a real draft");
        assert!(bytes.starts_with(b"%PDF-"), "output must be a real PDF");
    }
}
