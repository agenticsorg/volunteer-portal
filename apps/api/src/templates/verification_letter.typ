// ADR-0009 / Prompt 6.1: the Foundation letterhead for a volunteer hours
// verification letter. Compiled in-process by
// `apps/api/src/verification_letter_render.rs` via `typst-as-lib`,
// exported to a PDF/UA-1 tagged PDF by `typst-pdf`, and streamed
// directly in the HTTP response -- this file is never itself written to
// disk as part of that flow (it lives in the repo as source, embedded
// into the binary via `include_str!`).
//
// Brand compliance (concept.md section 7): exact colors, no palette
// substitutions, no em dashes or en dashes anywhere in this file's
// static copy -- verified by
// `verification_letter_render::tests::template_uses_exact_brand_colors_and_no_em_en_dashes`.
//
// Inputs (see `verification_letter_render::draft_to_inputs`):
//   volunteer_name: string
//   range_start, range_end: string (ISO 8601 date)
//   total_hours: string (decimal, already formatted)
//   generated_at: string (RFC 3339 timestamp)
//   projects: array of (name: string, hours: string)

#import sys: inputs

#set document(title: "Volunteer Hours Verification Letter", author: "Agentics Foundation")
#set text(lang: "en", font: "Libertinus Serif", size: 11pt, fill: rgb("#1a2a3a"))
#set page(paper: "us-letter", margin: (x: 1in, y: 1in), fill: rgb("#faf8f3"))

#align(center)[
  #text(size: 20pt, fill: rgb("#ff5a1f"), weight: "bold")[Agentics Foundation]

  #text(size: 13pt, fill: rgb("#5cb8e8"))[Volunteer Hours Verification Letter]
]

#v(18pt)

= Verification

This letter confirms that #strong[#inputs.volunteer_name] contributed
volunteer hours to the Agentics Foundation between #inputs.range_start
and #inputs.range_end.

#v(10pt)

#table(
  columns: (1fr, auto),
  stroke: 0.5pt + rgb("#1a2a3a"),
  table.header(
    table.cell(fill: rgb("#1a2a3a"))[#text(fill: white)[Project]],
    table.cell(fill: rgb("#1a2a3a"))[#text(fill: white)[Hours]],
  ),
  ..inputs.projects.map(p => ([#p.name], [#p.hours])).flatten()
)

#v(10pt)

#strong[Total hours:] #inputs.total_hours

#v(24pt)

Generated on #inputs.generated_at.

#v(30pt)

#line(length: 40%, stroke: 0.5pt + rgb("#1a2a3a"))
Agentics Foundation Administration
