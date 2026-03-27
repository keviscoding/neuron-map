import mapboxgl from "mapbox-gl";
import MapboxGeocoder from "@mapbox/mapbox-gl-geocoder";
import { fetchZones } from "./zones.js";
import { getNeuronRoute } from "./router.js";
import { startNavigation, stopNavigation, isNavigating } from "./voice.js";

mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN || "";

const CITY_CENTER = [-1.6148, 54.9783];

const map = new mapboxgl.Map({
  container: "map",
  style: "mapbox://styles/mapbox/dark-v11",
  center: CITY_CENTER,
  zoom: 13,
});

// State
let startCoords = null;
let endCoords = null;
let lastRouteSteps = null;
let lastRouteGeometry = null;
let fullRouteCoords = null; // original full route for trimming
let navWatchId = null;
let userMarker = null;
let currentHeading = 0;
let isRerouting = false;

// DOM
const panel = document.getElementById("panel");
const panelHandle = document.getElementById("panel-handle");
const useLocationBtn = document.getElementById("use-location-btn");
const routeBtn = document.getElementById("route-btn");
const routeInfo = document.getElementById("route-info");
const routeStatus = document.getElementById("route-status");
const routeDetails = document.getElementById("route-details");
const navBtn = document.getElementById("nav-btn");
const navOverlay = document.getElementById("nav-overlay");
const navInstruction = document.getElementById("nav-instruction");
const navMeta = document.getElementById("nav-meta");
const navExitBtn = document.getElementById("nav-exit-btn");

// --- Directional arrow marker ---
function createArrowEl() {
  const el = document.createElement("div");
  el.className = "user-arrow";
  el.innerHTML = `<svg width="48" height="48" viewBox="0 0 48 48">
    <defs>
      <filter id="shadow" x="-30%" y="-30%" width="160%" height="160%">
        <feDropShadow dx="0" dy="1" stdDeviation="2" flood-color="#000" flood-opacity="0.4"/>
      </filter>
    </defs>
    <circle cx="24" cy="24" r="22" fill="rgba(66,133,244,0.15)" />
    <polygon points="24,6 34,30 24,24 14,30" fill="#4285f4" stroke="#fff" stroke-width="2" filter="url(#shadow)" />
  </svg>`;
  return el;
}

function updateUserMarker(lng, lat, heading) {
  if (!userMarker) {
    userMarker = new mapboxgl.Marker({
      element: createArrowEl(),
      rotationAlignment: "map",
      pitchAlignment: "map",
    })
      .setLngLat([lng, lat])
      .setRotation(heading || 0)
      .addTo(map);
  } else {
    userMarker.setLngLat([lng, lat]);
    if (heading != null && !isNaN(heading)) {
      userMarker.setRotation(heading);
    }
  }
}

// --- Route trimming: remove the part you've already ridden ---
function findClosestPointIndex(coords, lngLat) {
  let minDist = Infinity;
  let minIdx = 0;
  for (let i = 0; i < coords.length; i++) {
    const dx = coords[i][0] - lngLat[0];
    const dy = coords[i][1] - lngLat[1];
    const d = dx * dx + dy * dy;
    if (d < minDist) {
      minDist = d;
      minIdx = i;
    }
  }
  return { index: minIdx, distance: Math.sqrt(minDist) };
}

function trimRouteToPosition(lngLat) {
  if (!fullRouteCoords || fullRouteCoords.length < 2) return;

  const { index, distance } = findClosestPointIndex(fullRouteCoords, lngLat);

  // Trim: keep from closest point onward
  const remaining = fullRouteCoords.slice(index);
  if (remaining.length >= 2) {
    map.getSource("route").setData({
      type: "Feature",
      geometry: { type: "LineString", coordinates: remaining },
    });
  }

  // Off-route detection: if user is >80m from the route, reroute
  // ~0.0008 degrees ≈ 80m at Newcastle's latitude
  const OFF_ROUTE_THRESHOLD = 0.0008;
  if (distance > OFF_ROUTE_THRESHOLD && !isRerouting) {
    reroute(lngLat);
  }
}

