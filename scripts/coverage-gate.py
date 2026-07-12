#!/usr/bin/env python3
"""Per-class coverage gate for the pre-push hook.

Self-contained (no external deps) so the hook works from the plugin repo alone —
the clover-parsing approach is borrowed from dndocker's tools/coverage-summary.py.
Reads a PHP clover.xml and exits:
  1  if any class whose file path contains --filter is below --threshold percent
     statement coverage (prints the offenders),
  2  if the clover is missing or no class matched (never a vacuous pass),
  0  otherwise.

Statement coverage is line-based (stmt lines with count > 0), matching
coverage-summary.py so the numbers agree with the interactive summary.

Usage: coverage-gate.py <clover.xml> [--threshold 90] [--filter /includes/]
"""

import argparse
import sys
import xml.etree.ElementTree as ET


def per_class_coverage(clover_path, path_filter):
    """[(display_name, covered, stmts, pct)] for each class under path_filter."""
    tree = ET.parse(clover_path)
    stats = []
    for fnode in tree.iter('file'):
        fpath = fnode.get('name', '')
        if path_filter and path_filter not in fpath:
            continue
        lines = {}
        for ln in fnode.iter('line'):
            if ln.get('type') != 'stmt':
                continue
            try:
                lines[int(ln.get('num'))] = int(ln.get('count', 0))
            except (TypeError, ValueError):
                continue
        stmts = len(lines)
        if stmts == 0:
            continue
        covered = sum(1 for n in lines.values() if n > 0)
        display = fpath.split(path_filter, 1)[-1] if path_filter else fpath
        # One entry per class node; classes in a file share its stmt lines.
        for _ in fnode.iter('class'):
            stats.append((display, covered, stmts, covered / stmts * 100))
    return stats


def main():
    ap = argparse.ArgumentParser(description='per-class coverage gate')
    ap.add_argument('clover', help='path to clover.xml')
    ap.add_argument('--threshold', type=float, default=90.0)
    ap.add_argument('--filter', default='/includes/',
                    help='only gate classes whose file path contains this (default /includes/)')
    args = ap.parse_args()

    try:
        stats = per_class_coverage(args.clover, args.filter)
    except (FileNotFoundError, ET.ParseError) as e:
        print(f'coverage-gate: cannot read clover at {args.clover}: {e}', file=sys.stderr)
        sys.exit(2)

    if not stats:
        print(f'coverage-gate: no classes matched {args.filter!r} in {args.clover}', file=sys.stderr)
        sys.exit(2)

    offenders = sorted((s for s in stats if s[3] < args.threshold), key=lambda s: s[3])
    if offenders:
        print(f'\nCOVERAGE GATE FAILED — {len(offenders)} below {args.threshold:g}% '
              f'(of {len(stats)} classes):\n')
        width = max(len(name) for name, _, _, _ in offenders)
        for name, covered, stmts, pct in offenders:
            print(f'  * {name:<{width}}  {pct:5.1f}%  {covered}/{stmts} stmts')
        sys.exit(1)

    print(f'coverage gate: all {len(stats)} classes at or above {args.threshold:g}%')
    sys.exit(0)


if __name__ == '__main__':
    main()
