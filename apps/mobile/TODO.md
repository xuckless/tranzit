I dug through the live-data pipeline. The bottom-sheet swap isn't where your memory/efficiency win is — the vehicle
  SSE fan-out is. Here's what's actually costing you, grounded in the code.

  The real hot path: full-fleet fan-out every tick

  useVehicles() hands every subscriber the entire Calgary fleet array on every SSE event, and both subscribers rebuild
  everything downstream. Three compounding costs:

  1. broadcast() rebuilds the whole fleet even on a 2-vehicle delta — lib/vehicleSSE.ts:41-44, 31-39

  applyUpdate() patches a handful of entries, then rebuildSnapshot() iterates all ~2-3k vehicles and re-runs
  isValidVehicle() on each to build a fresh array — every event. The vehicles were already validated on insert
  (applySnapshot/applyUpdate lines 49, 66), so the per-broadcast revalidation is pure waste.

  2. commute.tsx subscribes to the entire fleet but wants 1-3 routes — commute.tsx:607, 773-781

  allVehicles = useVehicles() → the full fleet flows into a 2,568-line screen, re-rendering it every tick, then
  routeVehicles filters the whole fleet down to one route's buses (.filter(... transitRouteIds.includes ...)) on every
  event. You re-render the biggest screen in the app on a 3s cadence to display ~3 buses.

  3. vehiclesToGeoJSON re-allocates the whole FeatureCollection every render — vehicleSSE.ts:150-169, used at
  map.tsx:227

  Each tick allocates a new FeatureCollection: N Feature objects + N [lng,lat] tuples + N props objects ≈ 3N
  short-lived allocations per subscriber per tick, all garbage the moment MapLibre diffs them. With the full fleet × 2
  subscribers, that's your GC churn / frame-drop source — this is the memory pressure, not steady-state footprint.

  Fixes, highest leverage first

  Fix: Add a selector hook useVehiclesForRoutes(ids) that filters inside the store and only setStates when those
    vehicles changed (returns a stable ref otherwise)
  Where: commute.tsx swaps useVehicles+filter for it
  Win: Stops re-rendering the 2,568-line screen every 3s; commute touches ~3 vehicles, not 3,000
  ────────────────────────────────────────
  Fix: Coalesce broadcasts — trailing throttle / requestAnimationFrame so bursty deltas trigger one render, not N
  Where: vehicleSSE.ts broadcast()
  Win: Fewer render cycles per second
  ────────────────────────────────────────
  Fix: Maintain the valid array incrementally instead of full rebuildSnapshot() revalidation
  Where: vehicleSSE.ts:31-44
  Win: Drops O(fleet) CPU per delta to O(changed)
  ────────────────────────────────────────
  Fix: Viewport-filter vehicles before GeoJSON on the map (you already have camera + CALGARY_MAX_BOUNDS)
  Where: map.tsx:227
  Win: Cuts per-tick allocation from full fleet to on-screen buses. MapLibre already culls rendering — this culls the
    wasted JS allocation

  Secondary, smaller

  - Dead var: invalidCount in rebuildSnapshot (vehicleSSE.ts:33,36) is computed and never used — trivial, just noise.
  - stopViews 30s setInterval (stopViews.tsx:258) is fine, but verify it's cleared on unmount and not stacking across
  panel re-opens.
  - commute.tsx at 2,568 lines with ~20 useMemos recomputing on every full-fleet re-render is the multiplier that
  makes #2 hurt — fixing the subscription (#2 above) neutralizes most of it without splitting the file.

  Honest framing

  - Throughput/jank/GC: big, real win — concentrated entirely in the vehicle pipeline above.
  - Steady-state memory footprint: modest. _vehicleMap (~2-3k objects) is the floor and stays; the win is killing the
  per-tick allocation churn, which is what actually shows up as dropped frames.
  - The bottom-sheet migration we discussed is orthogonal — a smoothness/UX upgrade, not a memory one.

  Want me to implement the selector hook + broadcast coalescing in vehicleSSE.ts and switch commute.tsx over? That's
  the 80/20 and it's a contained change to two files.


  2. @gorhom/bottom-sheet vs PanResponder + Animated
  
    Short version: negligible memory win, but a real responsiveness/jank win — and it's cheaper to adopt than you'd
    think because both native deps are already installed.
  
    Memory: essentially a wash. You'd add the gorhom JS library (small), but no new native modules —
    react-native-gesture-handler (2.28) and react-native-reanimated (4.1) are already in package.json. The sheet
    component itself doesn't hold meaningfully more in memory than your Animated.Value + PanResponder. Don't expect a
    memory improvement.
  
    Performance — this is the actual case for switching, and it's specific to your app:
  
    - PanResponder resolves every gesture on the JS thread. Even with Animated + useNativeDriver, the drag tracking is
    JS-driven.
    - map.tsx — the only place you use PanResponder — is also your most JS-thread-hungry screen: the vehicleSSE
    singleton rebuilds a fresh snapshot array on every SSE event, stopsGeoJSON/vehiclesGeoJSON useMemos recompute, stop
    panels poll every 30s. When that work lands mid-drag, the JS thread is busy and the sheet stutters.
    - gorhom runs on gesture-handler (UI-thread native gestures) + reanimated worklets (UI-thread animation). The
    drag→animate loop never touches the JS thread, so it stays at 60fps even while SSE updates hammer JS. That's the
    win, and map.tsx is exactly the screen that benefits.
  
    Bonus correctness wins (arguably bigger than the fps):
    - Native scroll-gesture blending (BottomSheetScrollView/FlatList) — your nested scrolls (e.g. placeViews already
    uses the RNGH ScrollView, StopDetailsPanel's arrival list) get proper drag-vs-scroll handoff for free. With
    PanResponder you'd hand-manage that, and it's a common source of jank.
    - Snap points, backdrop, keyboard avoidance, and imperative snapToIndex come built in — you'd be deleting
    hand-rolled sheetAnim interpolation code.
  
    Cost: rewrite the sheet in map.tsx only (one file), wrap the app in GestureHandlerRootView if it isn't already
    (expo-router template usually is), and confirm the reanimated babel plugin is active (it is, since reanimated 4 is
    installed and working). Watch the React Compiler interplay — reanimated worklets are supported, but verify the sheet
    animates after enabling.
  
    Recommendation: Worth doing, but frame it as a smoothness + nested-scroll correctness upgrade on map.tsx, not a
    memory optimization. Since the heavy deps are already there, the marginal cost is low.





UI Changes needed in commute.tsx

1. the arrival time on the page is way too vague to undertsand, users get confused if that time is "Reaching Destination" or "Bus arriving on the stop. Since we have bus number (Green HERO bar), arriving in, and stop name, we are going to restructure it to just display the bus arriving in that particular stop. 


2. There is a card right next to the first section which has text To: Destination and HH:MM time on a green hero card, with a little progression bar right below it and a faint text like Arriving around: HH:MM, we are going to restructure and say something like

To: Destination         ETA: HH:MM'

       Route progession bar

3. On the section mentioned in point 1, we are planning to add a LEAVE BY section when the trip starts. The arrival time on stop is discussed already and there would be a leave by section which aims to minimise wait at bus stop. This can be done by subtracting bus arrival time to walk duration, and giving 3 more minutes of offset. The leave by calculation should only appear when the route is initally set and should disappear when served its purpose. 

4. As discussed in point 3, we will push a notification that tells that "Start heading to BUS STOP NAME now" 

5. Route Save web socket connection already conains WALKING instructions, we are looing to integrate walking into the route progress section of the screen, currently it shows bus and Stop name with timings. But now it would also incorporate "walk" as well, adding a clear indication of transfer. 

6. The walking polyline should be thick dotted line on map on commute tsx, and busses should be solid. 

7. please fix any other issues you might find laying around.


the number 1 section should look like: 

Boarding {BUS INFO AS IT IS} (replaced hero icon)
from {BUS STOP} (replaced "next stop")
arrives in {time} | Leave by {hh:mm}


The overall design is left to you, feel free to incorporate industry best standards, but you have to use the existing theme settings clearly established and used in the project. 





Changes to route tsx

the storting/subsectioning should be done by the bus/vehicle number rather than transport type you can fetch this from the route returns
the fastest route logic is not working as intended. 
fetch the top 10-15 route rather than just 5 you can do this by adding a "num_itineraries": 10 on the post request
compact the views of individual routes. 
in each section the route should be sorted in order of arrival time of busses in ascending order
The default section with "ALL" should ONLY have "FASTEST" and "FASTEST OF EACH AVAILABLE VEHICLE" 

For example if 201, 30, and 17 all go to the same destination, 
the subsection would be ALL 201, 30, 17 - all of them indivually sorted with ascending order and a fastest badge, with a ALL section containing fastest route from all the other sections.

Bug fixes:
When i pull up a route, then type destination again, the old route still pollutes the screen. Make it so, that if new values are entered into the origin or destination field, the existing page should be cleared allowing user to press find routes wihtout being confused.




========================================================================
Deferred auth (later pass — descoped from the Clerk → Supabase migration)
========================================================================

The Clerk → Supabase Auth migration shipped only the four in-scope sign-in
methods (email+password, Google, Microsoft/Azure, Apple) via web OAuth. The
following were intentionally left out and should be picked up later:

Frontend
- MFA / 2FA (TOTP): reimplement `components/auth/TwoFactorSetup.tsx` (currently a
  null stub) on `supabase.auth.mfa.*` (enroll / challenge / verify), and re-add
  the second-factor step to the sign-in flow + the Settings row.
- Connected accounts: reimplement `components/auth/ConnectedAccounts.tsx`
  (currently a null stub) on `supabase.auth.linkIdentity` / `unlinkIdentity`,
  including the Google Calendar read-only scope, and re-add the Settings row.
- Native social sign-in (better UX than the current web OAuth): Apple via
  `expo-apple-authentication` + `signInWithIdToken({ provider: 'apple' })`, and
  Google via `@react-native-google-signin/google-signin` +
  `signInWithIdToken({ provider: 'google' })`. Both add native deps/config plugins
  and need a dev-client rebuild + provider client IDs.
- Passkeys / WebAuthn.
- Username-based login and phone (SMS) auth.

Backend (`tranzit-db-middleware` — services/db-middleware)
- Attach `Authorization: Bearer <session.access_token>` to the per-user requests
  in `lib/middleware.ts` (and, if wanted, the SSE/WS paths), once the server
  verifies it. Today the `/api/v1/user/*` routes are unauthenticated.
- Verify the Supabase JWT locally against Supabase's JWKS (ES256) in `userdb.go`
  before trusting `user_id`. No shared secret — fetch + cache
  `${SUPABASE_URL}/auth/v1/.well-known/jwks.json`.
- Optional: migrate existing `user_info` rows + FK children from old Clerk ids to
  Supabase UUIDs (one-off data remap; the column already accepts the UUID string).
