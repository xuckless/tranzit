package directions

// otp.go parses the OpenTripPlanner itineraries that tranzit-route-service returns
// from POST /route/otp (tagged `"source":"opentrip"`) into the same leg/stop shape
// the trip pipeline already consumes for Google routes. Unlike Google, OTP plans on
// the GTFS graph and hands back the concrete `trip_id` and entry/exit `stop_id` per
// transit leg, so the parsed legs carry those (ParsedLeg.TripID/EntryStopID/
// ExitStopID) and BuildTrip skips trip resolution (§5.2).
//
// The cleaned OTP leg (route-service CleanLeg) drops per-leg coordinates, keeping
// only an encoded `polyline`; we decode its first/last points to recover the
// entry/exit stop locations, so OTP legs are structurally identical to Google legs
// (coords for stop windowing and walk-endpoint derivation).

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/tranzit-route-save/internal/geo"
)

// SourceOpenTrip is the tag tranzit-route-service stamps on /route/otp responses
// (paralleling "google-maps-api" on /route). Route Save uses it to pick the OTP
// parser/engine for a posted route (POST /trips) and echoes it back unchanged.
const SourceOpenTrip = "opentrip"

// otpEnvelope is the route-service /route/otp response: a source tag plus ranked
// itineraries. It is also the shape the client POSTs to start an OTP trip.
type otpEnvelope struct {
	Source      string            `json:"source"`
	Itineraries []json.RawMessage `json:"itineraries"`
}

// otpItinerary / otpLeg mirror route-service's CleanItinerary / CleanLeg (only the
// fields we map). Coordinates are absent by design — recovered from Polyline.
type otpItinerary struct {
	DurationSeconds int      `json:"duration_seconds"`
	Legs            []otpLeg `json:"legs"`
}

type otpLeg struct {
	Mode           string    `json:"mode"`
	DistanceM      float64   `json:"distance_m"`
	StartTime      time.Time `json:"start_time"`
	EndTime        time.Time `json:"end_time"`
	FromName       string    `json:"from"`
	ToName         string    `json:"to"`
	FromStopID     string    `json:"from_stop_id"`
	ToStopID       string    `json:"to_stop_id"`
	RouteShortName string    `json:"route_short_name"`
	TripID         string    `json:"trip_id"`
	Polyline       string    `json:"polyline"`
}

// ParseOTP decodes an OTP route into a single Route. It accepts the route-service
// envelope ({source, itineraries:[…]}) — returning the shortest itinerary by
// duration, mirroring Best — or a bare itinerary object (what the client POSTs once
// it has picked one).
func ParseOTP(raw []byte) (Route, error) {
	r, _, err := BestOTPWithRaw(raw)
	if err == nil {
		return r, nil
	}
	// Fall back to a bare single itinerary object.
	if single, serr := parseOTPItinerary(raw); serr == nil && len(single.Legs) > 0 {
		return single, nil
	}
	return Route{}, err
}

// BestOTPWithRaw returns the shortest itinerary as a Route plus a re-marshaled echo
// envelope carrying only the chosen itinerary ({source, itineraries:[chosen]}). The
// echo is what gets pushed to the client (REROUTE / GET snapshot), source tag intact,
// so the client's OTP parser re-renders the same shape it fetches directly (§13.2).
func BestOTPWithRaw(raw []byte) (Route, json.RawMessage, error) {
	var env otpEnvelope
	if err := json.Unmarshal(raw, &env); err != nil {
		return Route{}, nil, fmt.Errorf("directions: decode otp envelope: %w", err)
	}
	if len(env.Itineraries) == 0 {
		return Route{}, nil, fmt.Errorf("directions: otp response contained no itineraries")
	}

	bestIdx := 0
	best, err := parseOTPItinerary(env.Itineraries[0])
	if err != nil {
		return Route{}, nil, fmt.Errorf("directions: otp itinerary 0: %w", err)
	}
	for i := 1; i < len(env.Itineraries); i++ {
		r, err := parseOTPItinerary(env.Itineraries[i])
		if err != nil {
			return Route{}, nil, fmt.Errorf("directions: otp itinerary %d: %w", i, err)
		}
		if r.DurationS < best.DurationS {
			best, bestIdx = r, i
		}
	}

	source := env.Source
	if source == "" {
		source = "opentrip"
	}
	echo, err := json.Marshal(otpEnvelope{Source: source, Itineraries: []json.RawMessage{env.Itineraries[bestIdx]}})
	if err != nil {
		return Route{}, nil, err
	}
	return best, echo, nil
}

