#!/bin/bash

id=$(cat cont.id)
echo $id

echo "removing docker container $id"
docker stop $id && docker rm $id && echo "container removed"

echo "killing novnc"
kill $(cat novnc.pid)
