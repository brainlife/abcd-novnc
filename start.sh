#!/bin/bash

#allow debugging locally
if [ -z $INST_DIR ]; then export INST_DIR=`pwd`; fi
if [ -z $SERVICE_DIR ]; then export SERVICE_DIR=`pwd`; fi

(cd $SERVICE_DIR && npm install)
echo "current directory"
pwd
echo "running $node $SERVICE_DIR/setup"
node $SERVICE_DIR/setup

