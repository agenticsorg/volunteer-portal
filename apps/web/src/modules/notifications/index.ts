/**
 * notifications bounded-context module — public interface.
 *
 * Notifications — delivery of email/in-app/push notifications, per-channel preferences.
 *
 * This is the ONLY file other modules may import from (ADR-0001). Everything
 * under domain/, application/, and infra/ in this module is private and must
 * never be imported directly by another module — see the module-boundary
 * lint rule (eslint.config.mjs) for enforcement.
 *
 * Stub only: no domain logic is implemented in this phase.
 */
export {};
