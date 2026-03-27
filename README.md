# 🛴 Neuron Map — Newcastle upon Tyne

Routes that actually work. A scooter route planner that respects Neuron's ride zones, no-ride zones, and slow zones.

## Setup

1. Get a free Mapbox token at https://account.mapbox.com/
2. Open `src/main.js` and replace `YOUR_MAPBOX_TOKEN` with your token
3. Install and run:

```bash
cd neuron-map
npm install
npm run dev
```

## Adding real zone data

The placeholder zones in `src/zones.js` are rough rectangles. To add real data:

1. Open the Neuron app and screenshot the zone boundaries
2. Go to https://geojson.io
3. Trace each zone as a polygon on the map
4. Copy the coordinates into the matching section in `src/zones.js`

Zone types:
- **rideZone** — the outer boundary where scooters work
- **noRideZones** — scooter stops completely here
- **slowZones** — speed is reduced
- **noParkingZones** — can't end your ride here
