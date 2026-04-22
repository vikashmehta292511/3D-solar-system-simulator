import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import init, { GravitySimulation } from "../rust-physics/pkg/rust_physics.js";

const DISTANCE_SCALE = 1.8;
const QUALITY_PRESETS = {
  low: {
    starCount: 1500,
    sparkleCount: 48,
    trailLength: 90,
    trailUpdateInterval: 4,
    pixelRatio: 1.15,
    glowStrength: 0.65
  },
  medium: {
    starCount: 2600,
    sparkleCount: 90,
    trailLength: 160,
    trailUpdateInterval: 3,
    pixelRatio: 1.5,
    glowStrength: 0.85
  },
  high: {
    starCount: 4200,
    sparkleCount: 160,
    trailLength: 260,
    trailUpdateInterval: 2,
    pixelRatio: 2,
    glowStrength: 1
  }
};
const GESTURE_WASM_BASE = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
const HAND_MODEL_URL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

const refs = {
  canvas: document.querySelector("#scene"),
  panel: document.querySelector("#control-panel"),
  panelToggle: document.querySelector("#panel-toggle"),
  pauseButton: document.querySelector("#pause-button"),
  resetButton: document.querySelector("#reset-button"),
  speedButtons: Array.from(document.querySelectorAll(".speed-button")),
  focusSelect: document.querySelector("#focus-select"),
  trailToggle: document.querySelector("#trail-toggle"),
  qualitySelect: document.querySelector("#quality-select"),
  gestureButton: document.querySelector("#gesture-button"),
  gestureStatus: document.querySelector("#gesture-status"),
  gestureVideo: document.querySelector("#gesture-video"),
  focusName: document.querySelector("#focus-name"),
  fpsCounter: document.querySelector("#fps-counter")
};

const renderer = new THREE.WebGLRenderer({
  canvas: refs.canvas,
  antialias: true,
  alpha: false
});
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, QUALITY_PRESETS.medium.pixelRatio));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
renderer.setClearColor("#030712");

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2("#040913", 0.0024);

const camera = new THREE.PerspectiveCamera(52, window.innerWidth / window.innerHeight, 0.1, 1200);
camera.position.set(0, 18, 54);

