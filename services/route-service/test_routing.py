#!/usr/bin/env python3
"""
OTP vs Google Maps routing comparison — all requests hit Cloud Run.

Usage:
  python3 test_routing.py              # all 5 test cases
  python3 test_routing.py --cases 2   # first N cases only
  python3 test_routing.py --raw       # also dump full JSON responses

Requires: pip install requests
"""

import argparse
import json
import sys
import time
from dataclasses import dataclass, field
from typing import Optional

import requests

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

CLOUD = "https://tranzit-route-service-000000000000.us-central1.run.app"
ORIGIN = {"lat": 51.0447, "lng": -114.0719}  # downtown Calgary (8 Ave & Centre St)

# Destinations: give place_id if already known, otherwise a search query.
# Chosen to cover a spread of distances, routes, and transit types.
CASES = [
    {
        "name": "University of Calgary",
        "query": "University of Calgary",
        "why": "Long CTrain Red Line route; heavily served",
    },
    {
        "name": "Chinook Centre",
        "query": "Chinook Centre Calgary",
        "why": "South corridor bus; BRT candidate",
    },
    {
        "name": "Jamesons Pub – 17 Ave SW",
        "place_id": "ChIJa60sVCdwcVMRWr5S3UjLloo",
        "why": "Short trip; borderline walkable — tests walk vs transit cutoff",
    },
    {
        "name": "Calgary Airport (YYC)",
        "query": "Calgary International Airport",
        "why": "Far north-east edge; tests low-frequency BRT/bus reliability",
    },
    {
        "name": "Tuscany LRT Station",
        "query": "Tuscany LRT Station Calgary",
        "why": "NW suburbs; end-of-line station, low frequency",
    },
]

OTP_MODES = ["walk_transit", "bike_transit", "walk"]

TIMEOUT = 45  # seconds per request


# ---------------------------------------------------------------------------
# HTTP helpers
# ---------------------------------------------------------------------------

def _get(path: str, **kwargs) -> requests.Response:
    return requests.get(f"{CLOUD}{path}", timeout=TIMEOUT, **kwargs)


def _post(path: str, **kwargs) -> requests.Response:
    return requests.post(f"{CLOUD}{path}", timeout=TIMEOUT, **kwargs)


def _with_retry(fn, label: str, retries: int = 2, backoff: float = 2.0):
    for attempt in range(retries + 1):
        try:
            r = fn()
            if r.status_code == 429:
                print(f"  [WARN] 429 quota warning on {label}" + (f", retrying in {backoff}s" if attempt < retries else " — giving up"))
                if attempt < retries:
                    time.sleep(backoff)
                    continue
            return r
        except requests.RequestException as exc:
            if attempt < retries:
                time.sleep(backoff)
            else:
                raise exc
    return None  # unreachable


# ---------------------------------------------------------------------------
# Place resolution
# ---------------------------------------------------------------------------

def search_place_id(query: str) -> Optional[str]:
    r = _with_retry(lambda: _get("/search", params={"q": query}), f"search:{query}")
    if r is None or r.status_code != 200:
        return None
    places = r.json().get("places", [])
    return places[0]["id"] if places else None


def details_coords(place_id: str) -> Optional[dict]:
    r = _with_retry(lambda: _post("/details", json={"place_id": place_id}), f"details:{place_id}")
    if r is None or r.status_code != 200:
        return None
    loc = r.json().get("location", {})
    lat, lng = loc.get("latitude"), loc.get("longitude")
    if lat is None or lng is None:
        return None
    return {"lat": lat, "lng": lng}


# ---------------------------------------------------------------------------
# Route calls
# ---------------------------------------------------------------------------

def google_route(origin: dict, place_id: str) -> dict:
    """Returns dict with keys: status, duration_s, routes_raw, legs_summary."""
    r = _with_retry(
        lambda: _post("/route", json={"origin": origin, "destination_id": place_id}),
        "google_route",
    )
    if r is None:
        return {"status": "error", "error": "request failed"}
    if r.status_code == 204:
        return {"status": "no_route"}
    if r.status_code == 429:
        return {"status": "quota_exceeded"}
    if r.status_code != 200:
        return {"status": "error", "error": f"HTTP {r.status_code}: {r.text[:200]}"}
    data = r.json()
    return {"status": "ok", "raw": data, **_parse_google(data)}


