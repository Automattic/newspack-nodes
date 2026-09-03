/**
 * Give a dashboard chart the live skin's own categorical series colors, so a
 * chart's areas and legend re-skin with the rest of the page.
 *
 * `_skins.scss` declares `--chart-1` through `--chart-8` on the skin-root
 * element, each an alias of one of that skin's four hues or their dark
 * variants. Only a descendant of that element inherits them, so the caller
 * passes a reader bound to the themed element it owns rather than this module
 * reaching for `getComputedStyle` itself: a read taken outside the skinned
 * subtree finds nothing and drops the chart to the static fallback with no
 * other symptom. Injecting the reader also leaves this module testable with no
 * DOM.
 */

import { PALETTE } from '@newspack-nodes/shared/hooks/useTimeChart';

/**
 * Resolve the active skin's categorical chart palette.
 *
 * One blank token forfeits the whole set. A skin declares all eight together,
 * so a blank one means the skin's styles did not reach the element at all, and
 * a partial read would color one legend out of two palettes.
 *
 * The fallback is the whole twenty-color `PALETTE`, not its first eight.
 * Callers index modulo the array length, so the two paths differ only in how
 * many series draw before a color repeats.
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