async function reroute(fromLngLat) {
  if (isRerouting || !endCoords) return;
  isRerouting = true;
  navInstruction.textContent = "Rerouting...";

  try {
    const result = await getNeuronRoute(fromLngLat, endCoords, mapboxgl.accessToken);
    if (result.ok) {
      lastRouteSteps = result.steps;
      lastRouteGeometry = result.geometry;
      fullRouteCoords = [...result.geometry.coordinates];

      map.getSource("route").setData({ type: "Feature", geometry: result.geometry });

      // Restart voice nav with new steps
      stopNavigation();
      startNavigation(lastRouteSteps, (stepIndex, instruction) => {
        navInstruction.textContent = instruction;
        const next = lastRouteSteps[stepIndex + 1];
        if (next) {
          navMeta.textContent = next.distance > 1000
            ? `${(next.distance / 1000).toFixed(1)} km`
            : `${Math.round(next.distance)} m`;
        } else {
          navMeta.textContent = "Arriving soon";
        }
      });
    }
  } catch (e) {
    console.warn("Reroute failed:", e);
  } finally {
    isRerouting = false;
  }
}

// --- Geocoders ---
const geocoderStart = new MapboxGeocoder({
  accessToken: mapboxgl.accessToken,
  placeholder: "Starting point",
  bbox: [-1.7, 54.93, -1.5, 55.02],
  proximity: { longitude: CITY_CENTER[0], latitude: CITY_CENTER[1] },
  mapboxgl,
});

const geocoderEnd = new MapboxGeocoder({
  accessToken: mapboxgl.accessToken,
  placeholder: "Where to?",
  bbox: [-1.7, 54.93, -1.5, 55.02],
  proximity: { longitude: CITY_CENTER[0], latitude: CITY_CENTER[1] },
  mapboxgl,
});

document.getElementById("geocoder-start").appendChild(geocoderStart.onAdd(map));
document.getElementById("geocoder-end").appendChild(geocoderEnd.onAdd(map));

geocoderStart.on("result", (e) => { startCoords = e.result.center; updateRouteButton(); });
geocoderEnd.on("result", (e) => { endCoords = e.result.center; updateRouteButton(); });

function updateRouteButton() {
  routeBtn.disabled = !(startCoords && endCoords);
}

// --- Panel toggle ---
panelHandle.addEventListener("click", () => {
  panel.classList.toggle("collapsed");
});

// --- Use my location ---
useLocationBtn.addEventListener("click", () => {
  if (!("geolocation" in navigator)) {
    useLocationBtn.textContent = "📍 Not supported";
    return;
  }

  useLocationBtn.textContent = "📍 Getting location...";
  useLocationBtn.classList.add("loading");

  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      const lng = pos.coords.longitude;
      const lat = pos.coords.latitude;
      startCoords = [lng, lat];

      // Show marker
      updateUserMarker(lng, lat, 0);

      // Reverse geocode
      try {
        const res = await fetch(
          `https://api.mapbox.com/geocoding/v5/mapbox.places/${lng},${lat}.json?access_token=${mapboxgl.accessToken}`
        );
        const data = await res.json();
        geocoderStart.setInput(data.features?.[0]?.place_name || `${lat.toFixed(4)}, ${lng.toFixed(4)}`);
      } catch {
        geocoderStart.setInput(`${lat.toFixed(4)}, ${lng.toFixed(4)}`);
      }

      useLocationBtn.textContent = "📍 Location set";
      useLocationBtn.classList.remove("loading");
      updateRouteButton();
      map.flyTo({ center: [lng, lat], zoom: 15 });
    },
    (err) => {
      const msgs = {
        1: "📍 Permission denied — check settings",
        2: "📍 Location unavailable",
        3: "📍 Timed out — try again",
      };
      useLocationBtn.textContent = msgs[err.code] || "📍 Error";
      useLocationBtn.classList.remove("loading");
      setTimeout(() => { useLocationBtn.textContent = "📍 Use my current location"; }, 4000);
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 }
  );
});

