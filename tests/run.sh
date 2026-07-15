#!/bin/bash -e
# Run from this checkout; container orchestration belongs to the caller.
TESTS_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
cd "$TESTS_DIR"
exec ../vendor/bin/phpunit "$@"