def otp_route(origin: dict, dest: dict, mode: str) -> dict:
    """Returns dict with keys: status, duration_s, walk_m, itineraries_raw, legs_summary."""
    r = _with_retry(
        lambda: _post("/route/otp", json={"origin": origin, "destination": dest, "mode": mode, "num_itineraries": 5}),
        f"otp_route:{mode}",
    )
    if r is None:
        return {"status": "error", "error": "request failed"}
    if r.status_code == 502:
        return {"status": "unreachable", "error": "OTP backend 502"}
    if r.status_code == 204:
        return {"status": "no_route"}
    if r.status_code == 429:
        return {"status": "quota_exceeded"}
    if r.status_code != 200:
        return {"status": "error", "error": f"HTTP {r.status_code}: {r.text[:200]}"}
    data = r.json()
    return {"status": "ok", "raw": data, **_parse_otp(data)}


# ---------------------------------------------------------------------------
# Parsers
# ---------------------------------------------------------------------------

def _dur_s(val) -> Optional[int]:
    """Parse Google '1144s' duration string → int seconds."""
    if val is None:
        return None
    try:
        return int(str(val).rstrip("s"))
    except (ValueError, TypeError):
        return None


def _fmt_min(secs) -> str:
    if isinstance(secs, (int, float)):
        return f"{secs / 60:.0f}m"
    return "?"


def _parse_google(resp: dict) -> dict:
    routes = resp.get("routes", [])
    if not routes:
        return {"duration_s": None, "num_routes": 0, "legs_summary": []}

    best = routes[0]
    duration_s = _dur_s(best.get("duration"))

    legs_summary = []
    for leg in best.get("legs", []):
        for step in leg.get("steps", []):
            mode = step.get("travelMode", "?")
            if mode == "TRANSIT":
                td = step.get("transitDetails", {}) or {}
                line = (td.get("transitLine", {}) or {})
                route_name = line.get("nameShort") or line.get("name") or "?"
                stops = td.get("stopCount", "?")
                headsign = td.get("headsign", "")
                legs_summary.append({
                    "mode": "TRANSIT",
                    "route": route_name,
                    "stops": stops,
                    "headsign": headsign,
                })
            else:
                legs_summary.append({"mode": mode})

    return {
        "duration_s": duration_s,
        "num_routes": len(routes),
        "legs_summary": legs_summary,
    }


def _parse_otp(resp: dict) -> dict:
    itineraries = resp.get("itineraries", [])
    if not itineraries:
        return {"duration_s": None, "walk_m": None, "num_itineraries": 0, "legs_summary": [], "realtime_legs": 0, "total_legs": 0}

    best = itineraries[0]
    legs = best.get("legs", [])

    legs_summary = []
    rt_count = 0
    for l in legs:
        mode = l.get("mode", "?")
        entry = {"mode": mode}
        if mode not in ("WALK", "BICYCLE"):
            entry["route"] = l.get("route_short_name") or l.get("route_long_name") or "?"
            entry["from"] = l.get("from", "?")
            entry["to"] = l.get("to", "?")
            entry["headsign"] = l.get("headsign", "")
            entry["delay_s"] = l.get("departure_delay_seconds", 0)
        if l.get("realtime"):
            rt_count += 1
            entry["realtime"] = True
        legs_summary.append(entry)

    return {
        "duration_s": best.get("duration_seconds"),
        "walk_m": best.get("walk_distance_m"),
        "num_itineraries": len(itineraries),
        "legs_summary": legs_summary,
        "realtime_legs": rt_count,
        "total_legs": len(legs),
    }


# ---------------------------------------------------------------------------
# Formatting helpers
# ---------------------------------------------------------------------------