const controls = new OrbitControls(camera, refs.canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.055;
controls.minDistance = 8;
controls.maxDistance = 260;
controls.enablePan = true;
controls.target.set(0, 0, 0);

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const pointerDown = new THREE.Vector2();

const ambientLight = new THREE.AmbientLight("#a9c9ff", 0.68);
const hemisphereLight = new THREE.HemisphereLight("#9cb7ff", "#0a1020", 0.82);
const sunLight = new THREE.PointLight("#ffd08a", 2.8, 900, 1.7);
const fillLight = new THREE.DirectionalLight("#8ab1ff", 0.8);
fillLight.position.set(-28, 22, 16);
scene.add(ambientLight, hemisphereLight, sunLight, fillLight);

const solarPlane = new THREE.Mesh(
  new THREE.RingGeometry(12, 110, 180),
  new THREE.MeshBasicMaterial({
    color: "#173158",
    transparent: true,
    opacity: 0.1,
    side: THREE.DoubleSide
  })
);
solarPlane.rotation.x = Math.PI / 2;
scene.add(solarPlane);

let simulation;
let metadata = [];
let bodyEntries = [];
let trailEntries = [];
let starfieldRoot;
let sparkleEntries = [];
let starLayers = [];
let currentFocusPosition = new THREE.Vector3();
let targetFocusPosition = new THREE.Vector3();
let trailFrameCounter = 0;
let fpsFrames = 0;
let fpsWindowStart = performance.now();
let activeQuality = "medium";

const state = {
  speed: 10,
  paused: false,
  trailsEnabled: true,
  focusIndex: 3,
  gestureEnabled: false,
  gestureReady: false,
  lastPinchDistance: null,
  lastPalmToggleAt: 0,
  lastGestureSampleAt: 0
};

const gestureState = {
  stream: null,
  vision: null,
  handLandmarker: null,
  FilesetResolver: null,
  HandLandmarker: null,
  lastVideoTime: -1,
  initializing: false
};

function createBodyVisual(bodyMeta, index) {
  const root = new THREE.Group();
  root.userData.bodyIndex = index;

  const sphereGeometry = new THREE.SphereGeometry(bodyMeta.radius, 36, 36);
  const baseColor = new THREE.Color(bodyMeta.color);
  const emissiveColor = new THREE.Color(bodyMeta.glow_color);
  const material = new THREE.MeshStandardMaterial({
    color: baseColor,
    emissive: emissiveColor,
    emissiveIntensity: bodyMeta.is_sun ? 1.5 : 0.18,
    roughness: bodyMeta.is_sun ? 0.55 : 0.8,
    metalness: bodyMeta.is_sun ? 0.08 : 0.02
  });
  const mesh = new THREE.Mesh(sphereGeometry, material);
  root.add(mesh);

  const glowScale = bodyMeta.is_sun ? 2.2 : 1.22;
  const glowMaterial = new THREE.MeshBasicMaterial({
    color: bodyMeta.glow_color,
    transparent: true,
    opacity: bodyMeta.is_sun ? 0.3 : 0.08,
    depthWrite: false
  });
  const glow = new THREE.Mesh(
    new THREE.SphereGeometry(bodyMeta.radius * glowScale, 24, 24),
    glowMaterial
  );
  root.add(glow);

  if (!bodyMeta.is_sun && ["Earth", "Venus", "Neptune", "Uranus"].includes(bodyMeta.name)) {
    const atmosphere = new THREE.Mesh(
      new THREE.SphereGeometry(bodyMeta.radius * 1.08, 26, 26),
      new THREE.MeshBasicMaterial({
        color: bodyMeta.glow_color,
        transparent: true,
        opacity: 0.1,
        depthWrite: false
      })
    );
    root.add(atmosphere);
  }

  if (bodyMeta.name === "Saturn") {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(bodyMeta.radius * 1.45, bodyMeta.radius * 2.2, 72),
      new THREE.MeshBasicMaterial({
        color: "#d6c68c",
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.6,
        depthWrite: false
      })
    );
    ring.rotation.x = Math.PI / 2.65;
    root.add(ring);
  }

  scene.add(root);
  return { metadata: bodyMeta, root, mesh, glow };
}

function createTrail(bodyMeta) {
  const geometry = new THREE.BufferGeometry();
  const material = new THREE.LineBasicMaterial({
    color: bodyMeta.trail_color,
    transparent: true,
    opacity: 0.55
  });
  const line = new THREE.Line(geometry, material);
  line.visible = state.trailsEnabled;
  scene.add(line);

  return {
    line,
    history: [],
    maxPoints: QUALITY_PRESETS[activeQuality].trailLength
  };
}

function createStarPoints(count, radiusMin, radiusMax, colorHex, size) {
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const color = new THREE.Color(colorHex);

  for (let i = 0; i < count; i += 1) {
    const radius = radiusMin + Math.random() * (radiusMax - radiusMin);
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);

    positions[i * 3] = radius * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = radius * Math.cos(phi) * 0.75;
    positions[i * 3 + 2] = radius * Math.sin(phi) * Math.sin(theta);

    colors[i * 3] = color.r * (0.8 + Math.random() * 0.2);
    colors[i * 3 + 1] = color.g * (0.8 + Math.random() * 0.2);
    colors[i * 3 + 2] = color.b;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));

  const material = new THREE.PointsMaterial({
    size,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.88,
    vertexColors: true,
    depthWrite: false
  });

  return new THREE.Points(geometry, material);
}

