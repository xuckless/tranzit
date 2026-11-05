#!/usr/bin/env bash
# Build the Calgary OTP2 graph: fetch OSM + static GTFS, clip OSM to Calgary, build graph.obj.
# Requires: bash, curl, java 21+, and osmium-tool (for the OSM clip step).
set -euo pipefail
cd "$(dirname "$0")"

OTP_VERSION="${OTP_VERSION:-2.6.0}"
OTP_JAR="otp-${OTP_VERSION}-shaded.jar"
OTP_JAR_URL="https://repo1.maven.org/maven2/org/opentripplanner/otp/${OTP_VERSION}/${OTP_JAR}"

# Calgary bounding box (minlon,minlat,maxlon,maxlat) — matches the route-service geofence.
BBOX="-114.7919,50.5947,-113.3519,51.4947"

GTFS_URL="https://data.calgary.ca/download/npk7-z3bj/application%2Fzip"
# Geofabrik Alberta extract (covers Calgary; clipped below).
ALBERTA_OSM_URL="https://download.geofabrik.de/north-america/canada/alberta-latest.osm.pbf"

echo "==> [1/5] OTP jar"
[ -f "$OTP_JAR" ] || curl -L --fail -o "$OTP_JAR" "$OTP_JAR_URL"

echo "==> [2/5] Static GTFS"
curl -L --fail -o calgary.gtfs.zip "$GTFS_URL"

echo "==> [3/5] Alberta OSM extract"
[ -f alberta-latest.osm.pbf ] || curl -L --fail -o alberta-latest.osm.pbf "$ALBERTA_OSM_URL"

echo "==> [4/5] Clip OSM to Calgary bbox"
if command -v osmium >/dev/null 2>&1; then
  osmium extract -b "$BBOX" alberta-latest.osm.pbf -o calgary.osm.pbf --overwrite
else
  echo "osmium not found — install osmium-tool, or manually clip alberta-latest.osm.pbf to bbox $BBOX as calgary.osm.pbf" >&2
  exit 1
fi

echo "==> [5/5] Build graph"
java -Xmx4G -jar "$OTP_JAR" --build --save .

echo "Done. Run ./run.sh to serve on :8080"