// --- Map layers ---
map.on("load", async () => {
  const zones = await fetchZones();

  map.addSource("ride-zone", { type: "geojson", data: zones.rideZone });
  map.addLayer({ id: "ride-zone-fill", type: "fill", source: "ride-zone",
    paint: { "fill-color": "#00e676", "fill-opacity": 0.06 } });
  map.addLayer({ id: "ride-zone-border", type: "line", source: "ride-zone",
    paint: { "line-color": "#00e676", "line-width": 2, "line-dasharray": [2, 2] } });

  map.addSource("no-ride-zones", { type: "geojson", data: zones.noRideZones });
  map.addLayer({ id: "no-ride-fill", type: "fill", source: "no-ride-zones",
    paint: { "fill-color": "#ff5252", "fill-opacity": 0.2 } });
  map.addLayer({ id: "no-ride-border", type: "line", source: "no-ride-zones",
    paint: { "line-color": "#ff5252", "line-width": 1.5 } });

  map.addSource("slow-zones", { type: "geojson", data: zones.slowZones });
  map.addLayer({ id: "slow-fill", type: "fill", source: "slow-zones",
    paint: { "fill-color": "#ffab00", "fill-opacity": 0.15 } });
  map.addLayer({ id: "slow-border", type: "line", source: "slow-zones",
    paint: { "line-color": "#ffab00", "line-width": 1 } });

  map.addSource("no-parking-zones", { type: "geojson", data: zones.noParkingZones });
  map.addLayer({ id: "no-parking-fill", type: "fill", source: "no-parking-zones",
    paint: { "fill-color": "#9c27b0", "fill-opacity": 0.15 } });
  map.addLayer({ id: "no-parking-border", type: "line", source: "no-parking-zones",
    paint: { "line-color": "#9c27b0", "line-width": 1 } });

  // Route line with shadow
  map.addSource("route", {
    type: "geojson",
    data: { type: "Feature", geometry: { type: "LineString", coordinates: [] } },
  });
  map.addLayer({ id: "route-shadow", type: "line", source: "route",
    layout: { "line-join": "round", "line-cap": "round" },
    paint: { "line-color": "#000", "line-width": 10, "line-opacity": 0.3 } });
  map.addLayer({ id: "route-line", type: "line", source: "route",
    layout: { "line-join": "round", "line-cap": "round" },
    paint: { "line-color": "#00e676", "line-width": 6, "line-opacity": 0.9 } });

  // Hover popups
  const popup = new mapboxgl.Popup({ closeButton: false, closeOnClick: false });
  for (const [layer, label] of [["no-ride-fill","No-Ride Zone"],["slow-fill","Slow Zone"],["no-parking-fill","No-Parking Zone"]]) {
    map.on("mouseenter", layer, (e) => {
      map.getCanvas().style.cursor = "pointer";
      const n = e.features[0].properties.name || label;
      const s = e.features[0].properties.speedLimit;
      popup.setLngLat(e.lngLat).setHTML(`<strong>${n}</strong><br>${label}${s ? ` · ${s} km/h` : ""}`).addTo(map);
    });
    map.on("mouseleave", layer, () => { map.getCanvas().style.cursor = ""; popup.remove(); });
  }
});

map.addControl(new mapboxgl.NavigationControl(), "top-right");

