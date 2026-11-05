// Package geo holds the small geospatial helpers Route Save needs.
//
// Everything here operates on decimal degrees in (lat, lng) order. Note the
// platform invariant (doc §2): WKT geometries from the database are stored
// lng-lat (POINT(lon lat)); converting those into LatLng is the caller's job
// (see internal/datasource), not this package's.
package geo

import "math"

const earthRadiusM = 6371000.0

// LatLng is a point in decimal degrees, latitude then longitude.
type LatLng struct {
	Lat float64
	Lng float64
}

// HaversineM returns the great-circle distance between a and b in metres.
func HaversineM(a, b LatLng) float64 {
	lat1 := a.Lat * math.Pi / 180
	lat2 := b.Lat * math.Pi / 180
	dLat := (b.Lat - a.Lat) * math.Pi / 180
	dLng := (b.Lng - a.Lng) * math.Pi / 180

	h := math.Sin(dLat/2)*math.Sin(dLat/2) +
		math.Cos(lat1)*math.Cos(lat2)*math.Sin(dLng/2)*math.Sin(dLng/2)
	return 2 * earthRadiusM * math.Asin(math.Min(1, math.Sqrt(h)))
}
