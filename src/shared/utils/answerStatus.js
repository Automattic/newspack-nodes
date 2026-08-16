/**
 * answerStatus — an answer, as the line a row or form shows for it.
 *
 * Every admin surface says the same three things about a verb it sent: it is
 * working, it failed with this text, or it succeeded. Only the words differ,
 * so the words are the argument.
 */

/**
 * Outstanding beats answered: a row asked about again shows the work, not the
 * last result. The caller reads `busy` from the hook that owns the outbox
 * rather than keeping a flag of its own.
 *
 * @param {?Object}  answer         `{ error }` for this subject, if any.
 * @param {Object}   texts          The words this surface uses.
 * @param {string}   [texts.busy]   Shown while the verb is outstanding.
 * @param {Function} [texts.failed] `( error ) => string` for a refusal.
 * @param {string}   [texts.ok]     Shown on success; omit to say nothing.
 * @param {boolean}  [busy]         Whether a verb about this subject is outstanding.
 * @return {{text: string, tone: string}} The status line.
 */
export function answerStatus( answer, texts, busy = false ) {
	if ( busy ) {
		return { text: texts.busy ?? '', tone: '' };
	}
	if ( answer?.error ) {
		return {
			text: texts.failed ? texts.failed( answer.error ) : answer.error,
			tone: 'is-error',
		};
	}
	if ( answer && texts.ok ) {
		return { text: texts.ok, tone: 'is-success' };
	}
	return { text: '', tone: '' };
}
