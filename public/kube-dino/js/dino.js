// Kube Dino: a small runner on a canvas, plus the live backend panel next to it.
//
// The panel and the game talk to the kube-dino API on the same host:
//   GET  /api/cluster  -> {"pods": [{"name", "status", "ready", "startedAt", "restarts", "version"}], "cpu", "memory"}
//   GET  /api/games    -> {"playing", "played", "best"}
//   POST /api/games    -> {"id", "heartbeatSeconds"}, then .../heartbeat and .../finish
// If the API is down the panel shows as not connected and the game runs on its
// own. Text comes from data attributes so the same script serves every language.
(() => {
  "use strict";

  const canvas = document.getElementById("dino");
  if (!canvas) return;

  // ---------------------------------------------------------------- Game

  const ctx = canvas.getContext("2d");
  const overlay = document.getElementById("dino-overlay");
  const scoreEl = document.getElementById("dino-score");
  const bestEl = document.getElementById("dino-best");

  // The world is 330 units tall and as wide as the canvas allows. Speeds and gaps
  // scale with that width (see `pace`), so a phone gets the same time to react
  // as a desktop instead of half of it. The ground sits a bit lower than before,
  // which leaves room under the road for a finger without hiding the runner.
  const WORLD_H = 330;
  const REF_W = 1000; // the width the speeds below were tuned for
  const GROUND = 180;
  const GRAVITY = 2400;
  const FALL_MULT = 1.6; // falling is heavier than rising, so jumps feel snappy and land on time
  const JUMP_SPEED = 760;
  const JUMP_CUT = 320; // letting go early caps the upward speed, for short hops
  const JUMP_BUFFER = 0.15; // a press this close before touchdown still jumps on landing
  const STEP = 1 / 120; // physics runs in fixed steps, so 60 Hz and 120 Hz phones play the same
  const START_SPEED = 290;
  const MAX_SPEED = 760;
  const ACCEL = 7;
  const POD_POINTS = 25;
  const JUMP_KEYS = new Set(["Space", "ArrowUp", "KeyW"]);
  const BEST_KEY = "kube-dino-best";

  let worldW = REF_W;
  let pace = 1; // worldW / REF_W, set on resize
  let colors = {};
  let state = "idle"; // idle | running | over
  let overAt = 0;
  let last = null;
  let accumulator = 0; // time not yet simulated, in seconds
  let dino, obstacles, pods, floats, goneQueue;
  let clouds = [];
  let speed, score, groundOffset, sinceSpawn, nextGap, sinceCloud, nextCloud;
  let jumpBuffer = 0; // seconds left for a jump pressed while in the air
  let best = loadBest();
  // The idle screen draws before any round starts, so it needs clouds too.
  for (let i = 0; i < 3; i++) addCloud(Math.random() * REF_W);

  function reset() {
    dino = { x: 44, y: GROUND - 40, w: 36, h: 40, vy: 0, onGround: true };
    obstacles = [];
    pods = [];
    floats = [];
    goneQueue = [];
    clouds = [];
    speed = START_SPEED;
    score = 0;
    groundOffset = 0;
    sinceSpawn = 0;
    nextGap = 240;
    sinceCloud = 0;
    nextCloud = 0;
    jumpBuffer = 0;
    // A few clouds already in the sky, so the idle screen isn't empty.
    for (let i = 0; i < 3; i++) addCloud(Math.random() * worldW);
  }

  function start() {
    reset();
    state = "running";
    overlay.hidden = true;
    scoreEl.textContent = pad(0);
    last = null;
    accumulator = 0;
    sessionStart();
    requestAnimationFrame(frame);
  }

  function gameOver() {
    state = "over";
    overAt = performance.now();
    sessionFinish(Math.floor(score));
    best = Math.max(best, Math.floor(score));
    saveBest(best);
    bestEl.textContent = pad(best);
    overlay.textContent = overlay.dataset.over;
    overlay.hidden = false;
  }

  function jump() {
    dino.vy = -JUMP_SPEED;
    dino.onGround = false;
    jumpBuffer = 0;
  }

  function press() {
    if (state === "running") {
      if (dino.onGround) jump();
      // In the air: remember the press so it fires the moment the dino lands.
      else jumpBuffer = JUMP_BUFFER;
    } else if (state === "idle" || performance.now() - overAt > 400) {
      // The short wait stops the key that lost the round from restarting it.
      start();
    }
  }

  function release() {
    if (state === "running" && dino.vy < -JUMP_CUT) dino.vy = -JUMP_CUT;
  }

  function frame(now) {
    const dt = last === null ? 0 : Math.min((now - last) / 1000, 0.05);
    last = now;
    if (state === "running") {
      // Advance in equal steps, however uneven the frames are, so the jump arc doesn't stutter.
      accumulator += dt;
      while (accumulator >= STEP && state === "running") {
        update(STEP);
        accumulator -= STEP;
      }
    }
    draw(now / 1000);
    if (state === "running") requestAnimationFrame(frame);
  }

  function update(dt) {
    speed = Math.min(MAX_SPEED, speed + ACCEL * dt);
    const dx = speed * pace * dt;
    groundOffset = (groundOffset + dx) % 24;
    score += dx / 10;
    jumpBuffer = Math.max(0, jumpBuffer - dt);

    dino.vy += GRAVITY * (dino.vy > 0 ? FALL_MULT : 1) * dt;
    dino.y += dino.vy * dt;
    if (dino.y >= GROUND - dino.h) {
      dino.y = GROUND - dino.h;
      dino.vy = 0;
      dino.onGround = true;
      if (jumpBuffer > 0) jump(); // jump again the instant the feet touch down
    }

    sinceSpawn += dx;
    if (sinceSpawn >= nextGap) spawn();

    sinceCloud += dx;
    if (sinceCloud >= nextCloud) {
      sinceCloud = 0;
      nextCloud = (250 + Math.random() * 350) * pace;
      addCloud(worldW + 20);
    }

    for (const o of obstacles) o.x -= dx;
    for (const p of pods) p.x -= dx;
    for (const c of clouds) c.x -= dx * 0.35;
    clouds = clouds.filter((c) => c.x > -80);
    for (const f of floats) {
      f.y -= 30 * dt;
      f.life -= dt;
    }
    obstacles = obstacles.filter((o) => o.x + o.w > -60);
    pods = pods.filter((p) => !p.taken && p.x + p.r > -10);
    floats = floats.filter((f) => f.life > 0);

    // A slightly smaller hitbox than the drawing, so near misses feel fair.
    const hit = { x: dino.x + 5, y: dino.y + 4, w: dino.w - 10, h: dino.h - 6 };
    for (const o of obstacles) {
      if (overlaps(hit, { x: o.x, y: GROUND - o.h - (o.lift || 0), w: o.w, h: o.h })) {
        gameOver();
        return;
      }
    }
    for (const p of pods) {
      if (overlaps(hit, { x: p.x - p.r, y: p.y - p.r, w: p.r * 2, h: p.r * 2 })) {
        p.taken = true;
        score += POD_POINTS;
        floats.push({ x: p.x, y: p.y - 10, text: `+${POD_POINTS}`, life: 0.8 });
      }
    }
    // Only touch the DOM when the shown number changes, not on every frame.
    const shown = pad(score);
    if (shown !== scoreEl.textContent) scoreEl.textContent = shown;
  }

  // Cacti come in four shapes, like the Chrome dino: single, tall, double and
  // triple. Bigger groups get more common as the score goes up.
  function makeCactus(x, gone) {
    const level = Math.min(1, score / 1000);
    const t = Math.random();
    const triple = 0.05 + 0.2 * level;
    let stems;
    let arms = [];
    if (t < triple) {
      stems = [0, 18, 36].map((dx) => ({ dx, w: 12, h: 24 + Math.random() * 18 }));
    } else if (t < triple + 0.2) {
      stems = [0, 20].map((dx) => ({ dx, w: 13, h: 28 + Math.random() * 14 }));
    } else if (t < triple + 0.4) {
      stems = [{ dx: 0, w: 16, h: 50 + Math.random() * 8 }];
      arms = [{ stem: 0, at: 22 + Math.random() * 10, len: 12 + Math.random() * 6, rise: 14 }];
    } else {
      stems = [{ dx: 0, w: 14, h: 28 + Math.random() * 16 }];
      if (Math.random() < 0.5) arms = [{ stem: 0, at: 14 + Math.random() * 6, len: 9 + Math.random() * 4, rise: 10 }];
    }
    // Bounding box of the whole cactus, arms included, used for collisions.
    const w = Math.max(
      ...stems.map((s) => s.dx + s.w),
      ...arms.map((a) => stems[a.stem].dx + stems[a.stem].w + a.len - 1),
    );
    const h = Math.max(...stems.map((s) => s.h), ...arms.map((a) => a.at + a.rise));
    return { x, w, h, stems, arms, gone: Boolean(gone), label: gone ? `✕ ${gone}` : "" };
  }

  // Birds come at three heights. The low ones (14, 26) reach a standing dino, so they must be jumped
  // over. The high one (60) passes above a standing dino, so jumping into it is what gets you.
  function makeBird(x) {
    const lift = [14, 26, 60][Math.floor(Math.random() * 3)];
    return { x, w: 30, h: 20, lift, stems: [], arms: [], gone: false, label: "", bird: true };
  }

  function spawn() {
    sinceSpawn = 0;
    // Distance the world moves per second. Gaps grow with it so there is always room to land and jump again.
    // Roughly 1.1 to 1.8 seconds between cacti at the start: a full jump lasts about 0.63 s, so there is time to land and go again.
    const unit = speed * pace;
    // Grows with the score without a limit. Each effect below has its own cap.
    const level = score / 1000;
    // Every 1000 points the free gap shrinks by 10%, down to 70% of the start gap (the floor keeps a jump always possible).
    nextGap = unit * (0.85 + Math.random() * 0.85) * Math.max(0.7, 1 - 0.1 * level) + 100 * pace;
    const gone = goneQueue.shift();
    // From 150 points on, some obstacles are birds, and more of them as the score grows.
    // Birds: 10% at the start, plus 12 points of chance every 1000 points, capped at 50%.
    const bird = !gone && score > 150 && Math.random() < Math.min(0.5, 0.1 + 0.12 * level);
    const first = bird ? makeBird(worldW + 20) : makeCactus(worldW + 20, gone);
    obstacles.push(first);
    // Now and then a second cactus follows close behind. It only spawns when one jump can clear both:
    // the span, plus the dino's hitbox, must fit in about a quarter of a second of travel.
    // Double cacti: 6% at the start, plus 13 points of chance every 1000 points, capped at 45%.
    if (!bird && !gone && score > 100 && Math.random() < Math.min(0.45, 0.06 + 0.13 * level)) {
      const second = makeCactus(first.x + first.w + 4 * pace, null);
      if (second.x + second.w - first.x + (dino.w - 10) <= unit * 0.26) obstacles.push(second);
    }
    if (!bird && Math.random() < 0.4) {
      pods.push({ x: first.x + nextGap / 2, y: GROUND - 72 - Math.random() * 30, r: 8, taken: false });
    }
  }

  // A pod that disappeared from the real cluster shows up as the next obstacle.
  // The end of the name is the part that tells pods apart, so that's what stays.
  function podGone(name) {
    if (state !== "running") return;
    goneQueue.push(name.length > 14 ? `…${name.slice(-12)}` : name);
  }

  function draw(t) {
    ctx.clearRect(0, 0, worldW, WORLD_H);

    for (const c of clouds) drawCloud(c);

    ctx.fillStyle = colors.line;
    ctx.fillRect(0, GROUND, worldW, 1.5);
    for (let x = -groundOffset; x < worldW; x += 24) ctx.fillRect(x, GROUND + 9, 10, 1.5);

    for (const p of pods) {
      ctx.fillStyle = colors.accent;
      hexagon(p.x, p.y, p.r);
      ctx.fillStyle = colors.surface;
      hexagon(p.x, p.y, p.r * 0.45);
    }

    ctx.font = `600 9px ${colors.mono}`;
    ctx.textAlign = "center";
    for (const o of obstacles) {
      if (o.bird) drawBird(o, t);
      else drawCactus(o);
    }

    drawDino(t);

    ctx.fillStyle = colors.accent;
    for (const f of floats) {
      ctx.globalAlpha = Math.max(0, f.life / 0.8);
      ctx.fillText(f.text, f.x, f.y);
    }
    ctx.globalAlpha = 1;
  }

  // Side view, facing right, in the 36 x 40 box the collisions use. The feet
  // stay on the ground line (y + 40) when running.
  function drawDino(t) {
    const { x, y } = dino;
    const running = state === "running" && dino.onGround;
    const step = running ? Math.floor(t * 12) % 2 : 0;

    ctx.fillStyle = colors.fg;
    // Tail, back, head, snout, throat and belly as one shape.
    ctx.beginPath();
    ctx.moveTo(x, y + 21); // tail tip
    ctx.lineTo(x + 10, y + 18); // tail joins the back
    ctx.lineTo(x + 14, y + 13);
    ctx.lineTo(x + 22, y + 10); // shoulders
    ctx.lineTo(x + 23, y + 3); // back of the head
    ctx.lineTo(x + 28, y); // top of the head
    ctx.lineTo(x + 36, y + 2); // top of the snout
    ctx.lineTo(x + 36, y + 9); // snout tip
    ctx.lineTo(x + 30, y + 11); // mouth
    ctx.lineTo(x + 28, y + 15); // jaw
    ctx.lineTo(x + 24, y + 22); // throat
    ctx.lineTo(x + 22, y + 28); // chest
    ctx.lineTo(x + 10, y + 28); // belly
    ctx.lineTo(x, y + 24); // underside of the tail
    ctx.closePath();
    ctx.fill();

    // Small arm.
    ctx.fillRect(x + 22, y + 18, 3, 5);

    // Legs: alternate while running, both tucked in the air.
    const back = !dino.onGround ? 8 : step ? 9 : 12;
    const front = !dino.onGround ? 8 : step ? 12 : 9;
    ctx.fillRect(x + 10, y + 28, 4, back);
    ctx.fillRect(x + 19, y + 28, 4, front);

    // Eye, in the background colour. A dead dino's eye is bigger.
    ctx.fillStyle = colors.surface;
    ctx.beginPath();
    ctx.arc(x + 28, y + 4, state === "over" ? 2.4 : 1.8, 0, Math.PI * 2);
    ctx.fill();
  }

  // Clouds drift slower than the ground, so they read as far away.
  function addCloud(x) {
    clouds.push({ x, y: 18 + Math.random() * 40, s: 0.8 + Math.random() * 0.6 });
  }

  function drawCloud(c) {
    ctx.fillStyle = colors.line;
    for (const [dx, dy, r] of [[0, 0, 8], [10, -5, 11], [22, 0, 8]]) {
      ctx.beginPath();
      ctx.arc(c.x + dx * c.s, c.y + dy * c.s, r * c.s, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Green cacti; a real pod that disappeared from the cluster shows up as a warning-coloured one with its name.
  function drawCactus(o) {
    ctx.fillStyle = o.gone ? colors.warn : colors.ok;
    for (const s of o.stems) box(o.x + s.dx, GROUND - s.h, s.w, s.h, s.w / 2);
    for (const a of o.arms) {
      const stem = o.stems[a.stem];
      const x0 = o.x + stem.dx + stem.w - 1;
      const top = GROUND - a.at - 6;
      box(x0, top, a.len, 6, 3); // the side branch
      box(x0 + a.len - 6, top - a.rise, 6, a.rise + 6, 3); // its upturned tip
    }
    if (o.label) {
      ctx.fillStyle = colors.warn;
      ctx.fillText(o.label, o.x + o.w / 2, GROUND - o.h - 6);
    }
  }

  // Flapping bird, drawn in the danger colour so it reads as a hazard.
  function drawBird(o, t) {
    const y = GROUND - o.h - o.lift;
    const up = Math.floor(t * 8) % 2 === 0;
    ctx.fillStyle = colors.danger;
    box(o.x + 4, y + 6, 22, 8, 4); // body
    ctx.fillRect(o.x + 25, y + 8, 5, 2); // beak
    const wingY = up ? y - 4 : y + 16;
    ctx.beginPath();
    ctx.moveTo(o.x + 9, y + 8);
    ctx.lineTo(o.x + 15, wingY);
    ctx.lineTo(o.x + 19, y + 8);
    ctx.closePath();
    ctx.fill();
  }

  function box(x, y, w, h, r) {
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
    else ctx.rect(x, y, w, h);
    ctx.fill();
  }

  function hexagon(cx, cy, r) {
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI / 3) * i + Math.PI / 6;
      ctx.lineTo(cx + r * Math.cos(a), cy + r * Math.sin(a));
    }
    ctx.closePath();
    ctx.fill();
  }

  function overlaps(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }

  function pad(n) {
    return String(Math.floor(n)).padStart(5, "0");
  }

  // Storage can be blocked (private windows, strict settings); the game works without it.
  function loadBest() {
    try {
      return Number(localStorage.getItem(BEST_KEY)) || 0;
    } catch {
      return 0;
    }
  }

  function saveBest(value) {
    try {
      localStorage.setItem(BEST_KEY, String(value));
    } catch {
      // Nothing to do: the best score just won't survive a reload.
    }
  }

  function readColors() {
    const css = getComputedStyle(document.documentElement);
    const v = (name) => css.getPropertyValue(name).trim();
    colors = {
      fg: v("--fg"),
      muted: v("--muted"),
      line: v("--line"),
      surface: v("--surface"),
      accent: v("--accent"),
      ok: v("--ok"),
      danger: v("--danger"),
      warn: v("--warn"),
      mono: v("--mono"),
    };
  }

  function resize() {
    const cssW = canvas.clientWidth;
    const cssH = canvas.clientHeight;
    if (!cssW || !cssH) return;
    // Capped at 2: a 3x phone would draw 2.25x the pixels for no visible gain.
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const scale = cssH / WORLD_H;
    // Changing the canvas size reallocates its pixels, so only do it when the size really changed.
    const w = Math.round(cssW * dpr);
    const h = Math.round(cssH * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    worldW = cssW / scale;
    pace = worldW / REF_W;
    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, 0, 0);
    draw(performance.now() / 1000);
  }

  canvas.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    // Focusing can scroll the page on a phone, so only do it when the canvas isn't focused yet.
    if (document.activeElement !== canvas) canvas.focus({ preventScroll: true });
    press();
  });
  window.addEventListener("pointerup", release);
  window.addEventListener("keydown", (e) => {
    if (!JUMP_KEYS.has(e.code)) return;
    // Space keeps scrolling the page and pressing links unless the game has the focus or is running.
    if (e.target.closest && e.target.closest("a, button, input, textarea, select")) return;
    if (state !== "running" && document.activeElement !== canvas) return;
    e.preventDefault();
    if (!e.repeat) press();
  });
  window.addEventListener("keyup", (e) => {
    if (JUMP_KEYS.has(e.code)) release();
  });
  // The canvas takes its colours from the CSS, so it redraws when the reader
  // switches theme in the header.
  const redrawForTheme = () => {
    readColors();
    draw(performance.now() / 1000);
  };
  new MutationObserver(redrawForTheme).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });

  readColors();
  reset();
  bestEl.textContent = pad(best);
  new ResizeObserver(resize).observe(canvas);

  // ------------------------------------------------------ Game sessions

  // Each round is reported to the API so the panel can show players and the
  // best score. All of it is best effort: if the API is down or slow, the game
  // plays exactly the same.
  let session = null; // promise of { id, heartbeatSeconds }, or of null
  let heartbeat;

  function post(path, body) {
    return fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body && JSON.stringify(body),
      keepalive: true,
      signal: AbortSignal.timeout(3000),
    });
  }

  function sessionStart() {
    clearInterval(heartbeat);
    const mine = post("/api/games")
      .then((res) => (res.ok ? res.json() : null))
      .catch(() => null);
    session = mine;
    mine.then((s) => {
      // The round may be over, or another one started, by the time this answers.
      if (!s || session !== mine) return;
      heartbeat = setInterval(() => post(`/api/games/${s.id}/heartbeat`).catch(() => {}), s.heartbeatSeconds * 1000);
    });
  }

  function sessionFinish(finalScore) {
    clearInterval(heartbeat);
    const mine = session;
    session = null;
    if (!mine) return;
    mine
      .then((s) => s && finishGame(s.id, finalScore))
      .then(() => refresh())
      .catch(() => {});
  }

  // One retry a second later if the answer is lost or the save failed. The
  // server recognises a game it already saved, so a retry never counts twice.
  function finishGame(id, finalScore) {
    const once = () => post(`/api/games/${id}/finish`, { score: finalScore });
    return once()
      .then((res) => (res.status >= 500 ? Promise.reject(new Error(`finish returned ${res.status}`)) : res))
      .catch(() => new Promise((resolve) => setTimeout(resolve, 1000)).then(once));
  }

  // ------------------------------------------------------ Backend panel

  const panel = document.getElementById("cluster");
  const status = document.getElementById("cluster-status");
  const readyEl = document.getElementById("cluster-ready");
  const cpuEl = document.getElementById("cluster-cpu");
  const memoryEl = document.getElementById("cluster-memory");
  const playingEl = document.getElementById("games-playing");
  const bestGlobalEl = document.getElementById("games-best");
  const playedEl = document.getElementById("games-played");
  const list = document.getElementById("cluster-pods");
  const labels = list.dataset;
  const numbers = new Intl.NumberFormat(document.documentElement.lang);
  // Statuses as `kubectl get pods` shows them; anything else not ready is just waiting.
  const FAILED_STATUSES = new Set(["Failed", "Error", "CrashLoopBackOff", "ImagePullBackOff", "ErrImagePull", "OOMKilled"]);
  let connected = false;
  let known = null;
  let updatedAt = 0;
  let timer;

  // Cluster and games are fetched apart, so one failing doesn't blank the other.
  async function getJson(path) {
    try {
      const res = await fetch(path, { cache: "no-store", signal: AbortSignal.timeout(5000) });
      return res.ok ? await res.json() : null;
    } catch {
      return null; // Not deployed yet, or the network dropped.
    }
  }

  async function refresh() {
    const [cluster, games] = await Promise.all([getJson("/api/cluster"), getJson("/api/games")]);

    connected = Boolean(cluster);
    if (cluster) {
      renderCluster(cluster);
    } else {
      readyEl.textContent = cpuEl.textContent = memoryEl.textContent = "–";
      list.replaceChildren();
      known = null;
    }
    playingEl.textContent = games ? numbers.format(games.playing) : "–";
    bestGlobalEl.textContent = games ? numbers.format(games.best) : "–";
    playedEl.textContent = games ? numbers.format(games.played) : "–";

    showAge();
    panel.classList.toggle("is-offline", !connected);
    clearTimeout(timer); // a finished game can trigger a refresh while another is waiting
    timer = setTimeout(refresh, connected ? 5000 : 30000);
  }

  function showAge() {
    status.textContent = connected
      ? status.dataset.updated.replace("{s}", Math.round((Date.now() - updatedAt) / 1000))
      : status.dataset.offline;
  }

  function renderCluster({ pods: items = [], cpu, memory }) {
    updatedAt = Date.now();
    readyEl.textContent = `${items.filter((p) => p.ready).length} / ${items.length}`;
    // The same units as `kubectl top pods`.
    cpuEl.textContent = typeof cpu === "number" ? `${cpu}m` : "–";
    memoryEl.textContent = typeof memory === "number" ? `${Math.round(memory / 2 ** 20)}Mi` : "–";

    const names = new Set(items.map((p) => p.name));
    if (known) for (const name of known) if (!names.has(name)) podGone(name);
    known = names;

    list.replaceChildren(...items.map(podItem));
  }

  function podItem(pod) {
    const rows = [
      [labels.pod, pod.name],
      [labels.status, pod.ready ? "Ready" : pod.status],
      [labels.uptime, uptime(pod.startedAt)],
      [labels.restarts, String(pod.restarts ?? "–")],
      [labels.version, pod.version ?? "–"],
    ];
    const dl = document.createElement("dl");
    dl.className = "pod";
    for (const [label, value] of rows) {
      const dt = document.createElement("dt");
      dt.textContent = label;
      const dd = document.createElement("dd");
      dd.textContent = value;
      dd.title = value;
      if (label === labels.status) {
        dd.className = pod.ready ? "is-ready" : FAILED_STATUSES.has(pod.status) ? "is-failed" : "is-waiting";
      }
      dl.append(dt, dd);
    }
    const li = document.createElement("li");
    li.append(dl);
    return li;
  }

  // Like the AGE column of kubectl: 45s, 12m, 3h4m, 2d5h.
  function uptime(startedAt) {
    const s = Math.floor((Date.now() - Date.parse(startedAt)) / 1000);
    if (!(s >= 0)) return "–";
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    if (s < 86400) return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
    return `${Math.floor(s / 86400)}d${Math.floor((s % 86400) / 3600)}h`;
  }

  setInterval(() => connected && showAge(), 1000);
  refresh();
})();
