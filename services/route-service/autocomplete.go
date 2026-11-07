package main

import (
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
)

func FetchAutocomplete(queryString string) ([]byte, error) {
	params, _ := url.ParseQuery(queryString)
	if !useGoogle() {
		return photonFetchAutocomplete(params.Get("input"))
	}
	apiKey := os.Getenv("GMAPS_API_KEY")

	if input := params.Get("input"); input != "" {
		params.Set("input", input+" calgary")
	}

	url := fmt.Sprintf("https://maps.googleapis.com/maps/api/place/autocomplete/json?%s&key=%s", params.Encode(), apiKey)

	resp, err := http.Get(url)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	return io.ReadAll(resp.Body)
}

func AutocompleteHandler(w http.ResponseWriter, r *http.Request) {
	// 1. Extract the "input" parameter from the URL
	input := r.URL.Query().Get("input")
	if input == "" {
		http.Error(w, `{"error": "Missing 'input' parameter"}`, http.StatusBadRequest)
		return
	}

	// 2. Safely encode the input and format the query string
	// Added Calgary bias: location=51.0447,-114.0719, radius=50km, restricted to Canada
	queryString := fmt.Sprintf("input=%s&location=51.0447,-114.0719&radius=50000&components=country:ca", url.QueryEscape(input))

	// 3. Call your fetch function
	data, err := FetchAutocomplete(queryString)
	if err != nil {
		http.Error(w, `{"error": "Failed to fetch data"}`, http.StatusInternalServerError)
		return
	}

	// 4. Return the JSON response
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	w.Write(data)
}
