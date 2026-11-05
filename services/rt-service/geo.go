package main

import (
	"math"
	"regexp"
	"strconv"
)

const earthRadiusM = 6_371_000.0

func haversineM(lat1, lon1, lat2, lon2 float64) float64 {
	φ1 := math.Pi / 180 * lat1
	φ2 := math.Pi / 180 * lat2
	Δφ := math.Pi / 180 * (lat2 - lat1)
	Δλ := math.Pi / 180 * (lon2 - lon1)
	a := math.Sin(Δφ/2)*math.Sin(Δφ/2) +
		math.Cos(φ1)*math.Cos(φ2)*math.Sin(Δλ/2)*math.Sin(Δλ/2)
	return earthRadiusM * 2 * math.Atan2(math.Sqrt(a), math.Sqrt(1-a))
}

func calcBearing(lat1, lon1, lat2, lon2 float64) float64 {
	φ1 := math.Pi / 180 * lat1
	φ2 := math.Pi / 180 * lat2
	Δλ := math.Pi / 180 * (lon2 - lon1)
	y := math.Sin(Δλ) * math.Cos(φ2)
	x := math.Cos(φ1)*math.Sin(φ2) - math.Sin(φ1)*math.Cos(φ2)*math.Cos(Δλ)
	return math.Mod(math.Atan2(y, x)*180/math.Pi+360, 360)
}

func calcSpeed(lat1, lon1, lat2, lon2 float64, dtSeconds int64) (float64, bool) {
	if dtSeconds <= 0 {
		return 0, false
	}
	return haversineM(lat1, lon1, lat2, lon2) / float64(dtSeconds), true
}

var wktPointRe = regexp.MustCompile(`POINT\(([^ ]+)\s+([^ )]+)\)`)

// parseWKTPoint parses "POINT(lon lat)" → (lat, lon). Returns false on failure.
func parseWKTPoint(wkt string) (lat, lon float64, ok bool) {
	m := wktPointRe.FindStringSubmatch(wkt)
	if m == nil {
		return 0, 0, false
	}
	lon, err1 := strconv.ParseFloat(m[1], 64)
	lat, err2 := strconv.ParseFloat(m[2], 64)
	if err1 != nil || err2 != nil {
		return 0, 0, false
	}
	return lat, lon, true
}

// closestPointTime estimates the Unix timestamp when a bus travelling from
// (lat1,lon1)@t1 to (lat2,lon2)@t2 was closest to stop (sLat, sLon).
func closestPointTime(lat1, lon1 float64, t1 int64, lat2, lon2 float64, t2 int64, sLat, sLon float64) (int64, bool) {
	cosLat := math.Cos(math.Pi / 180 * (lat1 + lat2) / 2)
	dx := (lon2 - lon1) * cosLat
	dy := lat2 - lat1
	sx := (sLon - lon1) * cosLat
	sy := sLat - lat1

	lenSq := dx*dx + dy*dy
	if lenSq == 0 {
		return 0, false
	}
	tFrac := (sx*dx + sy*dy) / lenSq
	if tFrac < 0 {
		tFrac = 0
	} else if tFrac > 1 {
		tFrac = 1
	}
	return t1 + int64(tFrac*float64(t2-t1)), true
}
