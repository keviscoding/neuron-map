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
let navWatchId = null;
let inNavMode = false;

// --- DOM refs ---
const sidebar = document.getElementById("sidebar");
const sidebarToggle = document.getElementById("sidebar-toggle");
const useLocationBtn = document.getElementById("use-location-btn");
const routeBtn = document.getElementById("route-btn");
const routeInfo = document.getElementById("route-info");
const routeStatus = document.getElementById("route-status");
const routeDetails = document.getElementById("route-details");
const navBtn = document.getElementById("nav-btn");
const navInstruction = document.getElementById("nav-instruction");
const navOverlay = document.getElementById("nav-overlay");
const navOverlayInstruction = document.getElementById("nav-overlay-instruction");
const navOverlayMeta = document.getElementById("nav-overlay-meta");
const navExitBtn = document.getElementById("nav-exit-btn");

// --- Geocoders ---
const geocoderStart = new MapboxGeocoder({
  accessToken: mapboxgl.accessToken,
  placeholder: "Your location or starting point",
  bbox: [-1.7, 54.93, -1.5, 55.02],
  proximity: { longitude: CITY_CENTER[0], latitude: CITY_CENTER[1] },
  mapboxgl,
});

const geocoderEnd = new MapboxGeocoder({
  accessToken: mapboxgl.accessToken,
  placeholder: "Where do you want to go?",
  bbox: [-1.7, 54.93, -1.5, 55.02],
  proximity: { longitude: CITY_CENTER[0], latitude: CITY_CENTER[1] },
  mapboxgl,
});

document.getElementById("geocoder-start").appendChild(geocoderStart.onAdd(map));
document.getElementById("geocoder-end").appendChild(geocoderEnd.onAdd(map));

geocoderStart.on("result", (e) => {
  startCoords = e.result.center;
  updateRouteButton();
});
geocoderEnd.on("result", (e) => {
  endCoords = e.result.center;
  updateRouteButton();
});

function updateRouteButton() {
  routeBtn.disabled = !(startCoords && endCoords);
}

