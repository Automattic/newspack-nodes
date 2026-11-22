/**
 * The `inert` attribute, which React 18 writes through as an unknown
 * attribute and its type package does not declare.
 *
 * A closing dialog box carries `inert=""` so it takes no click and no focus
 * during its exit; React 18 renders the string as given. Declared here, on
 * the one attribute, rather than widening any element's props.
 */

import 'react';

declare module 'react' {
	interface HTMLAttributes< T > {
		inert?: '' | undefined;
	}
}
