package api

import "encoding/json"

// StartRequest is the body of POST /trips: the client's chosen route object plus the
// destination it needs for reroutes. Live location is NOT sent here — it streams over
// the WebSocket as LOCATION frames.
//
// Two route styles are accepted, distinguished by Source (the tag route-service stamps
// on its responses):
//   - "" or "google-maps-api" (default): Route is a single Google route object and
//     DestinationPlaceID is required (reroutes call Google /route).
//   - "opentrip": Route is the OTP envelope ({source,itineraries:[chosen]}) or a bare
//     itinerary, and Destination coords are required (reroutes call OTP /route/otp).
type StartRequest struct {
	// Source selects the parser/engine; defaults to the Google path when empty.
	Source string `json:"source,omitempty"`
	// Route is the selected route object (Google route, or OTP envelope/itinerary).
	Route json.RawMessage `json:"route"`
	// DestinationPlaceID is held in memory for the session only, never persisted
	// (session-scoped place-ID invariant, §2). Required on the Google path.
	DestinationPlaceID string `json:"destination_place_id"`
	// Origin/Destination are coordinates. On the OTP path Destination is required and
	// is what reroutes target; on the Google path both are optional record-keeping.
	Origin      *LatLng `json:"origin,omitempty"`
	Destination *LatLng `json:"destination,omitempty"`
	// Mode/NumItineraries tune the OTP travel profile for source="opentrip" trips
	// (and their reroutes); ignored on the Google path. Defaults apply when zero.
	Mode           string `json:"mode,omitempty"`
	NumItineraries int    `json:"num_itineraries,omitempty"`
	// UserID is intentionally absent: the trip owner is derived from the verified
	// Supabase JWT (the token `sub`), never trusted from the request body.
}

// OTPStartRequest is the body of POST /tranzit-route: the server owns the directions
// fetch, so the client sends only its position and destination as coordinates. Route
// Save calls OTP, picks the best itinerary, and starts tracking.
type OTPStartRequest struct {
	Origin         *LatLng `json:"origin"`
	Destination    *LatLng `json:"destination"`
	Mode           string  `json:"mode,omitempty"`
	NumItineraries int     `json:"num_itineraries,omitempty"`
	// UserID is intentionally absent: the trip owner is derived from the verified
	// Supabase JWT (the token `sub`), never trusted from the request body.
}

// LatLng is a coordinate pair.
type LatLng struct {
	Lat float64 `json:"lat"`
	Lng float64 `json:"lng"`
}

// StartResponse is returned from POST /trips and POST /tranzit-route. Route is set
// only on /tranzit-route (the server-fetched OTP envelope), so the client can render
// directions immediately without a follow-up GET; it is omitted on /trips, where the
// client already holds the route it posted.
type StartResponse struct {
	SessionID string          `json:"session_id"`
	WSURL     string          `json:"ws_url"`
	Route     json.RawMessage `json:"route,omitempty"`
}
