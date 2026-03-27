import mapboxgl from "mapbox-gl";
import MapboxGeocoder from "@mapbox/mapbox-gl-geocoder";
import { fetchZones } from "./zones.js";
import { getNeuronRoute } from "./router.js";
import { startNavigation, stopNavigation, isNavigating } from "./voice.js";

// ⚠️ Replace with your Mapbox access token
// Get one free at https://account.mapbox.com/
// Set your Mapbox token as VITE_MAPBOX_TOKEN in a .env file
// or replace this fallback with your token for local dev
mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN || "";

// Newcastle city center
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
  document.getElementById("route-btn").disabled = !(startCoords && endCoords);
}

// --- Use my location ---
const useLocationBtn = document.getElementById("use-location-btn");

useLocationBtn.addEventListener("click", () => {
  if (!("geolocation" in navigator)) {
    useLocationBtn.textContent = "📍 Location not available";
    return;
  }

  useLocationBtn.textContent = "📍 Getting location...";
  useLocationBtn.classList.add("loading");

  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      const lng = pos.coords.longitude;
      const lat = pos.coords.latitude;
      startCoords = [lng, lat];

      // Reverse geocode to get a readable address
      try {
        const token = mapboxgl.accessToken;
        const res = await fetch(
          `https://api.mapbox.com/geocoding/v5/mapbox.places/${lng},${lat}.json?access_token=${token}`
        );
        const data = await res.json();
        const placeName = data.features?.[0]?.place_name || `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
        geocoderStart.setInput(placeName);
        useLocationBtn.textContent = "📍 Location set";
      } catch {
        geocoderStart.setInput(`${lat.toFixed(4)}, ${lng.toFixed(4)}`);
        useLocationBtn.textContent = "📍 Location set";
      }

      useLocationBtn.classList.remove("loading");
      updateRouteButton();

      // Fly to user location
      map.flyTo({ center: [lng, lat], zoom: 15 });
    },
    (err) => {
      useLocationBtn.textContent = "📍 Couldn't get location";
      useLocationBtn.classList.remove("loading");
      setTimeout(() => {
        useLocationBtn.textContent = "📍 Use my current location";
      }, 3000);
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
});

// --- Map layers (loaded after fetching live zone data) ---

map.on("load", async () => {
  // Fetch real Neuron zone data from their GBFS API
  const zones = await fetchZones();

  // Ride zone (green boundary)
  map.addSource("ride-zone", { type: "geojson", data: zones.rideZone });
  map.addLayer({
    id: "ride-zone-fill",
    type: "fill",
    source: "ride-zone",
    paint: { "fill-color": "#00e676", "fill-opacity": 0.08 },
  });
  map.addLayer({
    id: "ride-zone-border",
    type: "line",
    source: "ride-zone",
    paint: { "line-color": "#00e676", "line-width": 2, "line-dasharray": [2, 2] },
  });

  // No-ride zones (red)
  map.addSource("no-ride-zones", { type: "geojson", data: zones.noRideZones });
  map.addLayer({
    id: "no-ride-fill",
    type: "fill",
    source: "no-ride-zones",
    paint: { "fill-color": "#ff5252", "fill-opacity": 0.25 },
  });
  map.addLayer({
    id: "no-ride-border",
    type: "line",
    source: "no-ride-zones",
    paint: { "line-color": "#ff5252", "line-width": 2 },
  });

  // Slow zones (amber)
  map.addSource("slow-zones", { type: "geojson", data: zones.slowZones });
  map.addLayer({
    id: "slow-fill",
    type: "fill",
    source: "slow-zones",
    paint: { "fill-color": "#ffab00", "fill-opacity": 0.2 },
  });
  map.addLayer({
    id: "slow-border",
    type: "line",
    source: "slow-zones",
    paint: { "line-color": "#ffab00", "line-width": 1.5 },
  });

  // No-parking zones (purple)
  map.addSource("no-parking-zones", { type: "geojson", data: zones.noParkingZones });
  map.addLayer({
    id: "no-parking-fill",
    type: "fill",
    source: "no-parking-zones",
    paint: { "fill-color": "#9c27b0", "fill-opacity": 0.2 },
  });
  map.addLayer({
    id: "no-parking-border",
    type: "line",
    source: "no-parking-zones",
    paint: { "line-color": "#9c27b0", "line-width": 1.5 },
  });

  // Route line (empty until route is calculated)
  map.addSource("route", {
    type: "geojson",
    data: { type: "Feature", geometry: { type: "LineString", coordinates: [] } },
  });
  map.addLayer({
    id: "route-line",
    type: "line",
    source: "route",
    layout: { "line-join": "round", "line-cap": "round" },
    paint: { "line-color": "#00e676", "line-width": 5, "line-opacity": 0.85 },
  });

  // Zone labels on hover
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

const routeBtn = document.getElementById("route-btn");
const routeInfo = document.getElementById("route-info");
const routeStatus = document.getElementById("route-status");
const routeDetails = document.getElementById("route-details");
const navBtn = document.getElementById("nav-btn");
const navInstruction = document.getElementById("nav-instruction");

let lastRouteSteps = null;

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

    // Update route line on map
    map.getSource("route").setData({
      type: "Feature",
      geometry: result.geometry,
    });

    // Color the route based on status
    const colors = { ok: "#00e676", warn: "#ffab00", bad: "#ff5252" };
    map.setPaintProperty("route-line", "line-color", colors[result.status] || "#00e676");

    // Fit map to route
    const coords = result.geometry.coordinates;
    const bounds = coords.reduce(
      (b, c) => b.extend(c),
      new mapboxgl.LngLatBounds(coords[0], coords[0])
    );
    map.fitBounds(bounds, { padding: 80 });

    // Show info
    routeStatus.className = result.status;
    routeStatus.textContent = result.message;

    const distKm = (result.distance / 1000).toFixed(1);
    const durMin = Math.ceil(result.duration / 60);
    routeDetails.innerHTML = `${distKm} km · ~${durMin} min by scooter`;

    if (result.rerouted) {
      routeDetails.innerHTML += `<br>🔄 Rerouted to avoid no-ride zones`;
    }
    if (result.analysis.inSlow) {
      routeDetails.innerHTML += `<br>⚠️ Passes through slow zone — expect reduced speed`;
    }
    if (result.analysis.outsideRideZone) {
      routeDetails.innerHTML += `<br>🚶 Some sections are outside the ride zone — you'll need to walk`;
    }

    // Store steps and show voice nav button
    lastRouteSteps = result.steps;
    if (lastRouteSteps && lastRouteSteps.length > 0) {
      navBtn.classList.remove("hidden");
      navBtn.classList.remove("active");
      navBtn.textContent = "🔊 Start Voice Navigation";
      navInstruction.classList.add("hidden");
      stopNavigation();
    }
  } catch (err) {
    routeInfo.classList.remove("hidden");
    routeStatus.className = "bad";
    routeStatus.textContent = "Something went wrong getting the route.";
    routeDetails.textContent = err.message;
  } finally {
    routeBtn.textContent = "Find Neuron Route";
    routeBtn.disabled = false;
  }
});

