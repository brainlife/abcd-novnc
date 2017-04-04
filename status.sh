#!/bin/bash

if [ -f url.txt ]
then
    #I am not sure if it's safe to store password in status_msg.. but it should be only the user who has 
    #read access to it
    cat url.txt
else
    echo "starting"
fi

