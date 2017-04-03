#!/bin/bash

#allow debugging locally
if [ -z $INST_DIR ]; then export INST_DIR=`pwd`; fi
#if [ -z $TASK_DIR ]; then export TASK_DIR=`pwd`; fi
if [ -z $SERVICE_DIR ]; then export SERVICE_DIR=`pwd`; fi

node $SERVICE_DIR/setup

#echo "starting docker container"
#id=$(docker run -dP -v `pwd`/../$input_task_id:/input:ro soichih/vncserver-fsl)
#echo "started container $id"


