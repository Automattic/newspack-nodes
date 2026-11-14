/**
 * Sources: a declared name over a poll, a command or a stream, read by blocks
 * through `useSource()` under a `SourcesProvider`, so N blocks with equal
 * params make one fetch.
 */

export {
	declaredSources,
	registerSource,
	sourceDeclaration,
	stableJson,
} from './registry';
export { SourcesProvider, useSource, useSourcesPaused } from './useSource';
