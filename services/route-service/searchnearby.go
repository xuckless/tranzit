package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
)

type NearbyPlace struct {
	ID               string `json:"id"`
	FormattedAddress string `json:"formattedAddress"`
	DisplayName      struct {
		Text string `json:"text"`
	} `json:"displayName"`
	Location struct {
		Latitude  float64 `json:"latitude"`
		Longitude float64 `json:"longitude"`
	} `json:"location"`
}

type NearbyResponse struct {
	Places []NearbyPlace `json:"places"`
}

// FetchNearbyPlaces returns up to 4 closest establishments to the given coordinates.
// Uses a 50 m radius with DISTANCE ranking so results are ordered nearest-first.
func FetchNearbyPlaces(lat, lng float64) ([]NearbyPlace, error) {
	apiKey := os.Getenv("GMAPS_API_KEY")
	url := "https://places.googleapis.com/v1/places:searchNearby"

	body, _ := json.Marshal(map[string]interface{}{
		"locationRestriction": map[string]interface{}{
			"circle": map[string]interface{}{
				"center": map[string]float64{
					"latitude":  lat,
					"longitude": lng,
				},
				"radius": 50.0,
			},
		},
		"rankPreference": "DISTANCE",
		"maxResultCount": 4,
	})

	req, _ := http.NewRequest("POST", url, bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Goog-Api-Key", apiKey)
	req.Header.Set("X-Goog-FieldMask", "places.id,places.displayName,places.formattedAddress,places.location")

	client := &http.Client{}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		errBody, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("nearby search api error: %d — %s", resp.StatusCode, string(errBody))
	}

	var result NearbyResponse
	json.NewDecoder(resp.Body).Decode(&result)

	return result.Places, nil
}
