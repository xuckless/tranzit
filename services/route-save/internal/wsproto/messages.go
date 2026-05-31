// Package wsproto defines the per-trip WebSocket message contract (doc §13) and
// the read-only STATE export. Every message is a JSON object with a "type"
// discriminator. The server→client direction is authoritative and one-way for
// rendering; the client's only inputs are LOCATION, UNSURE_RESPONSE and RESUME.
package wsproto

import "encoding/json"

// Message type discriminators.
const (
	// Client → server.
	TypeLocation       = "LOCATION"
	TypeUnsureResponse = "UNSURE_RESPONSE"
	TypeResume         = "RESUME"

	// Server → client.
	TypeState   = "STATE"
	TypeReroute = "REROUTE"
	TypeNotify  = "NOTIFY"
)

// envelope is used to sniff the "type" before decoding the full message.
type envelope struct {
	Type string `json:"type"`
}

// DecodeType returns the "type" field of a raw client frame.
func DecodeType(raw []byte) (string, error) {
	var e envelope
	if err := json.Unmarshal(raw, &e); err != nil {
		return "", err
	}
	return e.Type, nil
}

// --- Client → server ---

// LocationMsg is the 5s GPS update (§13.1).
type LocationMsg struct {
	Type       string  `json:"type"`
	Lat        float64 `json:"lat"`
	Lng        float64 `json:"lng"`
	SpeedMPS   float64 `json:"speed_mps"`
	HeadingDeg float64 `json:"heading_deg"`
	TS         int64   `json:"ts"`
}

// UnsureResponseMsg answers a boarding-confirmation prompt (§10).
type UnsureResponseMsg struct {
	Type    string `json:"type"`
	StopID  string `json:"stop_id"`
	Boarded bool   `json:"boarded"`
}

// ResumeMsg requests reconciliation after a reconnect (§16.1). Deferred: the
// server currently just replies with the latest STATE.
type ResumeMsg struct {
	Type         string  `json:"type"`
	SessionID    string  `json:"session_id"`
	StateVersion int     `json:"state_version"`
	Lat          float64 `json:"lat"`
	Lng          float64 `json:"lng"`
}

// --- Server → client ---

// StateMsg is the full read-only export (§13.0/§13.2).
type StateMsg struct {
	Type      string      `json:"type"`
	SessionID string      `json:"session_id"`
	Version   int         `json:"version"`
	Overall   string      `json:"overall"`
	Stops     []StateStop `json:"stops"`
}

// StateStop is one stop as rendered by the client.
type StateStop struct {
	StopID         string  `json:"stop_id"`
	StopName       string  `json:"stop_name"`
	RouteID        string  `json:"route_id"`
	StopType       string  `json:"stop_type"`
	Status         string  `json:"status"`
	TimeRemainingS int     `json:"time_remaining_s"`
	ETA            int64   `json:"eta"`
	Lat            float64 `json:"lat"`
	Lng            float64 `json:"lng"`
}

// RerouteMsg announces a dynamic switch (§13.2). Route is the raw Google route
// object for the remaining journey (origin→destination), echoed verbatim so the
// client re-renders from the same shape it originally fetched; Legs is the
// server's parsed summary of the same spliced trip.
type RerouteMsg struct {
	Type   string          `json:"type"`
	Reason string          `json:"reason"`
	From   LatLng          `json:"from"`
	Route  json.RawMessage `json:"route,omitempty"`
	Legs   []RouteLeg      `json:"legs"`
}

// LatLng is a coordinate pair for the reroute origin.
type LatLng struct {
	Lat float64 `json:"lat"`
	Lng float64 `json:"lng"`
}

// RouteLeg summarises a spliced leg for the REROUTE payload.
type RouteLeg struct {
	LegIndex int    `json:"leg_index"`
	Mode     string `json:"mode"`
	RouteID  string `json:"route_id"`
	TripID   string `json:"trip_id"`
}

// NotifyMsg is a user-facing notification, optionally requiring a response (§13.2).
type NotifyMsg struct {
	Type             string `json:"type"`
	Kind             string `json:"kind"`
	StopID           string `json:"stop_id"`
	RequiresResponse bool   `json:"requires_response"`
	Message          string `json:"message"`
}
