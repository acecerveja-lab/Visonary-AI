/* Modern Strategy Prototype
   Single-file game logic. No external deps. */

(function () {
  // --- Config ---
  const MAP_W = 64;
  const MAP_H = 36;
  const TILE = 15; // pixels per tile
  const TICK_MS_BASE = 2000;
  const SAVE_KEY = "modern_strategy_save_v1";

  const COLORS = {
    ocean: "#0b1320",
    neutral: "#2b3547",
    selection: "#00bcd4",
  };

  const NATIONS = [
    { id: 1, name: "Aquila Union", color: "#3aa0ff" },
    { id: 2, name: "Vermilion Pact", color: "#ff6b6b" },
    { id: 3, name: "Emerald League", color: "#5ad49f" },
  ];

  const UNIT_TYPES = {
    INF: { name: "Infantry", speed: 1, atk: 6, def: 6, hp: 20, cost: { supplies: 60, money: 40 } },
    ARM: { name: "Armor", speed: 1, atk: 10, def: 8, hp: 30, cost: { supplies: 80, money: 120, components: 60 } },
    ART: { name: "Artillery", speed: 1, atk: 12, def: 4, hp: 16, ranged: 2, cost: { supplies: 90, components: 50, money: 80 } },
    AIR: { name: "Air Wing", speed: 3, atk: 12, def: 6, hp: 20, ranged: 3, cost: { money: 150, components: 120 } },
    NAV: { name: "Patrol Boat", speed: 1, atk: 8, def: 8, hp: 24, naval: true, cost: { supplies: 70, components: 80, money: 90 } },
  };

  const BUILDINGS = {
    FACTORY: { name: "Factory", cost: { money: 200, components: 120 }, effect: { prodBoost: 0.2 } },
    RADAR: { name: "Radar", cost: { components: 80, money: 60 }, effect: { vision: 3 } },
  };

  const TECH = [
    { id: "T_INF2", name: "Infantry Equipment II", cost: { rp: 50 }, effect: { unitBuff: { INF: { atk: +2, def: +1 } } } },
    { id: "T_ARM2", name: "Composite Armor", cost: { rp: 90 }, effect: { unitBuff: { ARM: { hp: +5, def: +2 } } } },
    { id: "T_ART2", name: "Precision Fire Control", cost: { rp: 80 }, effect: { unitBuff: { ART: { atk: +3 } } } },
    { id: "T_ECON", name: "Industrial Logistics", cost: { rp: 70 }, effect: { prodBuff: 0.1 } },
  ];

  // --- State ---
  const state = {
    tick: 0,
    speed: 1,
    paused: false,
    map: null,
    nations: [],
    cities: [],
    units: [],
    diplomacy: {}, // key: nationId -> stance map
    research: {},  // key: nationId -> { rp, unlocked: Set }
    resources: {}, // key: nationId -> resource object
    selection: { tile: null, unitId: null, cityId: null, nationId: 1 },
    orders: [], // queued moves
  };

  // --- DOM ---
  const canvas = document.getElementById("map");
  const ctx = canvas.getContext("2d");
  const tilePanel = document.getElementById("tileInfo");
  const unitPanel = document.getElementById("unitInfo");
  const cityPanel = document.getElementById("cityInfo");
  const queueList = document.getElementById("queueList");
  const nationInfo = document.getElementById("nationInfo");
  const tickInfo = document.getElementById("tickInfo");
  const techTree = document.getElementById("techTree");
  const researchInfo = document.getElementById("researchInfo");
  const dipList = document.getElementById("dipList");
  const diplomacyInfo = document.getElementById("diplomacyInfo");

  // --- Utils ---
  function randInt(a, b) { return Math.floor(Math.random() * (b - a + 1)) + a; }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function key(x, y) { return `${x},${y}`; }
  function deepClone(o) { return JSON.parse(JSON.stringify(o)); }

  // --- Map generation ---
  function genMap() {
    const tiles = new Array(MAP_W * MAP_H);
    for (let y = 0; y < MAP_H; y++) {
      for (let x = 0; x < MAP_W; x++) {
        const idx = y * MAP_W + x;
        // Simple land/ocean noise
        const ocean = y < 6 || y > MAP_H - 6 || x < 6 || x > MAP_W - 6 ? true : Math.random() < 0.18;
        tiles[idx] = { x, y, ocean, owner: 0, cityId: null, zoc: 0 };
      }
    }
    return tiles;
  }

  function seedNations() {
    state.nations = NATIONS.map(n => ({ id: n.id, name: n.name, color: n.color }));
    state.resources = {};
    state.research = {};
    state.diplomacy = {};
    for (const n of state.nations) {
      state.resources[n.id] = { supplies: 500, components: 300, money: 600, rp: 50 };
      state.research[n.id] = { rp: 0, unlocked: new Set() };
      state.diplomacy[n.id] = {};
      for (const m of state.nations) {
        if (m.id !== n.id) state.diplomacy[n.id][m.id] = "neutral";
      }
    }
  }

  function placeCapitals() {
    const spots = [
      { x: 10, y: 10 }, { x: MAP_W - 12, y: 10 }, { x: Math.floor(MAP_W / 2), y: MAP_H - 12 },
    ];
    state.cities = [];
    spots.forEach((s, i) => {
      const nationId = state.nations[i].id;
      const tile = getTile(s.x, s.y);
      tile.ocean = false;
      tile.owner = nationId;
      const city = {
        id: i + 1,
        name: `Capital ${i + 1}`,
        nationId,
        x: s.x, y: s.y,
        prod: { supplies: 10, components: 6, money: 8, rp: 2 },
        queue: [],
        buildings: [],
      };
      tile.cityId = city.id;
      state.cities.push(city);
    });
    // Spread initial territory
    for (const city of state.cities) {
      floodFill(city.x, city.y, city.nationId, 4);
    }
  }

  function floodFill(sx, sy, owner, radius) {
    const q = [{ x: sx, y: sy, d: 0 }];
    const seen = new Set();
    while (q.length) {
      const { x, y, d } = q.shift();
      const k = key(x, y);
      if (seen.has(k)) continue;
      seen.add(k);
      const t = getTile(x, y);
      if (!t || t.ocean) continue;
      t.owner = owner;
      if (d < radius) {
        for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
          q.push({ x: x + dx, y: y + dy, d: d + 1 });
        }
      }
    }
  }

  function getTile(x, y) {
    if (x < 0 || y < 0 || x >= MAP_W || y >= MAP_H) return null;
    return state.map[y * MAP_W + x];
  }

  // --- Units ---
  let unitSeq = 1;
  function spawnUnit(typeKey, nationId, x, y) {
    const type = UNIT_TYPES[typeKey];
    const unit = {
      id: unitSeq++,
      type: typeKey,
      nationId,
      x, y,
      hp: type.hp,
      orders: [],
      stance: "hold", // hold/move/fortify
    };
    state.units.push(unit);
    return unit;
  }

  // --- Rendering ---
  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // Tiles
    for (let y = 0; y < MAP_H; y++) {
      for (let x = 0; x < MAP_W; x++) {
        const t = getTile(x, y);
        const px = x * TILE;
        const py = y * TILE;
        ctx.fillStyle = t.ocean ? COLORS.ocean : (t.owner ? getNationById(t.owner).color : COLORS.neutral);
        ctx.fillRect(px, py, TILE - 1, TILE - 1);
        if (t.zoc > 0) {
          ctx.fillStyle = "rgba(255,255,255,0.06)";
          ctx.fillRect(px, py, TILE - 1, TILE - 1);
        }
        if (t.cityId) {
          ctx.fillStyle = "#ffd166";
          ctx.fillRect(px + 3, py + 3, TILE - 7, TILE - 7);
        }
      }
    }
    // Units
    for (const u of state.units) {
      const px = u.x * TILE + TILE / 2;
      const py = u.y * TILE + TILE / 2;
      ctx.strokeStyle = "#000";
      ctx.fillStyle = getNationById(u.nationId).color;
      ctx.beginPath(); ctx.arc(px, py, 5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      // Health bar
      ctx.fillStyle = "#111"; ctx.fillRect(px - 8, py + 6, 16, 3);
      const hpPct = clamp(u.hp / UNIT_TYPES[u.type].hp, 0, 1);
      ctx.fillStyle = hpPct > 0.5 ? "#27ae60" : (hpPct > 0.25 ? "#f2c94c" : "#eb5757");
      ctx.fillRect(px - 8, py + 6, 16 * hpPct, 3);
    }
    // Selection
    if (state.selection.tile) {
      const { x, y } = state.selection.tile;
      ctx.strokeStyle = COLORS.selection;
      ctx.lineWidth = 2;
      ctx.strokeRect(x * TILE + 1, y * TILE + 1, TILE - 3, TILE - 3);
    }
  }

  function getNationById(id) {
    return state.nations.find(n => n.id === id);
  }

  // --- UI updates ---
  function updatePanels() {
    const me = getNationById(state.selection.nationId);
    const r = state.resources[me.id];
    nationInfo.innerHTML = `
      <div><strong>${me.name}</strong></div>
      <div>Supplies: ${r.supplies} | Components: ${r.components} | Money: ${r.money} | RP: ${r.rp}</div>
    `;
    tickInfo.textContent = `Tick: ${state.tick} | Speed: ${state.speed}x`;

    if (state.selection.tile) {
      const t = state.selection.tile;
      const owner = t.owner ? getNationById(t.owner).name : "Unclaimed";
      tilePanel.innerHTML = `
        <div>Tile: ${t.x}, ${t.y}</div>
        <div>Owner: ${owner} ${t.ocean ? "(Ocean)" : ""}</div>
        <div>City: ${t.cityId ? getCity(t.cityId).name : "-"}</div>
      `;
    } else {
      tilePanel.textContent = "Select a tile";
    }

    if (state.selection.unitId) {
      const u = getUnit(state.selection.unitId);
      if (u) {
        const type = UNIT_TYPES[u.type];
        unitPanel.innerHTML = `
          <div>Unit: ${type.name} #${u.id}</div>
          <div>Pos: ${u.x}, ${u.y} | HP: ${u.hp}/${type.hp} | Stance: ${u.stance}</div>
          <div>Orders: ${u.orders.length}</div>
        `;
      } else unitPanel.textContent = "Select a unit";
    }

    if (state.selection.cityId) {
      const c = getCity(state.selection.cityId);
      const prodTxt = `+${c.prod.supplies}S | +${c.prod.components}C | +${c.prod.money}M | +${c.prod.rp}RP / tick`;
      cityPanel.innerHTML = `
        <div>${c.name} (${c.x},${c.y})</div>
        <div>Nation: ${getNationById(c.nationId).name}</div>
        <div>Production: ${prodTxt}</div>
      `;
      renderQueue(c);
    } else {
      cityPanel.textContent = "Select a city";
      queueList.innerHTML = "";
    }

    renderTech();
    renderDip();
  }

  function getCity(id) { return state.cities.find(c => c.id === id); }
  function getUnit(id) { return state.units.find(u => u.id === id); }

  function renderQueue(c) {
    queueList.innerHTML = "";
    if (!c.queue.length) {
      queueList.innerHTML = "<div class='item'><em>No items queued.</em></div>";
      return;
    }
    for (const q of c.queue) {
      const div = document.createElement("div");
      div.className = "item";
      div.innerHTML = `
        <span>${q.kind} ${q.type || ""}</span>
        <span class="badge ${q.done ? "ok" : "no"}">${q.done ? "Complete" : `ETA ${q.eta}`}</span>
      `;
      queueList.appendChild(div);
    }
  }

  function renderTech() {
    const me = getNationById(state.selection.nationId);
    const res = state.resources[me.id];
    const r = state.research[me.id];
    researchInfo.innerHTML = `RP Available: ${res.rp} | Unlocked: ${[...r.unlocked].join(", ") || "-"}`;
    techTree.innerHTML = "";
    for (const t of TECH) {
      const unlocked = r.unlocked.has(t.id);
      const item = document.createElement("div");
      item.className = "item";
      item.innerHTML = `
        <span>${t.name} (Cost: ${t.cost.rp} RP)</span>
        <span>
          <button ${unlocked || res.rp < t.cost.rp ? "disabled" : ""} data-tech="${t.id}">${unlocked ? "Unlocked" : "Research"}</button>
        </span>
      `;
      techTree.appendChild(item);
    }
  }

  function renderDip() {
    const me = getNationById(state.selection.nationId);
    diplomacyInfo.innerHTML = `You are ${me.name}. Set stances or send offers.`;
    dipList.innerHTML = "";
    for (const other of state.nations) {
      if (other.id === me.id) continue;
      const stance = state.diplomacy[me.id][other.id];
      const row = document.createElement("div");
      row.className = "item";
      row.innerHTML = `
        <span>${other.name}</span>
        <span>
          <select data-other="${other.id}">
            <option value="neutral" ${stance === "neutral" ? "selected" : ""}>Neutral</option>
            <option value="peace" ${stance === "peace" ? "selected" : ""}>Peace</option>
            <option value="war" ${stance === "war" ? "selected" : ""}>War</option>
          </select>
        </span>
      `;
      dipList.appendChild(row);
    }
  }

  // --- Input ---
  canvas.addEventListener("click", (e) => {
    const rect = canvas.getBoundingClientRect();
    const x = Math.floor((e.clientX - rect.left) / TILE);
    const y = Math.floor((e.clientY - rect.top) / TILE);
    const t = getTile(x, y);
    if (!t) return;
    state.selection.tile = t;
    state.selection.cityId = t.cityId;
    const unit = state.units.find(u => u.x === x && u.y === y && u.nationId === state.selection.nationId);
    state.selection.unitId = unit ? unit.id : null;
    updatePanels();
    draw();
  });

  canvas.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    if (!state.selection.unitId) return;
    const rect = canvas.getBoundingClientRect();
    const x = Math.floor((e.clientX - rect.left) / TILE);
    const y = Math.floor((e.clientY - rect.top) / TILE);
    const u = getUnit(state.selection.unitId);
    if (!u) return;
    u.orders.push({ type: "move", x, y });
    u.stance = "move";
    updatePanels();
  });

  document.getElementById("btnPause").onclick = () => { state.paused = true; };
  document.getElementById("btnPlay").onclick = () => { state.paused = false; state.speed = 1; };
  document.getElementById("btnFast").onclick = () => { state.paused = false; state.speed = 3; };
  document.getElementById("btnSave").onclick = saveGame;
  document.getElementById("btnLoad").onclick = loadGame;
  document.getElementById("btnNew").onclick = newGame;

  document.getElementById("btnQueue").onclick = () => {
    const sel = document.getElementById("buildSelect").value;
    if (!sel || !state.selection.cityId) return;
    const city = getCity(state.selection.cityId);
    if (UNIT_TYPES[sel]) {
      city.queue.push({ kind: "UNIT", type: sel, eta: 3, done: false });
    } else if (BUILDINGS[sel]) {
      city.queue.push({ kind: "BLDG", type: sel, eta: 3, done: false });
    }
    renderQueue(city);
  };
  document.getElementById("btnClearQueue").onclick = () => {
    if (!state.selection.cityId) return;
    const city = getCity(state.selection.cityId);
    city.queue = [];
    renderQueue(city);
  };

  document.getElementById("btnHold").onclick = () => {
    const u = getUnit(state.selection.unitId); if (u) u.stance = "hold";
    updatePanels();
  };
  document.getElementById("btnMove").onclick = () => {
    const u = getUnit(state.selection.unitId); if (u) u.stance = "move";
    updatePanels();
  };
  document.getElementById("btnFortify").onclick = () => {
    const u = getUnit(state.selection.unitId); if (u) u.stance = "fortify";
    updatePanels();
  };
  document.getElementById("btnDelete").onclick = () => {
    if (!state.selection.unitId) return;
    state.units = state.units.filter(u => u.id !== state.selection.unitId);
    state.selection.unitId = null;
    updatePanels();
    draw();
  };

  document.getElementById("techTree").addEventListener("click", (e) => {
    if (e.target.tagName === "BUTTON" && e.target.dataset.tech) {
      const techId = e.target.dataset.tech;
      const me = getNationById(state.selection.nationId);
      const res = state.resources[me.id];
      const t = TECH.find(x => x.id === techId);
      const r = state.research[me.id];
      if (!r.unlocked.has(techId) && res.rp >= t.cost.rp) {
        res.rp -= t.cost.rp;
        r.unlocked.add(techId);
      }
      applyTech(me.id);
      renderTech();
    }
  });

  document.getElementById("diplomacyPanel").addEventListener("change", (e) => {
    if (e.target.tagName === "SELECT" && e.target.dataset.other) {
      const otherId = parseInt(e.target.dataset.other, 10);
      const me = getNationById(state.selection.nationId);
      state.diplomacy[me.id][otherId] = e.target.value;
    }
  });

  // --- Tech effects ---
  function applyTech(nationId) {
    const r = state.research[nationId];
    for (const t of TECH) {
      if (!r.unlocked.has(t.id)) continue;
      if (t.effect.prodBuff) {
        for (const c of state.cities.filter(c => c.nationId === nationId)) {
          c.prod.supplies = Math.round(c.prod.supplies * (1 + t.effect.prodBuff));
          c.prod.components = Math.round(c.prod.components * (1 + t.effect.prodBuff));
          c.prod.money = Math.round(c.prod.money * (1 + t.effect.prodBuff));
        }
      }
      if (t.effect.unitBuff) {
        for (const [typeKey, buff] of Object.entries(t.effect.unitBuff)) {
          for (const u of state.units.filter(u => u.nationId === nationId && u.type === typeKey)) {
            if (buff.atk) u.atkBuff = (u.atkBuff || 0) + buff.atk;
            if (buff.def) u.defBuff = (u.defBuff || 0) + buff.def;
            if (buff.hp) { u.hp += buff.hp; }
          }
        }
      }
    }
  }

  // --- Production & economy ---
  function processEconomy() {
    for (const c of state.cities) {
      const res = state.resources[c.nationId];
      res.supplies += c.prod.supplies;
      res.components += c.prod.components;
      res.money += c.prod.money;
      res.rp += c.prod.rp;
      // Queue processing
      if (c.queue.length) {
        const head = c.queue[0];
        head.eta -= 1;
        if (head.eta <= 0) {
          if (head.kind === "UNIT") {
            if (payCost(c.nationId, UNIT_TYPES[head.type].cost)) {
              spawnUnit(head.type, c.nationId, c.x, c.y);
              head.done = true;
              c.queue.shift();
            } else {
              head.eta = 1; // retry next tick if not enough resources
            }
          } else if (head.kind === "BLDG") {
            const b = BUILDINGS[head.type];
            if (payCost(c.nationId, b.cost)) {
              c.buildings.push(head.type);
              // Apply building effect
              if (b.effect.prodBoost) {
                c.prod.supplies = Math.round(c.prod.supplies * (1 + b.effect.prodBoost));
                c.prod.components = Math.round(c.prod.components * (1 + b.effect.prodBoost));
                c.prod.money = Math.round(c.prod.money * (1 + b.effect.prodBoost));
              }
              head.done = true;
              c.queue.shift();
            } else {
              head.eta = 1;
            }
          }
        }
      }
    }
  }

  function payCost(nationId, cost) {
    const res = state.resources[nationId];
    for (const [k, v] of Object.entries(cost)) {
      if ((res[k] || 0) < v) return false;
    }
    for (const [k, v] of Object.entries(cost)) {
      res[k] -= v;
    }
    return true;
  }

  // --- Movement & combat ---
  function stepUnits() {
    // reset zoc
    for (const t of state.map) t.zoc = 0;
    for (const u of state.units) {
      // Mark zone of control
      const neighbors = [[1,0],[-1,0],[0,1],[0,-1]];
      for (const [dx, dy] of neighbors) {
        const t = getTile(u.x + dx, u.y + dy);
        if (t && !t.ocean) t.zoc = 1;
      }
    }

    for (const u of state.units) {
      if (u.stance === "move" && u.orders.length) {
        const order = u.orders[0];
        const path = stepToward(u.x, u.y, order.x, order.y, UNIT_TYPES[u.type].speed);
        if (path.length) {
          const next = path[0];
          const t = getTile(next.x, next.y);
          if (t && !t.ocean) {
            // Capture territory
            t.owner = u.nationId;
            u.x = next.x; u.y = next.y;
          }
        }
        if (u.x === order.x && u.y === order.y) u.orders.shift();
      }
    }

    // Ranged attacks then melee
    for (const u of state.units) {
      const ut = UNIT_TYPES[u.type];
      const range = ut.ranged || 0;
      if (range > 0) {
        const targets = state.units.filter(v =>
          v.nationId !== u.nationId && dist(u, v) <= range);
        if (targets.length) {
          const target = targets[0];
          dmgUnit(target, ut.atk, "ranged");
        }
      }
    }

    // Melee in same tile
    const tileUnits = new Map();
    for (const u of state.units) {
      const k = key(u.x, u.y);
      if (!tileUnits.has(k)) tileUnits.set(k, []);
      tileUnits.get(k).push(u);
    }
    for (const list of tileUnits.values()) {
      const factions = new Set(list.map(u => u.nationId));
      if (factions.size > 1) {
        // pairwise skirmish
        for (const u of list) {
          for (const v of list) {
            if (u.nationId !== v.nationId) {
              dmgUnit(v, UNIT_TYPES[u.type].atk, "melee");
            }
          }
        }
      }
    }

    // Attrition (in enemy ZOC)
    for (const u of state.units) {
      const t = getTile(u.x, u.y);
      if (t && t.owner && t.owner !== u.nationId && t.zoc) {
        u.hp -= 1;
      }
    }

    // Remove destroyed units
    state.units = state.units.filter(u => u.hp > 0);
  }

  function stepToward(x, y, tx, ty, speed) {
    const path = [];
    let cx = x, cy = y;
    for (let i = 0; i < speed; i++) {
      if (cx === tx && cy === ty) break;
      const dx = tx - cx, dy = ty - cy;
      const nx = cx + Math.sign(dx);
      const ny = cy + Math.sign(dy);
      path.push({ x: nx, y: ny });
      cx = nx; cy = ny;
    }
    return path;
  }

  function dist(a, b) {
    return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
  }

  function dmgUnit(u, atk, kind) {
    const def = UNIT_TYPES[u.type].def + (u.defBuff || 0);
    const delta = clamp(Math.round(atk - def / 2), 1, 12);
    u.hp -= delta;
  }

  // --- AI (simple) ---
  function aiStep() {
    for (const n of state.nations) {
      if (n.id === state.selection.nationId) continue; // player nation
      const myUnits = state.units.filter(u => u.nationId === n.id);
      const enemyCities = state.cities.filter(c => c.nationId !== n.id);
      if (!myUnits.length || !enemyCities.length) continue;
      const target = enemyCities[randInt(0, enemyCities.length - 1)];
      for (const u of myUnits) {
        if (!u.orders.length) {
          u.orders.push({ type: "move", x: target.x, y: target.y });
          u.stance = "move";
        }
      }
    }
  }

  // --- Tick loop ---
  let lastTick = 0;
  function loop(ts) {
    if (!lastTick) lastTick = ts;
    const interval = TICK_MS_BASE / state.speed;
    if (!state.paused && ts - lastTick > interval) {
      lastTick = ts;
      state.tick++;
      processEconomy();
      stepUnits();
      aiStep();
      updatePanels();
      draw();
    }
    requestAnimationFrame(loop);
  }

  // --- Save/Load ---
  function saveGame() {
    const payload = deepClone({
      tick: state.tick,
      speed: state.speed,
      nations: state.nations,
      resources: state.resources,
      research: Object.fromEntries(Object.entries(state.research).map(([k, v]) => [k, { rp: v.rp, unlocked: [...v.unlocked] } ])),
      map: state.map,
      cities: state.cities,
      units: state.units,
      diplomacy: state.diplomacy,
      selection: state.selection,
    });
    localStorage.setItem(SAVE_KEY, JSON.stringify(payload));
    alert("Game saved.");
  }

  function loadGame() {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) { alert("No save found."); return; }
    const data = JSON.parse(raw);
    Object.assign(state, data);
    // restore sets
    for (const [nid, r] of Object.entries(state.research)) {
      state.research[nid].unlocked = new Set(r.unlocked);
    }
    draw(); updatePanels();
  }

  function newGame() {
    state.tick = 0; state.speed = 1; state.paused = false;
    state.map = genMap();
    seedNations();
    placeCapitals();
    state.units = [];
    // Starter armies
    for (const c of state.cities) {
      spawnUnit("INF", c.nationId, c.x + 1, c.y);
      spawnUnit("ARM", c.nationId, c.x, c.y + 1);
      spawnUnit("ART", c.nationId, c.x - 1, c.y);
    }
    state.selection = { tile: null, unitId: null, cityId: null, nationId: 1 };
    draw(); updatePanels();
  }

  // --- Boot ---
  function boot() {
    canvas.width = MAP_W * TILE;
    canvas.height = MAP_H * TILE;
    newGame();
    requestAnimationFrame(loop);
  }

  boot();
})();
