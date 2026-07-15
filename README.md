# RTK Point Mapper

A no-frills phone tool for the SparkFun RTK Facet: get a fix, tap **Drop Pin
Here**, name it, and recall it later — on a list or a map. Everything is
stored on your device (`localStorage`); there's no server, no account, no
tracking.

## Install on your phone (Android + Chrome)

1. Host this folder somewhere your phone can reach it, or open it directly
   as a local file. Easiest options:
   - Serve it once over your LAN (e.g. `python3 -m http.server` from this
     directory) and open `http://<your-computer-ip>:8000` in Chrome on your
     phone, **or**
   - Push the repo (or just this folder) to GitHub Pages / any static host
     and open that URL.
2. In Chrome, open the page, tap the **⋮** menu → **Add to Home screen**.
   That installs it as a standalone app (via the web app manifest) and lets
   the service worker cache the app shell so it opens with zero signal from
   then on.

## How position accuracy works

This app reads position through the standard browser **Geolocation API**
(`navigator.geolocation`) by default — that's what shows up in the "Drop
Pin Here" card as **phone GPS**.

**To get Facet-grade (centimeter/decimeter) accuracy**, the simplest and
most reliable path is the one most RTK-on-Android users already use:

1. Pair the Facet to your phone over classic Bluetooth (SPP), as usual.
2. Install a "mock location" / Bluetooth-GPS bridge app (e.g. *Bluetooth
   GPS*, *GPS Connector*, or similar — search Play Store) and set it as
   your phone's mock/external location provider, feeding it from the
   Facet's NMEA stream.
3. Once that bridge is active, `navigator.geolocation` — and therefore this
   app — will report the Facet's corrected fix automatically. No app code
   changes needed; this is standard Android location-provider behavior.

### Experimental: direct Bluetooth Low Energy connection

