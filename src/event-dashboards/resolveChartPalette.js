import { PALETTE } from '@newspack-nodes/shared/hooks/useTimeChart';

/**
 * Resolve the active theme's categorical chart palette.
 *
 * @param {(name:string)=>string} getVar Reads a CSS custom property's computed value.
 * @return {string[]} The eight --chart-* colors, or the shared PALETTE fallback.
 */
export function resolveChartPalette( getVar ) {
	const vars = [];
	for ( let i = 1; i <= 8; i++ ) {
		const v = ( getVar( `--chart-${ i }` ) || '' ).trim();
		if ( ! v ) {
			return PALETTE;
		}
		vars.push( v );
	}
	return vars;
}
