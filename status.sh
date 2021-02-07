#!/bin/bash

if [ ! -f cont.id ]
then
    echo "starting up container"
    exit 0
fi

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