// parseOTPItinerary maps one cleaned OTP itinerary into a Route. Consecutive walk
// legs collapse into one (matching segmentLegs); each transit leg becomes a bus leg
// carrying its OTP-resolved ids.
func parseOTPItinerary(raw []byte) (Route, error) {
	var it otpItinerary
	if err := json.Unmarshal(raw, &it); err != nil {
		return Route{}, fmt.Errorf("decode otp itinerary: %w", err)
	}

	var legs []ParsedLeg
	walkOpen := false
	distance := 0
	for _, l := range it.Legs {
		distance += int(l.DistanceM)
		if otpLegIsTransit(l.Mode) {
			walkOpen = false
			legs = append(legs, otpBusLeg(l))
		} else if !walkOpen {
			legs = append(legs, ParsedLeg{Mode: ModeWalk})
			walkOpen = true
		}
	}
	return Route{
		DurationS: it.DurationSeconds,
		DistanceM: distance,
		Legs:      legs,
	}, nil
}

// otpBusLeg maps a transit CleanLeg to a bus ParsedLeg. Entry/exit coordinates come
// from the leg polyline's endpoints (the cleaned leg omits them); the trip and stop
// ids come straight from OTP's graph resolution.
func otpBusLeg(l otpLeg) ParsedLeg {
	entry, exit := otpPolylineEndpoints(l.Polyline)
	return ParsedLeg{
		Mode:        ModeBus,
		RouteID:     canonicalRouteID(l.RouteShortName),
		TripID:      l.TripID,
		EntryStopID: stripFeedPrefix(l.FromStopID),
		ExitStopID:  stripFeedPrefix(l.ToStopID),
		Entry:       &StopEndpoint{Name: l.FromName, Loc: entry, TimeEpoch: unixOrZero(l.StartTime)},
		Exit:        &StopEndpoint{Name: l.ToName, Loc: exit, TimeEpoch: unixOrZero(l.EndTime)},
	}
}

// otpLegIsTransit reports whether an OTP leg mode is a transit ride (vs an
// access/egress street leg). OTP street modes are WALK / BICYCLE / CAR; everything
// else (BUS, TRAM, RAIL, SUBWAY, FERRY, …) is a ride.
func otpLegIsTransit(mode string) bool {
	switch strings.ToUpper(strings.TrimSpace(mode)) {
	case "WALK", "BICYCLE", "BIKE", "CAR", "":
		return false
	default:
		return true
	}
}

// stripFeedPrefix turns an OTP gtfsId ("<feedId>:<rawId>", e.g. "1:8123") into the
// raw GTFS id our middleware tables key on. The trip_id is already stripped by
// route-service, but the stop ids are not — strip them here so they match the
// catalog stop_id. Empty / unprefixed values pass through.
func stripFeedPrefix(gtfsID string) string {
	if i := strings.IndexByte(gtfsID, ':'); i >= 0 {
		return gtfsID[i+1:]
	}
	return gtfsID
}

func unixOrZero(t time.Time) int64 {
	if t.IsZero() {
		return 0
	}
	return t.Unix()
}

// otpPolylineEndpoints decodes the first and last points of an encoded polyline
// (Google encoded polyline algorithm, precision 5 — what OTP emits). It returns
// zero coords when the polyline is empty or undecodable; the bus-leg windowing then
// relies on stop_id matching, and walk endpoints fall back to origin/destination.
func otpPolylineEndpoints(encoded string) (first, last geo.LatLng) {
	pts := decodePolyline(encoded)
	if len(pts) == 0 {
		return geo.LatLng{}, geo.LatLng{}
	}
	return pts[0], pts[len(pts)-1]
}

// decodePolyline decodes a precision-5 encoded polyline into points.
func decodePolyline(s string) []geo.LatLng {
	var pts []geo.LatLng
	var lat, lng int
	i := 0
	for i < len(s) {
		dlat, ok := decodeSignedNum(s, &i)
		if !ok {
			break
		}
		dlng, ok := decodeSignedNum(s, &i)
		if !ok {
			break
		}
		lat += dlat
		lng += dlng
		pts = append(pts, geo.LatLng{Lat: float64(lat) / 1e5, Lng: float64(lng) / 1e5})
	}
	return pts
}

// decodeSignedNum reads one zig-zag-encoded varint from s starting at *i, advancing
// *i past it. ok is false if the stream ends mid-number.
func decodeSignedNum(s string, i *int) (int, bool) {
	var result, shift int
	for {
		if *i >= len(s) {
			return 0, false
		}
		b := int(s[*i]) - 63
		*i++
		result |= (b & 0x1f) << shift
		shift += 5
		if b < 0x20 {
			break
		}
	}
	if result&1 != 0 {
		return ^(result >> 1), true
	}
	return result >> 1, true
}
