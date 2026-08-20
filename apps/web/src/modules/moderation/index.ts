/**
 * moderation bounded-context module — public interface.
 *
 * Moderation — reports, block/mute/suspend enforcement, append-only moderation audit log.
 *
 * This is the ONLY file other modules may import from (ADR-0001). Everything
 * under domain/, application/, and infra/ in this module is private and must
 * never be imported directly by another module — see the module-boundary
 * lint rule (eslint.config.mjs) for enforcement.
 *
 * Stub only: no domain logic is implemented in this phase.
 */
export {};
