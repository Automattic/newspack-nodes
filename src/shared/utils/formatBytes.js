/**
 * Default-export entry for the byte scaler, kept because
 * `newspack-event-logger-nodes` imports `@newspack-nodes/shared/utils/formatBytes`.
 * The implementation lives in `./formatters` with the rest of the ladder; delete
 * this file once that sibling imports `{ formatBytes }` from there.
 */

export { formatBytes as default } from './formatters';
