package main

// photon.go is the no-Google fallback for place search. When GMAPS_API_KEY is
// empty, FetchPlace / FetchAutocomplete / FetchPlaceDetails / FetchNearbyPlaces
// call Photon (OpenStreetMap geocoder, https://photon.komoot.io; base overridable
// via PHOTON_URL) instead, biased to Calgary and filtered to the same bbox the
// Google text search uses. Results are mapped onto the exact response structs the
// app already consumes.
//
// Place ids are synthesized as  osm:<osm_type><osm_id>@<lat>,<lng>  (e.g.
// osm:N123456@51.044700,-114.071900): the coordinates ride in the id so /details
// can resolve it with one Photon reverse lookup and still return the exact point.

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

const (
	calgaryLat = 51.0447
	calgaryLon = -114.0719
	// Same ~50 km box as the Google text search locationRestriction (places.go).
	bboxMinLat, bboxMinLon = 50.5947, -114.7919
	bboxMaxLat, bboxMaxLon = 51.4947, -113.3519

	photonUserAgent = "tranzit-demo"
)

var photonClient = &http.Client{Timeout: 10 * time.Second}

// useGoogle reports whether a Google Maps key is configured.
func useGoogle() bool { return os.Getenv("GMAPS_API_KEY") != "" }

func photonBase() string {
	return strings.TrimRight(envOr("PHOTON_URL", "https://photon.komoot.io"), "/")
}

func inCalgaryBBox(lat, lon float64) bool {
	return lat >= bboxMinLat && lat <= bboxMaxLat && lon >= bboxMinLon && lon <= bboxMaxLon
}

type photonFeature struct {
	Geometry struct {
		Coordinates []float64 `json:"coordinates"` // [lon, lat]
	} `json:"geometry"`
	Properties struct {
		OsmID       int64  `json:"osm_id"`
		OsmType     string `json:"osm_type"`
		OsmKey      string `json:"osm_key"`
		OsmValue    string `json:"osm_value"`
		Name        string `json:"name"`
		HouseNumber string `json:"housenumber"`
		Street      string `json:"street"`
		District    string `json:"district"`
		City        string `json:"city"`
		State       string `json:"state"`
		Postcode    string `json:"postcode"`
		Country     string `json:"country"`
	} `json:"properties"`
}

type photonResponse struct {
	Features []photonFeature `json:"features"`
}

func (f photonFeature) latLon() (float64, float64, bool) {
	if len(f.Geometry.Coordinates) < 2 {
		return 0, 0, false
	}
	return f.Geometry.Coordinates[1], f.Geometry.Coordinates[0], true
}

// placeID synthesizes the stable osm:… id (see file comment).
func (f photonFeature) placeID() string {
	lat, lon, _ := f.latLon()
	return fmt.Sprintf("osm:%s%d@%.6f,%.6f", f.Properties.OsmType, f.Properties.OsmID, lat, lon)
}

// parseOSMPlaceID extracts the coordinates from an osm:… id.
func parseOSMPlaceID(id string) (lat, lon float64, ok bool) {
	rest, found := strings.CutPrefix(id, "osm:")
	if !found {
		return 0, 0, false
	}
	at := strings.LastIndex(rest, "@")
	if at < 0 {
		return 0, 0, false
	}
	parts := strings.Split(rest[at+1:], ",")
	if len(parts) != 2 {
		return 0, 0, false
	}
	lat, err1 := strconv.ParseFloat(parts[0], 64)
	lon, err2 := strconv.ParseFloat(parts[1], 64)
	if err1 != nil || err2 != nil {
		return 0, 0, false
	}
	return lat, lon, true
}

func (f photonFeature) streetLine() string {
	p := f.Properties
	return strings.TrimSpace(strings.TrimSpace(p.HouseNumber + " " + p.Street))
}

// displayName prefers the POI/feature name, then the street address.
func (f photonFeature) displayName() string {
	if f.Properties.Name != "" {
		return f.Properties.Name
	}
	if s := f.streetLine(); s != "" {
		return s
	}
	return f.Properties.City
}

// formattedAddress renders a Google-style "street, city, state postcode, country".
func (f photonFeature) formattedAddress() string {
	p := f.Properties
	var parts []string
	add := func(s string) {
		if s = strings.TrimSpace(s); s != "" {
			parts = append(parts, s)
		}
	}
	add(f.streetLine())
	if p.City != "" {
		add(p.City)
	} else {
		add(p.District)
	}
	add(strings.TrimSpace(p.State + " " + p.Postcode))
	add(p.Country)
	return strings.Join(parts, ", ")
}

// secondaryText is the address minus the main text (for autocomplete rows).
func (f photonFeature) secondaryText() string {
	addr := f.formattedAddress()
	main := f.displayName()
	if rest, ok := strings.CutPrefix(addr, main); ok {
		return strings.TrimLeft(rest, ", ")
	}
	return addr
}

func (f photonFeature) toNearbyPlace() NearbyPlace {
	var p NearbyPlace
	p.ID = f.placeID()
	p.FormattedAddress = f.formattedAddress()
	p.DisplayName.Text = f.displayName()
	p.Location.Latitude, p.Location.Longitude, _ = f.latLon()
	return p
}

