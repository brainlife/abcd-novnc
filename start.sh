#!/bin/bash

rm -f url.txt #prevent premature novnc startup in case rerun

npm install
node setup.js || ./stop.sh &
