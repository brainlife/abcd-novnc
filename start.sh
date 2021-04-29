#!/bin/bash

set -e
set -x

rm -f url.txt #prevent premature novnc startup in case rerun

#setup nvidia runtime lib directory
if [ ! -d lib ]; then
    mkdir -p lib
    cp -av /usr/lib/x86_64-linux-gnu/libGL* lib
    cp -av /usr/lib/x86_64-linux-gnu/libEGL* lib
    cp -av /usr/lib/x86_64-linux-gnu/libnvidia* lib
    cp -av /usr/lib/x86_64-linux-gnu/libnvoptix* lib
    cp -r -av /usr/lib/x86_64-linux-gnu/vdpau lib
fi

#somehow I can't install this globally
npm install soichih/tcp-port-used

npm install
node setup.js || ./stop.sh &
