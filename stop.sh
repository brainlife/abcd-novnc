#!/bin/bash

set -e
set -x

id=$(cat cont.id)
echo $id

echo "removing docker container $id"
docker stop $id && docker rm $id && echo "container removed"
rm cont.id

list_descendants ()
{
  local children=$(ps -o pid= --ppid "$1")

  for pid in $children
  do
    list_descendants "$pid"
  done

  echo "$children"
}

if [ -f novnc.pid ]; then
    echo "killing novnc and all children"
    pid=$(cat novnc.pid)
    kill $pid $(list_descendants $pid)
    rm novnc.pid
fi
