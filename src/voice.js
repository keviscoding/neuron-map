/**
 * Voice navigation using the Web Speech API.
 * Announces turn-by-turn directions as you ride.
 */

let synth = null;
let watchId = null;
let steps = [];
let currentStepIndex = 0;
let announcedSteps = new Set();
let onStepChange = null;

// Distance (meters) at which to announce the next instruction
const ANNOUNCE_DISTANCE = 40;

/**
 * Initialize the speech engine
 */
function init() {
  if (!("speechSynthesis" in window)) {
    console.warn("Voice navigation not supported in this browser");
    return false;
  }
  synth = window.speechSynthesis;
  return true;
}

/**
 * Speak a message
 */
function speak(text) {
  if (!synth) return;
  synth.cancel(); // stop any current speech
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 1.0;
  utterance.pitch = 1.0;
  utterance.lang = "en-GB"; // Newcastle deserves a British voice
  synth.speak(utterance);
}

/**
 * Calculate distance between two [lng, lat] points in meters
 */
function distanceBetween(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLng = toRad(b[0] - a[0]);
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const h =
    sinLat * sinLat +
    Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * sinLng * sinLng;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

/**
 * Clean up a Mapbox instruction for speech
 */
function cleanInstruction(instruction) {
  return instruction
    .replace(/<[^>]*>/g, "") // strip HTML tags
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Start voice navigation with route steps and GPS tracking.
 * @param {Array} routeSteps - steps from Mapbox Directions response
 * @param {Function} callback - called with (stepIndex, instruction) on step change
 */
export function startNavigation(routeSteps, callback) {
  if (!init()) {
    alert("Voice navigation isn't supported in your browser. Try Chrome or Safari.");
    return false;
  }

  steps = routeSteps;
  currentStepIndex = 0;
  announcedSteps = new Set();
  onStepChange = callback;

  // Announce the first instruction
  if (steps.length > 0) {
    const first = cleanInstruction(steps[0].maneuver.instruction);
    speak(`Starting navigation. ${first}`);
    announcedSteps.add(0);
    if (onStepChange) onStepChange(0, first);
  }

  // Watch GPS position
  if (!("geolocation" in navigator)) {
    speak("GPS not available. Navigation will not auto-advance.");
    return true;
  }

  watchId = navigator.geolocation.watchPosition(
    (pos) => {
      const userPos = [pos.coords.longitude, pos.coords.latitude];
      checkProgress(userPos);
    },
    (err) => {
      console.warn("GPS error:", err.message);
    },
    { enableHighAccuracy: true, maximumAge: 2000 }
  );

  return true;
}

/**
 * Check user position against upcoming step maneuver points
 */
function checkProgress(userPos) {
  for (let i = currentStepIndex; i < steps.length; i++) {
    const maneuver = steps[i].maneuver;
    const stepPos = maneuver.location; // [lng, lat]
    const dist = distanceBetween(userPos, stepPos);

    if (dist < ANNOUNCE_DISTANCE && !announcedSteps.has(i)) {
      currentStepIndex = i;
      announcedSteps.add(i);

      const instruction = cleanInstruction(maneuver.instruction);
      speak(instruction);
      if (onStepChange) onStepChange(i, instruction);

      // If this is the last step, announce arrival
      if (i === steps.length - 1) {
        setTimeout(() => speak("You have arrived at your destination."), 2000);
      }
      break;
    }
  }

  // Also announce upcoming step when getting close
  const nextIdx = currentStepIndex + 1;
  if (nextIdx < steps.length && !announcedSteps.has(nextIdx)) {
    const nextManeuver = steps[nextIdx].maneuver;
    const dist = distanceBetween(userPos, nextManeuver.location);
    if (dist < ANNOUNCE_DISTANCE * 2.5) {
      const instruction = cleanInstruction(nextManeuver.instruction);
      speak(`In ${Math.round(dist)} metres, ${instruction}`);
      // Don't mark as announced yet — we'll announce again when closer
    }
  }
}

/**
 * Stop voice navigation and GPS tracking
 */
export function stopNavigation() {
  if (synth) synth.cancel();
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
  steps = [];
  currentStepIndex = 0;
  announcedSteps.clear();
  onStepChange = null;
}

/**
 * Check if navigation is currently active
 */
export function isNavigating() {
  return steps.length > 0;
}