def _fmt_google_legs(legs_summary: list) -> str:
    parts = []
    for l in legs_summary:
        if l["mode"] == "TRANSIT":
            parts.append(f"TRANSIT({l['route']}, {l['stops']} stops)")
        else:
            parts.append(l["mode"])
    return "→".join(parts) if parts else "—"


def _fmt_otp_legs(legs_summary: list) -> str:
    parts = []
    for l in legs_summary:
        if l["mode"] not in ("WALK", "BICYCLE"):
            rt = " RT" if l.get("realtime") else ""
            delay = f" +{l['delay_s']//60}m" if l.get("delay_s", 0) > 60 else ""
            parts.append(f"{l['mode']}:{l['route']}{rt}{delay}")
        else:
            parts.append(l["mode"])
    return "→".join(parts) if parts else "—"


def _transit_lines(legs_summary: list) -> set:
    return {l["route"] for l in legs_summary if l["mode"] == "TRANSIT" and "route" in l}


def _otp_transit_lines(legs_summary: list) -> set:
    return {l["route"] for l in legs_summary if l["mode"] not in ("WALK", "BICYCLE") and "route" in l}


# ---------------------------------------------------------------------------
# Result container
# ---------------------------------------------------------------------------

@dataclass
class CaseResult:
    name: str
    dest: Optional[dict]
    google: dict
    otp_by_mode: dict = field(default_factory=dict)

    def delta_s(self) -> Optional[int]:
        g = self.google.get("duration_s")
        o = (self.otp_by_mode.get("walk_transit") or {}).get("duration_s")
        if g and o:
            return o - g
        return None

    def route_agreement(self) -> str:
        g_lines = _transit_lines(self.google.get("legs_summary", []))
        o_lines = _otp_transit_lines((self.otp_by_mode.get("walk_transit") or {}).get("legs_summary", []))
        if not g_lines and not o_lines:
            return "both_no_transit"
        if not g_lines or not o_lines:
            return "mismatch"
        return "match" if g_lines & o_lines else "mismatch"

    def otp_status(self) -> str:
        wt = self.otp_by_mode.get("walk_transit") or {}
        return wt.get("status", "unknown")


# ---------------------------------------------------------------------------
# Quota check
# ---------------------------------------------------------------------------

def check_quota(label: str = ""):
    try:
        r = requests.get(f"{CLOUD}/limits", timeout=10)
        if r.status_code != 200:
            print(f"  [quota] HTTP {r.status_code}")
            return
        data = r.json()
        header = f"QUOTA {label}".strip()
        print(f"\n{'=' * 50}")
        print(f" {header}")
        print(f"{'=' * 50}")
        for ep in ("routes", "places", "details", "autocomplete", "searchnearby"):
            ep_data = data.get(ep, {})
            used = ep_data.get("used", "?")
            remaining = ep_data.get("remaining", "?")
            exceeded = " [EXCEEDED]" if ep_data.get("exceeded") else ""
            print(f"  {ep:<14} {used:>5} used  {remaining:>5} remaining{exceeded}")
    except Exception as exc:
        print(f"  [quota] error: {exc}")


# ---------------------------------------------------------------------------
# Print helpers
# ---------------------------------------------------------------------------

