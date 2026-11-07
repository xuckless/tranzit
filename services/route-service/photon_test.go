package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gofiber/fiber/v2"
)

const photonFixture = `{"type":"FeatureCollection","features":[
 {"geometry":{"coordinates":[-114.0631,51.0453]},"properties":{"osm_id":123,"osm_type":"N","osm_key":"amenity","osm_value":"library","name":"Central Library","housenumber":"800","street":"3 St SE","city":"Calgary","state":"Alberta","postcode":"T2G 2E7","country":"Canada"}},
 {"geometry":{"coordinates":[-113.4909,53.5444]},"properties":{"osm_id":9,"osm_type":"W","name":"Edmonton thing","city":"Edmonton"}}
]}`

// fakePhoton serves the fixture and records requests.
func fakePhoton(t *testing.T) (*httptest.Server, *[]*http.Request) {
	t.Helper()
	var reqs []*http.Request
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reqs = append(reqs, r)
		_, _ = io.WriteString(w, photonFixture)
	}))
	t.Cleanup(srv.Close)
	t.Setenv("PHOTON_URL", srv.URL)
	t.Setenv("GMAPS_API_KEY", "")
	return srv, &reqs
}

func TestPhotonSearchShapeAndBBox(t *testing.T) {
	_, reqs := fakePhoton(t)
	res, err := FetchPlace("library")
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Places) != 1 {
		t.Fatalf("want 1 place inside the Calgary bbox, got %d", len(res.Places))
	}
	p := res.Places[0]
	if p.ID != "osm:N123@51.045300,-114.063100" || p.DisplayName.Text != "Central Library" ||
		p.FormattedAddress != "800 3 St SE, Calgary, Alberta T2G 2E7, Canada" || p.Location.Latitude != 51.0453 {
		t.Errorf("unexpected place: %+v", p)
	}
	r := (*reqs)[0]
	if r.URL.Path != "/api" || r.URL.Query().Get("q") != "library" || r.URL.Query().Get("lat") == "" {
		t.Errorf("bad photon request: %s", r.URL)
	}
	if ua := r.Header.Get("User-Agent"); ua != "tranzit-demo" || strings.Contains(ua, "@") {
		t.Errorf("User-Agent = %q", ua)
	}
	// JSON shape matches what the app reads.
	b, _ := json.Marshal(res)
	for _, k := range []string{`"places"`, `"id"`, `"formattedAddress"`, `"displayName":{"text"`, `"location":{"latitude"`} {
		if !strings.Contains(string(b), k) {
			t.Errorf("search JSON missing %s: %s", k, b)
		}
	}
}

func TestPhotonAutocompleteShape(t *testing.T) {
	fakePhoton(t)
	b, err := FetchAutocomplete("input=central+lib&location=51.0447,-114.0719")
	if err != nil {
		t.Fatal(err)
	}
	var out struct {
		Status      string `json:"status"`
		Predictions []struct {
			PlaceID              string `json:"place_id"`
			Description          string `json:"description"`
			StructuredFormatting struct {
				MainText      string `json:"main_text"`
				SecondaryText string `json:"secondary_text"`
			} `json:"structured_formatting"`
		} `json:"predictions"`
	}
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatal(err)
	}
	if out.Status != "OK" || len(out.Predictions) != 1 {
		t.Fatalf("got %s", b)
	}
	p := out.Predictions[0]
	if p.PlaceID == "" || p.StructuredFormatting.MainText != "Central Library" ||
		p.StructuredFormatting.SecondaryText != "800 3 St SE, Calgary, Alberta T2G 2E7, Canada" {
		t.Errorf("prediction = %+v", p)
	}
}

func TestPhotonDetailsResolvesID(t *testing.T) {
	_, reqs := fakePhoton(t)
	d, err := FetchPlaceDetails("osm:N123@51.045300,-114.063100")
	if err != nil {
		t.Fatal(err)
	}
	if d.ID != "osm:N123@51.045300,-114.063100" || d.Location.Latitude != 51.0453 || d.Location.Longitude != -114.0631 ||
		d.DisplayName.Text != "Central Library" || len(d.Types) != 1 || d.Types[0] != "library" {
		t.Errorf("details = %+v", d)
	}
	if (*reqs)[0].URL.Path != "/reverse" {
		t.Errorf("details should reverse-geocode, got %s", (*reqs)[0].URL)
	}
	if _, err := FetchPlaceDetails("ChIJ-google-id"); err == nil {
		t.Error("a Google place id without GMAPS_API_KEY should error")
	}
}

func TestPhotonNearby(t *testing.T) {
	fakePhoton(t)
	ps, err := FetchNearbyPlaces(51.0453, -114.0631)
	if err != nil {
		t.Fatal(err)
	}
	if len(ps) != 1 || ps[0].DisplayName.Text != "Central Library" {
		t.Errorf("nearby = %+v", ps)
	}
}

func TestParseOSMPlaceID(t *testing.T) {
	for _, c := range []struct {
		id  string
		ok  bool
		lat float64
	}{
		{"osm:N1@51.1,-114.2", true, 51.1},
		{"osm:W99@bad,-114", false, 0},
		{"osm:N1", false, 0},
		{"ChIJabc", false, 0},
	} {
		lat, _, ok := parseOSMPlaceID(c.id)
		if ok != c.ok || lat != c.lat {
			t.Errorf("parseOSMPlaceID(%q) = %v,%v", c.id, lat, ok)
		}
	}
}

func TestDemoAuthFiber(t *testing.T) {
	app := fiber.New()
	app.Use(fiberAuth(demoVerifier{uid: "demo-user"}, true))
	app.Get("/search", func(c *fiber.Ctx) error {
		uid, _ := c.Locals("userID").(string)
		return c.SendString(uid)
	})
	for _, hdr := range []string{"", "Bearer demo", "Bearer whatever"} {
		req := httptest.NewRequest(http.MethodGet, "/search", nil)
		if hdr != "" {
			req.Header.Set("Authorization", hdr)
		}
		resp, err := app.Test(req)
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(resp.Body)
		if resp.StatusCode != 200 || string(body) != "demo-user" {
			t.Errorf("auth %q: %d %q", hdr, resp.StatusCode, body)
		}
	}
	// Non-demo enforce still rejects tokenless requests.
	app2 := fiber.New()
	app2.Use(fiberAuth(nil, true))
	app2.Get("/search", func(c *fiber.Ctx) error { return c.SendString("ok") })
	resp, _ := app2.Test(httptest.NewRequest(http.MethodGet, "/search", nil))
	if resp.StatusCode != 401 {
		t.Errorf("enforce without token: %d, want 401", resp.StatusCode)
	}
}

func TestSkewFrom(t *testing.T) {
	anchor := time.Date(2026, 11, 7, 8, 7, 48, 0, time.UTC)
	if d := skewFrom(anchor, anchor.Add(-time.Hour).UnixMilli()); d != time.Hour {
		t.Fatalf("one hour early: got %s", d)
	}
	if d := skewFrom(anchor, anchor.Add(90*time.Second).UnixMilli()); d != 0 {
		t.Fatalf("sub-15-minute noise should round to 0, got %s", d)
	}
	if d := skewFrom(anchor, 0); d != 0 {
		t.Fatalf("no plan.date: got %s", d)
	}
}