// --- Voice Navigation ---

navBtn.addEventListener("click", () => {
  if (isNavigating()) {
    stopNavigation();
    navBtn.classList.remove("active");
    navBtn.textContent = "🔊 Start Voice Navigation";
    navInstruction.classList.add("hidden");
  } else if (lastRouteSteps && lastRouteSteps.length > 0) {
    const started = startNavigation(lastRouteSteps, (stepIndex, instruction) => {
      navInstruction.classList.remove("hidden");
      navInstruction.textContent = instruction;
    });
    if (started) {
      navBtn.classList.add("active");
      navBtn.textContent = "⏹ Stop Navigation";
    }
  }
});

// --- Map controls ---

map.addControl(
  new mapboxgl.GeolocateControl({
    positionOptions: { enableHighAccuracy: true },
    trackUserLocation: true,
    showUserHeading: true,
  })
);

map.addControl(new mapboxgl.NavigationControl(), "bottom-right");

// --- Mobile sidebar toggle ---
const sidebarToggle = document.getElementById("sidebar-toggle");
const sidebar = document.getElementById("sidebar");

sidebarToggle.addEventListener("click", () => {
  sidebar.classList.toggle("collapsed");
  sidebarToggle.textContent = sidebar.classList.contains("collapsed") ? "▲" : "▼";
});
