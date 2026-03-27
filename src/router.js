import * as turf from "@turf/turf";
import { rideZone, noRideZones, slowZones } from "./zones.js";

/**
 * Neuron-aware routing engine v4.
 *
 * New strategy:
 * 1. Request multiple alternative routes from Mapbox
 * 2. Score each route by how much it overlaps with no-ride zones
 * 3. Pick the route with the least (ideally zero) no-ride overlap
 * 4. If ALL alternatives still hit no-ride zones, use waypoint injection
 *    with a smarter approach: place waypoints on the nearest road
 *    OUTSIDE the zone, found by casting rays outward from the zone edge
 */

const MAPBOX_URL = "https://api.mapbox.com/directions/v5/mapbox";
const MAX_REROUTE_ATTEMPTS = 4;

export function isInRideZone(lngLat) {
  const pt = turf.point(lngLat);
  return rideZone.features.some((f) => turf.booleanPointInPolygon(pt, f));
}

export function findNoRideZone(lngLat) {
  const pt = turf.point(lngLat);
  for (const f of noRideZones.features) {
    if (turf.booleanPointInPolygon(pt, f)) return f;
  }
  return null;
}

export function isInNoRideZone(lngLat) {
  return findNoRideZone(lngLat) !== null;
}

export function isInSlowZone(lngLat) {
  const pt = turf.point(lngLat);
  return slowZones.features.some((f) => turf.booleanPointInPolygon(pt, f));
}

/**
 * Score a route: count what fraction of route points are in no-ride zones.
 * Lower is better. 0 = perfect.
 * Uses a tolerance: only counts a point as "in" a no-ride zone if it's
 * more than ~10m inside the boundary (avoids false positives from routes
 * that just graze a zone edge).
 */
function scoreRoute(geometry) {
  const coords = geometry.coordinates;
  let noRideCount = 0;
  let consecutiveNoRide = 0;
  let maxConsecutive = 0;

  for (const c of coords) {
    if (isInNoRideZone(c)) {
      noRideCount++;
      consecutiveNoRide++;
      maxConsecutive = Math.max(maxConsecutive, consecutiveNoRide);
    } else {
      consecutiveNoRide = 0;
    }
  }

  // Only flag as "in no-ride" if there are multiple consecutive points inside
  // (3+ consecutive points = actually going through, not just grazing)
  const meaningfulNoRide = maxConsecutive >= 3;

  return {
    noRideCount: meaningfulNoRide ? noRideCount : 0,
    noRideFraction: coords.length > 0 ? noRideCount / coords.length : 0,
    inNoRide: meaningfulNoRide,
    inSlow: coords.some((c) => isInSlowZone(c)),
    outsideRideZone: coords.some((c) => !isInRideZone(c)),
    maxConsecutiveNoRide: maxConsecutive,
  };
}

/**
 * Fetch routes from Mapbox. With alternatives=true, returns up to 3 routes.
 * Tries both cycling and walking profiles to find more options.
 */
async function fetchRoutes(waypoints, accessToken, alternatives = true) {
  const coordStr = waypoints.map((w) => `${w[0]},${w[1]}`).join(";");
  const altParam = alternatives && waypoints.length === 2 ? "&alternatives=true" : "";

  // Fetch cycling and walking routes in parallel for more options
  const profiles = alternatives ? ["cycling", "walking"] : ["cycling"];
  const allRoutes = [];

  const fetches = profiles.map(async (profile) => {
    const url =
      `${MAPBOX_URL}/${profile}/${coordStr}` +
      `?geometries=geojson&overview=full&steps=true${altParam}&access_token=${accessToken}`;
    const res = await fetch(url);
    const data = await res.json();
    return data.routes || [];
  });

  const results = await Promise.all(fetches);
  for (const routes of results) allRoutes.push(...routes);
  return allRoutes;

  const res = await fetch(url);
  const data = await res.json();
  return data.routes || [];
}

/**
 * Find clusters of no-ride zone crossings in a route.
 * Returns array of { entryCoord, exitCoord, zone } objects.
 */
function findNoRideCrossings(coords) {
  const crossings = [];
  let i = 0;

  while (i < coords.length) {
    const zone = findNoRideZone(coords[i]);
    if (!zone) { i++; continue; }

    const entryCoord = i > 0 ? coords[i - 1] : coords[i];
    // Skip through the zone
    while (i < coords.length && findNoRideZone(coords[i])) i++;
    const exitCoord = coords[Math.min(i, coords.length - 1)];

    crossings.push({ entryCoord, exitCoord, zone });
  }

  return crossings;
}

/**
 * For a no-ride zone crossing, find a waypoint that's clearly outside
 * the zone and on the opposite side from the direct route.
 *
 * Strategy: cast 8 rays outward from the midpoint of entry/exit,
 * find which directions are clear of no-ride zones, and pick the
 * one that's furthest from the zone while still reasonable.
 */
