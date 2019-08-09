#!/bin/bash

rm -f url.txt #prevent premature novnc startup in case rerun

#setup nvidia runtime lib directory
#mkdir -p lib
#cp -av /usr/lib/x86_64-linux-gnu/libGL* lib
#cp -av /usr/lib/x86_64-linux-gnu/libEGL* lib
#cp -av /usr/lib/x86_64-linux-gnu/libnvidia* lib
#cp -av /usr/lib/x86_64-linux-gnu/libnvoptix* lib
#cp -r -av /usr/lib/x86_64-linux-gnu/vdpau lib
#cp -r -av /usr/lib/x86_64-linux-gnu/tls lib
#cp -r -av /usr/lib/x86_64-linux-gnu/nvidia lib

#npm install
node setup.js || ./stop.sh &
