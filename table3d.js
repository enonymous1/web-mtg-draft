// 3D pack-opening table for the reveal step. Plain vendored three.js
// (assets/vendor/three, 0.182.0, MIT, no CDN), no framework, no physics
// engine: opening a pack is choreography (deal-in + flip tweens), not a
// simulation. The 2D pool and deck builder stay 2D — sorting 90 cards
// on a table is slower in 3D than in a grid.
//
// The 2D reveal grid is the fallback: if WebGL is unavailable or the
// user prefers reduced motion, the app never creates this controller
// and renderReveal() shows the grid instead.
import * as THREE from "./assets/vendor/three/three.module.min.js";

const CARD_W = 0.63;
const CARD_H = 0.88;
const COLS = 5;
const GAP_X = 0.78;
const GAP_Z = 1.04;
const FLIP_MS = 550;
const DEAL_MS = 500;

function easeOutCubic(t) {
  return 1 - (1 - t) ** 3;
}

export function webglSupported() {
  try {
    const canvas = document.createElement("canvas");
    return !!(
      window.WebGLRenderingContext &&
      (canvas.getContext("webgl2") || canvas.getContext("webgl"))
    );
  } catch {
    return false;
  }
}

// Container holds the canvas. Callbacks: onCardClick(cardId) fires when
// a card mesh is clicked; the app decides what a click means.
export function createTable(container, { onCardClick } = {}) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.domElement.style.display = "block";
  renderer.domElement.style.width = "100%";
  renderer.domElement.style.height = "100%";
  renderer.domElement.style.touchAction = "manipulation";
  container.append(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 50);
  camera.position.set(0, 4.6, 5.4);
  camera.lookAt(0, 0, 0.2);

  scene.add(new THREE.AmbientLight(0xffffff, 0.85));
  const sun = new THREE.DirectionalLight(0xffffff, 1.4);
  sun.position.set(3, 6, 4);
  scene.add(sun);

  // Felt table.
  const table = new THREE.Mesh(
    new THREE.PlaneGeometry(12, 8),
    new THREE.MeshStandardMaterial({ color: 0x1d5c38, roughness: 0.95 }),
  );
  table.rotation.x = -Math.PI / 2;
  table.position.z = 0.2;
  scene.add(table);

  const loader = new THREE.TextureLoader();
  loader.setCrossOrigin("anonymous");
  const backTexture = loader.load(
    "https://backs.scryfall.io/normal/0/a/0aeebaf5-8c7d-4636-9e82-8c27447861f7.jpg",
  );
  const backMaterial = new THREE.MeshBasicMaterial({ map: backTexture });
  const placeholderMaterial = new THREE.MeshStandardMaterial({ color: 0x2b2b2b, roughness: 0.8 });
  // One shared geometry for every card. Geometries, materials, and
  // per-card textures are GPU resources: scene.remove() frees none of
  // them, so setPack() must dispose them (see disposeCard below) or a
  // sealed session leaks ~90 card meshes' worth of GPU memory.
  const cardGeometry = new THREE.PlaneGeometry(CARD_W, CARD_H);
  const glowGeometry = new THREE.PlaneGeometry(CARD_W + 0.1, CARD_H + 0.1);

  let cards = []; // { id, group, flip, flipStart, dealStart, target, revealed }
  let raf = 0;
  let visible = false;
  let running = false;
  let disposed = false;
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();

  function resize() {
    const w = container.clientWidth || 800;
    const h = container.clientHeight || 520;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(container);
  resize();

  function slotPosition(index, total) {
    const row = Math.floor(index / COLS);
    const rows = Math.ceil(total / COLS);
    const colsInRow = Math.min(COLS, total - row * COLS);
    const col = index % COLS;
    const x = (col - (colsInRow - 1) / 2) * GAP_X;
    const z = (row - (rows - 1) / 2) * GAP_Z + 0.2;
    return { x, z };
  }

  function makeCardMesh(card) {
    const group = new THREE.Group();
    const inner = new THREE.Group();
    const back = new THREE.Mesh(cardGeometry, backMaterial);
    back.position.z = 0.004;
    inner.add(back);
    const frontMaterial = card.image
      ? new THREE.MeshBasicMaterial({ map: loader.load(card.image) })
      : placeholderMaterial;
    const front = new THREE.Mesh(cardGeometry, frontMaterial);
    front.position.z = -0.004;
    front.rotation.y = Math.PI;
    inner.add(front);
    // Gold underlay, faded in when a rare/mythic flips.
    const glow = new THREE.Mesh(
      glowGeometry,
      new THREE.MeshBasicMaterial({ color: 0xd4a017, transparent: true, opacity: 0 }),
    );
    glow.position.z = -0.01;
    glow.rotation.y = Math.PI;
    inner.add(glow);
    group.add(inner);
    group.rotation.x = -Math.PI / 2;
    group.userData = { cardId: card.id, inner, glow, frontMaterial, isRare: card.rarity === "rare" || card.rarity === "mythic" };
    return group;
  }

  // Free a card's GPU resources. The shared card geometry, the shared
  // card-back material, and the placeholder material are owned by the
  // controller, not the card, and must NOT be disposed here. The
  // per-card front texture is cached by TextureLoader under its URL and
  // reused across packs, so it is intentionally kept: disposing the
  // material frees the material, the cached texture stays for reuse.
  function disposeCard(entry) {
    const { frontMaterial, glow } = entry.group.userData;
    glow.material.dispose();
    if (frontMaterial !== placeholderMaterial) frontMaterial.dispose();
  }

  function tick(now) {
    if (!running) return;
    raf = requestAnimationFrame(tick);
    let animating = false;
    for (const entry of cards) {
      const { group, target } = entry;
      // Deal-in: slide from the pack pile at the centre to the slot.
      if (entry.dealStart !== null) {
        const t = Math.min(1, (now - entry.dealStart) / DEAL_MS);
        const e = easeOutCubic(t);
        group.position.x = target.x * e;
        group.position.z = target.z * e + 0.2 * (1 - e);
        group.position.y = 0.02 + 0.35 * (1 - e);
        if (t >= 1) entry.dealStart = null;
        else animating = true;
      }
      // Flip: turn the card over around its long axis, with a little lift.
      if (entry.flipStart !== null) {
        const t = Math.min(1, (now - entry.flipStart) / FLIP_MS);
        const e = easeOutCubic(t);
        group.userData.inner.rotation.x = Math.PI * e;
        group.userData.inner.position.z = Math.sin(t * Math.PI) * 0.3;
        if (entry.isRare) group.userData.glow.material.opacity = 0.55 * e;
        if (t >= 1) entry.flipStart = null;
        else animating = true;
      }
    }
    renderer.render(scene, camera);
    // Stop the loop when nothing is moving; setPack/setRevealed/
    // setVisible restart it on demand. Saves battery on a static table.
    if (!animating) {
      running = false;
      return;
    }
  }

  function startLoop() {
    if (!running && !disposed) {
      running = true;
      raf = requestAnimationFrame(tick);
    }
  }

  function setPack(order, revealedIds) {
    for (const entry of cards) {
      disposeCard(entry);
      scene.remove(entry.group);
    }
    cards = order.map((card, index) => {
      const group = makeCardMesh(card);
      const target = slotPosition(index, order.length);
      group.position.set(0, 0.02, 0.2);
      scene.add(group);
      const revealed = revealedIds.has(card.id);
      const entry = {
        id: card.id,
        group,
        target,
        isRare: group.userData.isRare,
        dealStart: performance.now() + index * 60,
        flipStart: null,
        revealed,
      };
      if (revealed) {
        // Already flipped (re-render after a flip): show face-up at once,
        // do not replay the flip animation.
        group.userData.inner.rotation.x = Math.PI;
        if (entry.isRare) group.userData.glow.material.opacity = 0.55;
      }
      return entry;
    });
    startLoop();
  }

  function setRevealed(revealedIds) {
    for (const entry of cards) {
      if (revealedIds.has(entry.id) && !entry.revealed) {
        entry.revealed = true;
        entry.flipStart = performance.now();
      }
    }
    startLoop();
  }

  function onPointerDown(event) {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects(
      cards.map((entry) => entry.group),
      true,
    );
    if (hits.length === 0) return;
    let object = hits[0].object;
    while (object && !object.userData.cardId) object = object.parent;
    if (object && onCardClick) onCardClick(object.userData.cardId);
  }
  renderer.domElement.addEventListener("pointerdown", onPointerDown);

  return {
    setPack,
    setRevealed,
    setVisible(next) {
      visible = next;
      if (next) {
        resize();
        startLoop();
      }
    },
    dispose() {
      disposed = true;
      cancelAnimationFrame(raf);
      resizeObserver.disconnect();
      renderer.domElement.removeEventListener("pointerdown", onPointerDown);
      for (const entry of cards) disposeCard(entry);
      cards = [];
      cardGeometry.dispose();
      glowGeometry.dispose();
      backMaterial.dispose();
      backTexture.dispose();
      placeholderMaterial.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