function rebuildStarfield() {
  if (starfieldRoot) {
    scene.remove(starfieldRoot);
  }

  sparkleEntries = [];
  starLayers = [];
  starfieldRoot = new THREE.Group();

  const preset = QUALITY_PRESETS[activeQuality];
  const layerA = createStarPoints(preset.starCount, 150, 240, "#f7fbff", 0.8);
  const layerB = createStarPoints(Math.round(preset.starCount * 0.55), 90, 160, "#b0d0ff", 1.05);
  const layerC = createStarPoints(Math.round(preset.starCount * 0.35), 240, 360, "#ffe6b8", 1.25);
  layerB.rotation.y = 0.45;
  layerC.rotation.y = -0.2;

  starLayers.push(layerA, layerB, layerC);
  starfieldRoot.add(layerA, layerB, layerC);

  for (let i = 0; i < preset.sparkleCount; i += 1) {
    const sparkle = new THREE.Mesh(
      new THREE.SphereGeometry(0.08 + Math.random() * 0.08, 8, 8),
      new THREE.MeshBasicMaterial({
        color: i % 5 === 0 ? "#ffdca8" : "#f8fbff",
        transparent: true,
        opacity: 0.45,
        depthWrite: false
      })
    );

    const radius = 95 + Math.random() * 220;
    const theta = Math.random() * Math.PI * 2;
    const height = (Math.random() - 0.5) * 160;
    sparkle.position.set(Math.cos(theta) * radius, height, Math.sin(theta) * radius);

    const baseScale = 0.8 + Math.random() * 1.8;
    sparkle.scale.setScalar(baseScale);
    sparkle.userData.baseScale = baseScale;
    sparkle.userData.phase = Math.random() * Math.PI * 2;
    sparkle.userData.speed = 0.35 + Math.random() * 1.25;
    sparkleEntries.push(sparkle);
    starfieldRoot.add(sparkle);
  }

  scene.add(starfieldRoot);
}

function applyQualityPreset(quality) {
  activeQuality = quality;
  const preset = QUALITY_PRESETS[quality];
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, preset.pixelRatio));
  rebuildStarfield();

  trailEntries.forEach((trail) => {
    trail.maxPoints = preset.trailLength;
    if (trail.history.length > trail.maxPoints) {
      trail.history = trail.history.slice(-trail.maxPoints);
      trail.line.geometry.setFromPoints(trail.history);
    }
  });

  bodyEntries.forEach((entry) => {
    entry.glow.material.opacity = entry.metadata.is_sun
      ? 0.3 * preset.glowStrength
      : 0.08 * preset.glowStrength;
  });
}

function buildFocusOptions() {
  refs.focusSelect.innerHTML = "";

  metadata.forEach((bodyMeta, index) => {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = bodyMeta.name;
    refs.focusSelect.append(option);
  });
}

function setSpeed(speed) {
  state.speed = speed;
  refs.speedButtons.forEach((button) => {
    button.classList.toggle("is-active", Number(button.dataset.speed) === speed);
  });
}

function setPaused(paused) {
  state.paused = paused;
  simulation.set_paused(paused);
  refs.pauseButton.textContent = paused ? "Resume" : "Pause";
}

function setFocusIndex(index) {
  state.focusIndex = index;
  refs.focusSelect.value = String(index);
  refs.focusName.textContent = metadata[index]?.name ?? "Unknown";
}

function getFocusDistance(bodyMeta) {
  return Math.max(10, bodyMeta.radius * 7 + (bodyMeta.is_sun ? 16 : 10));
}

function refreshTrailVisibility() {
  trailEntries.forEach((trail) => {
    trail.line.visible = state.trailsEnabled;
  });
}

function updateTrails() {
  if (!state.trailsEnabled) {
    return;
  }

  const updateInterval = QUALITY_PRESETS[activeQuality].trailUpdateInterval;
  trailFrameCounter += 1;
  if (trailFrameCounter % updateInterval !== 0) {
    return;
  }

  trailEntries.forEach((trail, index) => {
    const bodyEntry = bodyEntries[index + 1];
    const point = bodyEntry.root.position.clone();
    trail.history.push(point);

    if (trail.history.length > trail.maxPoints) {
      trail.history.shift();
    }

    trail.line.geometry.setFromPoints(trail.history);
  });
}