// --- Use my location ---
useLocationBtn.addEventListener("click", () => {
  if (!("geolocation" in navigator)) {
    useLocationBtn.textContent = "📍 Not supported on this browser";
    return;
  }

  useLocationBtn.textContent = "📍 Getting location...";
  useLocationBtn.classList.add("loading");

  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      const lng = pos.coords.longitude;
      const lat = pos.coords.latitude;
      startCoords = [lng, lat];

      try {
        const res = await fetch(
          `https://api.mapbox.com/geocoding/v5/mapbox.places/${lng},${lat}.json?access_token=${mapboxgl.accessToken}`
        );
        const data = await res.json();
        const name = data.features?.[0]?.place_name || `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
        geocoderStart.setInput(name);
      } catch {
        geocoderStart.setInput(`${lat.toFixed(4)}, ${lng.toFixed(4)}`);
      }

      useLocationBtn.textContent = "📍 Location set";
      useLocationBtn.classList.remove("loading");
      updateRouteButton();
      map.flyTo({ center: [lng, lat], zoom: 15 });
    },
    (err) => {
      // More helpful error messages
      let msg = "📍 Couldn't get location";
      if (err.code === 1) msg = "📍 Location permission denied — check browser settings";
      else if (err.code === 2) msg = "📍 Location unavailable — try again";
      else if (err.code === 3) msg = "📍 Location timed out — try again";

      useLocationBtn.textContent = msg;
      useLocationBtn.classList.remove("loading");
      setTimeout(() => { useLocationBtn.textContent = "📍 Use my current location"; }, 4000);
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 }
  );
});

// --- Map layers ---
map.on("load", async () => {
  const zones = await fetchZones();

  map.addSource("ride-zone", { type: "geojson", data: zones.rideZone });
  map.addLayer({ id: "ride-zone-fill", type: "fill", source: "ride-zone",
    paint: { "fill-color": "#00e676", "fill-opacity": 0.08 } });
  map.addLayer({ id: "ride-zone-border", type: "line", source: "ride-zone",
    paint: { "line-color": "#00e676", "line-width": 2, "line-dasharray": [2, 2] } });

  map.addSource("no-ride-zones", { type: "geojson", data: zones.noRideZones });
  map.addLayer({ id: "no-ride-fill", type: "fill", source: "no-ride-zones",
    paint: { "fill-color": "#ff5252", "fill-opacity": 0.25 } });
  map.addLayer({ id: "no-ride-border", type: "line", source: "no-ride-zones",
    paint: { "line-color": "#ff5252", "line-width": 2 } });

  map.addSource("slow-zones", { type: "geojson", data: zones.slowZones });
  map.addLayer({ id: "slow-fill", type: "fill", source: "slow-zones",
    paint: { "fill-color": "#ffab00", "fill-opacity": 0.2 } });
  map.addLayer({ id: "slow-border", type: "line", source: "slow-zones",
    paint: { "line-color": "#ffab00", "line-width": 1.5 } });

  map.addSource("no-parking-zones", { type: "geojson", data: zones.noParkingZones });
  map.addLayer({ id: "no-parking-fill", type: "fill", source: "no-parking-zones",
    paint: { "fill-color": "#9c27b0", "fill-opacity": 0.2 } });
  map.addLayer({ id: "no-parking-border", type: "line", source: "no-parking-zones",
    paint: { "line-color": "#9c27b0", "line-width": 1.5 } });

  // Route line
  map.addSource("route", {
    type: "geojson",
    data: { type: "Feature", geometry: { type: "LineString", coordinates: [] } },
  });
  map.addLayer({ id: "route-line-bg", type: "line", source: "route",
    layout: { "line-join": "round", "line-cap": "round" },
    paint: { "line-color": "#000", "line-width": 8, "line-opacity": 0.4 } });
  map.addLayer({ id: "route-line", type: "line", source: "route",
    layout: { "line-join": "round", "line-cap": "round" },
    paint: { "line-color": "#00e676", "line-width": 5, "line-opacity": 0.9 } });

  // Hover popups
  const popup = new mapboxgl.Popup({ closeButton: false, closeOnClick: false });
  for (const [layerId, zoneType] of [
    ["no-ride-fill", "No-Ride Zone"],
    ["slow-fill", "Slow Zone"],
    ["no-parking-fill", "No-Parking Zone"],
  ]) {
    map.on("mouseenter", layerId, (e) => {
      map.getCanvas().style.cursor = "pointer";
      const name = e.features[0].properties.name || zoneType;
      const speed = e.features[0].properties.speedLimit;
      const extra = speed ? `<br>Speed limit: ${speed} km/h` : "";
      popup.setLngLat(e.lngLat).setHTML(`<strong>${name}</strong><br>${zoneType}${extra}`).addTo(map);
    });
    map.on("mouseleave", layerId, () => {
      map.getCanvas().style.cursor = "";
      popup.remove();
    });
  }
});

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

    // Draw route
    map.getSource("route").setData({ type: "Feature", geometry: result.geometry });
    const colors = { ok: "#00e676", warn: "#ffab00", bad: "#ff5252" };
    map.setPaintProperty("route-line", "line-color", colors[result.status] || "#00e676");

    // Fit to route
    const coords = result.geometry.coordinates;
    const bounds = coords.reduce((b, c) => b.extend(c), new mapboxgl.LngLatBounds(coords[0], coords[0]));
    map.fitBounds(bounds, { padding: 80 });

    routeStatus.className = result.status;
    routeStatus.textContent = result.message;

    const distKm = (result.distance / 1000).toFixed(1);
    const durMin = Math.ceil(result.duration / 60);
    routeDetails.innerHTML = `${distKm} km · ~${durMin} min by scooter`;
    if (result.rerouted) routeDetails.innerHTML += `<br>🔄 Rerouted to avoid no-ride zones`;
    if (result.analysis.inSlow) routeDetails.innerHTML += `<br>⚠️ Slow zone on route`;
    if (result.analysis.outsideRideZone) routeDetails.innerHTML += `<br>🚶 Some walking required`;

    lastRouteSteps = result.steps;
    lastRouteGeometry = result.geometry;
    if (lastRouteSteps?.length > 0) {
      navBtn.classList.remove("hidden");
      navBtn.classList.remove("active");
      navBtn.textContent = "🛴 Start Navigation";
      navInstruction.classList.add("hidden");
      stopNavigation();
    }
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

// --- Navigation Mode (Google Maps style) ---

function enterNavMode() {
  inNavMode = true;

  // Hide sidebar, show nav overlay
  sidebar.style.display = "none";
  navOverlay.classList.remove("hidden");

  // Thicken route line for nav
  map.setPaintProperty("route-line", "line-width", 8);
  map.setPaintProperty("route-line-bg", "line-width", 12);

  // Start voice nav
  const started = startNavigation(lastRouteSteps, (stepIndex, instruction) => {
    navOverlayInstruction.textContent = instruction;

    // Show distance to next step if available
    const nextStep = lastRouteSteps[stepIndex + 1];
    if (nextStep) {
      const dist = nextStep.distance;
      navOverlayMeta.textContent = dist > 1000
        ? `${(dist / 1000).toFixed(1)} km`
        : `${Math.round(dist)} m`;
    } else {
      navOverlayMeta.textContent = "Arriving";
    }
  });

  if (!started) {
    exitNavMode();
    return;
  }

  // Start GPS tracking for map rotation and centering
  navWatchId = navigator.geolocation.watchPosition(
    (pos) => {
      const lng = pos.coords.longitude;
      const lat = pos.coords.latitude;
      const heading = pos.coords.heading;

      // Center map on user, rotated to heading
      const options = {
        center: [lng, lat],
        zoom: 17,
        pitch: 60,
        duration: 1000,
      };

      // Rotate map to match travel direction
      if (heading !== null && !isNaN(heading)) {
        options.bearing = heading;
      }

      map.easeTo(options);
    },
    (err) => {
      console.warn("Nav GPS error:", err.message);
    },
    { enableHighAccuracy: true, maximumAge: 2000 }
  );
}

function exitNavMode() {
  inNavMode = false;

  // Stop GPS tracking
  if (navWatchId !== null) {
    navigator.geolocation.clearWatch(navWatchId);
    navWatchId = null;
  }

  // Stop voice
  stopNavigation();

  // Show sidebar, hide overlay
  sidebar.style.display = "";
  navOverlay.classList.add("hidden");

  // Reset map view
  map.setPaintProperty("route-line", "line-width", 5);
  map.setPaintProperty("route-line-bg", "line-width", 8);
  map.easeTo({ pitch: 0, bearing: 0, zoom: 13, duration: 500 });

  // Re-fit to route if we have one
  if (lastRouteGeometry) {
    const coords = lastRouteGeometry.coordinates;
    const bounds = coords.reduce((b, c) => b.extend(c), new mapboxgl.LngLatBounds(coords[0], coords[0]));
    map.fitBounds(bounds, { padding: 80 });
  }
}

// Nav button in sidebar starts nav mode
navBtn.addEventListener("click", () => {
  if (lastRouteSteps?.length > 0) {
    enterNavMode();
  }
});

// Exit button in nav overlay
navExitBtn.addEventListener("click", exitNavMode);

// --- Map controls ---
map.addControl(new mapboxgl.NavigationControl(), "bottom-right");

// --- Mobile sidebar toggle ---
sidebarToggle.addEventListener("click", () => {
  sidebar.classList.toggle("collapsed");
  sidebarToggle.textContent = sidebar.classList.contains("collapsed") ? "▲" : "▼";
});
