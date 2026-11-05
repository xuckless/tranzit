package main

const (
	urlStops         = "https://data.calgary.ca/resource/muzh-c9qc.json"
	urlRoutes        = "https://data.calgary.ca/resource/hpnd-riq4.json"
	urlTrainStations = "https://data.calgary.ca/resource/2axz-xm4q.json"
	urlRTVehicles    = "https://data.calgary.ca/download/am7c-qe3u/application%2Foctet-stream"
	urlRTTrips       = "https://data.calgary.ca/download/gs4m-mdc2/application%2Foctet-stream"
	urlRTAlerts      = "https://data.calgary.ca/download/jhgn-ynqj/application%2Foctet-stream"

	// Static GTFS feed (Calgary Transit "Scheduling Data", dataset npk7-z3bj).
	// Resolves to CT_GTFS.zip — agency/calendar/calendar_dates/routes/trips/stops/shapes/stop_times.
	// Loaded into the gtfs_* tables by gtfs_static.go (opt-in, via the --load-gtfs flag).
	urlGTFSStatic = "https://data.calgary.ca/download/npk7-z3bj/application%2Fzip"

	realtimeInterval = 30 // seconds
	wsPort           = 8765
)