def print_case(result: CaseResult, raw: bool = False):
    print(f"\n{'=' * 60}")
    print(f"  {result.name}")
    print(f"{'=' * 60}")

    if result.dest is None:
        print("  [ERROR] Could not resolve destination — skipping")
        return

    print(f"  origin={ORIGIN}  dest={result.dest}")

    # --- Google ---
    g = result.google
    print(f"\n  [Google /route — TRANSIT]")
    if g["status"] == "ok":
        dur = _fmt_min(g.get("duration_s"))
        num = g.get("num_routes", 0)
        legs = _fmt_google_legs(g.get("legs_summary", []))
        print(f"    duration={dur}  routes_returned={num}")
        print(f"    legs: {legs}")
    else:
        print(f"    STATUS: {g['status']}  {g.get('error','')}")

    if raw and g.get("raw"):
        print("    --- raw JSON ---")
        print(json.dumps(g["raw"], indent=2))

    # --- OTP modes ---
    for mode in OTP_MODES:
        o = result.otp_by_mode.get(mode, {})
        print(f"\n  [OTP /route/otp — {mode}]")
        if o.get("status") == "ok":
            dur = _fmt_min(o.get("duration_s"))
            walk = f"{o.get('walk_m', 0):.0f}m" if o.get("walk_m") is not None else "?"
            num = o.get("num_itineraries", 0)
            rt = f"{o.get('realtime_legs',0)}/{o.get('total_legs',0)} legs real-time"
            legs = _fmt_otp_legs(o.get("legs_summary", []))
            print(f"    duration={dur}  walk={walk}  itineraries_returned={num}  {rt}")
            print(f"    legs: {legs}")
        elif o.get("status") == "unreachable":
            print(f"    [OTP UNREACHABLE — 502] OTP backend not configured on Cloud Run")
        elif o.get("status") == "no_route":
            print(f"    [NO ROUTE — 204]")
        else:
            print(f"    STATUS: {o.get('status','unknown')}  {o.get('error','')}")

        if raw and o.get("raw"):
            print("    --- raw JSON ---")
            print(json.dumps(o["raw"], indent=2))

    # --- Comparison (walk_transit vs Google) ---
    print(f"\n  [Comparison: Google vs OTP walk_transit]")
    delta = result.delta_s()
    if delta is not None:
        g_dur = result.google.get("duration_s", 1)
        pct = (delta / g_dur * 100) if g_dur else 0
        sign = "+" if delta >= 0 else ""
        direction = "OTP slower" if delta > 30 else ("OTP faster" if delta < -30 else "roughly equal")
        print(f"    duration delta: {sign}{delta//60}m {sign}{delta%60}s ({sign}{pct:.0f}%)  → {direction}")
    else:
        print(f"    duration delta: N/A (one or both endpoints returned no result)")

    agreement = result.route_agreement()
    print(f"    route agreement: {agreement.upper()}")


def print_summary_table(results: list):
    print(f"\n\n{'=' * 80}")
    print("  SUMMARY TABLE")
    print(f"{'=' * 80}")
    header = f"  {'Destination':<28} {'Google':>7} {'OTP w_t':>8} {'Delta':>8} {'Agreement':>12} {'OTP RT':>8} {'OTP Status':>12}"
    print(header)
    print(f"  {'-'*76}")

    for res in results:
        name = res.name[:27]
        g_dur = _fmt_min(res.google.get("duration_s")) if res.google.get("status") == "ok" else res.google.get("status", "?")

        wt = res.otp_by_mode.get("walk_transit") or {}
        o_dur = _fmt_min(wt.get("duration_s")) if wt.get("status") == "ok" else wt.get("status", "?")

        delta = res.delta_s()
        if delta is not None:
            g_d = res.google.get("duration_s", 1)
            pct = int(delta / g_d * 100) if g_d else 0
            sign = "+" if delta >= 0 else ""
            delta_str = f"{sign}{pct}%"
        else:
            delta_str = "N/A"

        agreement = res.route_agreement()
        rt = f"{wt.get('realtime_legs',0)}/{wt.get('total_legs',0)}" if wt.get("status") == "ok" else "—"
        otp_status = wt.get("status", "unknown")

        print(f"  {name:<28} {g_dur:>7} {o_dur:>8} {delta_str:>8} {agreement:>12} {rt:>8} {otp_status:>12}")


