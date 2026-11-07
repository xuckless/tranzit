// Command rt-feed is the demo's GTFS-Realtime source. It serves Calgary Transit's
// three feeds (vehicle positions, trip updates, alerts) at /vehicles.pb,
// /trips.pb and /alerts.pb, so rt-service and OTP read one local address.
//
// Modes (FEED_MODE):
//   - auto (default): proxy the live feed; when it is unreachable, replay the recording.
//   - live:           proxy only (errors pass through as 502).
//   - replay:         always replay the recording (fully offline demo).
//
// With RECORD=1 every successful live fetch is also saved (at most once per
// RECORD_EVERY) as <REC_DIR>/<feed>/<unix>.pb.gz. Replay loops over the recording
// and shifts every timestamp so the data looks current.
package main

import (
	"bytes"
	"compress/gzip"
	"compress/zlib"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/MobilityData/gtfs-realtime-bindings/golang/gtfs"
	"google.golang.org/protobuf/proto"
)

type feed struct {
	name     string
	upstream string

	mu       sync.Mutex
	cached   []byte
	cachedAt time.Time
	lastSave time.Time
	lastOK   time.Time
	source   string // "live" | "replay" | ""
}

var (
	mode        = envOr("FEED_MODE", "auto")
	recDir      = envOr("REC_DIR", "/recordings")
	record      = os.Getenv("RECORD") == "1"
	recordEvery = durOr("RECORD_EVERY", 30*time.Second)
	cacheFor    = durOr("CACHE_FOR", 10*time.Second)
	client      = &http.Client{Timeout: 12 * time.Second}
	started     = time.Now()
)

func main() {
	feeds := map[string]*feed{
		"vehicles": {name: "vehicles", upstream: envOr("UPSTREAM_VEHICLES", "https://data.calgary.ca/download/am7c-qe3u/application%2Foctet-stream")},
		"trips":    {name: "trips", upstream: envOr("UPSTREAM_TRIPS", "https://data.calgary.ca/download/gs4m-mdc2/application%2Foctet-stream")},
		"alerts":   {name: "alerts", upstream: envOr("UPSTREAM_ALERTS", "https://data.calgary.ca/download/jhgn-ynqj/application%2Foctet-stream")},
	}

	mux := http.NewServeMux()
	for _, f := range feeds {
		f := f
		mux.HandleFunc("/"+f.name+".pb", func(w http.ResponseWriter, r *http.Request) { f.serve(w) })
	}
	mux.HandleFunc("/status", func(w http.ResponseWriter, r *http.Request) {
		out := map[string]any{"mode": mode, "recording": record}
		for name, f := range feeds {
			f.mu.Lock()
			out[name] = map[string]any{
				"source":     f.source,
				"last_live":  unixOrNil(f.lastOK),
				"recordings": len(listRecordings(name)),
			}
			f.mu.Unlock()
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(out)
	})
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte("ok")) })

	addr := ":" + envOr("PORT", "8780")
	log.Printf("rt-feed: mode=%s record=%v rec_dir=%s listening on %s", mode, record, recDir, addr)
	log.Fatal(http.ListenAndServe(addr, mux))
}

func (f *feed) serve(w http.ResponseWriter) {
	body, src, err := f.get()
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	w.Header().Set("Content-Type", "application/x-protobuf")
	w.Header().Set("X-Feed-Source", src)
	_, _ = w.Write(body)
}

func (f *feed) get() ([]byte, string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.cached != nil && time.Since(f.cachedAt) < cacheFor {
		return f.cached, f.source, nil
	}

	if mode != "replay" {
		body, err := fetch(f.upstream)
		if err == nil {
			f.lastOK = time.Now()
			if record && time.Since(f.lastSave) >= recordEvery {
				if err := save(f.name, body); err != nil {
					log.Printf("rt-feed: record %s: %v", f.name, err)
				} else {
					f.lastSave = time.Now()
				}
			}
			f.set(body, "live")
			return body, "live", nil
		}
		if mode == "live" {
			return nil, "", err
		}
		if f.source != "replay" {
			log.Printf("rt-feed: %s live fetch failed (%v) — replaying the recording", f.name, err)
		}
	}

	body, err := replay(f.name)
	if err != nil {
		return nil, "", err
	}
	f.set(body, "replay")
	return body, "replay", nil
}

func (f *feed) set(b []byte, src string) {
	f.cached, f.cachedAt, f.source = b, time.Now(), src
}

