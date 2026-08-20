-- Prompt 5.2 architecture-consistency review: `LinkCommandHandler`'s
-- corrected design (discord-integration.md, amended 2026-08-20) performs
-- no mutation and calls no Identity & Access linking port -- every real
-- account-linking mutation continues to flow exclusively through
-- `Volunteer::link_additional_provider`'s existing web OAuth-handshake
-- flow (Prompts 1.5/2.2). `DiscordLinkCompleted`/`DiscordLinkRepository`
-- were removed from discord-integration.md as a result: nothing left to
-- mutate means nothing left to persist a link-confirmation record for.
-- This table (migration 20260819000009) has no writer under the
-- corrected design.

drop table discord_link;
