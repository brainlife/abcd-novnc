#!/bin/bash
set -e

list_descendants () {
    local children
    children=$(ps -o pid= --ppid "$1" 2>/dev/null || true)
    for pid in $children; do list_descendants "$pid"; done
    echo "$children"
}

# Preparation may still be downloading files or pulling an image.
if [ -f setup.pid ]; then
    setup_pid=$(cat setup.pid)
    if [[ "$setup_pid" =~ ^[0-9]+$ ]]; then
        kill $(list_descendants "$setup_pid") "$setup_pid" 2>/dev/null || true
    fi
    rm -f setup.pid
fi

if [ -f cont.id ]; then
    id=$(cat cont.id)
    if [ -n "$id" ]; then
        docker stop "$id" && docker rm "$id"
    fi
    rm -f cont.id
fi

if [ -f novnc.pid ]; then
    pid=$(cat novnc.pid)
    if [[ "$pid" =~ ^[0-9]+$ ]]; then
        kill $(list_descendants "$pid") "$pid" 2>/dev/null || true
    fi
    rm -f novnc.pid
fi
rm -f url.txt
