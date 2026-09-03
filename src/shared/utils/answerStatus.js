/**
 * answerStatus — an answer, as the line a row or form shows for it.
 *
 * Every admin surface says the same three things about a verb it sent: it is
 * working, it failed with this text, or it succeeded. Only the words differ,
 * so the words are the argument.
 */

/**
 * Render one subject's answer as the line and the tone its status shows.
 *
 * Outstanding beats answered: a row asked about again shows the work, not the
 * last result. The caller reads `busy` from the hook that owns the outbox
 * rather than keeping a flag of its own.
 *
 * The tone is the modifier class that goes on the caller's
 * `.newspack-nodes-status` element — `is-error`, `is-success`, or empty for a
 * line with nothing to colour.
 *
 * @param {?{error?: ?string}}        answer         The reply about this subject, if any.
 * @param {Object}                    texts          The words this surface uses.
 * @param {string}                    [texts.busy]   Shown while the verb is outstanding.
 * @param {(error: string) => string} [texts.failed] Renders a refusal; the raw error stands when it is omitted.
 * @param {string}                    [texts.ok]     Shown on success; omit to say nothing.
 * @param {boolean}                   [busy]         Whether a verb about this subject is outstanding.
 * @return {{text: string, tone: string}} The status line and its tone class.
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
