/**
 * Re-export of the canonical unwrapCommandResponse helper.
 *
 * The implementation (and its doc comment) lives in
 * `src/shared/utils/unwrapCommandResponse.js`. The topology-console bundle
 * resolves the shared module's `@newspack-nodes/runtime` import via the same
 * esbuild/jest alias the event-dashboards bundle uses, so re-exporting keeps
 * a single source of truth — there is no second copy to drift.
 */

export { default } from '../../shared/utils/unwrapCommandResponse';
