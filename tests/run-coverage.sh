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

# Pin phpunit to the project's vendor binary rather than whatever
# /usr/bin/phpunit happens to be. The container's system phpunit is
# 11.x; the project pins 10.5.x in composer.json. Mixing them causes
# "Call to undefined method PHPUnit\Event\DispatchingEmitter::exportsObjects"
# because the system loader pulls 11.x classes while the vendor tree
# is wired for 10.x.
PHPUNIT="$SCRIPT_DIR/../vendor/bin/phpunit"

# Ensure xdebug coverage mode is enabled
export XDEBUG_MODE=coverage

# Clean up any previous test artifacts
rm -rf /tmp/newspack-nodes-test 2>/dev/null

# Run PHPUnit with coverage
"$PHPUNIT" --configuration phpunit.xml \
    --coverage-clover /volumes/pyrobase/tmp/newspack-nodes-coverage/clover.xml \
    --coverage-html /volumes/pyrobase/tmp/newspack-nodes-coverage \
	--enforce-time-limit \
    "$@"

echo ""
echo "Coverage report: /volumes/pyrobase/tmp/newspack-nodes-coverage/index.html"

rm -rf /tmp/admin-topo-stock-*           \
       /tmp/cmd-ctrl-ipc-*               \
       /tmp/m3-e2e-*                     \
       /tmp/msg-slot-check-*             \
       /tmp/msg-slot-conn-*              \
       /tmp/msg-slot-direct-sink-*       \
       /tmp/msg-slot-release-*           \
       /tmp/msg-stream-cmd-*             \
       /tmp/msg-stream-leak-*            \
       /tmp/newspack-nodes-test-*        \
       /tmp/nodes-lifecycle-*            \
       /tmp/phpunit-cache-newspack-nodes \
       /tmp/sse-sibling-patron-*         \
       /tmp/tsl-default-*                \
       /tmp/worker-disc-*