function findDetourPoint(entryCoord, exitCoord, zone) {
  const midLng = (entryCoord[0] + exitCoord[0]) / 2;
  const midLat = (entryCoord[1] + exitCoord[1]) / 2;

  // Get zone size to determine how far to offset
  const bbox = turf.bbox(zone);
  const zoneSize = Math.max(bbox[2] - bbox[0], bbox[3] - bbox[1]);
  // Offset should be at least the zone size, so we go well around it
  const baseOffset = zoneSize + 0.002;

  // Try 12 directions (every 30 degrees)
  const candidates = [];
  for (let angle = 0; angle < 360; angle += 30) {
    const rad = (angle * Math.PI) / 180;
    for (const multiplier of [1.0, 1.5, 2.0]) {
      const offset = baseOffset * multiplier;
      const pt = [
        midLng + Math.cos(rad) * offset,
        midLat + Math.sin(rad) * offset,
      ];

      if (!isInNoRideZone(pt)) {
        // Score: prefer points that are close to the straight line
        // between entry and exit (less detour) but outside the zone
        const detourDist = turf.distance(turf.point(entryCoord), turf.point(pt)) +
          turf.distance(turf.point(pt), turf.point(exitCoord));
        const directDist = turf.distance(turf.point(entryCoord), turf.point(exitCoord));
        const penalty = detourDist / Math.max(directDist, 0.001);

        candidates.push({ pt, penalty, offset: multiplier });
      }
    }
  }

  if (candidates.length === 0) return null;

  // Pick the candidate with the smallest detour penalty
  candidates.sort((a, b) => a.penalty - b.penalty);
  return candidates[0].pt;
}

/**
 * Main routing function.
 */
export async function getNeuronRoute(start, end, accessToken) {
  // Phase 1: Get alternatives from Mapbox and pick the best one
  const routes = await fetchRoutes([start, end], accessToken, true);

  if (routes.length === 0) {
    return { ok: false, error: "No route found" };
  }

  // Score all alternatives
  const scored = routes.map((r) => ({
    route: r,
    score: scoreRoute(r.geometry),
  }));

  // Sort: prefer no no-ride zones, then least no-ride fraction, then shortest
  scored.sort((a, b) => {
    if (a.score.inNoRide !== b.score.inNoRide) return a.score.inNoRide ? 1 : -1;
    if (a.score.noRideFraction !== b.score.noRideFraction)
      return a.score.noRideFraction - b.score.noRideFraction;
    return a.route.distance - b.route.distance;
  });

  let bestRoute = scored[0].route;
  let bestScore = scored[0].score;

  // Phase 2: If best alternative still hits no-ride zones, try waypoint rerouting
  if (bestScore.inNoRide) {
    let waypoints = [start, end];
    let attempt = 0;

    while (attempt < MAX_REROUTE_ATTEMPTS && bestScore.inNoRide) {
      const crossings = findNoRideCrossings(bestRoute.geometry.coordinates);
      if (crossings.length === 0) break;

      // Find detour points for each crossing
      const detourPts = [];
      for (const crossing of crossings) {
        const pt = findDetourPoint(crossing.entryCoord, crossing.exitCoord, crossing.zone);
        if (pt) detourPts.push(pt);
      }

      if (detourPts.length === 0) break;

      // Build new waypoint list, sorted by projection onto start→end line
      const dx = end[0] - start[0];
      const dy = end[1] - start[1];
      const len = Math.sqrt(dx * dx + dy * dy) || 1;

      const allMid = [...waypoints.slice(1, -1), ...detourPts];
      allMid.sort((a, b) => {
        const projA = ((a[0] - start[0]) * dx + (a[1] - start[1]) * dy) / len;
        const projB = ((b[0] - start[0]) * dx + (b[1] - start[1]) * dy) / len;
        return projA - projB;
      });

      // Dedup nearby points
      const deduped = [allMid[0]];
      for (let i = 1; i < allMid.length; i++) {
        const d = turf.distance(turf.point(deduped[deduped.length - 1]), turf.point(allMid[i]));
        if (d > 0.05) deduped.push(allMid[i]); // 50m threshold
      }

      // Cap waypoints
      const trimmed = deduped.length > 20 ? subsample(deduped, 20) : deduped;
      waypoints = [start, ...trimmed, end];

      // Fetch new route (no alternatives with waypoints)
      const newRoutes = await fetchRoutes(waypoints, accessToken, false);
      if (newRoutes.length === 0) break;

      const newScore = scoreRoute(newRoutes[0].geometry);

      // Only accept if it's actually better
      if (newScore.noRideCount < bestScore.noRideCount) {
        bestRoute = newRoutes[0];
        bestScore = newScore;
      } else {
        break; // Not improving, stop
      }

      attempt++;
    }
  }

  // Build result
  let status = "ok";
  let message = "Route avoids all no-ride zones. Ride on.";
  const rerouted = bestScore !== scored[0].score;

  if (bestScore.outsideRideZone) {
    status = "bad";
    message = "Part of this route is outside the Neuron ride boundary. You may need to walk some sections.";
  } else if (bestScore.inNoRide) {
    status = "bad";
    message = "Couldn't fully avoid all no-ride zones. Some sections may require walking.";
  } else if (bestScore.inSlow) {
    status = "warn";
    message = "Route passes through a slow zone — your scooter speed will be reduced.";
  }

  if (rerouted && !bestScore.inNoRide) {
    message = "Rerouted to avoid no-ride zones. " + message;
  }

  const steps = bestRoute.legs.flatMap((leg) => leg.steps || []);

  return {
    ok: true,
    status,
    message,
    geometry: bestRoute.geometry,
    distance: bestRoute.distance,
    duration: bestRoute.duration,
    steps,
    analysis: bestScore,
    rerouted,
  };
}

function subsample(arr, maxN) {
  if (arr.length <= maxN) return arr;
  const result = [arr[0]];
  const step = (arr.length - 1) / (maxN - 1);
  for (let i = 1; i < maxN - 1; i++) {
    result.push(arr[Math.round(i * step)]);
  }
  result.push(arr[arr.length - 1]);
  return result;
}