def print_reliability(results: list):
    print(f"\n\n{'=' * 60}")
    print("  RELIABILITY & REAL-TIME SUMMARY")
    print(f"{'=' * 60}")

    total = len(results)
    google_ok = sum(1 for r in results if r.google.get("status") == "ok")
    google_no_route = sum(1 for r in results if r.google.get("status") == "no_route")

    otp_ok = sum(1 for r in results if (r.otp_by_mode.get("walk_transit") or {}).get("status") == "ok")
    otp_unreachable = sum(1 for r in results if (r.otp_by_mode.get("walk_transit") or {}).get("status") == "unreachable")
    otp_no_route = sum(1 for r in results if (r.otp_by_mode.get("walk_transit") or {}).get("status") == "no_route")

    total_otp_legs = sum((r.otp_by_mode.get("walk_transit") or {}).get("total_legs", 0) for r in results)
    total_rt_legs = sum((r.otp_by_mode.get("walk_transit") or {}).get("realtime_legs", 0) for r in results)

    match_count = sum(1 for r in results if r.route_agreement() == "match")

    print(f"  Test cases run         : {total}")
    print(f"")
    print(f"  Google /route")
    print(f"    responded OK         : {google_ok}/{total}")
    print(f"    no route (204)       : {google_no_route}/{total}")
    print(f"")
    print(f"  OTP /route/otp (walk_transit)")
    print(f"    responded OK         : {otp_ok}/{total}")
    print(f"    unreachable (502)    : {otp_unreachable}/{total}")
    print(f"    no route (204)       : {otp_no_route}/{total}")
    print(f"")
    print(f"  Route agreement (walk_transit vs Google)")
    print(f"    matching transit lines : {match_count}/{total}")
    print(f"")
    if total_otp_legs > 0:
        rt_pct = total_rt_legs / total_otp_legs * 100
        print(f"  OTP real-time coverage : {total_rt_legs}/{total_otp_legs} legs ({rt_pct:.0f}%)")
    else:
        print(f"  OTP real-time coverage : N/A (no OTP legs returned)")

    # Overall verdict
    print(f"\n  VERDICT")
    if otp_unreachable == total:
        print(f"  OTP backend is not reachable from Cloud Run. Deploy OTP and set OTP_BASE_URL.")
    elif otp_ok == 0:
        print(f"  OTP returned no usable results. Check OTP deployment and GTFS/OSM data.")
    elif otp_ok == google_ok and match_count >= total // 2:
        print(f"  OTP is ON PAR with Google Maps: same reliability, overlapping routes.")
    elif otp_ok < google_ok:
        print(f"  OTP is LESS RELIABLE than Google Maps ({otp_ok} vs {google_ok} successful responses).")
    else:
        print(f"  Mixed results — review per-case output above for discrepancies.")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Compare OTP vs Google Maps routing on Cloud Run")
    parser.add_argument("--cases", type=int, default=len(CASES), help="Number of test cases to run (default: all)")
    parser.add_argument("--raw", action="store_true", help="Dump full JSON responses for each case")
    args = parser.parse_args()

    cases = CASES[: args.cases]

    print(f"Tranzit Route Service — OTP vs Google Maps comparison")
    print(f"Cloud Run: {CLOUD}")
    print(f"Origin: {ORIGIN}")
    print(f"Test cases: {len(cases)}")

    check_quota("BEFORE")

    results: list[CaseResult] = []

    for i, case in enumerate(cases, 1):
        print(f"\n[{i}/{len(cases)}] Resolving '{case['name']}'...")

        # Resolve place_id
        pid = case.get("place_id")
        if not pid:
            pid = search_place_id(case["query"])
            if not pid:
                print(f"  [ERROR] Could not find place_id for '{case['name']}'")
                results.append(CaseResult(
                    name=case["name"],
                    dest=None,
                    google={"status": "skipped"},
                ))
                continue

        # Resolve coords
        dest = details_coords(pid)
        if not dest:
            print(f"  [ERROR] Could not get coordinates for place_id {pid}")
            results.append(CaseResult(
                name=case["name"],
                dest=None,
                google={"status": "skipped"},
            ))
            continue

        print(f"  place_id={pid}  dest={dest}")

        # Google route
        print(f"  Calling Google /route...")
        g = google_route(ORIGIN, pid)

        # OTP routes
        otp_results = {}
        for mode in OTP_MODES:
            print(f"  Calling OTP /route/otp [{mode}]...")
            otp_results[mode] = otp_route(ORIGIN, dest, mode)

        res = CaseResult(
            name=case["name"],
            dest=dest,
            google=g,
            otp_by_mode=otp_results,
        )
        results.append(res)
        print_case(res, raw=args.raw)

    print_summary_table(results)
    print_reliability(results)
    check_quota("AFTER")


if __name__ == "__main__":
    main()
