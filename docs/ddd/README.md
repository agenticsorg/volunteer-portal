# Domain-Driven Design

The domain model for the Agentics Foundation Volunteer Portal, implementing the decisions in [`docs/adr/`](../adr/README.md). Start with the [context map](00-context-map.md) for the strategic view (bounded contexts, their integration pattern, and Core/Supporting/Generic classification), then each bounded-context document for the tactical model (aggregates, invariants, domain events, schema, and API contract).

Two contexts are split across two files purely to stay under this repo's 500-line-per-file guideline — same bounded context, same schema, no difference in ownership.

| Bounded context | Schema | Document(s) |
|---|---|---|
| Overview | — | [00-context-map.md](00-context-map.md) |
| Identity & Access | `identity` | [identity-access.md](identity-access.md) + [identity-access-schema-api.md](identity-access-schema-api.md) |
| Volunteering & Opportunities | `volunteering` | [volunteering-opportunities.md](volunteering-opportunities.md) + [volunteering-opportunities-schema-api.md](volunteering-opportunities-schema-api.md) |
| Training & Learning | `training` | [training-learning.md](training-learning.md) |
| Gamification | `gamification` | [gamification.md](gamification.md) |
| Community & Social | `community` | [community-social.md](community-social.md) |
| Moderation & Trust/Safety | `moderation` | [moderation-trust-safety.md](moderation-trust-safety.md) |
| Notifications | `notifications` | [notifications.md](notifications.md) |
| Admin & Reporting | `admin` | [admin-reporting.md](admin-reporting.md) |

Grounded in [`docs/research/`](../research/README.md) — the initial deep research this design implements.
