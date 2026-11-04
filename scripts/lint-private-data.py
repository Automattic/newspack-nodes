#!/usr/bin/env python3
"""lint-private-data.py — keep an organization's private values out of a repo.

    python3 -I scripts/lint-private-data.py --staged
    python3 -I scripts/lint-private-data.py --message <file>
    python3 -I scripts/lint-private-data.py [--range <base>..<head>]...
        [--ref <local_ref> <local_sha> <remote_ref>]...

Scans what a change ADDS against a private pattern list that never enters the
repo: the lines and the new paths `git diff --cached` adds, a commit message
file, or what a push carries — each commit in a range, its stored message,
the lines its diff adds and the paths it adds or renames to, and each pushed
ref's local and remote names and, for an annotated tag, its message. A removed
line never matches, so scrubbing a value out passes. Binary files are skipped.

The list is a TSV, one `class<TAB>regex<TAB>replacement` a line, blank lines
skipped; the gate reads the first two columns. It is read from
$NEWSPACK_PRIVATE_PATTERNS, else
${XDG_CONFIG_HOME:-$HOME/.config}/newspack/private-patterns.tsv. A missing
file fails; an empty one passes, for a machine with no private list. Each
regex compiles once, as bytes, and runs once over every scanned line joined
into one buffer.

A finding names where, by kind — a file and line, an added path, a commit's
message, a ref's name, a tag's message — and which class, never the matched
text or the regex, since printing either would publish the value to a
terminal or a pasted transcript. A line in a file whose own path is private
is named without that path. Exit 1 on any finding, 2 on a list, usage or git
error.

--message skips git's comment lines, which `git commit` strips from an edited
message; --range scans a stored message whole, and a merge's diff against its
first parent, so a conflict resolution is scanned too.
"""

import argparse
import bisect
import codecs
import os
import re
import subprocess
import sys

ENV = 'NEWSPACK_PRIVATE_PATTERNS'
DEFAULT_RELPATH = os.path.join('newspack', 'private-patterns.tsv')
COLUMNS = 3
COMMENT = b'#'
SCISSORS = b'# ------------------------ >8 ------------------------'
HUNK = re.compile(rb'^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@')
# A --raw record whose status adds a path: added, renamed or copied.
NEW_PATH = re.compile(rb'^:\S+ \S+ \S+ \S+ ([ARC])\d*\t(.*)$')
PRIVATE_PATH = '[a private path]'
# NUL cannot occur in a message or a text diff, so it delimits commits.
LOG_FORMAT = '--format=%x00%h%n%B%x00'
DIFF_ARGS = [
	'--raw', '-p', '--no-color', '--no-ext-diff', '--no-textconv', '-U0',
	'--src-prefix=a/', '--dst-prefix=b/',
]


def fail(message):
	print(f'lint-private-data: {message}', file=sys.stderr)
	sys.exit(2)


def list_path():
	explicit = os.environ.get(ENV)
	if explicit:
		return explicit
	config = os.environ.get('XDG_CONFIG_HOME') or os.path.join(os.path.expanduser('~'), '.config')
	return os.path.join(config, DEFAULT_RELPATH)


def load_patterns(path):
	if os.path.islink(path) and not os.path.exists(path):
		fail(f'{path} links to {os.readlink(path)}, which does not exist')
	if not os.path.isfile(path):
		fail(
			f'no private pattern list at {path}\n'
			f'  ${ENV} names another file in its place.\n'
			'  A machine with no private list satisfies the gate with an empty file:\n'
			f'    mkdir -p {os.path.dirname(path)} && touch {path}'
		)
	try:
		with open(path, 'rb') as handle:
			raw_lines = handle.read().split(b'\n')
	except OSError as error:
		fail(f'{path}: cannot read the list ({error.strerror})')
	patterns = []
	for number, raw in enumerate(raw_lines, 1):
		try:
			line = raw.decode('utf-8').rstrip('\r')
		except UnicodeError:
			fail(f'{path}: line {number} is not UTF-8')
		if not line.strip():
			continue
		columns = line.split('\t')
		if len(columns) < 2:
			fail(f'{path}: line {number} has no tab')
		if len(columns) != COLUMNS:
			fail(f'{path}: line {number} ({columns[0]}) has {len(columns)} tab-separated columns, not {COLUMNS}')
		try:
			patterns.append((columns[0], re.compile(columns[1].encode())))
		except (re.error, OverflowError, RecursionError):
			fail(f'{path}: line {number} ({columns[0]}) is not a regex this gate can compile')
	return patterns


def git(*args):
	command = ['git', '-c', 'core.quotePath=false', '-c', 'log.showSignature=false', *args]
	done = subprocess.run(command, stdout=subprocess.PIPE)
	if done.returncode:
		fail(f'git {args[0]} exited {done.returncode}')
	return done.stdout


def unquote(name):
	if name.startswith(b'"') and name.endswith(b'"'):
		return codecs.escape_decode(name[1:-1])[0]
	return name


def path_of(header):
	name = unquote(header[4:])
	if name.startswith(b'b/'):
		name = name[2:]
	return name


