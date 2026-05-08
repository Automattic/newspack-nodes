#!/bin/bash -e
# Run newspack-nodes tests inside dndocker container.
# Source dir must be deployed via setup/newspack-nodes.sh first.
docker exec -u bend eve-pyrobase1-1 bash -c 'cd /usr/src/newspack-nodes/tests && phpunit'
