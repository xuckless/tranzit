// places.go
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
)

type PlaceRequest struct {
	Query string `json:"query"`
}

type PlaceResponse struct {
	Places []struct {
		ID               string `json:"id"`
		FormattedAddress string `json:"formattedAddress"`
		DisplayName      struct {
			Text string `json:"text"`
		} `json:"displayName"`
		Location struct {
			Latitude  float64 `json:"latitude"`
			Longitude float64 `json:"longitude"`
		} `json:"location"`
	} `json:"places"`
}

func FetchPlace(query string) (*PlaceResponse, error) {
	apiKey := os.Getenv("GMAPS_API_KEY")
	url := "https://places.googleapis.com/v1/places:searchText"

	// Text Search only supports rectangle for locationRestriction (not circle).
	// Bounding box is ~50km from Calgary's centre (51.0447, -114.0719).
	body, _ := json.Marshal(map[string]interface{}{
		"textQuery": query,
		"locationRestriction": map[string]interface{}{
			"rectangle": map[string]interface{}{
				"low":  map[string]float64{"latitude": 50.5947, "longitude": -114.7919},
				"high": map[string]float64{"latitude": 51.4947, "longitude": -113.3519},
			},
		},
	})
	req, _ := http.NewRequest("POST", url, bytes.NewBuffer(body))

	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Goog-Api-Key", apiKey)
	// FieldMask limits data to "basic" to save cost
	req.Header.Set("X-Goog-FieldMask", "places.id,places.displayName,places.location,places.formattedAddress")

	client := &http.Client{}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		errBody, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("places api error: %d — %s", resp.StatusCode, string(errBody))
	}

	var result PlaceResponse
	json.NewDecoder(resp.Body).Decode(&result)
	return &result, nil
}
