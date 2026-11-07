#!/usr/bin/env bash
# Build the graph once (or when REBUILD_GRAPH=1), then serve it.
set -euo pipefail
D="${OTP_DATA:-/data}"
mkdir -p "$D/cache"
cp /opt/otp/build-config.json /opt/otp/router-config.json "$D/"

BBOX="-114.7919,50.5947,-113.3519,51.4947"   # matches services/otp/build.sh
GTFS_URL="${GTFS_STATIC_URL:-https://data.calgary.ca/download/npk7-z3bj/application%2Fzip}"
OSM_URL="${ALBERTA_OSM_URL:-https://download.geofabrik.de/north-america/canada/alberta-latest.osm.pbf}"

if [ ! -f "$D/graph.obj" ] || [ "${REBUILD_GRAPH:-0}" = "1" ]; then
  echo "otp-demo: building the Calgary graph (first run: ~600 MB download, ~10 min)"
  curl -fL --retry 3 -o "$D/calgary.gtfs.zip" "$GTFS_URL"
  if [ ! -f "$D/cache/calgary.osm.pbf" ]; then
    [ -f "$D/cache/alberta.osm.pbf" ] || curl -fL --retry 3 -o "$D/cache/alberta.osm.pbf" "$OSM_URL"
    osmium extract -b "$BBOX" "$D/cache/alberta.osm.pbf" -o "$D/cache/calgary.osm.pbf" --overwrite
    rm -f "$D/cache/alberta.osm.pbf"
  fi
  ln -sf "$D/cache/calgary.osm.pbf" "$D/calgary.osm.pbf"
  rm -f "$D/graph.obj.tmp"
  java $JAVA_BUILD_OPTS -jar /opt/otp-shaded.jar --build --save "$D"
  echo "otp-demo: graph built"
fi

exec java $JAVA_OPTS -jar /opt/otp-shaded.jar --load "$D"