// photonGet calls Photon and returns only features inside the Calgary bbox.
func photonGet(path string, params url.Values) ([]photonFeature, error) {
	req, err := http.NewRequest(http.MethodGet, photonBase()+path+"?"+params.Encode(), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", photonUserAgent)
	resp, err := photonClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return nil, fmt.Errorf("photon error: %d — %s", resp.StatusCode, string(b))
	}
	var pr photonResponse
	if err := json.NewDecoder(resp.Body).Decode(&pr); err != nil {
		return nil, fmt.Errorf("photon decode: %w", err)
	}
	out := make([]photonFeature, 0, len(pr.Features))
	for _, f := range pr.Features {
		if lat, lon, ok := f.latLon(); ok && inCalgaryBBox(lat, lon) {
			out = append(out, f)
		}
	}
	return out, nil
}

// photonSearch is a Calgary-biased forward search.
func photonSearch(query string, limit int) ([]photonFeature, error) {
	params := url.Values{}
	params.Set("q", query)
	params.Set("lat", strconv.FormatFloat(calgaryLat, 'f', -1, 64))
	params.Set("lon", strconv.FormatFloat(calgaryLon, 'f', -1, 64))
	params.Set("limit", strconv.Itoa(limit))
	params.Set("lang", "en")
	params.Set("bbox", fmt.Sprintf("%g,%g,%g,%g", bboxMinLon, bboxMinLat, bboxMaxLon, bboxMaxLat))
	return photonGet("/api", params)
}

func photonReverse(lat, lon float64, limit int, radiusKm float64) ([]photonFeature, error) {
	params := url.Values{}
	params.Set("lat", strconv.FormatFloat(lat, 'f', -1, 64))
	params.Set("lon", strconv.FormatFloat(lon, 'f', -1, 64))
	params.Set("limit", strconv.Itoa(limit))
	params.Set("lang", "en")
	if radiusKm > 0 {
		params.Set("radius", strconv.FormatFloat(radiusKm, 'f', -1, 64))
	}
	return photonGet("/reverse", params)
}

// ── fallbacks for the four endpoints (same shapes as the Google paths) ────────

func photonFetchPlace(query string) (*PlaceResponse, error) {
	feats, err := photonSearch(query, 10)
	if err != nil {
		return nil, err
	}
	res := &PlaceResponse{Places: []NearbyPlace{}}
	for _, f := range feats {
		res.Places = append(res.Places, f.toNearbyPlace())
	}
	return res, nil
}

// autocompletePrediction mirrors the subset of Google's legacy Place Autocomplete
// prediction the app reads (place_id, description, structured_formatting).
type autocompletePrediction struct {
	PlaceID              string `json:"place_id"`
	Description          string `json:"description"`
	StructuredFormatting struct {
		MainText      string `json:"main_text"`
		SecondaryText string `json:"secondary_text,omitempty"`
	} `json:"structured_formatting"`
}

func photonFetchAutocomplete(input string) ([]byte, error) {
	feats, err := photonSearch(input, 5)
	if err != nil {
		return nil, err
	}
	preds := make([]autocompletePrediction, 0, len(feats))
	for _, f := range feats {
		var p autocompletePrediction
		p.PlaceID = f.placeID()
		p.StructuredFormatting.MainText = f.displayName()
		p.StructuredFormatting.SecondaryText = f.secondaryText()
		p.Description = p.StructuredFormatting.MainText
		if p.StructuredFormatting.SecondaryText != "" {
			p.Description += ", " + p.StructuredFormatting.SecondaryText
		}
		preds = append(preds, p)
	}
	status := "OK"
	if len(preds) == 0 {
		status = "ZERO_RESULTS"
	}
	return json.Marshal(map[string]any{"predictions": preds, "status": status})
}

func photonFetchPlaceDetails(placeID string) (*PlaceDetailsResponse, error) {
	lat, lon, ok := parseOSMPlaceID(placeID)
	if !ok {
		return nil, errors.New("place id is not an osm: id and GMAPS_API_KEY is unset")
	}
	res := &PlaceDetailsResponse{ID: placeID, Types: []string{}}
	res.Location.Latitude, res.Location.Longitude = lat, lon
	feats, err := photonReverse(lat, lon, 5, 0.1)
	if err != nil {
		return nil, err
	}
	if len(feats) > 0 {
		// Prefer the very feature the id was minted from; else the nearest one.
		f := feats[0]
		for _, c := range feats {
			if strings.HasPrefix(placeID, fmt.Sprintf("osm:%s%d@", c.Properties.OsmType, c.Properties.OsmID)) {
				f = c
				break
			}
		}
		res.FormattedAddress = f.formattedAddress()
		res.DisplayName.Text = f.displayName()
		if f.Properties.OsmValue != "" {
			res.Types = []string{f.Properties.OsmValue}
		}
	}
	return res, nil
}

func photonFetchNearby(lat, lng float64) ([]NearbyPlace, error) {
	feats, err := photonReverse(lat, lng, 4, 0.05) // 50 m, like the Google path
	if err != nil {
		return nil, err
	}
	out := make([]NearbyPlace, 0, len(feats))
	for _, f := range feats {
		out = append(out, f.toNearbyPlace())
	}
	return out, nil
}
