package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
)

type PlaceDetailsResponse struct {
	ID               string `json:"id"`
	FormattedAddress string `json:"formattedAddress"`
	DisplayName      struct {
		Text string `json:"text"`
	} `json:"displayName"`
	Location struct {
		Latitude  float64 `json:"latitude"`
		Longitude float64 `json:"longitude"`
	} `json:"location"`
	Types               []string `json:"types"`
	NationalPhoneNumber string   `json:"nationalPhoneNumber"`
	WebsiteUri          string   `json:"websiteUri"`
	Rating              float64  `json:"rating"`
	UserRatingCount     int      `json:"userRatingCount"`
	BusinessStatus      string   `json:"businessStatus"`
	RegularOpeningHours struct {
		OpenNow             bool     `json:"openNow"`
		WeekdayDescriptions []string `json:"weekdayDescriptions"`
	} `json:"regularOpeningHours"`
}

func FetchPlaceDetails(placeID string) (*PlaceDetailsResponse, error) {
	if !useGoogle() {
		return photonFetchPlaceDetails(placeID)
	}
	apiKey := os.Getenv("GMAPS_API_KEY")
	url := fmt.Sprintf("https://places.googleapis.com/v1/places/%s", placeID)

	req, _ := http.NewRequest("GET", url, nil)
	req.Header.Set("X-Goog-Api-Key", apiKey)
	req.Header.Set("X-Goog-FieldMask", "id,displayName,formattedAddress,location,types,nationalPhoneNumber,websiteUri,rating,userRatingCount,businessStatus,regularOpeningHours")

	client := &http.Client{}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		errBody, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("places details api error: %d — %s", resp.StatusCode, string(errBody))
	}

	var result PlaceDetailsResponse
	json.NewDecoder(resp.Body).Decode(&result)
	return &result, nil
}
