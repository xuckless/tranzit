package main

import (
	"context"
	"fmt"
	"os"
	"time"

	"github.com/joho/godotenv"
)

func main() {
	_ = godotenv.Load()

	dsn := os.Getenv("SUPABASE_DIRECT_CONNECTION_STRING")
	if dsn == "" {
		fmt.Fprintln(os.Stderr, "SUPABASE_DIRECT_CONNECTION_STRING not set")
		os.Exit(1)
	}
	appToken := os.Getenv("APP_TOKEN")

	forceReload := false
	for _, arg := range os.Args[1:] {
		if arg == "--force-reload" {
			forceReload = true
		}
	}

	// Start the WebSocket server immediately so Cloud Run's startup probe passes
	// before the potentially long SODA2 scrape runs.
	port := os.Getenv("PORT")
	if port == "" {
		port = fmt.Sprintf("%d", wsPort)
	}
	hub := newHub()
	startWSServer(hub, "0.0.0.0:"+port)

	ctx := context.Background()

	pool, err := newPool(ctx, dsn)
	if err != nil {
		fmt.Fprintf(os.Stderr, "pool config: %v\n", err)
		os.Exit(1)
	}
	defer pool.Close()

	if err := waitForDB(ctx, pool, 5, 3*time.Second); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}

	if err := setupSchema(ctx, pool); err != nil {
		fmt.Fprintf(os.Stderr, "schema: %v\n", err)
		os.Exit(1)
	}

	loaded, err := isSoda2Loaded(ctx, pool)
	if err != nil {
		fmt.Fprintf(os.Stderr, "soda2 check: %v\n", err)
		os.Exit(1)
	}
	if forceReload || !loaded {
		if err := scrapeSoda2(ctx, pool, appToken); err != nil {
			fmt.Fprintf(os.Stderr, "soda2: %v\n", err)
			os.Exit(1)
		}
	} else {
		fmt.Println("SODA2 data already loaded. Use --force-reload to refresh.")
	}

	fmt.Printf("Starting real-time polling every %ds. Ctrl+C to stop.\n", realtimeInterval)
	for {
		if err := scrapeRealtime(ctx, pool, hub, appToken); err != nil {
			fmt.Printf("Realtime error: %v\n", err)
		}
		time.Sleep(realtimeInterval * time.Second)
	}
}