Settings → **Connect to Facet via Bluetooth (experimental)** attempts a
direct [Web Bluetooth](https://developer.mozilla.org/en-US/docs/Web/API/Web_Bluetooth_API)
link to the Facet's BLE NMEA service, bypassing the phone's location stack
entirely and showing the *true* fix type (RTK Fixed / RTK Float / GPS/DGPS)
plus satellite count, read straight from `$GxGGA` sentences.

This requires:
- Chrome on Android (Web Bluetooth isn't available on iOS Safari at all,
  and desktop Chrome needs a BLE adapter).
- The Facet's **Bluetooth Protocol** set to `BLE` or `Dual` in its system
  config menu (default is often `SPP` only — Web Bluetooth cannot talk to
  classic SPP, only BLE/GATT).

The service/characteristic UUIDs are pre-filled with a common ESP32
UART-bridge default, but **SparkFun's exact BLE GATT service UUID for the
RTK Everywhere firmware isn't publicly documented** as of this writing —
your unit's firmware may differ. If "Connect" fails or hangs at "waiting
for NMEA data":

1. Install a generic BLE scanner (e.g. *nRF Connect*) on your phone.
2. Connect to the Facet over BLE, look under its services for a UART-like
   service with a notify characteristic streaming ASCII text.
3. Copy that service UUID and the notify characteristic UUID into Settings
   here and reconnect.

If it never works out, that's fine — the phone-GPS + mock-location-bridge
path above gives you the same accuracy with zero extra config here.

## Features

- **Save** — live fix card (coordinates, altitude, accuracy, sat count,
  fix-quality badge) with one big button to drop a named pin.
- **Points** — searchable list of every saved point, with live distance
  and compass direction from your current position, tap-to-copy
  coordinates, edit, delete, and a one-tap "Navigate" button that opens
  your phone's map app via a `geo:` link.
- **Map** — all points plotted on an OpenStreetMap view (Leaflet, bundled
  locally — no CDN dependency). Tiles are cached as you view them, so
  previously visited areas keep working offline; brand-new areas still
  need connectivity for their first load, same as any web map.
- **Layout** — import CAD design points (no real-world coordinates needed)
  and calibrate them to GPS on site for stakeout. See below.
- **Backup** — export everything as GeoJSON, GPX (for Garmin/other GPS
  tools), or CSV; import a previously exported GeoJSON file back in.
- Fully offline-capable app shell via a service worker — once installed,
  opening the app, dropping pins, and browsing your list needs no network
  at all.

## Layout: staking out a foundation from a CAD file

This is for the common case where you have a CAD drawing of the building
footprint with **no real-world coordinates** — just local dimensions — and
you need to translate that onto the actual site with the RTK.

1. **Import** — Layout tab → pick your local units (feet/meters/inches) →
   **Import DXF / CSV**. Supported inputs:
   - **DXF**: `POINT`, `LWPOLYLINE`/`POLYLINE` vertices, `LINE` endpoints,
     and `INSERT` (block) insertion points are read from the `ENTITIES`
     section. If a foundation outline is drawn as a closed polyline, each
     corner becomes a point automatically. The file's `$INSUNITS` header
     variable is read and flagged if it disagrees with your unit dropdown,
     but the dropdown always wins — set it correctly before importing.
   - **CSV**: header row is matched flexibly (`x`/`east`/`easting`,
     `y`/`north`/`northing`, `z`/`elev`, `name`/`point`/`id`,
     `desc`/`notes`). With no recognizable header and 5 columns, it falls
     back to the standard data-collector **PNEZD** order (Point, Northing,
     Easting, Elevation, Description) — note Northing comes before Easting
     in that format. With 3-4 columns it falls back to Point, X, Y, Z.
   - You'll see a preview (point count + first few rows) before anything
     is added, so a misread column mapping is obvious before you commit.
   - Every import point lands in the Layout list unnamed toward a real
     position — nothing is placed on the map yet.

2. **Calibrate** — walk to any **two** of the imported points that you can
   physically identify on site (existing stakes, a foundation corner
   that's already been located by a surveyor, property pins, etc.) and tap
   **Set Here** on each while standing on it with the RTK. Two points is
   the minimum (gives an exact fit); calibrating a third or more improves
   accuracy by averaging out RTK noise, and the banner shows a fit
   residual so you can tell if a capture was off (recapture that point if
   the residual is larger than typical RTK noise, roughly &gt; 2-3 cm).

   Internally this fits a 2D similarity transform (rotation + uniform
   scale + translation, no mirroring) from your CAD's local X/Y to real
   GPS coordinates, via a flat-earth projection centered on the
   calibration points — accurate well below RTK noise floor at
   building-lot scale.

3. **Stake out** — once calibrated, every other imported point shows a
   live distance and direction from your current position. Tap the target
   icon to open a focused stakeout view: distance counts down as you walk,
   with a bearing (true north, not device compass — there's no magnetometer
   reading here, so use a real compass or just watch the distance shrink)
   and a ΔNorth/ΔEast breakdown. It turns green inside ~5 cm.

**Note on the transform assumption**: local X is treated as "east-like" and
Y as "north-like" (the standard CAD/site-plan convention). If your two
calibration points come out badly (huge residual, or points end up
mirrored), your drawing's axes may not follow that convention for this
specific site — the fit is a rotation, so orientation reconciles itself
automatically as long as X/Y aren't swapped or mirrored; a swapped axis
isn't something the current version auto-detects, so double check the
Layout list positions against reality before you commit to staking.

## Data format

Points are stored under the `rtk-points-v1` key in `localStorage` as a
JSON array of:

```json
{
  "id": "uuid",
  "name": "Property corner NE",
  "notes": "optional",
  "lat": 40.0,
  "lon": -105.0,
  "alt": 1620.4,
  "accuracy": 0.02,
  "quality": 4,
  "source": "ble",
  "createdAt": "2026-07-15T12:00:00.000Z"
}
```

`quality` follows the NMEA GGA fix-quality codes (4 = RTK Fixed, 5 = RTK
Float, 2 = DGPS, 1 = GPS, `null` = unknown/phone-GPS-only).

Design points (Layout tab) are stored separately under `rtk-design-points-v1`,
in meters internally regardless of import units:

```json
{
  "id": "uuid",
  "name": "FOUNDATION-1",
  "x": 0, "y": 0, "z": 0,
  "calibLat": 40.0, "calibLon": -105.0, "calibAccuracy": 0.02, "calibTs": 1752600000000,
  "createdAt": "2026-07-15T12:00:00.000Z"
}
```

A point with `calibLat`/`calibLon` set is a captured reference (calibration)
point; the rest are design points located purely via the fitted transform,
recomputed live from whichever points currently have calibration data.

Back up regularly with the GeoJSON export (Points tab data only — Layout
design points aren't yet included in export/import, since they're
inherently tied to a specific site's calibration) — `localStorage` is
per-browser and can be cleared by the OS or by clearing site data.
