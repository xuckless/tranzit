#!/usr/bin/env python3
"""Generate a GPS track (t_seconds,lat,lng CSV) from an OpenTripPlanner itinerary.

  python3 demo/gps/make-track.py FROM_LAT,FROM_LNG TO_LAT,TO_LNG out.csv [--otp http://localhost:8888] [--when 2026-11-09T08:15]

Picks the first itinerary that uses transit and samples a point every 2 s of
travel time along each leg's geometry, so `./demo.sh drive` moves the emulator
at walking / bus speed. Needs the demo stack running (OTP on :8888).
"""
import argparse, json, math, urllib.request
from datetime import datetime, timedelta

def decode(s):
    pts, i, lat, lng = [], 0, 0, 0
    while i < len(s):
        for which in (0, 1):
            shift = res = 0
            while True:
                b = ord(s[i]) - 63; i += 1
                res |= (b & 0x1F) << shift; shift += 5
                if b < 0x20: break
            d = ~(res >> 1) if res & 1 else res >> 1
            if which == 0: lat += d
            else: lng += d
        pts.append((lat / 1e5, lng / 1e5))
    return pts

def hav(a, b):
    r = 6371000; p1, p2 = math.radians(a[0]), math.radians(b[0])
    dp, dl = p2 - p1, math.radians(b[1] - a[1])
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))

def sample(pts, seconds, step=2.0):
    seg = [hav(pts[i], pts[i + 1]) for i in range(len(pts) - 1)]
    total = sum(seg) or 1
    out, n = [], max(1, int(seconds / step))
    for k in range(n + 1):
        target, acc = total * k / n, 0
        for i, d in enumerate(seg):
            if acc + d >= target or i == len(seg) - 1:
                f = 0 if d == 0 else (target - acc) / d
                a, b = pts[i], pts[i + 1]
                out.append((k * step, a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f))
                break
            acc += d
    return out

ap = argparse.ArgumentParser()
ap.add_argument("frm"); ap.add_argument("to"); ap.add_argument("out")
ap.add_argument("--otp", default="http://localhost:8888")
ap.add_argument("--when", default=None, help="local departure, default: next weekday 08:15")
a = ap.parse_args()
if a.when: when = datetime.fromisoformat(a.when)
else:
    d = datetime.now() + timedelta(days=1)
    while d.weekday() > 4: d += timedelta(days=1)
    when = d.replace(hour=8, minute=15, second=0, microsecond=0)
f, t = [float(x) for x in a.frm.split(",")], [float(x) for x in a.to.split(",")]
q = """{ plan(from:{lat:%f,lon:%f}, to:{lat:%f,lon:%f}, date:"%s", time:"%s", numItineraries:5,
  transportModes:[{mode:WALK},{mode:TRANSIT}]) { itineraries { legs { mode duration
  route { shortName } legGeometry { points } } } } }""" % (f[0], f[1], t[0], t[1], when.strftime("%Y-%m-%d"), when.strftime("%H:%M"))
req = urllib.request.Request(a.otp + "/otp/routers/default/index/graphql",
                             data=json.dumps({"query": q}).encode(), headers={"Content-Type": "application/json"})
its = json.load(urllib.request.urlopen(req))["data"]["plan"]["itineraries"]
it = next((i for i in its if any(l["mode"] != "WALK" for l in i["legs"])), None) or its[0]
rows, t0 = [], 0.0
for leg in it["legs"]:
    pts = decode(leg["legGeometry"]["points"])
    if len(pts) < 2: continue
    for s, lat, lng in sample(pts, leg["duration"]):
        rows.append((t0 + s, lat, lng))
    t0 += leg["duration"]
    print(f"  {leg['mode']:<6} {(leg.get('route') or {}).get('shortName') or '':<5} {leg['duration']/60:5.1f} min")
with open(a.out, "w") as fh:
    fh.write("t,lat,lng\n")
    for s, lat, lng in rows: fh.write(f"{s:.0f},{lat:.6f},{lng:.6f}\n")
print(f"wrote {len(rows)} points, {t0/60:.1f} min -> {a.out}")
