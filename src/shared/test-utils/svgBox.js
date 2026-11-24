/**
 * svgBox — the box jsdom lacks, for every `<svg>`: its size, its place in the
 * window, and the map from a point of the window to one of the box. A canvas
 * without a box draws nothing on the ForceGraph, and takes no pointer on the
 * schematic.
 */

/**
 * The controls `installSvgBox()` hands back.
 *
 * @typedef {Object} SvgBox
 * @property {(width: number, height: number) => void} setSize Gives the box another size, and notifies no one.
 * @property {() => void}                              restore Takes the box away.
 */

/**
 * A point that takes a matrix, as `createSVGPoint()` makes one.
 *
 * @return {{x: number, y: number, matrixTransform: (matrix: Object) => {x: number, y: number}}} The point, at the origin.
 */
function createSVGPoint() {
	return {
		x: 0,
		y: 0,
		matrixTransform( { a, b, c, d, e, f } ) {
			return {
				x: a * this.x + c * this.y + e,
				y: b * this.x + d * this.y + f,
			};
		},
	};
}

/**
 * Give every `<svg>` a box, at one scale with the window.
 *
 * @param {number} width          Its width in pixels.
 * @param {number} height         Its height in pixels.
 * @param {Object} [place]
 * @param {number} [place.left=0] Where it begins in the window.
 * @param {number} [place.top=0]  Where it begins in the window.
 * @return {SvgBox} The controls.
 */
export function installSvgBox( width, height, { left = 0, top = 0 } = {} ) {
	const size = { width, height };
	const toBox = { a: 1, b: 0, c: 0, d: 1, e: -left, f: -top };
	const svg = window.SVGSVGElement.prototype;
	const parts = {
		clientWidth: { get: () => size.width },
		clientHeight: { get: () => size.height },
		getBoundingClientRect: {
			value: () => ( {
				x: left,
				y: top,
				left,
				top,
				right: left + size.width,
				bottom: top + size.height,
				...size,
			} ),
		},
		createSVGPoint: { value: createSVGPoint },
		getScreenCTM: { value: () => ( { inverse: () => toBox } ) },
	};
	for ( const [ name, part ] of Object.entries( parts ) ) {
		Object.defineProperty( svg, name, {
			configurable: true,
			...part,
		} );
	}
	return {
		setSize( nextWidth, nextHeight ) {
			size.width = nextWidth;
			size.height = nextHeight;
		},
		restore() {
			Object.keys( parts ).forEach( ( name ) => delete svg[ name ] );
		},
	};
}
