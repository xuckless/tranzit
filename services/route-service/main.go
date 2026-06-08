package main

import (
	"encoding/json"
	"log"
	"os"
	"strconv"

	"github.com/gofiber/fiber/v2"
	"github.com/joho/godotenv"
)

type RateLimitCalculator struct {
	RouteCalls        int
	PlacesCalls       int
	AutocompleteCalls int
	DetailsCalls      int
	SearchNearbyCalls int
	MaxCalls          int
}

var tracker = RateLimitCalculator{MaxCalls: 4000}

func main() {
	if err := godotenv.Load(); err != nil {
		log.Println("No .env file found, relying on environment variables")
	}

	app := fiber.New()

	app.Get("/", func(c *fiber.Ctx) error {
		return c.SendString("Tranzit Route Service is running.")
	})

	// GET: Search for a place
	app.Get("/search", func(c *fiber.Ctx) error {
		if tracker.PlacesCalls >= tracker.MaxCalls {
			log.Printf("[/search] Quota exceeded: %d/%d Places calls used\n", tracker.PlacesCalls, tracker.MaxCalls)
			return c.Status(429).JSON(fiber.Map{
				"error": "Places API quota exceeded for this test environment",
				"used":  tracker.PlacesCalls,
				"max":   tracker.MaxCalls,
			})
		}

		query := c.Query("q")
		if query == "" {
			return c.Status(400).JSON(fiber.Map{"error": "Invalid request: missing query"})
		}

		tracker.PlacesCalls++
		log.Printf("[/search] Places call %d/%d\n", tracker.PlacesCalls, tracker.MaxCalls)

		places, err := FetchPlace(query)
		if err != nil {
			log.Printf("[/search] FetchPlace error: %v\n", err)
			return c.Status(502).JSON(fiber.Map{"error": "API unreachable"})
		}
		if len(places.Places) == 0 {
			return c.Status(404).JSON(fiber.Map{"error": "Location not found"})
		}

		prettyJSON, _ := json.MarshalIndent(places, "", "  ")
		log.Println("Google Places Response:\n", string(prettyJSON))

		return c.JSON(places)
	})

	// POST: Get Place Details by Place ID
	app.Post("/details", func(c *fiber.Ctx) error {
		if tracker.DetailsCalls >= tracker.MaxCalls {
			log.Printf("[/details] Quota exceeded: %d/%d Details calls used\n", tracker.DetailsCalls, tracker.MaxCalls)
			return c.Status(429).JSON(fiber.Map{
				"error": "Details API quota exceeded for this test environment",
				"used":  tracker.DetailsCalls,
				"max":   tracker.MaxCalls,
			})
		}

		var body struct {
			PlaceID string `json:"place_id"`
		}
		if err := c.BodyParser(&body); err != nil || body.PlaceID == "" {
			return c.Status(400).JSON(fiber.Map{"error": "Invalid request: missing place_id"})
		}

		tracker.DetailsCalls++
		log.Printf("[/details] Details call %d/%d\n", tracker.DetailsCalls, tracker.MaxCalls)

		details, err := FetchPlaceDetails(body.PlaceID)
		if err != nil {
			log.Printf("[/details] FetchPlaceDetails error: %v\n", err)
			return c.Status(502).JSON(fiber.Map{"error": "API unreachable"})
		}

		return c.JSON(details)
	})

	// GET: Autocomplete proxy
	app.Get("/autocomplete/json", func(c *fiber.Ctx) error {
		if tracker.AutocompleteCalls >= tracker.MaxCalls {
			log.Printf("[/autocomplete/json] Quota exceeded: %d/%d Autocomplete calls used\n", tracker.AutocompleteCalls, tracker.MaxCalls)
			return c.Status(429).JSON(fiber.Map{
				"error": "Autocomplete API quota exceeded for this test environment",
				"used":  tracker.AutocompleteCalls,
				"max":   tracker.MaxCalls,
			})
		}

		input := c.Query("input")
		if input == "" {
			return c.Status(400).JSON(fiber.Map{"error": "Invalid request: missing input"})
		}

		tracker.AutocompleteCalls++
		log.Printf("[/autocomplete/json] Autocomplete call %d/%d\n", tracker.AutocompleteCalls, tracker.MaxCalls)

		data, err := FetchAutocomplete(string(c.Request().URI().QueryString()))
		if err != nil {
			log.Printf("[/autocomplete/json] FetchAutocomplete error: %v\n", err)
			return c.Status(502).JSON(fiber.Map{"error": "API unreachable"})
		}

		c.Set("Content-Type", "application/json")
		return c.Send(data)
	})

	// POST: Get Transit Routes
	app.Post("/route", func(c *fiber.Ctx) error {
		if tracker.RouteCalls >= tracker.MaxCalls {
			log.Printf("[/route] Quota exceeded: %d/%d Route calls used\n", tracker.RouteCalls, tracker.MaxCalls)
			return c.Status(429).JSON(fiber.Map{
				"error": "Routes API quota exceeded for this test environment",
				"used":  tracker.RouteCalls,
				"max":   tracker.MaxCalls,
			})
		}

		req := new(RouteRequest)
		if err := c.BodyParser(req); err != nil {
			return c.Status(400).JSON(fiber.Map{"error": "Invalid JSON payload"})
		}

		if req.Destination == "" {
			return c.Status(400).JSON(fiber.Map{"error": "Destination ID required"})
		}

		tracker.RouteCalls++
		log.Printf("[/route] Route call %d/%d\n", tracker.RouteCalls, tracker.MaxCalls)

		routes, err := FetchTransitRoutes(req.Origin, req.Destination)
		if err != nil {
			return c.Status(502).JSON(fiber.Map{"error": "Routing service unreachable"})
		}

		if routes == nil {
			return c.SendStatus(204)
		}

		prettyJSON, _ := json.MarshalIndent(routes, "", "  ")
		log.Println("Google Routes Response:\n", string(prettyJSON))

		return c.JSON(routes)
	})

	// POST: Get walk/bike/transit routes from the self-hosted OpenTripPlanner engine.
	// Supplements /route (Google) — no Google quota is consumed here.
	app.Post("/route/otp", func(c *fiber.Ctx) error {
		req := new(OTPRouteRequest)
		if err := c.BodyParser(req); err != nil {
			return c.Status(400).JSON(fiber.Map{"error": "Invalid JSON payload"})
		}
		if req.Origin.Lat == 0 && req.Origin.Lng == 0 {
			return c.Status(400).JSON(fiber.Map{"error": "origin {lat,lng} required"})
		}
		if req.Destination.Lat == 0 && req.Destination.Lng == 0 {
			return c.Status(400).JSON(fiber.Map{"error": "destination {lat,lng} required"})
		}

		itineraries, err := FetchOTPRoutes(*req)
		if err != nil {
			log.Printf("[/route/otp] error: %v\n", err)
			return c.Status(502).JSON(fiber.Map{"error": "Routing engine unreachable or rejected request", "detail": err.Error()})
		}
		if len(itineraries) == 0 {
			return c.SendStatus(204)
		}
		return c.JSON(fiber.Map{"source": SourceOpenTrip, "itineraries": itineraries})
	})

	// GET: Find closest establishment to a lat/lng coordinate
	app.Get("/searchnearby", func(c *fiber.Ctx) error {
		if tracker.SearchNearbyCalls >= tracker.MaxCalls {
			log.Printf("[/searchnearby] Quota exceeded: %d/%d SearchNearby calls used\n", tracker.SearchNearbyCalls, tracker.MaxCalls)
			return c.Status(429).JSON(fiber.Map{
				"error": "SearchNearby API quota exceeded for this test environment",
				"used":  tracker.SearchNearbyCalls,
				"max":   tracker.MaxCalls,
			})
		}

		lat, latErr := strconv.ParseFloat(c.Query("lat"), 64)
		lng, lngErr := strconv.ParseFloat(c.Query("lng"), 64)
		if latErr != nil || c.Query("lat") == "" {
			return c.Status(400).JSON(fiber.Map{"error": "Invalid or missing 'lat' query parameter"})
		}
		if lngErr != nil || c.Query("lng") == "" {
			return c.Status(400).JSON(fiber.Map{"error": "Invalid or missing 'lng' query parameter"})
		}

		tracker.SearchNearbyCalls++
		log.Printf("[/searchnearby] SearchNearby call %d/%d — lat=%.6f lng=%.6f\n", tracker.SearchNearbyCalls, tracker.MaxCalls, lat, lng)

		places, err := FetchNearbyPlaces(lat, lng)
		if err != nil {
			log.Printf("[/searchnearby] FetchNearbyPlaces error: %v\n", err)
			return c.Status(502).JSON(fiber.Map{"error": "API unreachable"})
		}
		if len(places) == 0 {
			return c.Status(404).JSON(fiber.Map{"error": "No establishment found near that location"})
		}

		prettyJSON, _ := json.MarshalIndent(places, "", "  ")
		log.Println("SearchNearby Response:\n", string(prettyJSON))

		return c.JSON(fiber.Map{"places": places})
	})

	// GET: Quota usage
	app.Get("/limits", func(c *fiber.Ctx) error {
		return c.JSON(fiber.Map{
			"max_calls_per_endpoint": tracker.MaxCalls,
			"places": fiber.Map{
				"used":      tracker.PlacesCalls,
				"remaining": tracker.MaxCalls - tracker.PlacesCalls,
				"exceeded":  tracker.PlacesCalls >= tracker.MaxCalls,
			},
			"details": fiber.Map{
				"used":      tracker.DetailsCalls,
				"remaining": tracker.MaxCalls - tracker.DetailsCalls,
				"exceeded":  tracker.DetailsCalls >= tracker.MaxCalls,
			},
			"autocomplete": fiber.Map{
				"used":      tracker.AutocompleteCalls,
				"remaining": tracker.MaxCalls - tracker.AutocompleteCalls,
				"exceeded":  tracker.AutocompleteCalls >= tracker.MaxCalls,
			},
			"routes": fiber.Map{
				"used":      tracker.RouteCalls,
				"remaining": tracker.MaxCalls - tracker.RouteCalls,
				"exceeded":  tracker.RouteCalls >= tracker.MaxCalls,
			},
			"searchnearby": fiber.Map{
				"used":      tracker.SearchNearbyCalls,
				"remaining": tracker.MaxCalls - tracker.SearchNearbyCalls,
				"exceeded":  tracker.SearchNearbyCalls >= tracker.MaxCalls,
			},
		})
	})

	port := os.Getenv("PORT")
	if port == "" {
		port = "3100"
	}
	log.Fatal(app.Listen(":" + port))
}
