#!/bin/sh
# À lancer sur le serveur depuis ~/iitc-sync
set -e
cd "$(dirname "$0")"
mkdir -p data
sudo chown -R 1000:1000 data
sudo chmod -R go-rwx data
docker build -t 127.0.0.1:5000/iitc-sync:latest .
docker push 127.0.0.1:5000/iitc-sync:latest
docker stack deploy -c docker-stack.yml iitcsync