function updateBodyPositions(flatPositions) {
  for (let i = 0; i < bodyEntries.length; i += 1) {
    const offset = i * 3;
    bodyEntries[i].root.position.set(
      flatPositions[offset] * DISTANCE_SCALE,
      flatPositions[offset + 1] * DISTANCE_SCALE,
      flatPositions[offset + 2] * DISTANCE_SCALE
    );
  }

  sunLight.position.copy(bodyEntries[0].root.position);
}

function updateCameraFollow() {
  const focusEntry = bodyEntries[state.focusIndex];
  if (!focusEntry) {
    return;
  }

  targetFocusPosition.copy(focusEntry.root.position);
  currentFocusPosition.lerp(targetFocusPosition, 0.08);

  const desiredDistance = getFocusDistance(focusEntry.metadata);
  const offset = camera.position.clone().sub(controls.target);
  if (offset.lengthSq() < 0.001) {
    offset.set(desiredDistance * 0.35, desiredDistance * 0.2, desiredDistance);
  }

  const desiredOffset = offset.normalize().multiplyScalar(desiredDistance);
  const desiredCameraPosition = currentFocusPosition.clone().add(desiredOffset);

  controls.target.lerp(currentFocusPosition, 0.12);
  camera.position.lerp(desiredCameraPosition, 0.08);
}

function updateStarfield(elapsedTime, deltaSeconds) {
  if (!starfieldRoot) {
    return;
  }

  starfieldRoot.rotation.y += deltaSeconds * 0.004;
  if (starLayers[1]) {
    starLayers[1].rotation.y -= deltaSeconds * 0.0015;
  }
  if (starLayers[2]) {
    starLayers[2].rotation.y += deltaSeconds * 0.0009;
  }

  sparkleEntries.forEach((sparkle) => {
    const pulse = 0.5 + Math.sin(elapsedTime * sparkle.userData.speed + sparkle.userData.phase) * 0.5;
    sparkle.material.opacity = 0.18 + pulse * 0.52;
    const scale = sparkle.userData.baseScale * (0.8 + pulse * 0.5);
    sparkle.scale.setScalar(scale);
  });
}

function resizeRenderer() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, QUALITY_PRESETS[activeQuality].pixelRatio));
}

function pickBody(clientX, clientY) {
  const bounds = refs.canvas.getBoundingClientRect();
  pointer.x = ((clientX - bounds.left) / bounds.width) * 2 - 1;
  pointer.y = -((clientY - bounds.top) / bounds.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);

  const intersects = raycaster.intersectObjects(bodyEntries.map((entry) => entry.mesh), false);
  if (intersects.length === 0) {
    return;
  }

  const bodyIndex = intersects[0].object.parent.userData.bodyIndex;
  setFocusIndex(bodyIndex);
}

function updateFps(now) {
  fpsFrames += 1;
  if (now - fpsWindowStart >= 500) {
    const fps = Math.round((fpsFrames * 1000) / (now - fpsWindowStart));
    refs.fpsCounter.textContent = String(fps);
    fpsFrames = 0;
    fpsWindowStart = now;
  }
}

function setGestureStatus(text) {
  refs.gestureStatus.textContent = text;
}

function orbitCamera(deltaTheta, deltaPhi) {
  const offset = camera.position.clone().sub(controls.target);
  const spherical = new THREE.Spherical().setFromVector3(offset);
  spherical.theta -= deltaTheta;
  spherical.phi = THREE.MathUtils.clamp(spherical.phi - deltaPhi, 0.28, Math.PI - 0.28);
  offset.setFromSpherical(spherical);
  camera.position.copy(controls.target).add(offset);
  camera.lookAt(controls.target);
}

function zoomCamera(scaleFactor) {
  const offset = camera.position.clone().sub(controls.target);
  const nextLength = THREE.MathUtils.clamp(offset.length() * scaleFactor, controls.minDistance, controls.maxDistance);
  offset.setLength(nextLength);
  camera.position.copy(controls.target).add(offset);
}

