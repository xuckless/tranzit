// Package directions parses the raw Google Routes API v2 response (proxied
// verbatim by tranzit-route-service POST /route) into the leg/stop shape Route
// Save's trip pipeline consumes.
//
// The design doc's notion of a "Leg" (one continuous mode segment) maps to a
// *run of Google steps by travelMode*, not to Google's own `legs`: Google
// returns a single leg whose `steps` interleave WALK and TRANSIT. Consecutive
// WALK steps collapse into one WALK leg; each TRANSIT step becomes one BUS leg.
package directions

import "github.com/tranzit-route-save/internal/geo"

// Mode is the travel mode of a parsed leg.
type Mode int

const (
	// ModeWalk is a walking segment (one or more consecutive WALK steps).
	ModeWalk Mode = iota
	// ModeBus is a single transit ride.
	ModeBus
)

func (m Mode) String() string {
	switch m {
	case ModeWalk:
		return "WALK"
	case ModeBus:
		return "BUS"
	default:
		return "UNKNOWN"
	}
}

// StopEndpoint is the boarding (entry) or alighting (exit) stop of a bus leg as
// Google reports it. Google supplies only name + location + scheduled time; the
// stop_id is resolved later from our own GTFS data (see internal/datasource).
type StopEndpoint struct {
	Name string
	Loc  geo.LatLng
	// TimeEpoch is the scheduled time at this stop (Unix seconds). For Entry
	// this is the departure time; for Exit, the arrival time.
	TimeEpoch int64
}

// ParsedLeg is one continuous-mode segment of the trip.
type ParsedLeg struct {
	Mode Mode
	// RouteID is the bus number (Google transitLine.nameShort); empty for walk.
	RouteID string
	// Entry / Exit are set only for ModeBus legs.
	Entry *StopEndpoint
	Exit  *StopEndpoint
}

// Route is one parsed alternative: its total duration plus its ordered legs.
type Route struct {
	DurationS       int
	DistanceM       int
	Legs            []ParsedLeg
	EncodedPolyline string
}

// --- Google Routes API v2 response subset (only fields we decode) ---

type googleResponse struct {
	Routes []googleRoute `json:"routes"`
}

type googleRoute struct {
	DistanceMeters int         `json:"distanceMeters"`
	Duration       string      `json:"duration"` // e.g. "1264s"
	Legs           []googleLeg `json:"legs"`
	Polyline       googlePoly  `json:"polyline"`
}

type googlePoly struct {
	EncodedPolyline string `json:"encodedPolyline"`
}

type googleLeg struct {
	Steps []googleStep `json:"steps"`
}

type googleStep struct {
	TravelMode     string                `json:"travelMode"` // WALK | TRANSIT
	TransitDetails *googleTransitDetails `json:"transitDetails"`
}

type googleTransitDetails struct {
	StopDetails googleStopDetails `json:"stopDetails"`
	TransitLine googleTransitLine `json:"transitLine"`
}

type googleStopDetails struct {
	ArrivalStop   googleStop `json:"arrivalStop"`
	ArrivalTime   string     `json:"arrivalTime"` // RFC3339 UTC
	DepartureStop googleStop `json:"departureStop"`
	DepartureTime string     `json:"departureTime"` // RFC3339 UTC
}

type googleStop struct {
	Location googleLocation `json:"location"`
	Name     string         `json:"name"`
}

type googleLocation struct {
	LatLng googleLatLng `json:"latLng"`
}

type googleLatLng struct {
	Latitude  float64 `json:"latitude"`
	Longitude float64 `json:"longitude"`
}

type googleTransitLine struct {
	NameShort string `json:"nameShort"` // bus number -> route_id
}
