#!/bin/bash
#
# Run PHPUnit tests with code coverage
#
# Usage:
#   ./run-coverage.sh              # Run all tests with coverage
#   ./run-coverage.sh --filter X   # Run specific test
#
# Coverage report is written to /volumes/pyrobase/tmp/newspack-nodes-coverage/
#

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Ensure xdebug coverage mode is enabled
export XDEBUG_MODE=coverage

# Clean up any previous test artifacts
rm -rf /tmp/newspack-nodes-test 2>/dev/null

# Run PHPUnit with coverage
phpunit --configuration phpunit.xml \
    --coverage-clover /volumes/pyrobase/tmp/newspack-nodes-coverage/clover.xml \
    --coverage-html /volumes/pyrobase/tmp/newspack-nodes-coverage \
	--enforce-time-limit \
    "$@"

echo ""
echo "Coverage report: /volumes/pyrobase/tmp/newspack-nodes-coverage/index.html"