function isOpenPalm(landmarks) {
  const wrist = landmarks[0];
  const thumb = landmarks[4];
  const index = landmarks[8];
  const middle = landmarks[12];
  const ring = landmarks[16];
  const pinky = landmarks[20];

  const fingertips = [index, middle, ring, pinky];
  const averageDistance = fingertips.reduce((sum, point) => sum + Math.hypot(point.x - wrist.x, point.y - wrist.y), 0) / fingertips.length;
  const spread = Math.hypot(thumb.x - pinky.x, thumb.y - pinky.y);
  return averageDistance > 0.22 && spread > 0.22;
}

function updateGestureControls(now) {
  if (!state.gestureEnabled || !gestureState.handLandmarker || refs.gestureVideo.readyState < 2) {
    return;
  }

  if (refs.gestureVideo.currentTime === gestureState.lastVideoTime) {
    return;
  }

  gestureState.lastVideoTime = refs.gestureVideo.currentTime;
  const result = gestureState.handLandmarker.detectForVideo(refs.gestureVideo, now);
  const landmarks = result.landmarks?.[0];

  if (!landmarks) {
    state.lastPinchDistance = null;
    if (state.gestureReady) {
      setGestureStatus("Show one hand to orbit, pinch to zoom, open palm to pause.");
    }
    return;
  }

  state.gestureReady = true;
  const wrist = landmarks[0];
  const deltaX = THREE.MathUtils.clamp(wrist.x - 0.5, -0.32, 0.32);
  const deltaY = THREE.MathUtils.clamp(wrist.y - 0.5, -0.28, 0.28);

  if (Math.abs(deltaX) > 0.03 || Math.abs(deltaY) > 0.03) {
    orbitCamera(deltaX * 0.06, deltaY * 0.05);
  }

  const pinchDistance = Math.hypot(landmarks[4].x - landmarks[8].x, landmarks[4].y - landmarks[8].y);
  if (state.lastPinchDistance !== null) {
    const pinchDelta = pinchDistance - state.lastPinchDistance;
    if (Math.abs(pinchDelta) > 0.004) {
      zoomCamera(THREE.MathUtils.clamp(1 - pinchDelta * 4.5, 0.92, 1.08));
    }
  }
  state.lastPinchDistance = pinchDistance;

  if (isOpenPalm(landmarks) && now - state.lastPalmToggleAt > 1400) {
    state.lastPalmToggleAt = now;
    setPaused(!state.paused);
  }

  setGestureStatus("Gesture mode active. Move hand to orbit, pinch to zoom, open palm to pause.");
}

async function enableGestureMode() {
  if (gestureState.initializing || state.gestureEnabled) {
    return;
  }

  if (!navigator.mediaDevices?.getUserMedia) {
    setGestureStatus("This browser does not support webcam gesture control.");
    return;
  }

  gestureState.initializing = true;
  refs.gestureButton.textContent = "Starting";
  setGestureStatus("Requesting webcam and loading hand tracking...");

  try {
    if (!gestureState.FilesetResolver || !gestureState.HandLandmarker) {
      const tasksVision = await import("@mediapipe/tasks-vision");
      gestureState.FilesetResolver = tasksVision.FilesetResolver;
      gestureState.HandLandmarker = tasksVision.HandLandmarker;
    }

    gestureState.vision = await gestureState.FilesetResolver.forVisionTasks(GESTURE_WASM_BASE);
    gestureState.handLandmarker = await gestureState.HandLandmarker.createFromOptions(gestureState.vision, {
      baseOptions: {
        modelAssetPath: HAND_MODEL_URL
      },
      runningMode: "VIDEO",
      numHands: 1
    });

    gestureState.stream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: 640,
        height: 480,
        facingMode: "user"
      }
    });

    refs.gestureVideo.srcObject = gestureState.stream;
    await refs.gestureVideo.play();

    state.gestureEnabled = true;
    state.gestureReady = false;
    refs.gestureButton.textContent = "Disable";
    setGestureStatus("Gesture mode active. Show one hand to start controlling the camera.");
  } catch (error) {
    console.error(error);
    setGestureStatus("Could not enable webcam gesture control. Mouse and touch still work.");
    refs.gestureButton.textContent = "Enable";
  } finally {
    gestureState.initializing = false;
  }
}

