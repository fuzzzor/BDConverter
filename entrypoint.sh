#!/bin/sh
set -eu

# Support the environment used by older Compose deployments.
if [ -z "${LIBRARY_DIR:-}" ] && [ -n "${DEST_ROOT:-}" ]; then
    export LIBRARY_DIR="$DEST_ROOT"
fi
if [ -z "${TZ:-}" ] && [ -n "${TIMEZONE:-}" ]; then
    export TZ="$TIMEZONE"
fi

export OUTPUT_DIR="${OUTPUT_DIR:-/app/output}"
export UPLOAD_DIR="${UPLOAD_DIR:-/app/upload}"
export TEMP_DIR="${TEMP_DIR:-/app/temp}"
mkdir -p "$OUTPUT_DIR" "$UPLOAD_DIR" "$TEMP_DIR"

if [ "$#" -eq 0 ]; then
    set -- node server.js
fi

# Only bypass the known legacy preload. Other missing modules must still fail.
# Docker can create a directory when a bind-mounted source file is missing.
if [ "$#" -ge 4 ] && [ "$1" = node ] && [ "$4" = server.js ]; then
    case "$2" in
        -r|--require)
            case "$3" in
                ./dest-patch.js|/app/dest-patch.js)
                    if [ ! -f "$3" ] || [ ! -r "$3" ]; then
                        printf '%s\n' '[entrypoint] WARNING: dest-patch.js is missing, unreadable or a directory; starting the native server without the legacy patch.' >&2
                        printf '%s\n' '[entrypoint] Native library and ComicInfo features remain available; custom script behavior is not restored.' >&2
                        shift 3
                        set -- node "$@"
                    fi
                    ;;
            esac
            ;;
    esac
fi

# Preserve the official Node image argument handling and forward signals.
exec docker-entrypoint.sh "$@"
