#!/bin/bash

set -ex

rm -f url.txt setup-error.txt mrview-preflight.json #prevent stale readiness or errors on rerun

#setup nvidia runtime lib directory
if [ ! -d lib ]; then
    mkdir -p lib
    cp -av /usr/lib/x86_64-linux-gnu/libGL* lib || true
    cp -av /usr/lib/x86_64-linux-gnu/libEGL* lib || true
    cp -av /usr/lib/x86_64-linux-gnu/libnvidia* lib || true
    cp -av /usr/lib/x86_64-linux-gnu/libnvoptix* lib || true
    cp -r -av /usr/lib/x86_64-linux-gnu/vdpau lib || true
fi

#somehow I can't install this globally
npm install https://github.com/soichih/tcp-port-used

npm install
# Track preparation so Stop works before a Docker container exists.
(
    node setup.js &
    setup_pid=$!
    echo "$setup_pid" > setup.pid
    setup_result=0
    wait "$setup_pid" || setup_result=$?
    rm -f setup.pid
    if [ "$setup_result" -ne 0 ]; then
        if [ ! -f setup-error.txt ]; then
            echo "Viewer setup failed or was stopped. See task logs for details." > setup-error.txt
        fi
        ./stop.sh
    fi
) &
