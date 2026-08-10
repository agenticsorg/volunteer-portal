# ADR-0002: Next.js 14+ App Router with React Server Components by Default

## Status
Accepted — 2026-08-10

## Context
`06-ux-and-ia.md` and the synthesis in `docs/research/README.md` describe the portal's core surfaces as one flexible container rather than "three bolted-together apps": a Home/Feed, an Opportunities list, a Training Library, a My Progress view, Community (scoped leaderboards, teams), and Admin. Several of these are read-heavy, data-dense pages rendered from Postgres on every visit: the activity feed (recent kudos, badge awards, hour approvals across a person's teams/chapters), the training library (course catalog with per-user progress joined in), and leaderboards (aggregated points scoped by chapter/team/time window, per `02-gamification-and-social.md`'s guidance that leaderboards must be scoped, not global). These pages need fresh server-rendered data on every load, benefit from SEO/fast first paint for public-facing opportunity listings, and should not ship large client-side data-fetching/state-management bundles just to display what is fundamentally a server-rendered list.

A smaller set of surfaces are genuinely interactive and need client-side state and browser APIs: the video player (Cloudflare Stream playback, progress-tracking beacons, captions toggle — accessibility-critical per the WCAG 2.1 AA requirement in `05-domain-and-compliance.md`), hour-logging and application forms (client-side validation, optimistic submission), the moderation report-flow modal, and real-time-ish elements like a "kudos" button with optimistic UI. The system's canonical stack is TypeScript/Next.js end-to-end (ADR-0001) with tRPC for internal calls (ADR-0003) — the frontend decision needs to fit that shape without duplicating data-fetching logic between a REST client and a component tree.

## Decision
Use **Next.js 14+ with the App Router**, TypeScript throughout, as the single frontend + server-rendering layer for the Volunteer Portal (the same Next.js process that hosts the API routes and tRPC handlers from ADR-0003 — there is no separate frontend deployable).

**React Server Components (RSC) are the default** for every route. Pages are server components unless a specific piece of UI requires interactivity, in which case that piece — and only that piece — is extracted into a `"use client"` component (an "interactive island"). Concretely:
- **Server components** (fetch data directly via internal tRPC server-side callers or Prisma repositories, no client-side fetch waterfall): the Feed page shell and each feed item, the Training Library catalog grid, the Leaderboard table/rankings, the Opportunities list, My Progress summary, course detail pages (everything except the player itself).
- **Client components** (`"use client"`, mounted as islands inside otherwise-server-rendered pages): the video player (`<VideoPlayer />`, wraps Cloudflare Stream's player SDK, tracks watch-progress via a debounced tRPC mutation), the hour-logging form, the opportunity application form, the "give kudos" button, the moderation report modal, any drag/reorder admin UI, and the in-app notification bell (needs client polling/subscription state).

Data mutations from client components go through tRPC's React Query bindings (`@trpc/react-query`); data reads for initial page render never go through a client-side `useQuery` on first paint — they are fetched server-side and passed down as props (or read directly in the server component via a server-side tRPC caller), with `useQuery` used only for *subsequent* client-side refetches (e.g., re-polling the leaderboard after a kudos action) where React Query's cache is genuinely useful.

## Consequences

### Positive
- **Feed, Training Library, and Leaderboard ship minimal JS.** These are exactly the pages `06-ux-and-ia.md` identifies as core, frequently-visited surfaces; rendering them as RSC means the aggregation queries (join course progress, join points totals, join team membership for feed scoping) run on the server against Postgres directly, and the client receives HTML plus only the JS needed for the islands (kudos button, notification bell) — not a React Query client, not the query logic, not the row-mapping code.
- **One mental model for data access.** Server components call the same tRPC routers (via a server-side caller, `appRouter.createCaller(ctx)`) that client islands call via `@trpc/react-query` — the authorization (`can()`), validation, and business logic in each router procedure runs identically regardless of caller, so there is exactly one code path per operation, not a server-rendering path and a separate API path that can drift.
- **Accessibility-critical interactive surfaces are isolated and testable.** The video player, the highest-risk WCAG surface identified in the research (captions, custom controls, keyboard operability), is a single, well-bounded client component — Playwright/axe accessibility tests can target it directly rather than needing to crawl a monolithic client bundle.
- **Public opportunity listings get real SSR/SEO** without a separate static-site or SSR-only app, satisfying the "public opportunity listing needs to be discoverable" need from the research without adding a second frontend stack.
- **Streaming and partial rendering.** App Router's `loading.tsx` and `<Suspense>` boundaries let the feed page show its shell immediately while the (potentially slower) cross-schema-aggregated leaderboard widget streams in — important because leaderboard queries touch `gamification` and `identity` data with no DB-level join (ADR-0001), so they may be marginally slower than a single-table query and should not block the whole page.

### Negative / Trade-offs
- **RSC/client boundary discipline required.** Developers must consciously decide server-vs-client for every new component; getting it wrong (e.g., putting `"use client"` on a whole page because one button needs it) silently reverts the JS-bundle benefit this ADR is for. Mitigated with a lint rule flagging `"use client"` directives above a certain component-tree depth and a code-review checklist item.
- **Server component data-fetching patterns are less familiar** than a conventional SPA's `useEffect`/`useQuery` pattern; the team needs to standardize on server-side tRPC callers early (see Implementation Notes) or risk inconsistent per-page fetching approaches.
- **Caching is more subtle.** Next.js's fetch/data cache semantics (`revalidate`, `cache: 'no-store'`) must be set deliberately per data type — e.g., a leaderboard can tolerate `revalidate: 60`, but an hour-approval status must never be stale, so `no-store` is required on that path. Getting this wrong risks showing stale gamification state, which directly undermines the recognition/motivation goals `02-gamification-and-social.md` centers the gamification design on.
- **Testing story is bifurcated.** Server components are tested primarily via Playwright e2e / rendered-HTML assertions (they can't easily be unit-tested with React Testing Library in isolation since they're async and server-only); client islands get conventional RTL + Vitest unit tests. This means two testing idioms in one codebase, documented explicitly so contributors aren't surprised.

## Alternatives Considered
- **Next.js Pages Router (pre-App-Router).** Rejected: no RSC support, meaning every data-heavy page (feed, training library, leaderboard) would need `getServerSideProps` plus a fully client-hydrated component tree — shipping strictly more JS for the same content, and losing the `loading.tsx`/`<Suspense>` streaming story that keeps the leaderboard's cross-schema aggregation from blocking the rest of the feed page. Pages Router is also the path Next.js itself is de-emphasizing for new development.
- **Conventional SPA (Vite + React Router) with a separate API backend.** Rejected: this reintroduces exactly the frontend/backend split ADR-0001 avoids at this team size — a client-side data-fetching layer duplicating validation/authorization logic that already lives in tRPC routers, no SSR/SEO for public opportunity pages without bolting on a second rendering layer (e.g., a prerendering service), and a materially larger initial JS bundle for pages that are fundamentally server-rendered lists.
- **Remix.** Rejected: a credible alternative for the loader/action data model, but it does not offer React Server Components, so the same "ship a client-hydrated tree even for static-ish list pages" cost applies as with Pages Router; it would also mean adopting a second meta-framework's conventions distinct from the tRPC-centric internal API layer chosen in ADR-0003, with a smaller ecosystem overlap for tRPC/Prisma integration examples than Next.js has.
- **Full client-side rendering for everything, including Feed/Training Library/Leaderboard, to keep "one mental model everywhere."** Rejected as a simplicity argument that doesn't hold up against the concrete cost: these are precisely the pages identified as core, high-traffic, read-heavy surfaces, so uniformly client-rendering them is the worst place to accept extra JS and fetch-waterfall latency; the RSC-by-default rule is a small, consistently-applied heuristic ("is this interactive? no → server") rather than a case-by-case negotiation.

## Implementation Notes

### Route structure (App Router)
```
/src/app
  /(public)
    /opportunities/page.tsx          # RSC — public, SSR, indexable
    /opportunities/[id]/page.tsx     # RSC
  /(portal)                          # authenticated, behind middleware
    /feed/page.tsx                   # RSC — server tRPC caller for feed items
    /training
      /page.tsx                     # RSC — catalog grid
      /[courseId]/page.tsx          # RSC shell
      /[courseId]/video-player.tsx  # "use client" island, imported into the RSC page
    /progress/page.tsx               # RSC
    /community
      /leaderboard/page.tsx          # RSC, <Suspense> around the ranked table
      /teams/[teamId]/page.tsx       # RSC
    /admin/**                        # RSC shells + client islands per admin form
  /api
    /trpc/[trpc]/route.ts            # tRPC Next.js route handler (ADR-0003)
    /v1/**                            # versioned public REST handlers (ADR-0003)
  layout.tsx                          # root layout: theme, providers (React Query client for islands only)
  middleware.ts                       # Supabase JWT/session check, redirects unauthenticated to /login
```

### Server-side data fetching pattern
```ts
// app/(portal)/feed/page.tsx  — Server Component, no "use client"
import { appRouter } from "@/server/api/root";
import { createServerCaller } from "@/server/api/trpc-server";

export default async function FeedPage() {
  const caller = await createServerCaller(); // wraps appRouter.createCaller(ctx) with cookies() from next/headers
  const items = await caller.community.getFeed({ limit: 20 });
  return <FeedList items={items} />; // FeedList itself stays a server component; only <KudosButton> inside it is "use client"
}
```

### Client island pattern
```tsx
// app/(portal)/feed/kudos-button.tsx
"use client";
import { trpc } from "@/lib/trpc-client"; // @trpc/react-query hooks

export function KudosButton({ postId }: { postId: string }) {
  const utils = trpc.useUtils();
  const mutation = trpc.community.giveKudos.useMutation({
    onSuccess: () => utils.community.getFeed.invalidate(),
  });
  return <button onClick={() => mutation.mutate({ postId })} disabled={mutation.isPending}>👏</button>;
}
```

### Caching policy (set explicitly per route/query, never left implicit)
| Data | Strategy |
|---|---|
| Public opportunity listings | `revalidate: 300` (ISR-style) |
| Feed | `cache: 'no-store'` (always fresh per request) |
| Leaderboard | `revalidate: 60` — acceptable staleness, documented in the component |
| Training catalog metadata | `revalidate: 3600` |
| Hour-approval status, points balance | `cache: 'no-store'` — never stale |

### Key dependencies
- `next@^14`, `react@^18` (App Router requirement), `@trpc/server`, `@trpc/react-query`, `@tanstack/react-query` (client islands only), `@supabase/ssr` for cookie-based session reads in server components/middleware.
- Video player island wraps Cloudflare Stream's `@cloudflare/stream-react` (or the vanilla Stream Player embed if the React wrapper lags Stream API changes) — isolated so a captions/accessibility regression is scoped to one file.
- ESLint rule: forbid `"use client"` in any file under `app/**/page.tsx` for routes listed as RSC-by-default above (`no-restricted-syntax` custom rule checking the pragma), forcing interactivity to be pushed into a child component explicitly.