// --- Routing ---
routeBtn.addEventListener("click", async () => {
  if (!startCoords || !endCoords) return;
  routeBtn.textContent = "Calculating...";
  routeBtn.disabled = true;

  try {
    const result = await getNeuronRoute(startCoords, endCoords, mapboxgl.accessToken);
    routeInfo.classList.remove("hidden");

    if (!result.ok) {
      routeStatus.className = "bad";
      routeStatus.textContent = result.error;
      routeDetails.textContent = "";
      return;
    }

    map.getSource("route").setData({ type: "Feature", geometry: result.geometry });
    const colors = { ok: "#00e676", warn: "#ffab00", bad: "#ff5252" };
    map.setPaintProperty("route-line", "line-color", colors[result.status] || "#00e676");

    const coords = result.geometry.coordinates;
    const bounds = coords.reduce((b, c) => b.extend(c), new mapboxgl.LngLatBounds(coords[0], coords[0]));
    map.fitBounds(bounds, { padding: { top: 60, bottom: 300, left: 40, right: 40 } });

    routeStatus.className = result.status;
    routeStatus.textContent = result.message;

    const km = (result.distance / 1000).toFixed(1);
    const min = Math.ceil(result.duration / 60);
    routeDetails.innerHTML = `${km} km · ~${min} min`;
    if (result.rerouted) routeDetails.innerHTML += ` · 🔄 Rerouted`;
    if (result.analysis.inSlow) routeDetails.innerHTML += ` · ⚠️ Slow zone`;

    lastRouteSteps = result.steps;
    lastRouteGeometry = result.geometry;
    fullRouteCoords = [...result.geometry.coordinates];
    navBtn.classList.remove("hidden");
  } catch (err) {
    routeInfo.classList.remove("hidden");
    routeStatus.className = "bad";
    routeStatus.textContent = "Something went wrong.";
    routeDetails.textContent = err.message;
  } finally {
    routeBtn.textContent = "Find Neuron Route";
    routeBtn.disabled = false;
  }
});

// --- Navigation mode ---
function enterNavMode() {
  // Hide panel, show overlay
  panel.style.display = "none";
  navOverlay.classList.remove("hidden");

  // Thicken route
  map.setPaintProperty("route-line", "line-width", 10);
  map.setPaintProperty("route-shadow", "line-width", 16);

  // Start voice
  startNavigation(lastRouteSteps, (stepIndex, instruction) => {
    navInstruction.textContent = instruction;
    const next = lastRouteSteps[stepIndex + 1];
    if (next) {
      navMeta.textContent = next.distance > 1000
        ? `${(next.distance / 1000).toFixed(1)} km`
        : `${Math.round(next.distance)} m`;
    } else {
      navMeta.textContent = "Arriving soon";
    }
  });

  // GPS tracking — center + rotate map to heading, trim route
  navWatchId = navigator.geolocation.watchPosition(
    (pos) => {
      const lng = pos.coords.longitude;
      const lat = pos.coords.latitude;
      const heading = pos.coords.heading;

      if (heading != null && !isNaN(heading) && heading > 0) {
        currentHeading = heading;
      }

      updateUserMarker(lng, lat, currentHeading);
      trimRouteToPosition([lng, lat]);

      map.easeTo({
        center: [lng, lat],
        zoom: 17.5,
        pitch: 60,
        bearing: currentHeading,
        duration: 800,
      });
    },
    () => {},
    { enableHighAccuracy: true, maximumAge: 1500 }
  );
}

function exitNavMode() {
  if (navWatchId != null) {
    navigator.geolocation.clearWatch(navWatchId);
    navWatchId = null;
  }
  stopNavigation();

  panel.style.display = "";
  navOverlay.classList.add("hidden");

  map.setPaintProperty("route-line", "line-width", 6);
  map.setPaintProperty("route-shadow", "line-width", 10);
  map.easeTo({ pitch: 0, bearing: 0, duration: 400 });

  // Restore full route line
  if (lastRouteGeometry) {
    map.getSource("route").setData({ type: "Feature", geometry: lastRouteGeometry });
    const coords = lastRouteGeometry.coordinates;
    const bounds = coords.reduce((b, c) => b.extend(c), new mapboxgl.LngLatBounds(coords[0], coords[0]));
    setTimeout(() => map.fitBounds(bounds, { padding: { top: 60, bottom: 300, left: 40, right: 40 } }), 500);
  }
}

navBtn.addEventListener("click", () => {
  if (lastRouteSteps?.length > 0) enterNavMode();
});

navExitBtn.addEventListener("click", exitNavMode);
