package directions

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/tranzit-route-save/internal/geo"
)

// Parse decodes a raw Google Routes v2 response and returns every alternative
// route, ordered as Google returned them, each segmented into mode legs.
func Parse(raw []byte) ([]Route, error) {
	var resp googleResponse
	if err := json.Unmarshal(raw, &resp); err != nil {
		return nil, fmt.Errorf("directions: decode response: %w", err)
	}
	if len(resp.Routes) == 0 {
		return nil, fmt.Errorf("directions: response contained no routes")
	}

	routes := make([]Route, 0, len(resp.Routes))
	for i, gr := range resp.Routes {
		legs, err := segmentLegs(gr)
		if err != nil {
			return nil, fmt.Errorf("directions: route %d: %w", i, err)
		}
		routes = append(routes, Route{
			DurationS:       parseDurationS(gr.Duration),
			DistanceM:       gr.DistanceMeters,
			Legs:            legs,
			EncodedPolyline: gr.Polyline.EncodedPolyline,
		})
	}
	return routes, nil
}

// ParseSingle decodes a single Google route object — the shape the client POSTs
// to start a trip ({distanceMeters, duration, legs, polyline}), as opposed to
// the {routes:[…]} wrapper that /route returns. It segments the route into mode
// legs like Parse does.
func ParseSingle(raw []byte) (Route, error) {
	var gr googleRoute
	if err := json.Unmarshal(raw, &gr); err != nil {
		return Route{}, fmt.Errorf("directions: decode route: %w", err)
	}
	legs, err := segmentLegs(gr)
	if err != nil {
		return Route{}, fmt.Errorf("directions: parse single route: %w", err)
	}
	return Route{
		DurationS:       parseDurationS(gr.Duration),
		DistanceM:       gr.DistanceMeters,
		Legs:            legs,
		EncodedPolyline: gr.Polyline.EncodedPolyline,
	}, nil
}

// Best returns the alternative with the shortest duration. It is the default
// route-selection hook; callers wanting a different policy can pick from Parse.
func Best(raw []byte) (Route, error) {
	routes, err := Parse(raw)
	if err != nil {
		return Route{}, err
	}
	best := routes[0]
	for _, r := range routes[1:] {
		if r.DurationS < best.DurationS {
			best = r
		}
	}
	return best, nil
}

// segmentLegs walks the (single) Google leg's steps and collapses them into
// mode segments: consecutive WALK steps become one walk leg, each TRANSIT step
// becomes its own bus leg.
func segmentLegs(gr googleRoute) ([]ParsedLeg, error) {
	var legs []ParsedLeg
	walkOpen := false

	for _, gleg := range gr.Legs {
		for _, step := range gleg.Steps {
			switch strings.ToUpper(step.TravelMode) {
			case "TRANSIT":
				walkOpen = false
				bus, err := busLeg(step)
				if err != nil {
					return nil, err
				}
				legs = append(legs, bus)
			default: // WALK and any non-transit maneuver
				if !walkOpen {
					legs = append(legs, ParsedLeg{Mode: ModeWalk})
					walkOpen = true
				}
			}
		}
	}
	return legs, nil
}

func busLeg(step googleStep) (ParsedLeg, error) {
	td := step.TransitDetails
	if td == nil {
		return ParsedLeg{}, fmt.Errorf("transit step missing transitDetails")
	}
	dep, err := time.Parse(time.RFC3339, td.StopDetails.DepartureTime)
	if err != nil {
		return ParsedLeg{}, fmt.Errorf("departure time %q: %w", td.StopDetails.DepartureTime, err)
	}
	arr, err := time.Parse(time.RFC3339, td.StopDetails.ArrivalTime)
	if err != nil {
		return ParsedLeg{}, fmt.Errorf("arrival time %q: %w", td.StopDetails.ArrivalTime, err)
	}
	return ParsedLeg{
		Mode:    ModeBus,
		RouteID: canonicalRouteID(td.TransitLine.NameShort),
		Entry: &StopEndpoint{
			Name:      td.StopDetails.DepartureStop.Name,
			Loc:       toLatLng(td.StopDetails.DepartureStop.Location.LatLng),
			TimeEpoch: dep.Unix(),
		},
		Exit: &StopEndpoint{
			Name:      td.StopDetails.ArrivalStop.Name,
			Loc:       toLatLng(td.StopDetails.ArrivalStop.Location.LatLng),
			TimeEpoch: arr.Unix(),
		},
	}, nil
}

func toLatLng(l googleLatLng) geo.LatLng {
	return geo.LatLng{Lat: l.Latitude, Lng: l.Longitude}
}

// maxLineAliases maps Google's MAX BRT letter codes (transitLine.nameShort) to
// the numeric route_id the GTFS-RT feed uses. Google labels Calgary's MAX lines
// "MG", "MO", … whereas trip_updates.route_id (and therefore our trip
// resolution and the STATE export) uses 301, 303, … Extend this as more MAX
// lines surface.
var maxLineAliases = map[string]string{
	"MG": "301",
	"MO": "303",
	"MY": "304",
	"MT": "306",
	"MP": "307",
}

// canonicalRouteID converts a Google nameShort to the route_id our data uses,
// translating known MAX BRT aliases and passing everything else through.
func canonicalRouteID(nameShort string) string {
	if id, ok := maxLineAliases[strings.ToUpper(strings.TrimSpace(nameShort))]; ok {
		return id
	}
	return nameShort
}

// parseDurationS turns Google's "1264s" into 1264. Unparseable values yield 0,
// which is acceptable since duration only feeds Best's ordering.
func parseDurationS(s string) int {
	s = strings.TrimSuffix(strings.TrimSpace(s), "s")
	n, err := strconv.Atoi(s)
	if err != nil {
		return 0
	}
	return n
}
