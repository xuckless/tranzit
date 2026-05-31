package api

import "encoding/json"

// StartRequest is the body of POST /trips: the client's chosen Google route
// object plus the destination place ID needed for reroutes. Live location is
// NOT sent here — it streams over the WebSocket as LOCATION frames.
type StartRequest struct {
	// Route is the single selected Google route object (not the {routes:[…]}
	// wrapper).
	Route json.RawMessage `json:"route"`
	// DestinationPlaceID is held in memory for the session only, never persisted
	// (session-scoped place-ID invariant, §2). Required for reroutes.
	DestinationPlaceID string `json:"destination_place_id"`
	// Origin/Destination are optional record-keeping coordinates.
	Origin      *LatLng `json:"origin,omitempty"`
	Destination *LatLng `json:"destination,omitempty"`
	UserID      *string `json:"user_id,omitempty"`
}

// LatLng is a coordinate pair.
type LatLng struct {
	Lat float64 `json:"lat"`
	Lng float64 `json:"lng"`
}

// StartResponse is returned from POST /trips.
type StartResponse struct {
	SessionID string `json:"session_id"`
	WSURL     string `json:"ws_url"`
}
