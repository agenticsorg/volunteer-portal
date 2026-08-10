# UX & IA Research: Gamified Volunteer Portal + Training Library

## 1. Roles & Permission Tiers

Volunteer/community platforms typically converge on 4-5 tiers:

- **Volunteer/Member** — browse opportunities, sign up for shifts, complete training, view own progress/badges, participate in feed/community.
- **Team Lead / Mentor** — everything above, plus: view team roster progress, verify hours/task completion, moderate sub-group discussions, nudge incomplete training. VolunteerMatters and VolunteerHub both expose scoped "coordinator" roles limited to specific events/groups rather than org-wide access.
- **Training Author / Content Admin** — uploads/edits videos and courses, sets prerequisites, assigns badges/points to content, views completion analytics — but not necessarily org financials or user management.
- **Org Admin** — full access: user/role management, reporting, gamification rule config (point values, leaderboard scope), moderation, integrations.

Industry pattern: granular, scoped permissions (read-only vs. edit vs. specific event/group ownership) rather than a flat binary admin/user split — this matters for a nonprofit where many "admins" are actually volunteer team leads themselves. ([VolunteerHub Advanced Permissions](https://support.volunteerhub.com/support/solutions/articles/60000610950-advanced-permissions), [VolunteerMatters roles](https://support.volunteermatters.com/hc/en-us/articles/217473117-Granting-Administrative-Access-Roles-within-VolunteerMatters))

## 2. Onboarding Flow Patterns

Best-practice LMS/volunteer onboarding sequences: **signup → role-based required learning path → guided first task → light-touch gamification reveal.**

- Pre-boarding: send access/orientation materials before "day one"; auto-enroll in a role-based required curriculum.
- Orientation is framed as a short, mandatory checklist (not the whole library) — reduces drop-off.
- Gamification should be introduced *after* the user completes something real (their first module or shift), not as a splash-screen sales pitch — points/badges awarded as recognition of genuine progress avoid feeling gimmicky. Best practice: one gamified touch per onboarding phase (e.g., a progress bar during orientation, first badge on completing it), not stacked mechanics up front. ([Absorb LMS](https://www.absorblms.com/blog/gamification-the-secret-to-an-effective-employee-onboarding-strategy/), [Userpilot onboarding gamification](https://userpilot.com/blog/onboarding-gamification/))
- Trailhead's model is instructive: modules → units → quiz/challenge → points → rank, with points *earned as a byproduct* of real learning, not a separate game layer. ([Trailhead guide](https://www.salesforceben.com/salesforce-trailhead/))
- Habitica notably omits leaderboards to keep tone collaborative rather than competitive — relevant if a nonprofit wants gamification that feels supportive, not cutthroat. ([Trophy.so Habitica case study](https://trophy.so/blog/habitica-gamification-case-study))

## 3. Navigation/IA Patterns for Unifying Feed + Training + Gamification

- **Mighty Networks' "Spaces" model** is the strongest real-world analog: each Space is a configurable room mixing feed, courses, events, and member directory in one container — avoiding separate silos for "community" vs "learning." The lesson: don't build three top-level apps; build one flexible container type reused for cohorts/teams. ([Mighty Networks reviews](https://sellcoursesonline.com/mighty-networks-review), [Skool vs Mighty Networks](https://www.ruzuku.com/learn/articles/skool-vs-mighty-networks))
- **Trailhead** cross-links gamification into content itself — badges/points are earned *inside* the learning flow and surfaced on a persistent profile, not a separate "games" tab.
- Common anti-pattern flagged in industry writing: gamification "bolted onto a static course" as an afterthought rather than woven into course structure and analytics — avoid a standalone "Leaderboard" app disconnected from real actions. ([Enterprise LMS gamification](https://www.thelearningos.com/enterprise-knowledge/gamification-and-social-learning-in-enterprise-lms))
- Practical rule: gamification elements (points, badges) should appear as small persistent UI (header widget, profile strip) across every screen, not a separate destination people must seek out.

## 4. Dashboard/Profile Design

- Dominant failure mode is information overload (affects ~47% of dashboard users per UX research); fix is **progressive disclosure** — surface a compact summary (next required action, current rank/points) with drill-down for detail. ([Dashboard UX pattern research](https://www.pencilandpaper.io/articles/ux-pattern-analysis-data-dashboards))
- Pattern: separate "your progress" (training completion %, next task) from "your standing" (badges, leaderboard rank) into two visually distinct zones/cards on one profile screen rather than merging them — visual hierarchy (position, size, color) signals which is primary per context.
- Use compact status badges/progress bars for quick scanning, reserve full leaderboard/detail views for a dedicated but easily reachable secondary screen.

## Proposed Top-Level IA for Agentics Foundation Portal

1. **Home / Feed** — activity updates, announcements, community posts, contextual nudges ("2 badges away from Volunteer rank")
2. **Opportunities** — browse/sign up for volunteer tasks & shifts (role-gated by completed training)
3. **Training Library** — courses/videos, required vs. optional, org and role-based paths
4. **My Progress** — personal dashboard: training completion, task history, points/badges, next milestones
5. **Community** — leaderboard, teams, member directory, mentor/team-lead spaces
6. **Admin** *(role-gated)* — content authoring, user/role management, gamification & reporting config

This keeps gamification (points/badges) embedded as a persistent header/profile element rather than a standalone destination, while still giving it a dedicated "Community" home for leaderboard/social depth.
