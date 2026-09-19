/*
 * visual-webgl.js — the repository drawn as an architectural blueprint.
 *
 * This module intentionally receives the already-derived architecture model.
 * It does not invent analysis: imports, workflows, bays, risk, tests and
 * external packages remain separate drawing layers with separate legends.
 *
 * Sheet convention, top to bottom:
 *   · the entry gantry, a beam carrying a drop into every entry point
 *   · one horizontal plate per dependency tier — L0 on top, one plate down
 *     per import hop — subdivided into labelled source-folder bays
 *   · the plenum between two plates, where import routes are run
 *   · the vendor rail outside the building footprint, holding third parties
 */

// Data palettes are shared with the dashboard chrome (index.html WF_PALETTE /
// VIS_DIR_COLORS) so a workflow color means the same thing on every surface.
const WF_PALETTE = ["#6ea8ff", "#9a6eff", "#3fd68f", "#ffa14d", "#ff5d73", "#c99aff", "#4dd0e1", "#ffd166"];
const DIR_PALETTE = ["#6ea8ff", "#9a6eff", "#4dd0e1", "#3fd68f", "#ffa14d", "#ff7aa8", "#c99aff", "#ffd166", "#61dafb", "#8bd17c"];
const ACCENT = "#6ea8ff", ACCENT2 = "#9a6eff", OK = "#3fd68f";
const INK = "#8fb8e8";        // drafting linework
const PAPER = "#08111f";      // sheet ground
const TEST_LABEL = { "tested-real": "real tests", "tested-nameonly": "name-only test", untested: "untested", unknown: "unknown" };
const TEST_COLOR = { "tested-real": "#3fd68f", "tested-nameonly": "#ffd166", untested: "#ff5d73", unknown: "#8b96b8" };

const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[c]));
const wrapAngle = (angle) => {
  const turn = Math.PI * 2;
  return ((angle + Math.PI) % turn + turn) % turn - Math.PI;
};
const angularDelta = (from, to) => wrapAngle(to - from);
const dirOf = (node) => node.dir && node.dir !== "." ? node.dir : "(root)";
const riskColor = (score) => score >= 70 ? "#ff5d73" : score >= 45 ? "#ffa14d" : score >= 25 ? "#ffd166" : "#3fd68f";
const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

function nodeColor(item, model, mode) {
  if (item.kind === "external") return item.color;
  if (mode === "risk") return riskColor(model.risk[item.idx]);
  if (mode === "tests") return TEST_COLOR[item.nd.test] || TEST_COLOR.unknown;
  if (mode === "folders") {
    const dir = dirOf(item.nd);
    let hash = 0;
    for (let i = 0; i < dir.length; i++) hash = (hash * 31 + dir.charCodeAt(i)) >>> 0;
    return DIR_PALETTE[hash % DIR_PALETTE.length];
  }
  return item.nd.wfs?.length ? WF_PALETTE[item.nd.wfs[0] % WF_PALETTE.length] : "#60719d";
}

/** Flat drafting chip: hairline border, no halo. Reads as annotation, not neon. */
function textSprite(THREE, text, options = {}) {
  const weight = options.font || 600;
  const size = options.size || 26;
  const padX = 14, padY = 9;
  const measure = document.createElement("canvas").getContext("2d");
  measure.font = `${weight} ${size}px ${MONO}`;
  try { measure.letterSpacing = "2px"; } catch { /* older engines */ }
  const width = Math.ceil(measure.measureText(text).width + padX * 2 + 4);
  const height = size + padY * 2;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(64, width * 2);
  canvas.height = height * 2;
  const ctx = canvas.getContext("2d");
  ctx.scale(2, 2);
  try { ctx.letterSpacing = "2px"; } catch { /* older engines */ }
  ctx.fillStyle = options.background || "rgba(7,16,29,.93)";
  ctx.strokeStyle = options.border || "rgba(110,168,255,.7)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.rect(.5, .5, width - 1, height - 1);
  ctx.fill();
  ctx.stroke();
  // Registration notch on the leading edge — a drafting tell, not decoration.
  ctx.fillStyle = options.border || "rgba(110,168,255,.7)";
  ctx.fillRect(.5, .5, 2.5, height - 1);
  ctx.font = `${weight} ${size}px ${MONO}`;
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  ctx.fillStyle = options.color || "#dce8fb";
  ctx.fillText(text, width / 2 + 1, height / 2 + 1);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false });
  const sprite = new THREE.Sprite(material);
  const scale = options.scale || .18;
  sprite.scale.set(width * scale, height * scale, 1);
  sprite.renderOrder = 50;
  sprite.userData.labelTexture = texture;
  sprite.userData.labelText = text;
  return sprite;
}

/**
 * The tier's identification tag: level number, what the level means, module and
 * LOC counts, and a coverage bar. This is the row a CIO actually reads.
 */
function tierTagSprite(THREE, tier, accent) {
  const W = 360, H = 116;
  const canvas = document.createElement("canvas");
  canvas.width = W * 2;
  canvas.height = H * 2;
  const ctx = canvas.getContext("2d");
  ctx.scale(2, 2);
  try { ctx.letterSpacing = "1.5px"; } catch { /* older engines */ }
  ctx.fillStyle = "rgba(7,16,29,.94)";
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = accent;
  ctx.globalAlpha = .75;
  ctx.lineWidth = 1;
  ctx.strokeRect(.5, .5, W - 1, H - 1);
  ctx.globalAlpha = 1;
  ctx.fillStyle = accent;
  ctx.fillRect(0, 0, 6, H);

  ctx.font = `700 44px ${MONO}`;
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = accent;
  ctx.fillText(`L${tier.depth}`, 20, 50);

  ctx.font = `600 17px ${MONO}`;
  ctx.fillStyle = "#e4eefc";
  ctx.fillText(tier.label, 96, 34);
  ctx.font = `500 15px ${MONO}`;
  ctx.fillStyle = "rgba(180,204,238,.82)";
  ctx.fillText(`${tier.count} MODULES · ${tier.loc.toLocaleString()} LOC`, 96, 55);

  // Coverage bar: filled portion is modules with real tests.
  const barX = 20, barY = 74, barW = W - 40, barH = 9;
  const covered = tier.count ? tier.tested / tier.count : 0;
  ctx.fillStyle = "rgba(255,93,115,.30)";
  ctx.fillRect(barX, barY, barW, barH);
  ctx.fillStyle = "#3fd68f";
  ctx.fillRect(barX, barY, barW * covered, barH);
  ctx.strokeStyle = "rgba(160,196,240,.45)";
  ctx.strokeRect(barX + .5, barY + .5, barW - 1, barH - 1);
  ctx.font = `600 13px ${MONO}`;
  ctx.fillStyle = "rgba(180,204,238,.9)";
  ctx.fillText(`${Math.round(covered * 100)}% TESTED`, barX, barY + 27);
  if (tier.highRisk) {
    ctx.fillStyle = "#ff5d73";
    ctx.textAlign = "right";
    ctx.fillText(`${tier.highRisk} HIGH RISK`, W - 20, barY + 27);
    ctx.textAlign = "left";
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false, opacity: .96 }));
  sprite.scale.set(W * .52, H * .52, 1);
  sprite.renderOrder = 48;
  sprite.userData.labelTexture = texture;
  return sprite;
}

/** Keystone / callout card: a headline number with its consequence spelled out. */
function calloutSprite(THREE, headline, title, body, accent) {
  const W = 320, H = 96;
  const canvas = document.createElement("canvas");
  canvas.width = W * 2;
  canvas.height = H * 2;
  const ctx = canvas.getContext("2d");
  ctx.scale(2, 2);
  try { ctx.letterSpacing = "1.2px"; } catch { /* older engines */ }
  ctx.fillStyle = "rgba(9,18,33,.95)";
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = accent;
  ctx.globalAlpha = .85;
  ctx.lineWidth = 1;
  ctx.strokeRect(.5, .5, W - 1, H - 1);
  ctx.globalAlpha = 1;
  ctx.fillStyle = accent;
  ctx.fillRect(0, 0, W, 3);
  ctx.font = `700 13px ${MONO}`;
  ctx.fillStyle = accent;
  ctx.fillText(headline, 16, 28);
  ctx.font = `600 16px ${MONO}`;
  ctx.fillStyle = "#e8f0fd";
  ctx.fillText(title.length > 26 ? title.slice(0, 25) + "…" : title, 16, 54);
  ctx.font = `500 13px ${MONO}`;
  ctx.fillStyle = "rgba(180,204,238,.85)";
  ctx.fillText(body, 16, 76);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false }));
  sprite.scale.set(W * .4, H * .4, 1);
  sprite.renderOrder = 52;
  sprite.userData.labelTexture = texture;
  return sprite;
}

