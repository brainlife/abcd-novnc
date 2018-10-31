#!/bin/bash

if [ -f url.txt ]
then

    #check to see if the docker container is still running
    docker inspect $(cat cont.id) > cont.info
    if [ ! $? -eq 0 ]
    then
        echo "Container disappeared"
        exit 2
    fi

    #also check for noVNC process is still running
    if ! kill -0 $(cat novnc.pid)
    then
        echo "novnc process disappeared"
        exit 2 
    fi

    echo "Container running!"
    exit 0
else
    echo "Launching container"
    exit 0
fi

