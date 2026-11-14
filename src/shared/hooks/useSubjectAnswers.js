/**
 * useSubjectAnswers — each row's last answer, put there BY the reply that
 * named it. This is a screen laying out answers it was handed, not a
 * correlation table: the graph did the matching in the reply's ADDRESS
 * before the screen saw it (ADR-7), which is why a row keeps its line while
 * a sibling is answered.
 */

import { useCallback, useState } from '@wordpress/element';

/**
 * Hold each subject's last answer.
 *
 * @return {{file: (subject: string, answer: Object) => void, answerFor: (subject: string) => ?Object}}
 *   `file` keeps what a row shows of one reply, which holds no secret the
 *   command answered; `answerFor` reads a subject's last, null for none.
 */
export function useSubjectAnswers() {
	const [ answers, setAnswers ] = useState( {} );
	const file = useCallback(
		( subject, answer ) =>
			setAnswers( ( prior ) => ( { ...prior, [ subject ]: answer } ) ),
		[]
	);
	const answerFor = useCallback(
		( subject ) =>
			Object.hasOwn( answers, subject ) ? answers[ subject ] : null,
		[ answers ]
	);
	return { file, answerFor };
}
