#!/bin/bash

set -ex

rm -f url.txt #prevent premature novnc startup in case rerun

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
node setup.js || ./stop.sh &
