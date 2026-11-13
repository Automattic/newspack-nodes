/**
 * The aside: a container whose children stand in a column beside the main
 * one at 1,100 px and up, and after it below that. It reads nothing.
 */

/**
 * @param {Object}                    props
 * @param {import('react').ReactNode} [props.children] Its blocks, rendered.
 * @return {import('react').ReactElement} The column.
 */
export default function AsideView( { children } ) {
	return (
		<aside className="newspack-nodes-composed-aside">{ children }</aside>
	);
}
