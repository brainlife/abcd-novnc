#!/bin/bash

if [ -f url.txt ]
then

    #check to see if the docker container is still running
    docker inspect $(cat cont.id) > cont.info
    if [ ! $? -eq 0 ]
    then
        echo "container disappeared"
        exit 2
    fi

    #I am not sure if it's safe to store password in status_msg.. but it should be only the user who has 
    #read access to it
    cat url.txt
    exit 0 #running
else
    echo "starting"
    exit 0 #running
fi

