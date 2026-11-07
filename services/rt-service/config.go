package main

import "os"

// Feed URLs default to Calgary Open Data. Each is overridable by an env var so a
// local replay server can serve recorded snapshots instead (demo / offline dev).
var (
	urlStops         = envOr("STOPS_URL", "https://data.calgary.ca/resource/muzh-c9qc.json")
	urlRoutes        = envOr("ROUTES_URL", "https://data.calgary.ca/resource/hpnd-riq4.json")
	urlTrainStations = envOr("TRAIN_STATIONS_URL", "https://data.calgary.ca/resource/2axz-xm4q.json")
	urlRTVehicles    = envOr("RT_VEHICLES_URL", "https://data.calgary.ca/download/am7c-qe3u/application%2Foctet-stream")
	urlRTTrips       = envOr("RT_TRIPS_URL", "https://data.calgary.ca/download/gs4m-mdc2/application%2Foctet-stream")
	urlRTAlerts      = envOr("RT_ALERTS_URL", "https://data.calgary.ca/download/jhgn-ynqj/application%2Foctet-stream")

	// Static GTFS feed (Calgary Transit "Scheduling Data", dataset npk7-z3bj).
	// Resolves to CT_GTFS.zip — agency/calendar/calendar_dates/routes/trips/stops/shapes/stop_times.
	// Loaded into the gtfs_* tables by gtfs_static.go (opt-in, via the --load-gtfs flag).
	urlGTFSStatic = envOr("GTFS_STATIC_URL", "https://data.calgary.ca/download/npk7-z3bj/application%2Fzip")
)

const (
	realtimeInterval = 30 // seconds
	wsPort           = 8765
)

// envOr returns the env var key when set (non-empty), else def.
func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