def read_diff(diff):
	"""Answers ([new path], [(path, line, text)]) for one --raw -p diff."""
	paths, lines = [], []
	path, number, in_hunk = None, 0, False
	for raw in diff.split(b'\n'):
		record = NEW_PATH.match(raw) if not in_hunk else None
		if record:
			paths.append(unquote(record.group(2).split(b'\t')[-1]))
			continue
		if raw.startswith(b'diff --git '):
			path, in_hunk = None, False
			continue
		hunk = HUNK.match(raw)
		if hunk:
			number, in_hunk = int(hunk.group(1)), True
			continue
		if not in_hunk:
			if raw.startswith(b'+++ ') and raw != b'+++ /dev/null':
				path = path_of(raw)
			continue
		if raw.startswith(b'+'):
			lines.append((path, number, raw[1:]))
			number += 1
		elif raw.startswith(b' '):
			number += 1
	return paths, lines


def diff_entries(diff, prefix, patterns):
	"""Entries for a diff's new paths and added lines, private paths unnamed."""
	paths, lines = read_diff(diff)
	by_index = scan([(index, path) for index, path in enumerate(paths)], patterns)
	private = {paths[index] for index, _ in by_index}
	path_entries = [(f'{prefix}added path', path) for path in paths]
	line_entries = [
		(f'{prefix}{PRIVATE_PATH if path in private else path.decode("utf-8", "replace")}:{number}', text)
		for path, number, text in lines
	]
	return path_entries + line_entries


def message_lines(message, label):
	for number, raw in enumerate(message.split(b'\n'), 1):
		if raw == SCISSORS:
			return
		if not raw.startswith(COMMENT):
			yield f'{label}:{number}', raw


def range_entries(spec, patterns):
	base, sep, head = spec.partition('..')
	if not sep or not base or not head:
		fail(f'--range wants <base>..<head>, not {spec}')
	# A base that is not a commit (the empty tree) means all of head's history.
	is_commit = subprocess.run(
		['git', 'rev-parse', '-q', '--verify', f'{base}^{{commit}}'],
		stdout=subprocess.DEVNULL,
	).returncode == 0
	revs = spec if is_commit else head
	log = git('log', '--root', '--diff-merges=first-parent', LOG_FORMAT, *DIFF_ARGS, revs, '--')
	chunks = log.split(b'\x00')
	entries = []
	for header, diff in zip(chunks[1::2], chunks[2::2]):
		sha, _, body = header.partition(b'\n')
		sha = sha.decode()
		entries += [(f'commit {sha} message', raw) for raw in body.split(b'\n')]
		entries += diff_entries(diff, f'commit {sha} ', patterns)
	return entries


def ref_entries(number, local_ref, local_sha, remote_ref):
	entries = [
		(f'ref {number} local name', local_ref.encode()),
		(f'ref {number} remote name', remote_ref.encode()),
	]
	kind = subprocess.run(['git', 'cat-file', '-t', local_sha], stdout=subprocess.PIPE)
	if 0 == kind.returncode and b'tag' == kind.stdout.strip():
		_, _, message = git('cat-file', 'tag', local_sha).partition(b'\n\n')
		entries += [(f'tag {local_sha[:7]} message', raw) for raw in message.split(b'\n')]
	return entries


def scan(entries, patterns):
	"""Answers [(label, class)] in scan order, one per label and class."""
	if not entries:
		return []
	starts, offset = [], 0
	for _, raw in entries:
		starts.append(offset)
		offset += len(raw) + 1
	buffer = b'\n'.join(raw for _, raw in entries)
	hits = {}
	for kind, regex in patterns:
		for match in regex.finditer(buffer):
			index = bisect.bisect_right(starts, match.start()) - 1
			hits.setdefault((entries[index][0], kind), index)
	return sorted(hits, key=hits.get)


class Usage(argparse.ArgumentParser):
	def error(self, message):
		fail(f'{message}\n{self.format_usage().rstrip()}')


def main(argv):
	parser = Usage(prog='lint-private-data.py')
	parser.add_argument('--staged', action='store_true')
	parser.add_argument('--message', metavar='FILE')
	parser.add_argument('--range', action='append', default=[], metavar='BASE..HEAD')
	parser.add_argument('--ref', action='append', default=[], nargs=3, metavar=('LOCAL_REF', 'LOCAL_SHA', 'REMOTE_REF'))
	options = parser.parse_args(argv)
	modes = [options.staged, None is not options.message, bool(options.range or options.ref)]
	if 1 != sum(modes):
		parser.error('name one of --staged, --message, or --range and --ref')

	path = list_path()
	patterns = load_patterns(path)
	entries = []
	if options.staged:
		entries = diff_entries(git('diff', '--cached', *DIFF_ARGS), '', patterns)
	elif options.message is not None:
		try:
			with open(options.message, 'rb') as handle:
				entries = list(message_lines(handle.read(), options.message))
		except OSError as error:
			fail(f'{options.message}: cannot read the message ({error.strerror})')
	for spec in options.range:
		entries += range_entries(spec, patterns)
	for number, ref in enumerate(options.ref, 1):
		entries += ref_entries(number, *ref)

	hits = scan(entries, patterns)
	for label, kind in hits:
		print(f'{label}: matches a private {kind} pattern', file=sys.stderr)
	if hits:
		count = len(hits)
		print(
			f'lint-private-data: {count} finding{"" if 1 == count else "s"}; the values are in'
			f' the private list at {path}. Remove them before this lands.',
			file=sys.stderr,
		)
		return 1
	return 0


if __name__ == '__main__':
	sys.exit(main(sys.argv[1:]))
