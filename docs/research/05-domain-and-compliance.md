# Volunteer Management Domain & Compliance Research

## 1. Standard Platform Features
Baseline feature set across VolunteerHub, Galaxy Digital, Golden, Bloomerang, VolunteerMatters ([Bloomerang roundup](https://bloomerang.com/blog/volunteer-management-software), [Galaxy Digital](https://www.galaxydigital.com/blog/volunteer-management-software)):
- **Profiles + applications**: volunteer database, custom application workflows, skills/interests tagging, availability.
- **Opportunities & scheduling**: opportunity listings, shift sign-up, waitlists, automated reminders, recurring shifts.
- **Hour logging + approval**: self-logged hours routed through an approval workflow — supervisor sign-off, photo proof, or GPS check-in ([Alignmint](https://www.getalignmint.org/features/volunteer-hour-tracking)). Approval state is a first-class field, not a boolean afterthought.
- **Compliance document vault**: waivers, certifications, background-check results, training completions with expiry dates.
- **Screening/background checks**: Sterling Volunteers, Checkr, VolunteerBadge. US checks are FCRA-regulated: written disclosure, separate written authorization, and a **two-step adverse action process** (pre-adverse notice → waiting period → final notice) ([Sterling](https://www.sterlingvolunteers.com/blog/2022/08/compliance-background-check/)). ~35 states have Fair Chance/"Ban the Box" rules. For a distributed AI/OSS community this is likely **out of scope day one** — but leave a slot for per-role screening requirements.
- **Recognition**: service/reference letters, milestone certificates, impact statements.
- **Reporting**: hours rollups by program/date/person, exportable to CSV/PDF for board and grant packets.

## 2. Data Privacy (international volunteer base)
- **GDPR applies** to any EU/EEA-based volunteer regardless of nonprofit status ([DataGuard](https://www.dataguard.com/blog/gdpr-for-charities-a-complete-guide), [Usercentrics](https://usercentrics.com/knowledge-hub/gdpr-for-charities/)). Practical obligations: a documented **lawful basis per processing purpose** (volunteer agreement = contract; newsletters/photos = consent; training records = legitimate interest), a privacy notice, retention limits, security, and DSAR handling (access/erasure/portability/objection).
- **Video & training data is personal data**: watch duration, progress, quiz results, completion timestamps are learning analytics under GDPR ([Knowledge Worker](https://www.knowledgeworker.com/en/blog/data-protection-in-e-learning)). Gamification leaderboards publish behavioral data — that needs its own basis and an opt-out.
- **Cookies/analytics** need ePrivacy consent in the EU, separate from GDPR basis.
- **PIPEDA (Canada)**: managing volunteers, newsletters, and donations are generally *not* "commercial activity," so most nonprofits fall outside PIPEDA for these ([OPC Canada](https://www.priv.gc.ca/en/privacy-topics/privacy-laws-in-canada/the-personal-information-protection-and-electronic-documents-act-pipeda/r_o_p/02_05_d_19/)). Selling/renting lists *is* commercial and triggers it. Provincial laws (QC Law 25) may still bite.
- **CCPA/CPRA**: nonprofits are exempt as non-"businesses" ([TermsFeed](https://www.termsfeed.com/blog/ccpa-nonprofits/)). A for-profit subsidiary would not be.
- Practical stance: **build to GDPR** — it's the strictest and satisfies the rest.

## 3. Accessibility (WCAG 2.1/2.2 AA)
- ADA Title II's 2024 rule mandates **WCAG 2.1 AA** for public entities (deadlines Apr 2026 / Apr 2027) ([Accessible.org](https://accessible.org/ada-title-ii-web-accessibility/)). Most nonprofits sit under Title III, where WCAG 2.1 AA is the de facto litigation standard rather than a codified one — and **government grant terms frequently impose it contractually** ([FatLab](https://fatlabwebsupport.com/blog/nonprofit/wcag-accessibility-compliance-for-nonprofit-websites-what-you-actually-need-to-know/)).
- EU: **EN 301 549 / European Accessibility Act**. Ontario: **AODA** (WCAG 2.0 AA).
- Highest-risk surfaces here: **video** (captions 1.2.2, audio description 1.2.5, accessible custom player controls), gamification badges/progress bars (never color-alone, 1.4.1), live social feeds (status messages 4.1.3), and keyboard-operable modals/drag interactions (2.5.7 drag alternatives in 2.2).

## 4. Nonprofit UX
- **Volunteer ≠ donor, but often the same human.** Split-role duplicate records break hour totals and donor LTV ([SimpliPhi](https://simpliphi.io/blog/how-do-i-find-and-merge-duplicate-donor-records-in-my-crm)). Model **one person + attached roles**, not separate account types.
- **Hours must be exportable.** Funders accept volunteer time as in-kind match, valued at the Independent Sector rate (**$36.14/hr in 2026**), but require **dates, timestamps, and supervisor sign-off** ([Independent Sector](https://independentsector.org/research/value-of-volunteer-time-methodology/), [Galaxy Digital](https://www.galaxydigital.com/blog/value-of-a-volunteer-hour)). FASB only permits financial-statement recognition for specialized skills.
- **Moderation is a day-one requirement** for social features: published code of conduct, in-product report flow with evidence attachment, user block/mute, graduated enforcement ladder (warn → mute → suspend → ban), and an immutable **moderation audit log** ([Watchers.io](https://watchers.io/post/online-community-moderation)).

---

## Day-One Checklist (data model + permissions)
1. **Person-centric identity** with pluggable roles (volunteer / donor / staff / moderator / admin) — never duplicate accounts per role.
2. **Hour entries as immutable-once-approved records**: actor, opportunity, start/end timestamps, status (`submitted|approved|rejected`), approver ID, approval timestamp, rejection reason.
3. **Grant-ready export** (CSV/PDF) of approved hours filtered by date/program, with a configurable hourly valuation rate.
4. **Per-purpose consent records**: separate flags + timestamps + versioned policy text for newsletters, photo/name publication, leaderboard participation, analytics cookies.
5. **DSAR machinery**: export-all-my-data and delete/anonymize paths that survive foreign keys (anonymize hour records rather than cascade-delete — grant reporting needs the aggregate).
6. **Retention policy per data class** (inactive volunteer PII, video watch events, moderation logs) with automated expiry jobs.
7. **Field-level access control**: only screening admins see background-check status; leaderboards/social profiles expose an explicitly whitelisted public field set.
8. **Data residency + processor inventory**: record sub-processors (video host, email, analytics) and transfer mechanism for EU volunteers.
9. **Moderation primitives**: report, block, mute, suspend, plus an append-only moderation action log with actor and reason.
10. **Accessibility gates in CI**: captions required before a training video publishes; automated axe checks on core flows.
11. **Age gating**: capture DOB or a 16+ attestation — GDPR consent for under-16s requires guardian authorization.
12. **Audit trail on every privileged action** (hour approval, role grant, data export, moderation).
