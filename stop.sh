#!/bin/bash

id=$(cat cont.id)
echo $id

echo "removing docker container"
docker stop $id
docker rm $id

echo "killing novnc"
kill $(cat novnc.pid)
