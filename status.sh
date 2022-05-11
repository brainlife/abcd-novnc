#!/bin/bash

#state management is really poor.. this script doesn't work well when container fails to start, stopped, etc

if [ -f url.txt ]
then
    #check to see if the docker container exists
    docker inspect $(cat cont.id) > cont.info
    if [ ! $? -eq 0 ]
    then
        echo "Container disappeared"
        exit 2
    fi

    #check to see if the container is still running
    status=$(cat cont.info | jq -r '.[0].State.Status')
    if [ "$status" != "running" ]; then
        echo "container is not running ($status)"
        exit 2
    fi

    #also check for noVNC process is still running
    if [ -f novnc.pid ]
    then
        if ! kill -0 $(cat novnc.pid)
        then
            echo "novnc process disappeared"
            exit 2 
        fi
    fi

    echo "Opening View!"
    exit 0
else
    echo "setting up vis container (might take a while for the first time)"
    exit 0
fi

