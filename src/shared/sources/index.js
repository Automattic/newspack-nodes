/**
 * Sources: a declared name over a poll, a command or a stream, read by blocks
 * through `useSource()` under a `SourcesProvider`, so N blocks with equal
 * params make one fetch.
 */

export { registerSource } from './registry';
export { SourcesProvider, useSource } from './useSource';
