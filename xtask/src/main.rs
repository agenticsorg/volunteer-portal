//! ADR-0002's lint pass: "flag `Json<...>`-accepting handlers on
//! mutating HTTP methods lacking a recognized extractor type". Used as a
//! proxy for "mutating handler" here: a handler that accepts a `Json<T>`
//! request body is, in practice, always a mutating (POST/PUT/PATCH/
//! DELETE) handler in this codebase — tracing HTTP-method-to-handler
//! wiring statically through `Router::route(...)` registrations is a
//! substantially harder static-analysis problem for comparatively little
//! extra precision, so this narrower, cheaper check is the "where
//! feasible" version ADR-0002 asks for, not a full custom clippy lint
//! (which would require a nightly toolchain and rustc-dev components).
//!
//! Run via `cargo run -p xtask -- check-handlers`.

use std::path::Path;
use std::process::ExitCode;

use syn::visit::Visit;
use syn::{FnArg, ItemFn, Pat, PatType, Type};

const RECOGNIZED_EXTRACTORS: &[&str] = &["AuthUser", "LeadOf", "AdminUser"];

struct Violation {
    file: String,
    line: usize,
    function: String,
}

struct HandlerVisitor<'a> {
    file: &'a str,
    violations: Vec<Violation>,
}

fn type_name(ty: &Type) -> Option<String> {
    if let Type::Path(type_path) = ty {
        type_path.path.segments.last().map(|s| s.ident.to_string())
    } else {
        None
    }
}

fn arg_binding_name(pat: &Pat) -> Option<String> {
    match pat {
        Pat::Ident(ident) => Some(ident.ident.to_string()),
        // Extractors are frequently destructured directly in the
        // signature, e.g. `AuthUser(user_id): AuthUser` — the type
        // annotation (checked separately) is what matters there; a tuple
        // struct pattern like `AuthUser(user_id)` also names the
        // extractor via its own path.
        Pat::TupleStruct(pat) => pat.path.segments.last().map(|s| s.ident.to_string()),
        _ => None,
    }
}

impl<'a> Visit<'a> for HandlerVisitor<'a> {
    fn visit_item_fn(&mut self, node: &'a ItemFn) {
        let mut accepts_json = false;
        let mut has_recognized_extractor = false;

        for input in &node.sig.inputs {
            if let FnArg::Typed(PatType { ty, pat, .. }) = input {
                if let Some(name) = type_name(ty) {
                    if name == "Json" {
                        accepts_json = true;
                    }
                    if RECOGNIZED_EXTRACTORS.contains(&name.as_str()) {
                        has_recognized_extractor = true;
                    }
                }
                // Also recognize an extractor named via the argument's own
                // binding pattern (covers `AuthUser(user_id): AuthUser`
                // where the type is already checked above, and guards
                // against a bare pattern match without an explicit type
                // path segment in unusual formatting).
                if let Some(name) = arg_binding_name(pat) {
                    if RECOGNIZED_EXTRACTORS.contains(&name.as_str()) {
                        has_recognized_extractor = true;
                    }
                }
            }
        }

        if accepts_json && !has_recognized_extractor {
            self.violations.push(Violation {
                file: self.file.to_string(),
                line: node.sig.fn_token.span.start().line,
                function: node.sig.ident.to_string(),
            });
        }

        syn::visit::visit_item_fn(self, node);
    }
}

fn check_source(content: &str, label: &str) -> Vec<Violation> {
    let Ok(file) = syn::parse_file(content) else {
        // Non-fatal: a file that doesn't parse as valid Rust is caught by
        // `cargo check` anyway; this lint doesn't need to duplicate that.
        return Vec::new();
    };
    let mut visitor = HandlerVisitor {
        file: label,
        violations: Vec::new(),
    };
    visitor.visit_file(&file);
    visitor.violations
}

fn check_file(path: &Path) -> Vec<Violation> {
    let content = std::fs::read_to_string(path).expect("read source file");
    check_source(&content, &path.display().to_string())
}

fn main() -> ExitCode {
    let root = Path::new("apps/api/src");
    if !root.exists() {
        eprintln!("xtask check-handlers: {} not found (run from the workspace root)", root.display());
        return ExitCode::FAILURE;
    }

    let mut violations = Vec::new();
    for entry in walkdir::WalkDir::new(root) {
        let entry = entry.expect("walk apps/api/src");
        if entry.file_type().is_file() && entry.path().extension().is_some_and(|e| e == "rs") {
            violations.extend(check_file(entry.path()));
        }
    }

    if violations.is_empty() {
        println!("xtask check-handlers: OK — every Json-accepting handler names a recognized auth extractor");
        ExitCode::SUCCESS
    } else {
        eprintln!("xtask check-handlers: FAILED — the following handlers accept a Json body but name no recognized extractor (AuthUser/LeadOf/AdminUser), per ADR-0002:");
        for v in &violations {
            eprintln!("  {}:{} fn {}", v.file, v.line, v.function);
        }
        ExitCode::FAILURE
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flags_json_handler_with_no_recognized_extractor() {
        let src = r#"
            async fn approve_hours(Json(payload): Json<ApproveHoursRequest>) -> Result<(), ()> {
                Ok(())
            }
        "#;
        let violations = check_source(src, "test");
        assert_eq!(violations.len(), 1);
        assert_eq!(violations[0].function, "approve_hours");
    }

    #[test]
    fn does_not_flag_json_handler_with_auth_user() {
        let src = r#"
            async fn approve_hours(
                AuthUser(user): AuthUser,
                Json(payload): Json<ApproveHoursRequest>,
            ) -> Result<(), ()> {
                Ok(())
            }
        "#;
        assert!(check_source(src, "test").is_empty());
    }

    #[test]
    fn does_not_flag_json_handler_with_lead_of() {
        let src = r#"
            async fn approve_hours(
                LeadOf(project_id): LeadOf,
                Json(payload): Json<ApproveHoursRequest>,
            ) -> Result<(), ()> {
                Ok(())
            }
        "#;
        assert!(check_source(src, "test").is_empty());
    }

    #[test]
    fn does_not_flag_handler_with_no_json_body() {
        let src = r#"
            async fn health() -> &'static str {
                "ok"
            }
        "#;
        assert!(check_source(src, "test").is_empty());
    }
}
