#!/bin/sh
if [ -z "${1}" ] || [ -z "${2}" ]; then
	echo "Usage: get-line-at-offset.sh <offset> <file>"
	exit 1
fi
OFFSET=$(( ${1} + 1 ))
FILE="${2}"
tail -c +"${OFFSET}" "${FILE}" | head -1 | jq