function disableGestureMode() {
  state.gestureEnabled = false;
  state.gestureReady = false;
  state.lastPinchDistance = null;
  refs.gestureButton.textContent = "Enable";
  setGestureStatus("Camera control is off. Mouse and touch stay available.");

  if (gestureState.stream) {
    gestureState.stream.getTracks().forEach((track) => track.stop());
    gestureState.stream = null;
  }

  refs.gestureVideo.srcObject = null;
}

function wireEvents() {
  window.addEventListener("resize", resizeRenderer);

  refs.panelToggle.addEventListener("click", () => {
    refs.panel.classList.toggle("panel-collapsed");
    refs.panelToggle.textContent = refs.panel.classList.contains("panel-collapsed")
      ? "Show Panel"
      : "Hide Panel";
  });

  refs.pauseButton.addEventListener("click", () => {
    setPaused(!state.paused);
  });

  refs.resetButton.addEventListener("click", () => {
    simulation.reset();
    setPaused(false);
    trailEntries.forEach((trail) => {
      trail.history = [];
      trail.line.geometry.setFromPoints([]);
    });
  });

  refs.speedButtons.forEach((button) => {
    button.addEventListener("click", () => {
      setSpeed(Number(button.dataset.speed));
    });
  });

  refs.focusSelect.addEventListener("change", (event) => {
    setFocusIndex(Number(event.target.value));
  });

  refs.trailToggle.addEventListener("change", (event) => {
    state.trailsEnabled = event.target.checked;
    refreshTrailVisibility();
  });

  refs.qualitySelect.addEventListener("change", (event) => {
    applyQualityPreset(event.target.value);
  });

  refs.gestureButton.addEventListener("click", async () => {
    if (state.gestureEnabled) {
      disableGestureMode();
      return;
    }

    await enableGestureMode();
  });

  refs.canvas.addEventListener("pointerdown", (event) => {
    pointerDown.set(event.clientX, event.clientY);
  });

  refs.canvas.addEventListener("click", (event) => {
    if (pointerDown.distanceTo(new THREE.Vector2(event.clientX, event.clientY)) > 8) {
      return;
    }

    pickBody(event.clientX, event.clientY);
  });
}

function createSolarSystem() {
  bodyEntries = metadata.map((bodyMeta, index) => createBodyVisual(bodyMeta, index));
  trailEntries = metadata.filter((bodyMeta) => !bodyMeta.is_sun).map((bodyMeta) => createTrail(bodyMeta));
}

async function start() {
  await init();
  simulation = new GravitySimulation();
  metadata = simulation.get_body_metadata();

  if (!Array.isArray(metadata) || metadata.length !== simulation.body_count()) {
    throw new Error("WASM body metadata did not load correctly.");
  }

  createSolarSystem();
  buildFocusOptions();
  applyQualityPreset(activeQuality);
  setSpeed(10);
  setPaused(false);
  setFocusIndex(3);
  wireEvents();

  const clock = new THREE.Clock();

  function frame(now) {
    const delta = Math.min(clock.getDelta(), 0.05);
    const elapsed = clock.elapsedTime;

    simulation.update(delta, state.speed);
    updateBodyPositions(simulation.get_positions());
    updateTrails();
    updateStarfield(elapsed, delta);
    updateCameraFollow();
    updateGestureControls(now);
    controls.update();
    renderer.render(scene, camera);
    updateFps(now);

    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
}

start().catch((error) => {
  console.error(error);
  setGestureStatus("The simulator could not start. Check the console for details.");
});