func fetch(url string) ([]byte, error) {
	req, _ := http.NewRequest(http.MethodGet, url, nil)
	req.Header.Set("User-Agent", "tranzit-demo-rt-feed")
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("upstream %s", resp.Status)
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, 64<<20))
	if err != nil {
		return nil, err
	}
	// Calgary sometimes serves the feed gzip/zlib-compressed without a
	// Content-Encoding header (rt-service's reader copes the same way). Return the
	// first decoding that parses; reject HTML error pages and truncated bodies.
	for _, dec := range []func([]byte) ([]byte, error){
		func(c []byte) ([]byte, error) { return c, nil },
		func(c []byte) ([]byte, error) {
			r, err := gzip.NewReader(bytes.NewReader(c))
			if err != nil {
				return nil, err
			}
			defer r.Close()
			return io.ReadAll(r)
		},
		func(c []byte) ([]byte, error) {
			r, err := zlib.NewReader(bytes.NewReader(c))
			if err != nil {
				return nil, err
			}
			defer r.Close()
			return io.ReadAll(r)
		},
	} {
		d, err := dec(b)
		if err == nil && proto.Unmarshal(d, &gtfs.FeedMessage{}) == nil {
			return d, nil
		}
	}
	return nil, fmt.Errorf("upstream returned a non-GTFS-RT body (%d bytes)", len(b))
}

func save(name string, body []byte) error {
	dir := filepath.Join(recDir, name)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	if _, err := zw.Write(body); err != nil {
		return err
	}
	if err := zw.Close(); err != nil {
		return err
	}
	ts := feedTimestamp(body)
	if ts == 0 {
		ts = time.Now().Unix()
	}
	return os.WriteFile(filepath.Join(dir, fmt.Sprintf("%d.pb.gz", ts)), buf.Bytes(), 0o644)
}

// listRecordings returns the recorded snapshot times for a feed, ascending.
func listRecordings(name string) []int64 {
	entries, _ := os.ReadDir(filepath.Join(recDir, name))
	var out []int64
	for _, e := range entries {
		n := strings.TrimSuffix(e.Name(), ".pb.gz")
		if ts, err := strconv.ParseInt(n, 10, 64); err == nil {
			out = append(out, ts)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out
}

// replay picks the snapshot at the same offset into the recording as we are into
// a loop of it, and shifts its timestamps forward so they read as "now".
func replay(name string) ([]byte, error) {
	recs := listRecordings(name)
	if len(recs) == 0 {
		return nil, fmt.Errorf("live %s feed unavailable and no recording in %s (run ./demo.sh record)", name, filepath.Join(recDir, name))
	}
	first, last := recs[0], recs[len(recs)-1]
	span := last - first + 30
	offset := int64(time.Since(started).Seconds()) % span
	pick := recs[0]
	for _, ts := range recs {
		if ts-first <= offset {
			pick = ts
		}
	}

	raw, err := os.ReadFile(filepath.Join(recDir, name, fmt.Sprintf("%d.pb.gz", pick)))
	if err != nil {
		return nil, err
	}
	zr, err := gzip.NewReader(bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	body, err := io.ReadAll(zr)
	if err != nil {
		return nil, err
	}
	var msg gtfs.FeedMessage
	if err := proto.Unmarshal(body, &msg); err != nil {
		return nil, err
	}
	shiftFeed(&msg, time.Now().Unix()-pick)
	return proto.Marshal(&msg)
}

// shiftFeed moves every absolute time in the feed forward by delta seconds.
// Service-date fields (start_date) are rewritten to today so trip matching works
// for trips that run on the replay day too.
func shiftFeed(m *gtfs.FeedMessage, delta int64) {
	sh := func(p *uint64) *uint64 {
		if p == nil || *p == 0 {
			return p
		}
		v := uint64(int64(*p) + delta)
		return &v
	}
	shi := func(p *int64) *int64 {
		if p == nil || *p == 0 {
			return p
		}
		v := *p + delta
		return &v
	}
	today := time.Now().In(calgary()).Format("20060102")
	m.Header.Timestamp = sh(m.Header.Timestamp)
	for _, e := range m.Entity {
		if v := e.Vehicle; v != nil {
			v.Timestamp = sh(v.Timestamp)
			if v.Trip != nil && v.Trip.StartDate != nil {
				v.Trip.StartDate = proto.String(today)
			}
		}
		if tu := e.TripUpdate; tu != nil {
			tu.Timestamp = sh(tu.Timestamp)
			if tu.Trip != nil && tu.Trip.StartDate != nil {
				tu.Trip.StartDate = proto.String(today)
			}
			for _, st := range tu.StopTimeUpdate {
				if st.Arrival != nil {
					st.Arrival.Time = shi(st.Arrival.Time)
				}
				if st.Departure != nil {
					st.Departure.Time = shi(st.Departure.Time)
				}
			}
		}
		if a := e.Alert; a != nil {
			for _, p := range a.ActivePeriod {
				p.Start = sh(p.Start)
				p.End = sh(p.End)
			}
		}
	}
}

func feedTimestamp(b []byte) int64 {
	var m gtfs.FeedMessage
	if proto.Unmarshal(b, &m) != nil || m.Header == nil {
		return 0
	}
	return int64(m.Header.GetTimestamp())
}

func calgary() *time.Location {
	if loc, err := time.LoadLocation("America/Edmonton"); err == nil {
		return loc
	}
	return time.FixedZone("MT", -7*3600)
}

func unixOrNil(t time.Time) any {
	if t.IsZero() {
		return nil
	}
	return t.Unix()
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func durOr(k string, def time.Duration) time.Duration {
	if d, err := time.ParseDuration(os.Getenv(k)); err == nil {
		return d
	}
	return def
}
