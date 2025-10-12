(() => {
  'use strict';

  const CANVAS_W = 960;
  const CANVAS_H = 540;
  const PLAYER_SPEED = 180;
  const PLAYER_R = 10;
  const PS_BASE = 100;
  const XP_ATTRACT_BASE = 100;
  const XP_ORB_LIFE = 15;
  const WALL_FIRST_TIME = 10;
  const WALL_INTERVAL = 20;
  const WALL_SHRINK_T = 8;
  const WALL_FIRST_THRESHOLD = 12;
  const WALL_GROWTH = 1.25;
  const WALL_DPS0 = 5;
  const WALL_DPS_RATE = 1.2;
  const ENEMY_SPAWN_COOLDOWN_MIN = 0.8;
  const ENEMY_SPAWN_COOLDOWN_MAX = 1.6;
  const TARGET_ENEMIES_MAX_TIME = 10;
  const TARGET_ENEMIES_MAX_ALL = 20;
  const FIXED_DT = 1 / 60;
  const ENEMY_BASE_SPEED = 100;
  const ENEMY_OUT_MARGIN = 32;
  const XP_ORB_RADIUS = 6;

  const SurvivalMultiplierDefaults = {
    id: 'survival',
    M: 1.1,
    n: 1,
    delta0: 0.005,
    a: 0.0015,
    S: 40,
  };

  const canvas = document.getElementById('game-canvas');
  const ctx = canvas.getContext('2d');
  const hpDisplay = document.getElementById('hp-display');
  const psDisplay = document.getElementById('ps-display');
  const scoreDisplay = document.getElementById('score-display');
  const levelText = document.getElementById('level-text');
  const xpText = document.getElementById('xp-text');
  const xpBarFill = document.getElementById('xp-bar-fill');
  const xpRangeStacks = document.getElementById('xp-range-stacks');
  const xpSweepCount = document.getElementById('xp-sweep-count');
  const xpSweepButton = document.getElementById('xp-sweep-button');
  const toastContainer = document.getElementById('toast-container');
  const gameOverPanel = document.getElementById('game-over');

  class Random {
    constructor(seed) {
      this.seed = seed >>> 0;
    }
    next() {
      this.seed += 0x6d2b79f5;
      let t = this.seed;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    range(min, max) {
      return min + (max - min) * this.next();
    }
    int(min, max) {
      return Math.floor(this.range(min, max + 1));
    }
    pick(arr) {
      return arr[Math.floor(this.next() * arr.length)];
    }
  }

  function vec2(x = 0, y = 0) {
    return { x, y };
  }

  function add(a, b) {
    return { x: a.x + b.x, y: a.y + b.y };
  }

  function sub(a, b) {
    return { x: a.x - b.x, y: a.y - b.y };
  }

  function mulScalar(v, s) {
    return { x: v.x * s, y: v.y * s };
  }

  function length(v) {
    return Math.hypot(v.x, v.y);
  }

  function normalize(v) {
    const len = length(v);
    if (len === 0) return { x: 0, y: 0 };
    return { x: v.x / len, y: v.y / len };
  }

  function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function lerpVec(a, b, t) {
    return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) };
  }

  function targetEnemies(tSec, breaks) {
    const base = Math.min(3 + Math.floor(tSec / 10), 10);
    const bonus = Math.min(breaks, 10);
    return Math.min(base + bonus, TARGET_ENEMIES_MAX_ALL);
  }

  function spawnWeights(b) {
    if (b === 0) return { Basic: 1 };
    if (b === 1) return { Basic: 0.7, Swift: 0.3 };
    if (b === 2) return { Basic: 0.55, Swift: 0.25, Zigzag: 0.2 };
    if (b === 3) return { Basic: 0.45, Swift: 0.25, Zigzag: 0.2, Wanderer: 0.1 };
    if (b === 4) return { Basic: 0.35, Swift: 0.25, Zigzag: 0.2, Wanderer: 0.1, Blitz: 0.1 };
    return { Basic: 0.25, Swift: 0.25, Zigzag: 0.2, Wanderer: 0.1, Blitz: 0.1, Heavy: 0.1 };
  }

  function weightedPick(rng, weights) {
    let sum = 0;
    for (const key in weights) sum += weights[key];
    const r = rng.range(0, sum);
    let acc = 0;
    for (const key in weights) {
      acc += weights[key];
      if (r <= acc) return key;
    }
    return Object.keys(weights)[0];
  }

  function nextXpNeeded(level) {
    const table = [5, 5, 5, 5, 8, 12, 18, 25, 35];
    if (level - 1 < table.length) {
      return table[level - 1];
    }
    const extraLevel = level - table.length;
    const base = table[table.length - 1];
    return Math.ceil(base * Math.pow(1.3, extraLevel));
  }

  function tickSurvivalMultiplier(m) {
    const n = m.n;
    const aEff = m.a * (m.S / (m.S + n));
    const delta = m.delta0 + aEff * Math.max(0, n - 1);
    m.M += delta;
    m.n += 1;
  }

  function wallThresholdAt(index) {
    if (index === 0) return WALL_FIRST_THRESHOLD;
    let threshold = WALL_FIRST_THRESHOLD;
    for (let i = 1; i <= index; i++) {
      threshold = Math.ceil(threshold * WALL_GROWTH);
    }
    return threshold;
  }

  function spawnWall(index, state) {
    const center = { x: CANVAS_W / 2, y: CANVAS_H / 2 };
    const maxRadius = Math.hypot(CANVAS_W, CANVAS_H) / 2 + 120;
    const wall = {
      active: true,
      t: 0,
      T: WALL_SHRINK_T,
      rStart: maxRadius,
      rEnd: 60,
      threshold: wallThresholdAt(index),
      center,
      entered: false,
      success: false,
      damageElapsed: 0,
      currentDps: WALL_DPS0,
    };
    addToast(`デッドライン出現！ スコア${wall.threshold}以上で突破`);
    return wall;
  }

  function createPlayer() {
    return {
      pos: { x: CANVAS_W / 2, y: CANVAS_H / 2 },
      vel: { x: 0, y: 0 },
      r: PLAYER_R,
      hp: 100,
      maxHp: 100,
      speed: PLAYER_SPEED,
      level: 1,
      xp: 0,
      xpNeeded: nextXpNeeded(1),
      psRadius: PS_BASE,
      xpAttractRadius: XP_ATTRACT_BASE,
      psMultiplier: 1,
      xpRangeStacks: 0,
      score: 0,
    multipliers: [{
      id: SurvivalMultiplierDefaults.id,
      M: SurvivalMultiplierDefaults.M,
      n: SurvivalMultiplierDefaults.n,
      delta0: SurvivalMultiplierDefaults.delta0,
      a: SurvivalMultiplierDefaults.a,
      S: SurvivalMultiplierDefaults.S,
    }],
    };
  }

  function spawnEnemy(state, type) {
    const margin = 30;
    const side = state.rng.int(0, 3);
    let pos;
    if (side === 0) pos = { x: -margin, y: state.rng.range(0, CANVAS_H) };
    else if (side === 1) pos = { x: CANVAS_W + margin, y: state.rng.range(0, CANVAS_H) };
    else if (side === 2) pos = { x: state.rng.range(0, CANVAS_W), y: -margin };
    else pos = { x: state.rng.range(0, CANVAS_W), y: CANVAS_H + margin };

    const enemy = {
      type,
      pos,
      vel: vec2(),
      r: PLAYER_R,
      speed: ENEMY_BASE_SPEED,
      ai: {},
      life: 18,
    };

    switch (type) {
      case 'Basic':
        enemy.speed = ENEMY_BASE_SPEED;
        enemy.r = 10;
        break;
      case 'Swift':
        enemy.speed = ENEMY_BASE_SPEED * 1.5;
        enemy.r = 10;
        break;
      case 'Zigzag':
        enemy.speed = ENEMY_BASE_SPEED * 1.2;
        enemy.r = 10;
        enemy.ai.phase = 0;
        break;
      case 'Wanderer':
        enemy.speed = ENEMY_BASE_SPEED * 0.9;
        enemy.r = 11;
        enemy.ai.timer = 0;
        enemy.ai.dir = vec2(1, 0);
        break;
      case 'Blitz':
        enemy.speed = ENEMY_BASE_SPEED * 2.0;
        enemy.r = 10;
        enemy.ai.timer = 0;
        enemy.ai.dir = normalize(sub(state.player.pos, enemy.pos));
        break;
      case 'Heavy':
        enemy.speed = ENEMY_BASE_SPEED * 0.6;
        enemy.r = 16;
        enemy.ai.dir = vec2();
        break;
    }
    return enemy;
  }

  function spawnXpOrb(state, point) {
    const orb = {
      pos: { x: point.x, y: point.y },
      vel: vec2(),
      life: XP_ORB_LIFE,
      blink: false,
    };
    state.xpOrbs.push(orb);
  }

  function applyXpToPlayer(state, amount) {
    const player = state.player;
    player.xp += amount;
    while (player.xp >= player.xpNeeded) {
      player.xp -= player.xpNeeded;
      player.level += 1;
      player.xpNeeded = nextXpNeeded(player.level);
      addToast(`レベルアップ！ Lv${player.level}`);
      autoGrantXpRange(state);
      if (player.level % 3 === 0) {
        state.xpSweepCharges += 1;
        addToast('XP全回収を獲得！');
      }
    }
  }

  function autoGrantXpRange(state) {
    const player = state.player;
    if (player.xpRangeStacks >= 3) return;
    player.xpRangeStacks += 1;
    player.xpAttractRadius = XP_ATTRACT_BASE * Math.pow(1.1, player.xpRangeStacks);
    addToast(`XP吸引範囲 +10% (x${player.xpRangeStacks})`);
  }

  function pickXpIfCollide(state) {
    const player = state.player;
    const keep = [];
    for (const orb of state.xpOrbs) {
      const dist = Math.hypot(orb.pos.x - player.pos.x, orb.pos.y - player.pos.y);
      if (dist <= player.r + XP_ORB_RADIUS) {
        applyXpToPlayer(state, 1);
      } else {
        keep.push(orb);
      }
    }
    state.xpOrbs = keep;
  }

  function consumeXpSweep(state) {
    if (state.xpSweepCharges <= 0) return;
    state.xpSweepCharges -= 1;
    let total = 0;
    for (const orb of state.xpOrbs) {
      total += 1;
    }
    if (total > 0) {
      applyXpToPlayer(state, total);
      addToast(`XP全回収：${total} 獲得`);
    } else {
      addToast('XP全回収：回収対象なし');
    }
    state.xpOrbs = [];
  }

  function handleWallCollision(state, dt) {
    const wall = state.wall;
    if (!wall || !wall.active) return;
    const player = state.player;
    const dist = Math.hypot(player.pos.x - wall.center.x, player.pos.y - wall.center.y);
    const currentRadius = lerp(wall.rStart, wall.rEnd, clamp(wall.t / wall.T, 0, 1));
    wall.currentRadius = currentRadius;
    const inside = dist <= currentRadius;

    if (inside) {
      if (!wall.entered) {
        wall.entered = true;
        if (player.score >= wall.threshold) {
          wall.success = true;
          wall.active = false;
          state.breaks += 1;
          state.nextWallIndex += 1;
          addToast(`デッドライン突破！ (${state.breaks})`);
          state.xpSweepCharges += 1;
          addToast('XP全回収を獲得！');
        } else {
          addToast('スコア不足！デッドラインに耐えろ');
        }
      }
      if (!wall.success && player.score >= wall.threshold) {
        wall.success = true;
        wall.active = false;
        state.breaks += 1;
        state.nextWallIndex += 1;
        addToast(`デッドライン突破！ (${state.breaks})`);
        state.xpSweepCharges += 1;
        addToast('XP全回収を獲得！');
      }
      if (!wall.success) {
        wall.damageElapsed += dt;
        if (wall.damageElapsed >= 1) {
          wall.damageElapsed -= 1;
          const damage = wall.currentDps;
          player.hp -= damage;
          wall.currentDps *= WALL_DPS_RATE;
          addToast(`デッドラインダメージ -${damage.toFixed(1)}`);
          if (player.hp <= 0) {
            player.hp = 0;
            triggerGameOver(state);
          }
        }
      }
    } else {
      if (!wall.success) {
        wall.damageElapsed = 0;
        wall.currentDps = WALL_DPS0;
      }
    }
  }

  function triggerGameOver(state) {
    if (!state.running) return;
    state.running = false;
    gameOverPanel.classList.remove('hidden');
    addToast('ゲームオーバー');
  }

  function updateEnemy(state, enemy, dt) {
    const player = state.player;
    switch (enemy.type) {
      case 'Basic': {
        const desired = mulScalar(normalize(sub(player.pos, enemy.pos)), enemy.speed);
        enemy.vel = lerpVec(enemy.vel, desired, 0.25);
        break;
      }
      case 'Swift': {
        const desired = mulScalar(normalize(sub(player.pos, enemy.pos)), enemy.speed);
        enemy.vel = lerpVec(enemy.vel, desired, 0.3);
        break;
      }
      case 'Zigzag': {
        enemy.ai.phase = (enemy.ai.phase || 0) + dt;
        const baseDir = normalize(sub(player.pos, enemy.pos));
        const baseAngle = Math.atan2(baseDir.y, baseDir.x);
        const angle = baseAngle + (Math.PI / 6) * Math.sin(enemy.ai.phase * Math.PI * 2);
        const desired = { x: Math.cos(angle) * enemy.speed, y: Math.sin(angle) * enemy.speed };
        enemy.vel = lerpVec(enemy.vel, desired, 0.28);
        break;
      }
      case 'Wanderer': {
        enemy.ai.timer -= dt;
        if (enemy.ai.timer <= 0) {
          enemy.ai.timer = 1 + state.rng.next();
          const angle = state.rng.range(0, Math.PI * 2);
          enemy.ai.dir = { x: Math.cos(angle), y: Math.sin(angle) };
        }
        const desired = mulScalar(enemy.ai.dir, enemy.speed);
        enemy.vel = lerpVec(enemy.vel, desired, 0.12);
        break;
      }
      case 'Blitz': {
        enemy.ai.timer -= dt;
        if (enemy.ai.timer <= 0) {
          enemy.ai.timer = 0.8;
          const dir = normalize(sub(player.pos, enemy.pos));
          const jitter = state.rng.range(-0.2, 0.2);
          const angle = Math.atan2(dir.y, dir.x) + jitter;
          enemy.ai.dir = { x: Math.cos(angle), y: Math.sin(angle) };
        }
        enemy.vel = mulScalar(enemy.ai.dir, enemy.speed);
        break;
      }
      case 'Heavy': {
        const desiredDir = normalize(sub(player.pos, enemy.pos));
        const desired = mulScalar(desiredDir, enemy.speed);
        enemy.vel = lerpVec(enemy.vel, desired, 0.12);
        break;
      }
    }
    enemy.pos = add(enemy.pos, mulScalar(enemy.vel, dt));
  }

  function updateEnemies(state, dt) {
    const keep = [];
    for (const enemy of state.enemies) {
      updateEnemy(state, enemy, dt);
      enemy.life -= dt;
      if (enemy.life <= 0) {
        spawnXpOrb(state, randomPointAvoidingWall(state));
        continue;
      }
      if (
        enemy.pos.x < -ENEMY_OUT_MARGIN ||
        enemy.pos.x > CANVAS_W + ENEMY_OUT_MARGIN ||
        enemy.pos.y < -ENEMY_OUT_MARGIN ||
        enemy.pos.y > CANVAS_H + ENEMY_OUT_MARGIN
      ) {
        spawnXpOrb(state, randomPointAvoidingWall(state));
        continue;
      }
      keep.push(enemy);
    }
    state.enemies = keep;
  }

  function randomPointAvoidingWall(state) {
    const wall = state.wall;
    for (let attempts = 0; attempts < 10; attempts++) {
      const p = {
        x: state.rng.range(40, CANVAS_W - 40),
        y: state.rng.range(40, CANVAS_H - 40),
      };
      if (wall && wall.active) {
        const dist = Math.hypot(p.x - wall.center.x, p.y - wall.center.y);
        const radius = lerp(wall.rStart, wall.rEnd, clamp(wall.t / wall.T, 0, 1));
        if (dist < radius) continue;
      }
      return p;
    }
    return {
      x: state.rng.range(40, CANVAS_W - 40),
      y: state.rng.range(40, CANVAS_H - 40),
    };
  }

  function updateXpOrbs(state, dt) {
    const player = state.player;
    const keep = [];
    for (const orb of state.xpOrbs) {
      orb.life -= dt;
      if (orb.life <= 0) continue;
      if (orb.life <= 5) {
        orb.blink = !orb.blink;
      }
      const toPlayer = sub(player.pos, orb.pos);
      const dist = length(toPlayer);
      if (dist <= player.xpAttractRadius) {
        const dir = normalize(toPlayer);
        orb.vel = lerpVec(orb.vel, mulScalar(dir, 220), 0.3);
      } else {
        orb.vel = lerpVec(orb.vel, vec2(), 0.08);
      }
      orb.pos = add(orb.pos, mulScalar(orb.vel, dt));
      keep.push(orb);
    }
    state.xpOrbs = keep;
  }

  function refillEnemies(state, dt) {
    if (state.spawnPaused) return;
    state.spawnCooldown -= dt;
    const target = targetEnemies(Math.floor(state.time), state.breaks);
    const weights = spawnWeights(state.breaks);
    while (state.enemies.length < target && state.spawnCooldown <= 0) {
      const type = weightedPick(state.rng, weights);
      state.enemies.push(spawnEnemy(state, type));
      state.spawnCooldown = state.rng.range(ENEMY_SPAWN_COOLDOWN_MIN, ENEMY_SPAWN_COOLDOWN_MAX);
    }
  }

  function updatePlayer(state, dt) {
    const player = state.player;
    const dir = { x: inputState.right - inputState.left, y: inputState.down - inputState.up };
    const len = length(dir);
    let move = vec2();
    if (len > 0) {
      const normalized = { x: dir.x / len, y: dir.y / len };
      move = mulScalar(normalized, player.speed * dt);
    }
    player.pos = add(player.pos, move);
    player.pos.x = clamp(player.pos.x, player.r, CANVAS_W - player.r);
    player.pos.y = clamp(player.pos.y, player.r, CANVAS_H - player.r);
  }

  function updateWall(state, dt) {
    const wall = state.wall;
    if (!wall || !wall.active) return;
    wall.t += dt;
    if (wall.t >= wall.T && !wall.success) {
      // Wall completed shrinking, keep active but cap radius
      wall.t = wall.T;
    }
  }

  function updateScore(state, dt) {
    state.scoreTimer += dt;
    state.multiplierTimer += dt;
    const player = state.player;
    while (state.multiplierTimer >= 1) {
      state.multiplierTimer -= 1;
      for (const m of player.multipliers) {
        tickSurvivalMultiplier(m);
      }
    }
    while (state.scoreTimer >= 1) {
      const perSecond = player.level * player.multipliers.reduce((acc, m) => acc * m.M, 1);
      player.score += perSecond;
      state.scoreTimer -= 1;
    }
  }

  function updateDamageFromEnemies(state) {
    const player = state.player;
    for (const enemy of state.enemies) {
      const dist = Math.hypot(enemy.pos.x - player.pos.x, enemy.pos.y - player.pos.y);
      if (dist < enemy.r + player.r) {
        player.hp -= 10 * (1 / 60);
        if (player.hp <= 0) {
          player.hp = 0;
          triggerGameOver(state);
        }
      }
    }
  }

  function addToast(message, duration = 3) {
    const toast = { message, duration, life: duration, element: null };
    state.toasts.push(toast);
    const div = document.createElement('div');
    div.className = 'toast';
    div.textContent = message;
    toast.element = div;
    toastContainer.appendChild(div);
  }

  function updateToasts(dt) {
    const keep = [];
    for (const toast of state.toasts) {
      toast.life -= dt;
      if (toast.life <= 0) {
        if (toast.element && toast.element.parentElement) {
          toast.element.parentElement.removeChild(toast.element);
        }
      } else {
        keep.push(toast);
      }
    }
    state.toasts = keep;
  }

  function updateUI(state) {
    const player = state.player;
    hpDisplay.textContent = `HP: ${Math.ceil(player.hp)}/${player.maxHp}`;
    psDisplay.textContent = `PS: ${player.psRadius.toFixed(0)}px`;
    scoreDisplay.textContent = `Score: ${Math.floor(player.score)}`;
    levelText.textContent = player.level;
    xpText.textContent = `${Math.floor(player.xp)}/${player.xpNeeded}`;
    const ratio = clamp(player.xp / player.xpNeeded, 0, 1);
    xpBarFill.style.width = `${ratio * 100}%`;
    xpRangeStacks.textContent = player.xpRangeStacks;
    xpSweepCount.textContent = state.xpSweepCharges;
    xpSweepButton.disabled = state.xpSweepCharges <= 0;
  }

  function draw(state) {
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
    ctx.save();
    ctx.fillStyle = '#05060b';
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
    ctx.restore();

    const player = state.player;

    // Draw deadline wall
    if (state.wall && state.wall.active) {
      const wall = state.wall;
      const radius = wall.currentRadius ?? lerp(wall.rStart, wall.rEnd, clamp(wall.t / wall.T, 0, 1));
      ctx.save();
      ctx.beginPath();
      ctx.arc(wall.center.x, wall.center.y, radius, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(210, 40, 60, 0.35)';
      ctx.fill();

      ctx.clip();
      ctx.strokeStyle = 'rgba(255, 120, 140, 0.35)';
      ctx.lineWidth = 6;
      for (let x = -radius; x < radius * 2; x += 20) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x + radius * 2, radius * 2);
        ctx.stroke();
      }
      ctx.restore();
      ctx.save();
      ctx.beginPath();
      ctx.arc(wall.center.x, wall.center.y, radius, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.restore();
    }

    // Personal space circle
    ctx.save();
    ctx.beginPath();
    ctx.arc(player.pos.x, player.pos.y, player.psRadius, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(80, 150, 255, 0.08)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(120, 200, 255, 0.25)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();

    // XP orbs
    for (const orb of state.xpOrbs) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(orb.pos.x, orb.pos.y, XP_ORB_RADIUS, 0, Math.PI * 2);
      const alpha = orb.life <= 5 ? (orb.blink ? 0.4 : 0.8) : 0.8;
      ctx.fillStyle = `rgba(80, 220, 255, ${alpha})`;
      ctx.fill();
      ctx.restore();
    }

    // Enemies
    for (const enemy of state.enemies) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(enemy.pos.x, enemy.pos.y, enemy.r, 0, Math.PI * 2);
      ctx.fillStyle = enemyColor(enemy.type);
      ctx.fill();
      ctx.restore();
    }

    // Player
    ctx.save();
    const gradient = ctx.createRadialGradient(
      player.pos.x - 6,
      player.pos.y - 6,
      4,
      player.pos.x,
      player.pos.y,
      player.r
    );
    gradient.addColorStop(0, '#ffffff');
    gradient.addColorStop(1, '#61a8ff');
    ctx.beginPath();
    ctx.arc(player.pos.x, player.pos.y, player.r, 0, Math.PI * 2);
    ctx.fillStyle = gradient;
    ctx.fill();
    ctx.restore();

    if (!state.running) {
      ctx.save();
      ctx.fillStyle = 'rgba(0,0,0,0.4)';
      ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
      ctx.restore();
    }
  }

  function enemyColor(type) {
    switch (type) {
      case 'Basic':
        return '#ffffff';
      case 'Swift':
        return '#ffea70';
      case 'Zigzag':
        return '#60aaff';
      case 'Wanderer':
        return '#74ff8d';
      case 'Blitz':
        return '#ff5b5b';
      case 'Heavy':
        return '#c588ff';
      default:
        return '#ffffff';
    }
  }

  const inputState = {
    up: 0,
    down: 0,
    left: 0,
    right: 0,
  };

  let lastTime = performance.now();
  let accumulator = 0;

  const state = {
    rng: new Random(Date.now()),
    player: createPlayer(),
    enemies: [],
    xpOrbs: [],
    time: 0,
    breaks: 0,
    wall: null,
    spawnCooldown: 0,
    running: true,
    nextWallTime: WALL_FIRST_TIME,
    nextWallIndex: 0,
    scoreTimer: 0,
    multiplierTimer: 0,
    toasts: [],
    xpSweepCharges: 0,
    spawnPaused: false,
  };

  function resetState() {
    state.rng = new Random(Date.now());
    state.player = createPlayer();
    state.enemies = [];
    state.xpOrbs = [];
    state.time = 0;
    state.breaks = 0;
    state.wall = null;
    state.spawnCooldown = 0;
    state.running = true;
    state.nextWallTime = WALL_FIRST_TIME;
    state.nextWallIndex = 0;
    state.scoreTimer = 0;
    state.multiplierTimer = 0;
    state.xpSweepCharges = 0;
    state.spawnPaused = false;
    for (const toast of state.toasts) {
      if (toast.element && toast.element.parentElement) {
        toast.element.parentElement.removeChild(toast.element);
      }
    }
    state.toasts = [];
    gameOverPanel.classList.add('hidden');
    for (let i = 0; i < 3; i++) {
      spawnXpOrb(state, randomPointAvoidingWall(state));
    }
  }

  function update(dt) {
    if (!state.running) return;
    state.time += dt;
    updatePlayer(state, dt);
    updateEnemies(state, dt);
    updateDamageFromEnemies(state);
    updateXpOrbs(state, dt);
    updateWall(state, dt);
    handleWallCollision(state, dt);
    pickXpIfCollide(state);
    refillEnemies(state, dt);
    updateScore(state, dt);

    if (!state.wall && state.time >= state.nextWallTime) {
      state.wall = spawnWall(state.nextWallIndex, state);
      state.nextWallTime += WALL_INTERVAL;
    }

    if (state.wall && !state.wall.active) {
      state.wall = null;
    }
  }

  function renderLoop(timestamp) {
    const delta = (timestamp - lastTime) / 1000;
    lastTime = timestamp;
    accumulator += delta;
    if (accumulator > 1) accumulator = 1;
    while (accumulator >= FIXED_DT) {
      update(FIXED_DT);
      accumulator -= FIXED_DT;
    }
    draw(state);
    updateUI(state);
    updateToasts(delta);
    requestAnimationFrame(renderLoop);
  }

  function onKeyDown(e) {
    switch (e.code) {
      case 'ArrowUp':
      case 'KeyW':
        inputState.up = 1;
        break;
      case 'ArrowDown':
      case 'KeyS':
        inputState.down = 1;
        break;
      case 'ArrowLeft':
      case 'KeyA':
        inputState.left = 1;
        break;
      case 'ArrowRight':
      case 'KeyD':
        inputState.right = 1;
        break;
      case 'KeyC':
        consumeXpSweep(state);
        break;
      case 'KeyR':
        if (!state.running) {
          resetState();
        }
        break;
      case 'F1':
        state.wall = spawnWall(state.nextWallIndex, state);
        state.nextWallTime = state.time + WALL_INTERVAL;
        break;
      case 'F2':
        state.player.score += 10;
        addToast('スコア +10 (F2)');
        break;
      case 'F3':
        applyXpToPlayer(state, 5);
        addToast('XP +5 (F3)');
        break;
      case 'F4':
        state.spawnPaused = !state.spawnPaused;
        addToast(`敵スポーン ${state.spawnPaused ? '停止' : '再開'}`);
        break;
      case 'F9':
        console.log('--- Acceptance check ---');
        console.log('Score timer per second:', state.player.level, state.player.multipliers.map(m => m.M));
        console.log('Enemies target:', targetEnemies(Math.floor(state.time), state.breaks));
        console.log('Breaks:', state.breaks, 'Next wall threshold', wallThresholdAt(state.nextWallIndex));
        console.log('XP orbs:', state.xpOrbs.length);
        console.log('XP attract radius:', state.player.xpAttractRadius);
        console.log('------------------------');
        break;
    }
  }

  function onKeyUp(e) {
    switch (e.code) {
      case 'ArrowUp':
      case 'KeyW':
        inputState.up = 0;
        break;
      case 'ArrowDown':
      case 'KeyS':
        inputState.down = 0;
        break;
      case 'ArrowLeft':
      case 'KeyA':
        inputState.left = 0;
        break;
      case 'ArrowRight':
      case 'KeyD':
        inputState.right = 0;
        break;
    }
  }

  xpSweepButton.addEventListener('click', () => {
    consumeXpSweep(state);
  });

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);

  resetState();
  requestAnimationFrame(renderLoop);
})();
