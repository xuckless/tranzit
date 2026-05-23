package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
)

type RouteRequest struct {
	Origin      Location `json:"origin"`
	Destination string   `json:"destination_id"`
}

type Location struct {
	Lat float64 `json:"lat"`
	Lng float64 `json:"lng"`
}

func FetchTransitRoutes(origin Location, destID string) (interface{}, error) {
	apiKey := os.Getenv("GMAPS_API_KEY")
	url := "https://routes.googleapis.com/directions/v2:computeRoutes"

	payload := map[string]interface{}{
		"origin": map[string]interface{}{
			"location": map[string]interface{}{
				"latLng": map[string]float64{"latitude": origin.Lat, "longitude": origin.Lng},
			},
		},
		"destination": map[string]interface{}{
			"placeId": destID,
		},
		"travelMode":               "TRANSIT",
		"computeAlternativeRoutes": true,
		"languageCode":             "en-US",
		"units":                    "METRIC",
	}

	body, _ := json.Marshal(payload)
	req, _ := http.NewRequest("POST", url, bytes.NewBuffer(body))

	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Goog-Api-Key", apiKey)
	// Expanded FieldMask to capture every nested transit detail
	req.Header.Set("X-Goog-FieldMask", "routes.duration,routes.distanceMeters,routes.polyline,routes.legs.steps.transitDetails,routes.legs.steps.travelMode,routes.legs.steps.navigationInstruction")

	client := &http.Client{}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("routes api error: %d", resp.StatusCode)
	}

	var rawResponse struct {
		Routes []map[string]interface{} `json:"routes"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&rawResponse); err != nil {
		return nil, err
	}

	// Logic to sort by duration and return best 2
	sort.Slice(rawResponse.Routes, func(i, j int) bool {
		durI := parseDuration(rawResponse.Routes[i]["duration"].(string))
		durJ := parseDuration(rawResponse.Routes[j]["duration"].(string))
		return durI < durJ
	})

	if len(rawResponse.Routes) > 2 {
		rawResponse.Routes = rawResponse.Routes[:2]
	}

	return rawResponse, nil
}

// Helper to convert "439s" string to integer for sorting
func parseDuration(d string) int {
	d = strings.TrimSuffix(d, "s")
	val, _ := strconv.Atoi(d)
	return val
}
