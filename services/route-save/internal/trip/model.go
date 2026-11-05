// Package trip holds Route Save's canonical trip data model (doc §4) and the
// builder that assembles a TripState from parsed directions plus resolved GTFS
// data.
//
// TripState.Stops is the single source of truth: a flat, ordered slice the
// state machine evaluates by index. Each Leg references a [StopStart, StopEnd)
// range into that slice rather than owning a copy, so there is exactly one
// StopRecord per stop to mutate.
package trip

import "github.com/tranzit-route-save/internal/geo"

// Mode is a leg's travel mode.
type Mode int

const (
	ModeWalk Mode = iota
	ModeBus
)

func (m Mode) String() string {
	if m == ModeBus {
		return "BUS"
	}
	return "WALK"
}

// StopType gates the MISSED check (§5.4): only FETCHED (boarding) stops run it.
type StopType int

const (
	// Fetched: a stop where the user is expected to board (§3).
	Fetched StopType = iota
	// Transfer: any other loaded stop (intermediate ride-through or handoff);
	// exempt from MISSED while the rider is ON_BUS (§7.3).
	Transfer
)

func (t StopType) String() string {
	if t == Transfer {
		return "TRANSFER"
	}
	return "FETCHED"
}

// Status is the per-stop (and overall) lifecycle state (§4.3).
type Status int

const (
	StatusExpected Status = iota
	StatusActive
	StatusCompleted
	StatusUnsure
	StatusMissed
)

func (s Status) String() string {
	switch s {
	case StatusActive:
		return "ACTIVE"
	case StatusCompleted:
		return "COMPLETED"
	case StatusUnsure:
		return "UNSURE"
	case StatusMissed:
		return "MISSED"
	default:
		return "EXPECTED"
	}
}

// StopRecord is the canonical row the state machine evaluates (§4.1).
type StopRecord struct {
	StopID   string
	StopName string
	StopLat  float64
	StopLng  float64
	RouteID  string
	TripID   string
	StopType StopType

	BusArrivalTime  int64 // epoch; GTFS-RT, refreshed 30s
	UserArrivalTime int64 // epoch; Google static, fallback only (§5.3)
	UserDistanceM   float64
	TimeRemainingS  int

	Status Status
}

// Loc returns the stop location as a LatLng.
func (s StopRecord) Loc() geo.LatLng { return geo.LatLng{Lat: s.StopLat, Lng: s.StopLng} }

// Leg is one continuous-mode segment (§11). For walk legs StopStart == StopEnd.
type Leg struct {
	LegIndex int
	Mode     Mode
	RouteID  string // empty for walk
	TripID   string // empty for walk

	// StopStart/StopEnd bound this leg's stops within TripState.Stops.
	StopStart int
	StopEnd   int // exclusive

	// WalkFrom/WalkTo bound a WALK leg's segment (geo, lat-lng); zero for bus
	// legs. Derived from adjacent bus stops / trip origin+destination in
	// BuildTrip, so the trip is self-describing (the reroute A/B choice is
	// leg-mode based, §9) and the STATE/REROUTE exports can draw the walk.
	WalkFrom geo.LatLng
	WalkTo   geo.LatLng
}

// UserLocation is the latest reported client fix (§4.2).
type UserLocation struct {
	Loc        geo.LatLng
	SpeedMPS   float64
	HeadingDeg float64
	TS         int64 // client-reported epoch; not used for staleness (clock drift, §6.2)
	// RecvAt is the server clock time the fix was accepted; staleness is measured
	// against this, never the client TS.
	RecvAt int64
	// Valid is false until the first LOCATION update arrives.
	Valid bool
}

// TripState is the per-session, server-held trip (§4.2).
type TripState struct {
	SessionID   string
	UserID      *string // owner UUID from the verified Supabase JWT (token `sub`)
	Origin      geo.LatLng
	Destination geo.LatLng

	Legs             []Leg
	Stops            []StopRecord
	CurrentStopIndex int
	OverallStatus    Status

	UserLocation UserLocation
	LastRTUpdate int64
	LastReroute  int64
	StateVersion int
}

// ActiveStop returns a pointer to the stop currently under evaluation, or nil
// once the trip has advanced past its last stop.
func (t *TripState) ActiveStop() *StopRecord {
	if t.CurrentStopIndex < 0 || t.CurrentStopIndex >= len(t.Stops) {
		return nil
	}
	return &t.Stops[t.CurrentStopIndex]
}

// LegOf returns the leg containing the stop at the given index, or nil.
func (t *TripState) LegOf(stopIdx int) *Leg {
	for i := range t.Legs {
		if stopIdx >= t.Legs[i].StopStart && stopIdx < t.Legs[i].StopEnd {
			return &t.Legs[i]
		}
	}
	return nil
}