// Final-grade pass: a clean drafting vignette and a whisper of paper tooth.
// No film grain, no chromatic bloom smear — the sheet has to stay legible.
const BlueprintGrade = {
  uniforms: { tDiffuse: { value: null }, uTime: { value: 0 }, uVignette: { value: .78 }, uTooth: { value: .014 } },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform float uTime, uVignette, uTooth;
    varying vec2 vUv;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
    void main() {
      vec4 color = texture2D(tDiffuse, vUv);
      float dist = distance(vUv, vec2(0.5));
      color.rgb *= smoothstep(1.22, 0.30, dist * uVignette);
      // Static paper tooth, tied to the pixel and not to time, so nothing crawls.
      float tooth = hash(floor(vUv * 1400.0)) - 0.5;
      color.rgb += tooth * uTooth;
      gl_FragColor = color;
    }`,
};

/** Start the WebGL world. Returns false only when renderer construction fails. */
export function initVisualWebGL(options) {
  const {
    THREE, arch, model, world, consolePanel, stage, placeholder, hud, tooltip, inspector, legend,
    search, filter, color, routes, jump, topBtn, isoBtn, frontBtn, autoBtn, zoomOutBtn, zoomInBtn, resetBtn, fullBtn, cameraTools,
    dashboardState, onOpenArchitecture, post, lines,
  } = options;

  const canvas = document.createElement("canvas");
  canvas.id = placeholder.id;
  canvas.className = placeholder.className;
  canvas.tabIndex = 0;
  canvas.setAttribute("role", "application");
  canvas.setAttribute("aria-label", placeholder.getAttribute("aria-label") || "Interactive 3D architecture blueprint");
  for (const [key, value] of Object.entries(placeholder.dataset)) canvas.dataset[key] = value;
  canvas.dataset.renderer = "webgl";
  canvas.dataset.semanticGeometry = "true";
  canvas.dataset.layout = "tiered-blueprint";
  canvas.dataset.tierCount = String(world.tiers.length);
  canvas.dataset.bayCount = String(world.bays.length);
  canvas.dataset.entryAnchorCount = String(model.entryIdx.length);
  canvas.dataset.directedParticles = "true";

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: "high-performance" });
  } catch {
    return false;
  }
  placeholder.replaceWith(canvas);
  stage.classList.add("webgl");
  consolePanel.classList.add("webgl-console");
  const liveChip = hud.querySelector(".live");
  if (liveChip) liveChip.textContent = "● SHEET A-01 · RENDERED";

  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.02;

  const sheet = world.sheet, rail = world.rail, tiers = world.tiers;
  // Annotation sprites are sized in world units, so on a large sheet they have
  // to grow with it or they shrink to illegible specks at the overview.
  const noteScale = Math.max(1, Math.min(3.2, (tiers[0].x2 - tiers[0].x1) / 760));
  const TIER_GAP = world.geom.TIER_GAP;
  const topY = world.topY;
  const centerX = (world.bounds.x1 + world.bounds.x2) / 2;
  const centerZ = (world.bounds.z1 + world.bounds.z2) / 2;
  const spanX = world.bounds.x2 - world.bounds.x1;
  const spanZ = world.bounds.z2 - world.bounds.z1;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(PAPER);
  scene.fog = new THREE.Fog(PAPER, Math.max(1400, spanX * 1.1), Math.max(4200, spanX * 3.4));

  // ------------------------------------------------------- drafting lines
  // Plain WebGL lines are locked to one device pixel, which is too faint for
  // plate borders. Line2 gives real stroke weights; without the addon every
  // call below silently degrades to a hairline, which still reads correctly.
  const lineResolution = new THREE.Vector2(1, 1);
  const lineMaterials = [];
  function drawSegments(points, options = {}) {
    const { color: strokeColor = INK, width = 1, opacity = .5, dash = null } = options;
    if (!lines) {
      const material = new (dash ? THREE.LineDashedMaterial : THREE.LineBasicMaterial)({
        color: strokeColor, transparent: true, opacity,
        ...(dash ? { dashSize: dash[0], gapSize: dash[1] } : {}),
      });
      material.userData.baseOpacity = opacity;
      const object = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(points), material);
      if (dash) object.computeLineDistances();
      return object;
    }
    const geometry = new lines.LineSegmentsGeometry();
    const flat = [];
    for (const point of points) flat.push(point.x, point.y, point.z);
    geometry.setPositions(flat);
    const material = new lines.LineMaterial({
      color: new THREE.Color(strokeColor), linewidth: width, transparent: true, opacity,
      dashed: !!dash, dashScale: 1, dashSize: dash ? dash[0] : 6, gapSize: dash ? dash[1] : 5,
    });
    material.resolution.copy(lineResolution);
    material.userData.baseOpacity = opacity;
    lineMaterials.push(material);
    const object = new lines.LineSegments2(geometry, material);
    object.computeLineDistances();
    return object;
  }
  const v3 = (x, y, z) => new THREE.Vector3(x, y, z);
  const rectSegments = (x1, z1, x2, z2, y) => [
    v3(x1, y, z1), v3(x2, y, z1), v3(x2, y, z1), v3(x2, y, z2),
    v3(x2, y, z2), v3(x1, y, z2), v3(x1, y, z2), v3(x1, y, z1),
  ];
  const gridSegments = (x1, z1, x2, z2, y, step) => {
    const out = [];
    for (let x = Math.ceil(x1 / step) * step; x < x2; x += step) out.push(v3(x, y, z1), v3(x, y, z2));
    for (let z = Math.ceil(z1 / step) * step; z < z2; z += step) out.push(v3(x1, y, z), v3(x2, y, z));
    return out;
  };

  // ---------------------------------------------------------------- lights
  // Even, neutral, architectural light. One key for legible massing, a cool
  // fill so the north faces do not go black, and no colored stage lamps.
  scene.add(new THREE.HemisphereLight("#bfd6f5", "#0b1728", 1.25));
  scene.add(new THREE.AmbientLight("#7d95c2", .42));
  const keyLight = new THREE.DirectionalLight("#eaf2ff", 2.1);
  keyLight.position.set(-620, topY + 1150, 720);
  keyLight.castShadow = true;
  keyLight.shadow.mapSize.set(2048, 2048);
  const shadowExtent = Math.max(900, Math.max(spanX, spanZ) * .62);
  keyLight.shadow.camera.left = -shadowExtent;
  keyLight.shadow.camera.right = shadowExtent;
  keyLight.shadow.camera.top = shadowExtent;
  keyLight.shadow.camera.bottom = -shadowExtent;
  keyLight.shadow.camera.near = 10;
  keyLight.shadow.camera.far = topY + 3200;
  keyLight.shadow.bias = -0.0008;
  scene.add(keyLight);
  const fillLight = new THREE.DirectionalLight("#7fa8e0", .55);
  fillLight.position.set(700, topY + 300, -620);
  scene.add(fillLight);

  // ----------------------------------------------------------- the sheet
  // Everything sits on a drawing sheet: paper, survey grid, double border and
  // corner registration marks. This is the frame the model is drafted inside.
  const sheetPad = 78;
  const sheetRect = {
    x1: Math.min(sheet.x1, rail.x1) - sheetPad, x2: Math.max(sheet.x2, rail.x2) + sheetPad,
    z1: sheet.z1 - sheetPad, z2: Math.max(sheet.z2, rail.z2) + sheetPad,
  };
  const paper = new THREE.Mesh(
    new THREE.PlaneGeometry(sheetRect.x2 - sheetRect.x1, sheetRect.z2 - sheetRect.z1),
    new THREE.MeshStandardMaterial({ color: "#0a1729", roughness: .95, metalness: .05 }),
  );
  paper.rotation.x = -Math.PI / 2;
  paper.position.set((sheetRect.x1 + sheetRect.x2) / 2, -14, (sheetRect.z1 + sheetRect.z2) / 2);
  paper.receiveShadow = true;
  scene.add(paper);
  scene.add(drawSegments(gridSegments(sheetRect.x1, sheetRect.z1, sheetRect.x2, sheetRect.z2, -12, 50), { color: "#17314f", width: 1, opacity: .34 }));
  scene.add(drawSegments(gridSegments(sheetRect.x1, sheetRect.z1, sheetRect.x2, sheetRect.z2, -11.5, 250), { color: "#27496f", width: 1.2, opacity: .45 }));
  scene.add(drawSegments(rectSegments(sheetRect.x1, sheetRect.z1, sheetRect.x2, sheetRect.z2, -11), { color: ACCENT, width: 1.8, opacity: .34 }));
  scene.add(drawSegments(rectSegments(sheetRect.x1 + 22, sheetRect.z1 + 22, sheetRect.x2 - 22, sheetRect.z2 - 22, -11), { color: ACCENT, width: 1, opacity: .18 }));
  {
    // Corner registration marks.
    const marks = [];
    const arm = 54;
    for (const [cx, cz, sx, sz] of [
      [sheetRect.x1, sheetRect.z1, 1, 1], [sheetRect.x2, sheetRect.z1, -1, 1],
      [sheetRect.x2, sheetRect.z2, -1, -1], [sheetRect.x1, sheetRect.z2, 1, -1],
    ]) {
      marks.push(v3(cx, -10.5, cz), v3(cx + arm * sx, -10.5, cz));
      marks.push(v3(cx, -10.5, cz), v3(cx, -10.5, cz + arm * sz));
    }
    scene.add(drawSegments(marks, { color: "#9cc4ff", width: 2.2, opacity: .6 }));
  }

  // ------------------------------------------------------------ tier plates
  const tierPlates = [];
  const tierTags = [];
  for (const tier of tiers) {
    const group = new THREE.Group();
    const width = tier.x2 - tier.x1, depth = tier.z2 - tier.z1;
    const accent = tier.detached ? "#ff7aa8" : tier.depth === 0 ? OK : ACCENT;
    // The plate itself: a thin slab, deliberately flat and matte.
    const slab = new THREE.Mesh(
      new THREE.BoxGeometry(width, tier.plate, depth),
      new THREE.MeshStandardMaterial({ color: "#10233e", roughness: .88, metalness: .12, transparent: true, opacity: .93 }),
    );
    slab.position.set((tier.x1 + tier.x2) / 2, tier.y + tier.plate / 2, (tier.z1 + tier.z2) / 2);
    slab.receiveShadow = true;
    slab.castShadow = true;
    group.add(slab);
    // Plate linework: inset survey grid, heavy edge, and a soffit line below.
    group.add(drawSegments(gridSegments(tier.x1, tier.z1, tier.x2, tier.z2, tier.y + tier.plate + .4, 33), { color: "#27507f", width: 1, opacity: .34 }));
    group.add(drawSegments(rectSegments(tier.x1, tier.z1, tier.x2, tier.z2, tier.y + tier.plate + .6), { color: accent, width: 2.2, opacity: .72 }));
    group.add(drawSegments(rectSegments(tier.x1, tier.z1, tier.x2, tier.z2, tier.y - .4), { color: accent, width: 1, opacity: .28 }));
    // Edge-of-plate dimension ticks, every 200 units, on the front edge.
    const ticks = [];
    for (let x = Math.ceil(tier.x1 / 200) * 200; x < tier.x2; x += 200) {
      ticks.push(v3(x, tier.y + tier.plate + .6, tier.z2), v3(x, tier.y + tier.plate + .6, tier.z2 + 14));
    }
    if (ticks.length) group.add(drawSegments(ticks, { color: accent, width: 1.2, opacity: .4 }));

    const tag = tierTagSprite(THREE, tier, accent);
    tag.scale.multiplyScalar(noteScale);
    tag.position.set(tier.x1 - 100 * noteScale, tier.y + 74 * noteScale, tier.z1 + 30);
    group.add(tag);
    tierTags.push(tag);
    // Leader from the tag to the plate corner.
    group.add(drawSegments([
      v3(tier.x1 - 38, tier.y + 44, tier.z1 + 30), v3(tier.x1 - 6, tier.y + 8, tier.z1 + 10),
    ], { color: accent, width: 1.2, opacity: .5 }));

    scene.add(group);
    tierPlates.push({ tier, group, slab, accent });
  }

  // Structural columns tie the plates into one building instead of a stack of
  // unrelated slabs, and they give the eye a vertical scale reference.
  {
    const columns = [];
    const lowest = tiers[tiers.length - 1], highest = tiers[0];
    const cx1 = Math.min(...tiers.map((t) => t.x1)), cx2 = Math.max(...tiers.map((t) => t.x2));
    const cz1 = Math.min(...tiers.map((t) => t.z1)), cz2 = Math.max(...tiers.map((t) => t.z2));
    for (const [x, z] of [[cx1, cz1], [cx2, cz1], [cx2, cz2], [cx1, cz2]]) {
      columns.push(v3(x, lowest.y, z), v3(x, highest.y + highest.plate + 40, z));
    }
    scene.add(drawSegments(columns, { color: "#3f6ea8", width: 1.6, opacity: .45 }));
    // Floor-to-floor dimension ticks up the front-left column.
    const dims = [];
    for (const tier of tiers) dims.push(v3(cx2 + 20, tier.y, cz2), v3(cx2 + 52, tier.y, cz2));
    dims.push(v3(cx2 + 36, lowest.y, cz2), v3(cx2 + 36, highest.y, cz2));
    scene.add(drawSegments(dims, { color: INK, width: 1.4, opacity: .5 }));
    const dimLabel = textSprite(THREE, `${tiers.length} DEPENDENCY TIERS · 1 PLATE = 1 IMPORT HOP`, { size: 21, border: "rgba(143,184,232,.7)", color: "#cfe0f7", scale: .2 * noteScale });
    dimLabel.position.set(cx2 + 190 * noteScale, (lowest.y + highest.y) / 2, cz2 + 20);
    scene.add(dimLabel);
  }

  // -------------------------------------------------------------- bays
  for (const bay of world.bays) {
    const y = bay.y + world.geom.PLATE + .9;
    const fill = new THREE.Mesh(
      new THREE.PlaneGeometry(bay.x2 - bay.x1, bay.z2 - bay.z1),
      new THREE.MeshBasicMaterial({ color: bay.color, transparent: true, opacity: .055, depthWrite: false }),
    );
    fill.rotation.x = -Math.PI / 2;
    fill.position.set(bay.cx, y, bay.cz);
    scene.add(fill);
    scene.add(drawSegments(rectSegments(bay.x1, bay.z1, bay.x2, bay.z2, y + .2), { color: bay.color, width: 1.3, opacity: .48, dash: [9, 7] }));
    // Header rule separating the bay's label strip from its blocks.
    scene.add(drawSegments([
      v3(bay.x1, y + .2, bay.z1 + world.geom.BAY_HEADER), v3(bay.x2, y + .2, bay.z1 + world.geom.BAY_HEADER),
    ], { color: bay.color, width: 1, opacity: .3 }));
    const tag = textSprite(THREE, `${bay.dir.toUpperCase()} · ${bay.count}`, { size: 21, border: bay.color, color: "#dbe7f8", scale: .2 });
    tag.position.set(bay.x1 + (bay.x2 - bay.x1) / 2, bay.y + 26, bay.z1 + 13);
    scene.add(tag);
  }

  // --------------------------------------------------------- module blocks
  const moduleViews = new Map();
  const itemViews = new Map();
  const pickables = [];
  const riskTabs = [];
  const externalViews = [];

  function materialFor(hex) {
    const accent = new THREE.Color(hex);
    // A matte architectural finish: the block is lit by the scene and tinted by
    // its classification, never self-illuminated into a glowing orb.
    return new THREE.MeshStandardMaterial({
      color: accent.clone().lerp(new THREE.Color("#0b1526"), .55),
      emissive: accent,
      emissiveIntensity: .085,
      roughness: .62,
      metalness: .22,
      transparent: true,
      opacity: .96,
      flatShading: false,
    });
  }

  function archetypeOf(nd) {
    const name = `${nd.path} ${nd.lang || ""}`.toLowerCase();
    if (nd.grouped) return "tooling group";
    if (nd.entry) return "entry gateway";
    if (/worker|queue|job|python/.test(name)) return "worker block";
    if (/worklet|audio|voice|pcm|opus|pitch|revoice|stream/.test(name)) return "signal block";
    if (/app|ui|view|page|public|component/.test(name)) return "interface block";
    if (/server|route|api|http|socket/.test(name)) return "service block";
    return "module block";
  }

  for (const item of world.modules) {
    if (!item) continue;
    const baseColor = nodeColor(item, model, dashboardState.visualColor || "workflow");
    const height = item.h;
    const material = materialFor(baseColor);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(item.w, height, item.d), material);
    mesh.position.y = height / 2;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.item = item;

    const group = new THREE.Group();
    group.position.set(item.x, item.y, item.z);
    group.add(mesh);

    // Crisp massing outline — the single most blueprint-like detail there is.
    const outline = new THREE.LineSegments(
      new THREE.EdgesGeometry(mesh.geometry),
      new THREE.LineBasicMaterial({ color: baseColor, transparent: true, opacity: .92 }),
    );
    outline.material.userData.baseOpacity = .92;
    outline.position.copy(mesh.position);
    group.add(outline);

    // Cap plate: test status, read straight down in plan view.
    const testColor = TEST_COLOR[item.nd.test] || TEST_COLOR.unknown;
    const cap = new THREE.Mesh(
      new THREE.PlaneGeometry(item.w * .82, item.d * .2),
      new THREE.MeshBasicMaterial({ color: testColor, transparent: true, opacity: .85, side: THREE.DoubleSide, depthWrite: false }),
    );
    cap.material.userData.baseOpacity = .85;
    cap.rotation.x = -Math.PI / 2;
    cap.position.y = height + .6;
    group.add(cap);

    // Footprint ring on the plate: where the block lands, drawn like a plan.
    const footprint = new THREE.LineSegments(
      new THREE.BufferGeometry().setFromPoints(rectSegments(-item.w / 2 - 3, -item.d / 2 - 3, item.w / 2 + 3, item.d / 2 + 3, .5)),
      new THREE.LineBasicMaterial({ color: baseColor, transparent: true, opacity: .34 }),
    );
    footprint.material.userData.baseOpacity = .34;
    group.add(footprint);

    const markers = [];
    if (item.nd.entry) {
      // Entry mast: a surveyor's pin marking a way in to the system.
      const mast = new THREE.Mesh(
        new THREE.CylinderGeometry(.9, .9, 34, 6),
        new THREE.MeshBasicMaterial({ color: OK, transparent: true, opacity: .9 }),
      );
      mast.material.userData.baseOpacity = .9;
      mast.position.y = height + 17;
      const flag = new THREE.Mesh(
        new THREE.ConeGeometry(5.4, 11, 4),
        new THREE.MeshBasicMaterial({ color: OK, transparent: true, opacity: .95 }),
      );
      flag.material.userData.baseOpacity = .95;
      flag.position.y = height + 38;
      group.add(mast, flag);
      markers.push(mast.material, flag.material);
    }
    if (model.risk[item.idx] >= 70) {
      // Risk tab: a flagged corner, not a throbbing beacon.
      const tab = new THREE.Mesh(
        new THREE.BoxGeometry(item.w * .34, 3.2, item.d * .34),
        new THREE.MeshBasicMaterial({ color: "#ff5d73", transparent: true, opacity: .95 }),
      );
      tab.material.userData.baseOpacity = .95;
      tab.position.set(item.w * .33, height + 2.4, -item.d * .33);
      tab.userData.phase = item.idx * .73;
      group.add(tab);
      riskTabs.push(tab);
      markers.push(tab.material);
    }

    const labelText = item.nd.name.length > 28 ? item.nd.name.slice(0, 27) + "…" : item.nd.name;
    const label = textSprite(THREE, labelText, { border: baseColor, size: 24, scale: .27 });
    label.position.y = height + (item.nd.entry ? 56 : 22);
    label.visible = !!item.nd.entry || model.risk[item.idx] >= 70;
    group.add(label);

    scene.add(group);
    const accentMaterials = [outline.material, footprint.material];
    const view = {
      item, group, mesh, material, outline, cap, footprint, label, height,
      radius: Math.max(item.w, item.d) * .5, archetype: archetypeOf(item.nd), baseColor,
      accentMaterials, fadeMaterials: [material, outline.material, cap.material, footprint.material, ...markers],
      phase: item.idx * .83,
    };
    moduleViews.set(item.idx, view);
    itemViews.set(item, view);
    pickables.push(mesh);
  }

  // --------------------------------------------------- third-party boundary
  {
    const y = rail.y;
    scene.add(drawSegments(rectSegments(rail.x1, rail.z1 - 46, rail.x2, rail.z2, y - 3), { color: ACCENT2, width: 1.3, opacity: .3, dash: [14, 12] }));
    const plate = new THREE.Mesh(
      new THREE.PlaneGeometry(rail.x2 - rail.x1, rail.z2 - rail.z1 + 46),
      new THREE.MeshBasicMaterial({ color: ACCENT2, transparent: true, opacity: .025, depthWrite: false }),
    );
    plate.rotation.x = -Math.PI / 2;
    plate.position.set((rail.x1 + rail.x2) / 2, y - 3.4, (rail.z1 - 46 + rail.z2) / 2);
    scene.add(plate);
    const heading = textSprite(THREE, `THIRD-PARTY BOUNDARY · ${rail.count} PACKAGES`, { size: 23, border: ACCENT2, color: "#e3d9fb", scale: .24 * noteScale });
    heading.position.set((rail.x1 + rail.x2) / 2, y + 40 * noteScale, rail.z1 - 64);
    scene.add(heading);
  }
  for (const item of world.externals) {
    const colorValue = item.color;
    const accent = new THREE.Color(colorValue);
    // Flat, chamfered vendor plates: components on a schedule, not planets.
    const mesh = new THREE.Mesh(
      new THREE.CylinderGeometry(item.w * .46, item.w * .46, item.h, 6),
      new THREE.MeshStandardMaterial({
        color: accent.clone().lerp(new THREE.Color("#0b1526"), .5),
        emissive: colorValue, emissiveIntensity: .12, roughness: .55, metalness: .3,
        transparent: true, opacity: .95,
      }),
    );
    mesh.rotation.y = Math.PI / 6;
    mesh.position.set(item.x, item.y + item.h / 2, item.z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.item = item;
    const outline = new THREE.LineSegments(
      new THREE.EdgesGeometry(mesh.geometry),
      new THREE.LineBasicMaterial({ color: colorValue, transparent: true, opacity: .8 }),
    );
    outline.material.userData.baseOpacity = .8;
    outline.rotation.copy(mesh.rotation);
    outline.position.copy(mesh.position);
    scene.add(mesh, outline);
    const label = textSprite(THREE, `${item.external.pkg} · ${item.external.count}`, { border: colorValue, size: 21, scale: .2 });
    label.position.set(item.x, item.y + item.h + 22, item.z);
    label.visible = item.external.count >= 3;
    scene.add(label);
    const view = {
      item, group: mesh, mesh, material: mesh.material, outline, label,
      height: item.h, baseY: item.y + item.h / 2, baseColor: colorValue, radius: item.w * .5,
      fadeMaterials: [mesh.material, outline.material],
    };
    itemViews.set(item, view);
    pickables.push(mesh);
    externalViews.push(view);
  }

  // ----------------------------------------------------------- entry gantry
  // A beam above the top plate with one drop per entry point. It replaces the
  // old central "star": entry points are a surface, not a gravity well.
  const gantryY = topY + world.geom.PLATE + 118;
  const entryItems = model.entryIdx.map((idx) => world.modules[idx]).filter(Boolean);
  if (entryItems.length) {
    const gx1 = Math.min(...entryItems.map((m) => m.x)) - 60;
    const gx2 = Math.max(...entryItems.map((m) => m.x)) + 60;
    const gz = Math.min(...entryItems.map((m) => m.z));
    const beam = new THREE.Mesh(
      new THREE.BoxGeometry(gx2 - gx1, 5, 7),
      new THREE.MeshStandardMaterial({ color: "#1c3d5e", emissive: OK, emissiveIntensity: .18, roughness: .6, metalness: .35 }),
    );
    beam.position.set((gx1 + gx2) / 2, gantryY, gz - 70);
    beam.castShadow = true;
    scene.add(beam);
    scene.add(drawSegments([v3(gx1, gantryY, gz - 70), v3(gx2, gantryY, gz - 70)], { color: OK, width: 2.2, opacity: .7 }));
    const heading = textSprite(THREE, `ENTRY SURFACE · ${entryItems.length} WAY${entryItems.length === 1 ? "" : "S"} IN`, { size: 23, border: OK, color: "#dcfbea", scale: .24 * noteScale });
    heading.position.set((gx1 + gx2) / 2, gantryY + 38 * noteScale, gz - 70);
    scene.add(heading);
  }

  // ----------------------------------------------------------- routed lines
  const connectionViews = [];
  const particles = [];
  const particleGeometry = new THREE.BoxGeometry(3.4, 1.4, 3.4);

  const anchorFor = (item) => {
    const view = itemViews.get(item);
    if (item.kind === "external") return v3(item.x, item.y + item.h / 2, item.z);
    return v3(item.x, item.y + (view?.height || item.h || 20) * .5, item.z);
  };

  /**
   * Routes are drafted, not flung: they leave a block vertically, run level
   * through a service corridor, turn once in plan, then rise into the target.
   * The corners are eased just enough to read as conduit rather than as a
   * polyline, and the corridor elevation is what separates the drawing layers.
   */
  function routeCurve(from, to, corridorY) {
    const points = [
      from,
      v3(from.x, corridorY, from.z),
      v3(to.x, corridorY, from.z),
      v3(to.x, corridorY, to.z),
      to,
    ];
    // Drop duplicate stops so a straight vertical drop stays perfectly straight.
    const cleaned = points.filter((point, i) => i === 0 || point.distanceTo(points[i - 1]) > 1.5);
    if (cleaned.length < 2) cleaned.push(to.clone().add(v3(0, -1, 0)));
    const curve = new THREE.CatmullRomCurve3(cleaned, false, "catmullrom", .04);
    return curve;
  }

  function corridorFor(edge, from, to) {
    if (edge.kind === "entry") return gantryY;
    if (edge.kind === "workflow") return Math.max(from.y, to.y) + 74 + (edge.wi % 3) * 16;
    if (edge.kind === "external") return rail.y - 34;
    // Imports run in the plenum between the two plates they connect.
    return Math.abs(from.y - to.y) > 8 ? (from.y + to.y) / 2 : Math.min(from.y, to.y) - TIER_GAP * .3;
  }

  function addConnection(edge) {
    const start = edge.kind === "entry" ? v3(edge.b.x, gantryY, edge.b.z - 70) : anchorFor(edge.a);
    const end = edge.kind === "entry" ? anchorFor(edge.b) : anchorFor(edge.b);
    const corridorY = corridorFor(edge, start, end);
    const curve = edge.kind === "entry"
      ? new THREE.CatmullRomCurve3([start, v3(edge.b.x, gantryY - 30, edge.b.z - 70), v3(edge.b.x, (gantryY + end.y) / 2, edge.b.z), end], false, "catmullrom", .04)
      : routeCurve(start, end, corridorY);

    let object, material, colorValue, opacity, glowObject = null, glowMaterial = null;
    if (edge.kind === "entry") {
      colorValue = OK;
      opacity = .62;
      material = new THREE.MeshBasicMaterial({ color: colorValue, transparent: true, opacity });
      object = new THREE.Mesh(new THREE.TubeGeometry(curve, 40, .9, 5, false), material);
    } else if (edge.kind === "import") {
      colorValue = nodeColor(edge.a, model, dashboardState.visualColor || "workflow");
      opacity = .62;
      // Route weight encodes real coupling: the more modules depend on the
      // target, the heavier the run carrying traffic into it.
      const fanIn = model.dependents?.[edge.bi]?.size || 0;
      const weight = Math.min(5, Math.log2(1 + fanIn));
      const tubeRadius = .85 + weight * .34;
      material = new THREE.MeshBasicMaterial({ color: colorValue, transparent: true, opacity });
      object = new THREE.Mesh(new THREE.TubeGeometry(curve, 56, tubeRadius, 6, false), material);
      edge.weight = weight;
    } else if (edge.kind === "workflow") {
      colorValue = WF_PALETTE[edge.wi % WF_PALETTE.length];
      opacity = .5;
      material = new THREE.LineDashedMaterial({ color: colorValue, transparent: true, opacity, dashSize: 14, gapSize: 9 });
      object = new THREE.Line(new THREE.BufferGeometry().setFromPoints(curve.getPoints(64)), material);
      object.computeLineDistances();
    } else {
      colorValue = ACCENT2;
      opacity = .11;
      material = new THREE.LineDashedMaterial({ color: colorValue, transparent: true, opacity, dashSize: 4, gapSize: 11 });
      object = new THREE.Line(new THREE.BufferGeometry().setFromPoints(curve.getPoints(48)), material);
      object.computeLineDistances();
    }
    object.renderOrder = edge.kind === "external" ? 1 : 2;
    scene.add(object);
    const rec = {
      edge, object, material, glowObject, glowMaterial, curve, baseColor: colorValue, baseOpacity: opacity,
      speed: 1 + (edge.weight || 0) * .14 + ((edge.ai || 0) * 7 + (edge.bi || 0) * 13) % 5 * .04,
    };
    connectionViews.push(rec);
    if (edge.kind === "entry" || edge.kind === "import" || edge.kind === "workflow") {
      const particleCount = edge.kind === "import" ? ((edge.weight || 0) >= 3 ? 2 : 1) : 1;
      const edgePhase = Math.abs(((edge.ai || 0) * .119 + (edge.bi || 0) * .071 + (edge.wi || 0) * .037) % 1);
      for (let particleIndex = 0; particleIndex < particleCount; particleIndex++) {
        const particleMaterial = new THREE.MeshBasicMaterial({ color: colorValue, transparent: true, opacity: .9, depthWrite: false });
        const particle = new THREE.Mesh(particleGeometry, particleMaterial);
        particle.userData.phase = (edgePhase + particleIndex / particleCount) % 1;
        particle.userData.connection = rec;
        scene.add(particle);
        particles.push(particle);
      }
    }
  }
  model.entryIdx.map((idx) => ({ a: null, b: world.modules[idx], kind: "entry", bi: idx }))
    .filter((edge) => edge.b)
    .forEach(addConnection);
  world.workflowEdges.forEach(addConnection);
  world.importEdges.forEach(addConnection);
  world.extEdges.forEach(addConnection);

  // ------------------------------------------------------ keystone callouts
  // The three modules whose failure moves the most of the codebase. A CIO
  // reading this sheet should not have to hunt for them.
  const keystoneViews = [];
  {
    const ranked = world.modules.filter(Boolean)
      .filter((item) => model.blast[item.idx] > 0)
      .sort((a, b) => model.blast[b.idx] - model.blast[a.idx])
      .slice(0, 3);
    // Cards hang above the back edge of the sheet on annotation leaders, so
    // they never sit on top of the plates they are describing.
    const bandY = topY + world.geom.PLATE + 168 * noteScale;
    const bandZ = tiers[0].z1 - 200 * noteScale;
    const bandX = tiers[0].x1, bandSpan = tiers[0].x2 - tiers[0].x1;
    ranked.forEach((item, rank) => {
      const view = moduleViews.get(item.idx);
      const share = model.n ? Math.round((model.blast[item.idx] / model.n) * 100) : 0;
      const accent = rank === 0 ? "#ffa14d" : "#ffd166";
      const cardX = bandX + bandSpan * ((rank + .5) / ranked.length);
      const cardY = bandY - rank * 58 * noteScale;
      const card = calloutSprite(
        THREE,
        `KEYSTONE ${rank + 1} · BLAST RADIUS ${model.blast[item.idx]}`,
        item.nd.name,
        `${share}% of mapped modules · risk ${model.risk[item.idx]}`,
        accent,
      );
      card.scale.multiplyScalar(noteScale);
      card.position.set(cardX, cardY, bandZ);
      scene.add(card);
      const blockTop = v3(item.x, item.y + view.height + 8, item.z);
      const elbow = v3(cardX, cardY - 26, bandZ);
      const leader = drawSegments([
        blockTop, v3(item.x, cardY - 26, item.z), v3(item.x, cardY - 26, item.z), elbow,
      ], { color: accent, width: 1.3, opacity: .5 });
      scene.add(leader);
      keystoneViews.push({ item, card, leader });
    });
  }

  // ------------------------------------------------------- dimension string
  {
    const y = -9;
    const z = sheetRect.z2 - 74;
    const dims = [v3(sheet.x1, y, z), v3(sheet.x2, y, z)];
    for (const x of [sheet.x1, sheet.x2]) dims.push(v3(x, y, z - 13), v3(x, y, z + 13));
    scene.add(drawSegments(dims, { color: INK, width: 1.4, opacity: .55 }));
    const totalLoc = model.nodes.reduce((sum, nd) => sum + (nd.loc || 0), 0);
    const caption = textSprite(THREE, `SOURCE FOOTPRINT · ${model.n} MODULES · ${totalLoc.toLocaleString()} LOC · ${model.uniqEdges.length} IMPORT ROUTES`, {
      size: 22, border: "rgba(143,184,232,.65)", color: "#cfe0f7", scale: .21 * noteScale,
    });
    caption.position.set((sheet.x1 + sheet.x2) / 2, y + 28 * noteScale, z + 34 * noteScale);
    scene.add(caption);
  }

  // ----------------------------------------------------------- title block
  // Bottom-right corner of the sheet, the way a real drawing is signed off.
  const titleBlock = document.createElement("div");
  titleBlock.className = "visual-titleblock";
  const repoName = String(arch.repo || "repository").split("/").filter(Boolean).pop() || "repository";
  const untestedCount = model.nodes.filter((nd) => nd.test !== "tested-real").length;
  const coverage = model.n ? Math.round(((model.n - untestedCount) / model.n) * 100) : 0;
  const cycles = (model.sccs || []).length;
  titleBlock.innerHTML =
    `<div class="tb-head"><b>${esc(repoName)}</b><span>ARCHITECTURE SHEET A-01</span></div>` +
    `<div class="tb-grid">` +
    `<div><span>TIERS</span><b>${tiers.length}</b></div>` +
    `<div><span>MODULES</span><b>${model.n}</b></div>` +
    `<div><span>ROUTES</span><b>${model.uniqEdges.length}</b></div>` +
    `<div><span>BAYS</span><b>${world.bays.length}</b></div>` +
    `<div><span>VENDORS</span><b>${model.externals.length}</b></div>` +
    `<div class="${coverage >= 60 ? "" : "warn"}"><span>TESTED</span><b>${coverage}%</b></div>` +
    `<div class="${cycles ? "bad" : ""}"><span>CYCLES</span><b>${cycles}</b></div>` +
    `<div class="${model.risk.filter((x) => x >= 70).length ? "bad" : ""}"><span>RISK 70+</span><b>${model.risk.filter((x) => x >= 70).length}</b></div>` +
    `</div>` +
    `<div class="tb-foot"><span>DRAWN FROM STATIC CODE MAP</span><span>REV ${new Date().toISOString().slice(0, 10)}</span></div>`;
  stage.appendChild(titleBlock);

  // ---------------------------------------------------------- focus marker
  // Four corner brackets, the way a CAD selection reads.
  const focusMarker = new THREE.Group();
  {
    const arm = .34, half = .5;
    const points = [];
    for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const cx = half * sx, cz = half * sz;
      points.push(v3(cx, 0, cz), v3(cx - arm * sx, 0, cz));
      points.push(v3(cx, 0, cz), v3(cx, 0, cz - arm * sz));
    }
    const brackets = new THREE.LineSegments(
      new THREE.BufferGeometry().setFromPoints(points),
      new THREE.LineBasicMaterial({ color: "#ffffff", transparent: true, opacity: .95, depthTest: false }),
    );
    brackets.renderOrder = 40;
    focusMarker.add(brackets);
  }
  focusMarker.visible = false;
  scene.add(focusMarker);

  // --------------------------------------------------------------- camera
  const FOV = 34;
  // Frame the bounding sphere of everything that is actually drawn — vendor
  // rail at the bottom, keystone annotation band at the top — so the opening
  // view is the whole sheet and never a cropped corner of it.
  const drawnLow = Math.min(-40, rail.y - 60);
  const drawnHigh = topY + world.geom.PLATE + 200 * noteScale;
  const stackHeight = drawnHigh - drawnLow;
  // True bounding-sphere radius of the drawn box: the sheet has to stay framed
  // at every orbit angle, and X and Z combine once the camera rotates.
  const boundingRadius = .5 * Math.hypot(spanX, spanZ, stackHeight);
  const overviewRadius = Math.max(860, boundingRadius / Math.sin(FOV * Math.PI / 360) * .80);
  const eyeY = (drawnLow + drawnHigh) / 2;
  const target = new THREE.Vector3(centerX, eyeY, centerZ);
  const targetGoal = target.clone();

  const perspective = new THREE.PerspectiveCamera(FOV, 1, 1, 24000);
  const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, -6000, 12000);
  let orthographic = false;
  let camera = perspective;

  let yaw = -.72, pitch = .46, radius = overviewRadius;
  let yawGoal = yaw, pitchGoal = pitch, radiusGoal = radius;
  let yawVelocity = 0, pitchVelocity = 0;
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let autoOrbit = !reduced;
  autoBtn.classList.toggle("on", autoOrbit);
  autoBtn.setAttribute("aria-pressed", String(autoOrbit));

  function placeCamera() {
    const cp = Math.cos(pitch);
    const position = new THREE.Vector3(
      target.x + radius * cp * Math.sin(yaw),
      target.y + radius * Math.sin(pitch),
      target.z + radius * cp * Math.cos(yaw),
    );
    camera.position.copy(position);
    if (orthographic) {
      // Frustum height tracks the orbit radius so zoom means the same thing in
      // both projections and PLAN / ELEV read as true scaled drawings.
      const halfHeight = radius * .46;
      const halfWidth = halfHeight * (camera.aspect || 1);
      camera.left = -halfWidth;
      camera.right = halfWidth;
      camera.top = halfHeight;
      camera.bottom = -halfHeight;
      camera.updateProjectionMatrix();
    }
    camera.lookAt(target);
  }

  function setProjection(next) {
    if (orthographic === next) return;
    orthographic = next;
    camera = orthographic ? ortho : perspective;
    camera.aspect = width / Math.max(1, height);
    if (!orthographic) camera.updateProjectionMatrix();
    if (renderPass) renderPass.camera = camera;
    projBtn.classList.toggle("on", orthographic);
    projBtn.setAttribute("aria-pressed", String(orthographic));
    projBtn.textContent = orthographic ? "ORTHO" : "PERSP";
    canvas.dataset.projection = orthographic ? "orthographic" : "perspective";
    placeCamera();
  }

  // ----------------------------------------------------------- HUD helpers
  function setLegend() {
    const mode = dashboardState.visualColor || "workflow";
    if (mode === "risk") legend.innerHTML = `<b>BLOCK COLOR = RISK</b><span><i style="background:#ff5d73;color:#ff5d73"></i>70–100</span><span><i style="background:#ffa14d;color:#ffa14d"></i>45–69</span><span><i style="background:#ffd166;color:#ffd166"></i>25–44</span><span><i style="background:#3fd68f;color:#3fd68f"></i>0–24</span>`;
    else if (mode === "tests") legend.innerHTML = `<b>BLOCK COLOR = TEST COVERAGE</b><span><i style="background:#3fd68f;color:#3fd68f"></i>real tests</span><span><i style="background:#ffd166;color:#ffd166"></i>name-only / unknown</span><span><i style="background:#ff5d73;color:#ff5d73"></i>untested</span>`;
    else if (mode === "folders") legend.innerHTML = `<b>BLOCK COLOR = SOURCE BAY</b>${world.zones.slice(0, 8).map((z) => `<span><i style="background:${z.color};color:${z.color}"></i>${esc(z.dir)} · ${z.count}</span>`).join("")}`;
    else legend.innerHTML = `<b>BLOCK COLOR = WORKFLOW</b>${(arch.workflows || []).slice(0, 7).map((w, i) => `<span><i style="background:${WF_PALETTE[i % WF_PALETTE.length]};color:${WF_PALETTE[i % WF_PALETTE.length]}"></i>${esc(String(w.id))}</span>`).join("")}<span><i style="background:#60719d;color:#60719d"></i>shared / detached</span>`;
  }
  setLegend();

  // ----------------------------------------------------------- inspector UI
  let selected = null;
  let hovered = null;
  let touring = false;
  let tourAt = 0;
  let tourIndex = 0;
  const tourItems = [];
  const pushTour = (item) => { if (item && !tourItems.includes(item)) tourItems.push(item); };
  model.entryIdx.forEach((i) => pushTour(world.modules[i]));
  [...world.modules].filter(Boolean).sort((a, b) => model.blast[b.idx] - model.blast[a.idx]).slice(0, 3).forEach(pushTour);
  [...world.modules].filter(Boolean).sort((a, b) => model.risk[b.idx] - model.risk[a.idx]).slice(0, 4).forEach(pushTour);

  function defaultItem() {
    const idx = model.risk.reduce((best, score, i) => score > model.risk[best] ? i : best, 0);
    return world.modules[idx];
  }

  function riskBadge(score) {
    const badgeColor = riskColor(score);
    return `<span class="risk-badge" style="color:${badgeColor};border-color:${badgeColor}99">risk ${score}</span>`;
  }

  function renderInspector(item, preview = false, defaulted = false) {
    item ||= defaultItem();
    if (item.kind === "external") {
      const ex = item.external;
      inspector.innerHTML = `<div class="eyebrow">${preview ? "Hover preview" : "Pinned vendor component"}</div><h3>${esc(ex.pkg)}</h3>` +
        `<div class="brief">A ${ex.builtin ? "Node.js built-in" : "third-party package"} on the vendor rail, outside the building footprint. Its dotted ties terminate at every mapped module that imports it.</div>` +
        `<div class="visual-kpis"><div class="visual-kpi"><b>${ex.count}</b><span>importing modules</span></div><div class="visual-kpi"><b>${ex.builtin ? "core" : "npm"}</b><span>dependency type</span></div></div>` +
        `<div class="visual-section"><h4>Imported by</h4><div class="visual-file-list">${(ex.files || []).map((p) => `<button data-path="${esc(p)}">${esc(p)}</button>`).join("")}</div></div>`;
    } else {
      const nd = item.nd, i = item.idx;
      const directDeps = model.out[i].map((j) => model.nodes[j]);
      const directUp = model.inn[i].map((j) => model.nodes[j]);
      const flows = (nd.wfs || []).map((wi) => ({ wi, flow: arch.workflows?.[wi] })).filter((x) => x.flow);
      const view = moduleViews.get(i);
      const eyebrow = touring ? "Guided sheet walkthrough" : defaulted ? "Start here · highest risk" : preview ? "Hover preview" : "Focused module";
      const share = model.n ? Math.round((model.blast[i] / model.n) * 100) : 0;
      inspector.innerHTML = `<div class="eyebrow">${eyebrow} · TIER L${model.depth[i]} · BAY ${esc(dirOf(nd).toUpperCase())}</div><h3>${esc(nd.path)}</h3>` +
        `<div>${riskBadge(model.risk[i])} <span class="tag" style="color:${TEST_COLOR[nd.test] || TEST_COLOR.unknown}">${nd.test === "tested-real" ? "✓" : "◌"} ${esc(TEST_LABEL[nd.test] || nd.test || "unknown")}</span> <span class="tag">${esc(view?.archetype || "module block")}</span>${nd.entry ? ` <span class="tag">⚡ ${esc(nd.entry)}</span>` : ""}</div>` +
        `<div class="brief">${nd.entry ? "An entry gateway on the top plate — traffic reaches the system through here." : `Sits ${model.depth[i]} import hop${model.depth[i] === 1 ? "" : "s"} below the entry surface.`} ${model.blast[i] ? `Changing it can move ${model.blast[i]} module${model.blast[i] === 1 ? "" : "s"} — ${share}% of the mapped codebase.` : "No other mapped module depends on it transitively."}</div>` +
        `<div class="visual-kpis"><div class="visual-kpi"><b>${(nd.loc || 0).toLocaleString()}</b><span>lines of code</span></div><div class="visual-kpi"><b>${(nd.fns || []).length}</b><span>indexed functions</span></div><div class="visual-kpi"><b>${model.outDeg[i]}</b><span>direct imports</span></div><div class="visual-kpi"><b>${model.blast[i]}</b><span>blast radius</span></div></div>` +
        (flows.length ? `<div class="visual-section"><h4>Connected workflows</h4><div class="visual-file-list">${flows.map(({ wi, flow }) => `<span style="border-color:${WF_PALETTE[wi % WF_PALETTE.length]};color:#dce6ff">⚙ ${esc(String(flow.id))}</span>`).join("")}</div></div>` : "") +
        `<div class="visual-section"><h4>Imports →</h4><div class="visual-file-list">${directDeps.length ? directDeps.slice(0, 12).map((x) => `<button data-path="${esc(x.path)}">${esc(x.name)}</button>`).join("") : `<span>leaf module</span>`}</div></div>` +
        `<div class="visual-section"><h4>← Imported by</h4><div class="visual-file-list">${directUp.length ? directUp.slice(0, 12).map((x) => `<button data-path="${esc(x.path)}">${esc(x.name)}</button>`).join("") : `<span>root / entry surface</span>`}</div></div>` +
        ((nd.fns || []).length ? `<div class="visual-section"><h4>Largest functions</h4><div class="visual-file-list">${nd.fns.slice(0, 8).map((f) => `<span>${esc(f.name || "anonymous")} · ${f.loc || 0} loc${f.exported ? " · export" : ""}</span>`).join("")}</div></div>` : "") +
        `<div class="visual-section"><button class="visual-icon-btn" id="visual-fly-selected">FLY TO BLOCK</button> <button class="visual-icon-btn" id="visual-open-architecture">OPEN ARCHITECTURE →</button></div>`;
      inspector.querySelector("#visual-fly-selected")?.addEventListener("click", () => flyTo(item, true));
      inspector.querySelector("#visual-open-architecture")?.addEventListener("click", () => onOpenArchitecture(nd.path));
    }
    inspector.querySelectorAll("button[data-path]").forEach((button) => button.addEventListener("click", () => {
      const next = world.pathItem.get(button.dataset.path);
      if (next) selectItem(next, true);
    }));
  }

  function relatedStrength(item) {
    // Hover alone (no selection) applies the same neighborhood logic, more gently.
    const focus = selected?.kind === "module" ? selected : !selected && hovered?.kind === "module" ? hovered : null;
    if (!focus) return selected === item ? 1 : selected ? .16 : 1;
    if (item.kind === "external") {
      if ((item.external.files || []).includes(focus.nd.path)) return .96;
      const dependencyPaths = new Set([...model.deps[focus.idx]].map((idx) => model.nodes[idx]?.path));
      return (item.external.files || []).some((path) => dependencyPaths.has(path)) ? .56 : .12;
    }
    if (item === focus) return 1;
    if (model.deps[focus.idx].has(item.idx) || model.dependents[focus.idx].has(item.idx)) return .96;
    if ((item.nd.wfs || []).some((wf) => (focus.nd.wfs || []).includes(wf))) return .62;
    if (dirOf(item.nd) === dirOf(focus.nd)) return .42;
    return .14;
  }

  function filterAllows(item) {
    if (item.kind === "external") return (item.external.files || []).some((p) => {
      const module = world.pathItem.get(p);
      return module && filterAllows(module);
    });
    const mode = dashboardState.visualFilter || "all";
    if (mode === "runtime" && !model.reachable.has(item.idx)) return false;
    if (mode === "untested" && item.nd.test === "tested-real") return false;
    if (mode === "risk" && model.risk[item.idx] < 70) return false;
    return true;
  }

  function routeAllows(edge) {
    const mode = dashboardState.visualRoutes || "all";
    if (mode === "none") return false;
    if (mode === "imports") return edge.kind === "entry" || edge.kind === "import";
    if (mode === "runtime") return edge.kind === "entry" || edge.kind === "import" || edge.kind === "workflow";
    if (mode === "exact") return edge.kind === "entry" || edge.kind === "import" || edge.kind === "external";
    return true;
  }

  function applyVisualState() {
    const query = search.value.trim().toLowerCase();
    for (const [item, view] of itemViews) {
      const allowed = filterAllows(item);
      view.group.visible = allowed;
      if (view.outline && item.kind === "external") view.outline.visible = allowed;
      if (!allowed) { view.label.visible = false; continue; }
      const text = item.kind === "module" ? `${item.nd.path} ${item.nd.lang || ""}` : item.external.pkg;
      const match = !query || text.toLowerCase().includes(query);
      const strength = Math.min(match ? 1 : .1, relatedStrength(item));
      for (const material of view.fadeMaterials) {
        const baseOpacity = material.userData.baseOpacity ?? 1;
        material.transparent = baseOpacity < 1 || strength < .99;
        material.opacity = Math.max(.03, strength * baseOpacity);
        material.depthWrite = baseOpacity >= 1 && strength > .35;
      }
      if (item.kind === "module") {
        const base = new THREE.Color(view.baseColor);
        let glow = base;
        if (selected?.kind === "module" && model.dependents[selected.idx].has(item.idx)) glow = new THREE.Color("#ffa14d");
        else if (selected?.kind === "module" && model.deps[selected.idx].has(item.idx)) glow = new THREE.Color("#3fd68f");
        view.material.emissive.copy(glow);
        view.accentMaterials.forEach((material) => material.color?.copy(glow));
        view.material.emissiveIntensity = item === selected ? .55 : strength > .8 ? .2 : .06;
        const directlyRelated = selected?.kind === "module" && (
          model.out[selected.idx].includes(item.idx) || model.inn[selected.idx].includes(item.idx)
        );
        view.label.visible = item === selected || item === hovered || directlyRelated || (!selected && (!!item.nd.entry || model.risk[item.idx] >= 70));
      } else {
        view.label.visible = item === selected || item === hovered || (!selected && item.external.count >= 3);
      }
      const scale = item === selected ? 1.12 : item === hovered ? 1.05 : 1;
      view.group.scale.setScalar(scale);
      if (item.kind === "external" && view.outline) view.outline.scale.setScalar(scale);
    }

    for (const rec of connectionViews) {
      const { edge, material } = rec;
      const visible = routeAllows(edge) && (!edge.a || filterAllows(edge.a)) && filterAllows(edge.b);
      rec.object.visible = visible;
      if (!visible) continue;
      let opacity = rec.baseOpacity;
      let colorValue = rec.baseColor;
      if (selected?.kind === "module") {
        if (edge.kind === "entry") {
          opacity = edge.b === selected ? .96 : .05;
        } else if (edge.kind === "import") {
          const up = model.dependents[selected.idx], down = model.deps[selected.idx];
          const upstream = (up.has(edge.ai) || edge.ai === selected.idx) && (up.has(edge.bi) || edge.bi === selected.idx);
          const downstream = (down.has(edge.ai) || edge.ai === selected.idx) && (down.has(edge.bi) || edge.bi === selected.idx);
          opacity = upstream || downstream ? 1 : .04;
          colorValue = upstream ? "#ffa14d" : downstream ? "#3fd68f" : rec.baseColor;
        } else if (edge.kind === "workflow") {
          opacity = (selected.nd.wfs || []).includes(edge.wi) ? .88 : .03;
        } else {
          opacity = edge.a === selected || model.deps[selected.idx].has(edge.a.idx) ? .6 : .025;
        }
      } else if (hovered?.kind === "module") {
        // No selection: softly sink unrelated routes so the hovered module's
        // immediate system pops without the full focus treatment.
        const touch = edge.a === hovered || edge.b === hovered || edge.ai === hovered.idx || edge.bi === hovered.idx;
        opacity = touch ? Math.max(opacity, .92) : opacity * .3;
      }
      material.opacity = opacity;
      material.color.set(colorValue);
    }
    for (const particle of particles) {
      particle.visible = particle.userData.connection.object.visible && particle.userData.connection.material.opacity > .14;
      particle.material.opacity = Math.min(1, particle.userData.connection.material.opacity * 1.3);
      particle.material.transparent = particle.material.opacity < .99;
    }
    for (const keystone of keystoneViews) {
      const show = !selected || selected === keystone.item;
      keystone.card.visible = show;
      keystone.leader.visible = show;
    }
  }

  function flyTo(item, close = false) {
    const view = itemViews.get(item);
    if (!view) return;
    targetGoal.set(item.x, (item.y || 0) + (view.height || 24) * .5, item.z);
    radiusGoal = close ? 230 : 420;
  }

  function selectItem(item, fly = true) {
    selected = selected === item ? null : item;
    if (selected) {
      const view = itemViews.get(selected);
      const span = Math.max(selected.w || 30, selected.d || 30) + 22;
      focusMarker.visible = true;
      focusMarker.position.set(selected.x, (selected.y || 0) + .9, selected.z);
      focusMarker.scale.set(span, 1, span);
      renderInspector(selected, false, false);
      if (fly) flyTo(selected, false);
      canvas.setAttribute("aria-label", selected.kind === "module"
        ? `Focused ${selected.nd.path} on tier L${model.depth[selected.idx]}. Risk ${model.risk[selected.idx]} of 100, ${selected.nd.loc || 0} lines, blast radius ${model.blast[selected.idx]}.`
        : `Focused vendor package ${selected.external.pkg}, imported by ${selected.external.count} modules.`);
    } else {
      focusMarker.visible = false;
      renderInspector(hovered, !!hovered, !hovered);
    }
    applyVisualState();
  }

  renderInspector(null, true, true);
  applyVisualState();

  // Billboard labels are resolved in screen space every frame, highest-value
  // first. This keeps dense bays readable while the camera moves.
  function resolveLabels() {
    const candidates = [];
    for (const [item, view] of itemViews) {
      if (!view.group.visible) { view.label.visible = false; continue; }
      const directlyRelated = selected?.kind === "module" && item.kind === "module" && (
        model.out[selected.idx].includes(item.idx) || model.inn[selected.idx].includes(item.idx)
      );
      const show = item === selected || item === hovered || directlyRelated
        || (!selected && item.kind === "module" && (!!item.nd.entry || model.risk[item.idx] >= 70))
        || (!selected && item.kind === "external" && item.external.count >= 3);
      if (!show) { view.label.visible = false; continue; }
      const priority = item === selected ? 1000 : item === hovered ? 900 : item.kind === "module" ? model.risk[item.idx] + (item.nd.entry ? 120 : 0) : 10;
      candidates.push({ item, view, priority, strong: item === selected || item === hovered });
    }
    candidates.sort((a, b) => b.priority - a.priority);
    const boxes = [];
    const worldPos = new THREE.Vector3();
    for (const candidate of candidates) {
      candidate.view.label.getWorldPosition(worldPos);
      // Labels far from the camera dissolve, keeping the foreground readable.
      const distance = worldPos.distanceTo(camera.position);
      const depthFade = orthographic ? 1 : Math.max(.24, Math.min(1, 1.6 - distance / 2800));
      const position = worldPos.clone().project(camera);
      const x = (position.x * .5 + .5) * width;
      const y = (-position.y * .5 + .5) * height;
      const labelText = candidate.view.label.userData.labelText || "module";
      const w = Math.max(76, Math.min(190, labelText.length * 7.2 + 22));
      const box = { x1: x - w / 2, x2: x + w / 2, y1: y - 12, y2: y + 12 };
      const offscreen = position.z < -1 || position.z > 1 || box.x2 < 8 || box.x1 > width - 8 || box.y2 < 42 || box.y1 > height - 8;
      const collision = boxes.some((other) => box.x1 < other.x2 + 5 && box.x2 > other.x1 - 5 && box.y1 < other.y2 + 4 && box.y2 > other.y1 - 4);
      candidate.view.label.visible = !offscreen && (!collision || candidate.strong);
      candidate.view.label.material.opacity = depthFade * (candidate.strong ? 1 : .84);
      if (candidate.view.label.visible) boxes.push(box);
    }
  }

  // --------------------------------------------------------- sheet controls
  const flyBtn = document.createElement("button");
  flyBtn.className = "visual-icon-btn";
  flyBtn.textContent = "FLY TO";
  flyBtn.title = "Fly the camera to the selected block";
  const tourBtn = document.createElement("button");
  tourBtn.className = "visual-icon-btn";
  tourBtn.textContent = "TOUR";
  tourBtn.title = "Guided walkthrough: entry points, keystones and risk hotspots";
  tourBtn.setAttribute("aria-pressed", "false");
  const projBtn = document.createElement("button");
  projBtn.className = "visual-icon-btn";
  projBtn.textContent = "PERSP";
  projBtn.title = "Switch between perspective and true orthographic projection";
  projBtn.setAttribute("aria-label", "Toggle orthographic projection");
  projBtn.setAttribute("aria-pressed", "false");
  cameraTools.insertBefore(flyBtn, autoBtn);
  cameraTools.insertBefore(tourBtn, autoBtn);
  cameraTools.insertBefore(projBtn, autoBtn);

  function stopTour() {
    touring = false;
    tourBtn.classList.remove("on");
    tourBtn.setAttribute("aria-pressed", "false");
  }
  function stopAuto() {
    autoOrbit = false;
    autoBtn.classList.remove("on");
    autoBtn.setAttribute("aria-pressed", "false");
  }
  function stepTour(now) {
    if (!tourItems.length) return;
    const item = tourItems[tourIndex++ % tourItems.length];
    selected = null;
    selectItem(item, true);
    tourAt = now + 4800;
  }
  flyBtn.addEventListener("click", () => flyTo(selected || defaultItem(), true));
  tourBtn.addEventListener("click", () => {
    touring = !touring;
    tourBtn.classList.toggle("on", touring);
    tourBtn.setAttribute("aria-pressed", String(touring));
    if (touring) { stopAuto(); tourAt = 0; }
  });
  projBtn.addEventListener("click", () => { setProjection(!orthographic); canvas.focus(); });

  function preset(name) {
    stopTour(); stopAuto();
    if (name === "plan") {
      // A true plan: straight down, orthographic, framing the whole sheet.
      setProjection(true);
      targetGoal.set(centerX, 0, centerZ);
      radiusGoal = Math.max(spanX, spanZ) * 1.22;
      yawGoal = 0; pitchGoal = Math.PI / 2 - .002;
    } else if (name === "elevation") {
      // Elevation: every dependency tier edge-on, stacked like floors.
      setProjection(true);
      targetGoal.set(centerX, eyeY, centerZ);
      radiusGoal = Math.max(spanX * 1.12, stackHeight * 1.25);
      yawGoal = 0; pitchGoal = .012;
    } else {
      setProjection(false);
      targetGoal.set(centerX, eyeY, centerZ);
      radiusGoal = overviewRadius;
      yawGoal = -.72; pitchGoal = .46;
    }
  }
  topBtn.addEventListener("click", () => preset("plan"));
  isoBtn.addEventListener("click", () => preset("iso"));
  frontBtn.addEventListener("click", () => preset("elevation"));
  resetBtn.addEventListener("click", () => { selected = null; hovered = null; focusMarker.visible = false; applyVisualState(); renderInspector(null, true, true); preset("iso"); });
  zoomInBtn.addEventListener("click", () => { stopAuto(); radiusGoal = Math.max(140, radiusGoal / 1.22); canvas.focus(); });
  zoomOutBtn.addEventListener("click", () => { stopAuto(); radiusGoal = Math.min(overviewRadius * 4, radiusGoal * 1.22); canvas.focus(); });
  autoBtn.addEventListener("click", () => {
    stopTour();
    autoOrbit = !autoOrbit;
    autoBtn.classList.toggle("on", autoOrbit);
    autoBtn.setAttribute("aria-pressed", String(autoOrbit));
  });
  fullBtn.addEventListener("click", () => document.fullscreenElement ? document.exitFullscreen?.() : stage.requestFullscreen?.());

  // ---------------------------------------------------------- picking/input
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let dragging = false, moved = false, shifted = false, lastX = 0, lastY = 0;

  function pick(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    return raycaster.intersectObjects(pickables, false)[0]?.object.userData.item || null;
  }
  function showTip(item, clientX, clientY) {
    if (!item) { tooltip.style.display = "none"; return; }
    const rect = stage.getBoundingClientRect();
    const x = clientX - rect.left, y = clientY - rect.top;
    tooltip.style.display = "block";
    tooltip.style.left = Math.min(stage.clientWidth - 340, Math.max(8, x + 14)) + "px";
    tooltip.style.top = Math.min(stage.clientHeight - 92, Math.max(44, y + 14)) + "px";
    tooltip.innerHTML = item.kind === "module"
      ? `<b>${esc(item.nd.path)}</b><span>tier L${model.depth[item.idx]} · ${itemViews.get(item)?.archetype || "module block"} · risk ${model.risk[item.idx]}/100 · ${item.nd.loc || 0} loc · ${model.blast[item.idx]} blast<br>click to focus · double-click to fly close</span>`
      : `<b>${esc(item.external.pkg)}</b><span>${item.external.builtin ? "built-in" : "third-party package"} · ${item.external.count} importing modules<br>click to focus</span>`;
  }

  canvas.addEventListener("pointerdown", (event) => {
    dragging = true; moved = false; shifted = event.shiftKey || event.button === 2; lastX = event.clientX; lastY = event.clientY;
    yawVelocity = 0; pitchVelocity = 0; stopTour(); stopAuto();
    canvas.setPointerCapture(event.pointerId); canvas.classList.add("dragging");
  });
  canvas.addEventListener("pointermove", (event) => {
    if (dragging) {
      const dx = event.clientX - lastX, dy = event.clientY - lastY;
      if (Math.abs(dx) + Math.abs(dy) > 2) moved = true;
      if (shifted || event.shiftKey) {
        const factor = radius * .00125;
        targetGoal.x -= (Math.cos(yaw) * dx + Math.sin(yaw) * dy) * factor;
        targetGoal.z += (Math.sin(yaw) * dx - Math.cos(yaw) * dy) * factor;
      } else {
        yawVelocity = dx * .0075;
        pitchVelocity = dy * .0065;
        yawGoal = wrapAngle(yawGoal + yawVelocity);
        pitchGoal = Math.max(-1.45, Math.min(1.5695, pitchGoal + pitchVelocity));
      }
      lastX = event.clientX; lastY = event.clientY; tooltip.style.display = "none";
      return;
    }
    const next = pick(event.clientX, event.clientY);
    if (next !== hovered) {
      hovered = next;
      if (!selected) renderInspector(hovered, !!hovered, !hovered);
      applyVisualState();
    }
    showTip(hovered, event.clientX, event.clientY);
  });
  canvas.addEventListener("pointerup", (event) => {
    if (!dragging) return;
    dragging = false; canvas.classList.remove("dragging");
    if (!moved) selectItem(pick(event.clientX, event.clientY), true);
  });
  canvas.addEventListener("pointercancel", () => { dragging = false; canvas.classList.remove("dragging"); });
  canvas.addEventListener("pointerleave", () => { if (!dragging) { hovered = null; tooltip.style.display = "none"; if (!selected) renderInspector(null, true, true); applyVisualState(); } });
  canvas.addEventListener("dblclick", (event) => { const item = pick(event.clientX, event.clientY); if (item) { if (selected !== item) selectItem(item, false); flyTo(item, true); } });
  canvas.addEventListener("contextmenu", (event) => event.preventDefault());
  canvas.addEventListener("wheel", (event) => { event.preventDefault(); stopTour(); stopAuto(); radiusGoal = Math.max(130, Math.min(9000, radiusGoal * Math.exp(event.deltaY * .001))); }, { passive: false });
  canvas.addEventListener("keydown", (event) => {
    const key = event.key.toLowerCase();
    if (["arrowleft", "arrowright", "arrowup", "arrowdown", "+", "=", "-", "home", "enter"].includes(key)) event.preventDefault();
    if (key === "arrowleft") yawGoal = wrapAngle(yawGoal - .12);
    if (key === "arrowright") yawGoal = wrapAngle(yawGoal + .12);
    if (key === "arrowup") pitchGoal = Math.min(1.5695, pitchGoal + .1);
    if (key === "arrowdown") pitchGoal = Math.max(-1.45, pitchGoal - .1);
    if (key === "+" || key === "=") radiusGoal = Math.max(130, radiusGoal / 1.16);
    if (key === "-") radiusGoal = Math.min(9000, radiusGoal * 1.16);
    if (key === "home") preset("iso");
    if (key === "enter" && hovered) selectItem(hovered, true);
    stopTour(); stopAuto();
  });

  // --------------------------------------------------------- filters/search
  search.addEventListener("input", () => {
    const query = search.value.trim().toLowerCase();
    if (query) {
      const found = world.items.find((item) => item.kind === "module" ? item.nd.path.toLowerCase().includes(query) : item.external.pkg.toLowerCase().includes(query));
      if (found) { hovered = found; renderInspector(found, true, false); }
    }
    applyVisualState();
  });
  search.addEventListener("keydown", (event) => { if (event.key === "Enter" && hovered) { selectItem(hovered, true); canvas.focus(); } });
  filter.addEventListener("change", () => { dashboardState.visualFilter = filter.value; if (selected && !filterAllows(selected)) selected = null; applyVisualState(); });
  routes.addEventListener("change", () => { dashboardState.visualRoutes = routes.value; applyVisualState(); });
  color.addEventListener("change", () => {
    dashboardState.visualColor = color.value;
    for (const item of world.modules) {
      if (!item) continue;
      const view = moduleViews.get(item.idx);
      const next = nodeColor(item, model, color.value);
      view.baseColor = next;
      view.material.color.copy(new THREE.Color(next).lerp(new THREE.Color("#0b1526"), .55));
      view.material.emissive.set(next);
      view.accentMaterials.forEach((material) => material.color?.set(next));
    }
    for (const rec of connectionViews.filter((x) => x.edge.kind === "import")) {
      rec.baseColor = nodeColor(rec.edge.a, model, color.value);
      rec.material.color.set(rec.baseColor);
    }
    setLegend(); applyVisualState();
  });
  jump.addEventListener("change", () => { if (jump.value !== "") { const item = world.modules[Number(jump.value)]; if (item) { selectItem(item, true); canvas.focus(); } } });

  // ------------------------------------------------------------- animation
  let disposed = false;
  let frame = 0;
  let previous = performance.now();
  let width = 1, height = 1;
  let composer = null, gradePass = null, renderPass = null;
  function resize() {
    const rect = stage.getBoundingClientRect();
    width = Math.max(1, rect.width); height = Math.max(1, rect.height);
    renderer.setSize(width, height, false);
    perspective.aspect = width / height;
    perspective.updateProjectionMatrix();
    ortho.aspect = width / height;
    lineResolution.set(width, height);
    for (const material of lineMaterials) material.resolution.set(width, height);
    composer?.setSize(width, height);
    placeCamera();
  }
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(stage);
  resize();
  placeCamera();

  // ------------------------------------------------- post-processing chain
  // A whisper of bloom so entry masts and risk tabs read as lit, plus the
  // paper grade. Deliberately restrained: a blueprint that blooms is a poster.
  if (post) {
    try {
      composer = new post.EffectComposer(renderer);
      renderPass = new post.RenderPass(scene, camera);
      composer.addPass(renderPass);
      composer.addPass(new post.UnrealBloomPass(new THREE.Vector2(width, height), .14, .5, .92));
      gradePass = new post.ShaderPass(BlueprintGrade);
      composer.addPass(gradePass);
      composer.addPass(new post.OutputPass());
      composer.setSize(width, height);
      canvas.dataset.post = "blueprint-grade";
    } catch {
      composer = null;
      gradePass = null;
      renderPass = null;
    }
  }
  canvas.dataset.projection = "perspective";
  canvas.dataset.fatLines = lines ? "true" : "false";

  function animate(now) {
    if (disposed || !canvas.isConnected) return;
    frame = requestAnimationFrame(animate);
    const dt = Math.min(.05, (now - previous) / 1000);
    previous = now;
    if (touring && now >= tourAt) stepTour(now);
    if (autoOrbit) yawGoal = wrapAngle(yawGoal + dt * .085);
    if (!dragging && !autoOrbit && (Math.abs(yawVelocity) > .0001 || Math.abs(pitchVelocity) > .0001)) {
      yawGoal = wrapAngle(yawGoal + yawVelocity);
      pitchGoal = Math.max(-1.45, Math.min(1.5695, pitchGoal + pitchVelocity));
      yawVelocity *= .9;
      pitchVelocity *= .9;
    }
    yaw = wrapAngle(yaw + angularDelta(yaw, yawGoal) * Math.min(1, dt * 9));
    pitch += (pitchGoal - pitch) * Math.min(1, dt * 9);
    radius += (radiusGoal - radius) * Math.min(1, dt * 8);
    target.lerp(targetGoal, Math.min(1, dt * 7));
    placeCamera();
    resolveLabels();

    if (focusMarker.visible) focusMarker.children[0].material.opacity = .72 + Math.sin(now * .0035) * .22;
    if (!reduced) {
      riskTabs.forEach((tab) => {
        tab.material.opacity = (tab.material.userData.baseOpacity ?? .95) * (.7 + Math.sin(now * .0033 + tab.userData.phase) * .3);
      });
      particles.forEach((particle) => {
        const connection = particle.userData.connection;
        if (!particle.visible) return;
        const progress = (now * .00013 * (connection.speed || 1) + particle.userData.phase) % 1;
        particle.position.copy(connection.curve.getPoint(progress));
        const tangent = connection.curve.getTangent(progress);
        particle.lookAt(particle.position.clone().add(tangent));
        particle.material.color.copy(connection.material.color);
      });
    }

    const azimuth = ((Math.round(yaw * 180 / Math.PI) % 360) + 360) % 360;
    const tilt = Math.round(pitch * 180 / Math.PI);
    const cameraHud = hud.querySelector("#visual-camera");
    if (cameraHud) cameraHud.textContent = `${orthographic ? "ORTHO" : "PERSP"} · AZIMUTH ${azimuth}° · TILT ${tilt}° · ${Math.round((overviewRadius / radius) * 100)}%`;
    if (gradePass) gradePass.uniforms.uTime.value = now * .001;
    if (composer) composer.render();
    else renderer.render(scene, camera);
  }
  frame = requestAnimationFrame(animate);

  dashboardState.visualCleanup = () => {
    disposed = true;
    cancelAnimationFrame(frame);
    resizeObserver.disconnect();
    titleBlock.remove();
    composer?.dispose?.();
    renderer.dispose();
    scene.traverse((object) => {
      object.geometry?.dispose?.();
      const materials = Array.isArray(object.material) ? object.material : object.material ? [object.material] : [];
      for (const material of materials) {
        material.map?.dispose?.();
        material.dispose?.();
      }
      object.userData?.labelTexture?.dispose?.();
    });
    stage.classList.remove("webgl");
    consolePanel.classList.remove("webgl-console");
  };
  return true;
}
