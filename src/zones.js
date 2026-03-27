/**
 * Neuron zone data — fetched LIVE from Neuron's public GBFS API.
 * No manual tracing needed. This is the real data from the Neuron app.
 *
 * GBFS endpoint: https://mds.neuron-mobility.com/ncl/gbfs/2/en/geofencing_zones
 * Found via the official GBFS systems catalog.
 */

const GEOFENCING_URL =
  "https://mds.neuron-mobility.com/ncl/gbfs/2/en/geofencing_zones";

// Parsed zone collections — populated by fetchZones()
export let rideZone = { type: "FeatureCollection", features: [] };
export let noRideZones = { type: "FeatureCollection", features: [] };
export let slowZones = { type: "FeatureCollection", features: [] };
export let noParkingZones = { type: "FeatureCollection", features: [] };

/**
 * Fetch and categorize all Neuron geofencing zones for Newcastle.
 * Call this once on app startup.
 */
export async function fetchZones() {
  const res = await fetch(GEOFENCING_URL);
  const json = await res.json();
  const features = json.data.geofencing_zones.features;

  const noRide = [];
  const slow = [];
  const noParking = [];

  for (const feature of features) {
    const rules = feature.properties.rules || {};
    const rideAllowed = rules.ride_allowed !== false;
    const maxSpeed = rules.maximum_speed_kph;
    const parkingAllowed = rules.parking_allowed;

    // Normalize MultiPolygon to Polygon features for easier rendering
    const normalized = normalizeFeature(feature);

    if (!rideAllowed) {
      for (const f of normalized) {
        f.properties = { ...f.properties, type: "no-ride" };
        noRide.push(f);
      }
    } else if (maxSpeed) {
      for (const f of normalized) {
        f.properties = { ...f.properties, type: "slow", speedLimit: maxSpeed };
        slow.push(f);
      }
    }

    if (parkingAllowed === false) {
      for (const f of normalized) {
        f.properties = { ...f.properties, type: "no-parking" };
        noParking.push(f);
      }
    }
  }

  noRideZones = { type: "FeatureCollection", features: noRide };
  slowZones = { type: "FeatureCollection", features: slow };
  noParkingZones = { type: "FeatureCollection", features: noParking };

  // Build a ride zone from the bounding box of all features
  rideZone = buildRideZoneBoundary(features);

  return { rideZone, noRideZones, slowZones, noParkingZones };
}

/**
 * Convert MultiPolygon features into individual Polygon features
 */
function normalizeFeature(feature) {
  const geom = feature.geometry;
  if (geom.type === "Polygon") {
    return [feature];
  }
  if (geom.type === "MultiPolygon") {
    return geom.coordinates.map((coords) => ({
      type: "Feature",
      properties: { ...feature.properties },
      geometry: { type: "Polygon", coordinates: coords },
    }));
  }
  return [feature];
}

/**
 * Build a rough ride zone boundary from the extent of all zone features.
 * The actual ride boundary is the union of all slow zones (which define
 * the rideable neighborhoods) with some padding.
 */
function buildRideZoneBoundary(features) {
  let minLng = Infinity, maxLng = -Infinity;
  let minLat = Infinity, maxLat = -Infinity;

  for (const f of features) {
    const coords = flattenCoords(f.geometry);
    for (const [lng, lat] of coords) {
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
  }

  // Add a small buffer
  const pad = 0.002;
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { name: "Newcastle Ride Zone", type: "ride" },
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [minLng - pad, maxLat + pad],
              [maxLng + pad, maxLat + pad],
              [maxLng + pad, minLat - pad],
              [minLng - pad, minLat - pad],
              [minLng - pad, maxLat + pad],
            ],
          ],
        },
      },
    ],
  };
}

function flattenCoords(geometry) {
  if (geometry.type === "Polygon") {
    return geometry.coordinates[0];
  }
  if (geometry.type === "MultiPolygon") {
    return geometry.coordinates.flatMap((poly) => poly[0]);
  }
  return [];
}
