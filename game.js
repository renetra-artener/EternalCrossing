(() => {
  'use strict';

  const CANVAS_W = 960;
  const CANVAS_H = 540;
  const PLAYER_SPEED = 180;
  const PLAYER_R = 10;
  const PS_BASE = 50;
  const XP_ATTRACT_BASE = 100;
  const XP_ORB_LIFE = 15;
  const SHUEN_INITIAL_SPEED = 120;
  const SHUEN_GROWTH_INTERVAL = 20;
  const SHUEN_GROWTH_RATE = 1.35;
  const SHUEN_BAND_WIDTH = 12;
  const SHUEN_RELATIVE_RANGE = 10000;
  const SHUEN_DPS0 = 5;
  const SHUEN_DPS_RATE = 1.2;
  const ENEMY_SPAWN_COOLDOWN_MIN = 0.8;
  const ENEMY_SPAWN_COOLDOWN_MAX = 1.6;
  const TARGET_ENEMIES_MAX_TIME = 10;
  const TARGET_ENEMIES_MAX_ALL = 20;
  const FIXED_DT = 1 / 60;
  const ENEMY_BASE_SPEED = 100;
  const ENEMY_OUT_MARGIN = 32;
  const XP_ORB_RADIUS = 6;

  const STACKING_MULTIPLIERS = {
    nice: {
      id: 'nice',
      name: 'ナイス回避',
      description: '危機を潜り抜けた余韻がスコア倍率を底上げする。',
      base: 1.1,
      delta0: 0.05,
      a: 0.035,
      S: 4,
    },
    predation: {
      id: 'predation',
      name: '捕食',
      description: '攻めの姿勢を維持し、重ねるほど効率が急伸する。',
      base: 1,
      delta0: 0.12,
      a: 0.06,
      S: 5,
    },
    reflection: {
      id: 'reflection',
      name: '反射',
      description: '反射の閃きが連鎖し、倍率を加速的に押し上げる。',
      base: 1,
      delta0: 0.1,
      a: 0.05,
      S: 6,
    },
  };

  const STACKING_MULTIPLIER_ORDER = ['nice', 'predation', 'reflection'];
  const MULTIPLIER_COLOR_CLASSES = ['mul-slot-a', 'mul-slot-b', 'mul-slot-c', 'mul-slot-d'];
  const MULTIPLIER_SLOT_LABELS = ['乗算A', '乗算B', '乗算C', '乗算D'];
  const MULTIPLIER_DECIMALS = 2;

  const canvas = document.getElementById('game-canvas');
  const ctx = canvas.getContext('2d');
  const hpDisplay = document.getElementById('hp-display');
  const psDisplay = document.getElementById('ps-display');
  const escapeDistanceText = document.getElementById('escape-distance');
  const levelText = document.getElementById('level-text');
  const xpText = document.getElementById('xp-text');
  const xpBarFill = document.getElementById('xp-bar-fill');
  const xpRangeStacks = document.getElementById('xp-range-stacks');
  const xpSweepCount = document.getElementById('xp-sweep-count');
  const xpSweepButton = document.getElementById('xp-sweep-button');
  const toastContainer = document.getElementById('toast-container');
  const gameOverPanel = document.getElementById('game-over');
  const multiplierBreakdown = document.getElementById('multiplier-breakdown');
  const perkModal = document.getElementById('perk-modal');
  const perkOptions = document.getElementById('perk-options');
  const timeDisplay = document.getElementById('time-display');
  const relativeBarShuen = document.getElementById('relative-bar-shuen');

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

  function formatLargeNumber(value, fractionDigits = 2) {
    if (!Number.isFinite(value)) return '∞';
    if (value === 0) return '0';
    const abs = Math.abs(value);
    if (abs >= 1e6 || abs < 1e-2) {
      return value.toExponential(fractionDigits).replace('+', '');
    }
    return value.toLocaleString('en-US', {
      maximumFractionDigits: fractionDigits,
      minimumFractionDigits: Math.min(fractionDigits, 2),
    });
  }

  function shuenRatio(state) {
    if (!state) return 0;
    return Math.min(state.relativeDistance / SHUEN_RELATIVE_RANGE, 1);
  }

  function getShuenX(state) {
    const ratio = shuenRatio(state);
    const usableWidth = CANVAS_W - SHUEN_BAND_WIDTH;
    const x = CANVAS_W - SHUEN_BAND_WIDTH - (1 - ratio) * usableWidth;
    return clamp(x, 0, CANVAS_W - SHUEN_BAND_WIDTH);
  }

  function lerpVec(a, b, t) {
    return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) };
  }

  function rotateVec(v, angle) {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    return { x: v.x * cos - v.y * sin, y: v.x * sin + v.y * cos };
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

  function getStackingMultiplierDef(id) {
    return STACKING_MULTIPLIERS[id] ?? null;
  }

  function applyStackingMultiplierGain(multiplier) {
    const n = multiplier.stacks;
    const aEff = multiplier.a * (multiplier.S / (multiplier.S + n));
    const delta = multiplier.delta0 + aEff * n;
    multiplier.M += delta;
    multiplier.stacks += 1;
  }

  function grantStackingMultiplier(state, id) {
    const player = state.player;
    const def = getStackingMultiplierDef(id);
    if (!def) return;

    let multiplier = player.multipliers.find(m => m.id === id);
    if (!multiplier) {
      const takenSlots = player.multipliers.map(m => m.slotIndex ?? m.colorSlot ?? -1);
      let slotIndex = 0;
      while (takenSlots.includes(slotIndex) && slotIndex < MULTIPLIER_COLOR_CLASSES.length) {
        slotIndex += 1;
      }
      if (slotIndex >= MULTIPLIER_COLOR_CLASSES.length) {
        addToast('倍率枠はこれ以上追加できません');
        return;
      }
      multiplier = {
        id: def.id,
        name: def.name,
        M: def.base,
        stacks: 0,
        delta0: def.delta0,
        a: def.a,
        S: def.S,
        order: state.nextMultiplierOrder++,
        colorSlot: slotIndex,
        slotIndex,
      };
      applyStackingMultiplierGain(multiplier);
      player.multipliers.push(multiplier);
      addToast(`${def.name}倍率を獲得 (${multiplier.stacks}スタック)`);
    } else {
      applyStackingMultiplierGain(multiplier);
      addToast(`${multiplier.name ?? def.name}倍率が強化 (${multiplier.stacks}スタック)`);
    }
    state.multiplierUiDirty = true;
  }

  function applyNiceAvoidBonus(state) {
    const def = getStackingMultiplierDef('nice');
    if (!def) return;
    const player = state.player;
    let multiplier = player.multipliers.find(m => m.id === 'nice');
    if (!multiplier) {
      const takenSlots = player.multipliers.map(m => m.slotIndex ?? m.colorSlot ?? -1);
      let slotIndex = 0;
      while (takenSlots.includes(slotIndex) && slotIndex < MULTIPLIER_COLOR_CLASSES.length) {
        slotIndex += 1;
      }
      if (slotIndex >= MULTIPLIER_COLOR_CLASSES.length) {
        return;
      }
      multiplier = {
        id: def.id,
        name: def.name,
        M: def.base,
        stacks: 0,
        delta0: def.delta0,
        a: def.a,
        S: def.S,
        order: state.nextMultiplierOrder++,
        colorSlot: slotIndex,
        slotIndex,
      };
      player.multipliers.push(multiplier);
    }
    applyStackingMultiplierGain(multiplier);
    state.multiplierUiDirty = true;
    addToast('ナイス回避！倍率上昇');
  }

  const MULTIPLIER_PERKS = STACKING_MULTIPLIER_ORDER.map(id => {
    const def = getStackingMultiplierDef(id);
    return {
      id: `mult_${id}`,
      name: `倍率: ${def.name}`,
      description: `${def.description} 重ね取得で効率が加速的に上昇する。`,
      apply(state) {
        grantStackingMultiplier(state, id);
      },
    };
  });

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
      escapeDistance: 0,
      multipliers: [],
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
        enemy.ai.timer = state.rng.range(0.8, 1.2);
        {
          const towardCenter = normalize(sub({ x: CANVAS_W / 2, y: CANVAS_H / 2 }, enemy.pos));
          if (length(towardCenter) === 0) {
            const angle = state.rng.range(0, Math.PI * 2);
            enemy.ai.dir = { x: Math.cos(angle), y: Math.sin(angle) };
          } else {
            enemy.ai.dir = towardCenter;
          }
        }
        break;
      case 'Swift':
        enemy.speed = ENEMY_BASE_SPEED * 1.5;
        enemy.r = 10;
        enemy.ai.dir = normalize(
          sub({ x: CANVAS_W / 2, y: CANVAS_H / 2 }, enemy.pos)
        );
        if (enemy.ai.dir.x === 0 && enemy.ai.dir.y === 0) {
          const angle = state.rng.range(0, Math.PI * 2);
          enemy.ai.dir = { x: Math.cos(angle), y: Math.sin(angle) };
        }
        enemy.ai.timer = state.rng.range(1.2, 2.4);
        break;
      case 'Zigzag':
        enemy.speed = ENEMY_BASE_SPEED * 1.2;
        enemy.r = 10;
        enemy.ai.phase = 0;
        enemy.ai.baseDir = normalize(sub({ x: CANVAS_W / 2, y: CANVAS_H / 2 }, enemy.pos));
        if (enemy.ai.baseDir.x === 0 && enemy.ai.baseDir.y === 0) {
          enemy.ai.baseDir = { x: 1, y: 0 };
        }
        enemy.ai.retarget = state.rng.range(2.4, 4.2);
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
        enemy.ai.timer = state.rng.range(0.8, 1.2);
        enemy.ai.dir = normalize(sub({ x: CANVAS_W / 2, y: CANVAS_H / 2 }, enemy.pos));
        if (enemy.ai.dir.x === 0 && enemy.ai.dir.y === 0) {
          const angle = state.rng.range(0, Math.PI * 2);
          enemy.ai.dir = { x: Math.cos(angle), y: Math.sin(angle) };
        }
        enemy.ai.burst = 0;
        break;
      case 'Heavy':
        enemy.speed = ENEMY_BASE_SPEED * 0.6;
        enemy.r = 16;
        const driftAngle = state.rng.range(0, Math.PI * 2);
        enemy.ai.driftDir = { x: Math.cos(driftAngle), y: Math.sin(driftAngle) };
        enemy.ai.driftTimer = state.rng.range(1.4, 2.4);
        enemy.ai.jitterTimer = state.rng.range(0.4, 0.8);
        enemy.ai.jitterVec = rotateVec(enemy.ai.driftDir, Math.PI / 2);
        break;
    }
    const player = state.player;
    if (player) {
      enemy.prevPsDist = Math.hypot(enemy.pos.x - player.pos.x, enemy.pos.y - player.pos.y);
    } else {
      enemy.prevPsDist = null;
    }
    enemy.niceTriggered = false;
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
    let leveled = false;
    while (player.xp >= player.xpNeeded) {
      player.xp -= player.xpNeeded;
      player.level += 1;
      player.xpNeeded = nextXpNeeded(player.level);
      addToast(`レベルアップ！ Lv${player.level}`);
      state.pendingPerkChoices += 1;
      leveled = true;
      state.multiplierUiDirty = true;
    }
    if (leveled) {
      maybeStartPerkDraft();
    }
  }

  function grantXpAttractPerk(state) {
    const player = state.player;
    player.xpRangeStacks += 1;
    player.xpAttractRadius = XP_ATTRACT_BASE * Math.pow(1.1, player.xpRangeStacks);
    addToast(`XP吸引範囲 +10% (x${player.xpRangeStacks})`);
  }

  function grantXpSweepCharge(state, amount = 1) {
    state.xpSweepCharges += amount;
    addToast(`XP全回収チャージ +${amount}`);
  }

  const PERK_LIBRARY = [
    {
      id: 'xp_attract',
      name: 'XP吸引範囲 +10%',
      description: 'XP吸引範囲を10%拡大する。重複して効果が加算される。',
      apply(state) {
        grantXpAttractPerk(state);
      },
    },
    {
      id: 'xp_sweep',
      name: 'XP全回収',
      description: 'XP全回収チャージを1つ獲得し、即時使用可能。',
      apply(state) {
        grantXpSweepCharge(state, 1);
      },
    },
    ...MULTIPLIER_PERKS,
    {
      id: 'prototype_boost',
      name: 'プロトタイプ: 共鳴コア',
      description: '将来のアップデートで機能追加予定。現バージョンでは演習用パーク。',
      apply() {
        addToast('プロトタイプパークを選択しました (効果未実装)');
      },
    },
  ];

  function rollPerkOptions() {
    const pool = [...PERK_LIBRARY];
    const picks = [];
    while (picks.length < 3 && pool.length > 0) {
      const index = Math.floor(state.rng.next() * pool.length);
      picks.push(pool.splice(index, 1)[0]);
    }
    while (picks.length < 3) {
      picks.push(PERK_LIBRARY[PERK_LIBRARY.length - 1]);
    }
    return picks;
  }

  function renderPerkOptions(options) {
    perkOptions.innerHTML = '';
    options.forEach((perk, idx) => {
      const card = document.createElement('div');
      card.className = 'perk-option';
      card.dataset.index = String(idx);
      card.innerHTML = `<h3>${idx + 1}. ${perk.name}</h3><p>${perk.description}</p>`;
      card.addEventListener('click', () => {
        choosePerk(idx);
      });
      perkOptions.appendChild(card);
    });
  }

  function openPerkDraft() {
    if (state.pendingPerkChoices <= 0) return;
    state.paused = true;
    state.perkModalActive = true;
    state.pendingPerkChoices -= 1;
    state.currentPerkOptions = rollPerkOptions();
    renderPerkOptions(state.currentPerkOptions);
    perkModal.classList.remove('hidden');
  }

  function closePerkModal() {
    perkModal.classList.add('hidden');
    perkOptions.innerHTML = '';
    state.perkModalActive = false;
    state.paused = false;
    state.currentPerkOptions = [];
  }

  function choosePerk(index) {
    if (!state.perkModalActive) return;
    const perk = state.currentPerkOptions[index];
    if (!perk) return;
    perk.apply(state);
    if (state.pendingPerkChoices > 0) {
      openPerkDraft();
    } else {
      closePerkModal();
    }
  }

  function maybeStartPerkDraft() {
    if (!state.running) return;
    if (state.perkModalActive) return;
    if (state.pendingPerkChoices <= 0) return;
    openPerkDraft();
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
    if (state.paused) return;
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

  function triggerGameOver(state) {
    if (!state.running) return;
    state.running = false;
    state.paused = false;
    state.perkModalActive = false;
    state.pendingPerkChoices = 0;
    perkModal.classList.add('hidden');
    perkOptions.innerHTML = '';
    gameOverPanel.classList.remove('hidden');
    addToast('ゲームオーバー');
  }

  function updateEnemy(state, enemy, dt) {
    const player = state.player;
    switch (enemy.type) {
      case 'Basic': {
        enemy.ai.timer = (enemy.ai.timer || 0) - dt;
        if (!enemy.ai.dir || (enemy.ai.dir.x === 0 && enemy.ai.dir.y === 0)) {
          const angle = state.rng.range(0, Math.PI * 2);
          enemy.ai.dir = { x: Math.cos(angle), y: Math.sin(angle) };
        }
        if (enemy.ai.timer <= 0) {
          enemy.ai.timer = state.rng.range(0.8, 1.2);
          const currentAngle = Math.atan2(enemy.ai.dir.y, enemy.ai.dir.x);
          const delta = state.rng.range(-Math.PI / 9, Math.PI / 9);
          const nextAngle = currentAngle + delta;
          enemy.ai.dir = { x: Math.cos(nextAngle), y: Math.sin(nextAngle) };
        }
        const desired = mulScalar(enemy.ai.dir, enemy.speed);
        enemy.vel = lerpVec(enemy.vel, desired, 0.08);
        break;
      }
      case 'Swift': {
        enemy.ai.timer = (enemy.ai.timer || 0) - dt;
        if (enemy.ai.timer <= 0) {
          enemy.ai.timer = state.rng.range(1.2, 2.2);
          const jitter = state.rng.range(-Math.PI / 8, Math.PI / 8);
          enemy.ai.dir = normalize(rotateVec(enemy.ai.dir || vec2(1, 0), jitter));
        }
        const desiredDir = enemy.ai.dir || vec2(1, 0);
        const desired = mulScalar(desiredDir, enemy.speed);
        enemy.vel = lerpVec(enemy.vel, desired, 0.16);
        break;
      }
      case 'Zigzag': {
        enemy.ai.phase = (enemy.ai.phase || 0) + dt;
        enemy.ai.retarget = (enemy.ai.retarget || 0) - dt;
        if (enemy.ai.retarget <= 0) {
          enemy.ai.retarget = state.rng.range(2.2, 3.6);
          const angleShift = state.rng.range(-Math.PI / 6, Math.PI / 6);
          enemy.ai.baseDir = normalize(rotateVec(enemy.ai.baseDir || vec2(1, 0), angleShift));
        }
        const baseDir = enemy.ai.baseDir || vec2(1, 0);
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
        enemy.ai.timer = (enemy.ai.timer || 0) - dt;
        if (enemy.ai.timer <= 0) {
          enemy.ai.timer = 1.1;
          const jitter = state.rng.range(-Math.PI / 6, Math.PI / 6);
          enemy.ai.dir = normalize(rotateVec(enemy.ai.dir || vec2(1, 0), jitter));
          enemy.ai.burst = 0.6;
        }
        enemy.ai.burst = Math.max(0, (enemy.ai.burst || 0) - dt);
        const speedScale = enemy.ai.burst > 0 ? 1.2 : 0.7;
        const desired = mulScalar(enemy.ai.dir || vec2(1, 0), enemy.speed * speedScale);
        enemy.vel = lerpVec(enemy.vel, desired, 0.18);
        break;
      }
      case 'Heavy': {
        enemy.ai.driftTimer = (enemy.ai.driftTimer || 0) - dt;
        if (enemy.ai.driftTimer <= 0) {
          enemy.ai.driftTimer = state.rng.range(1.4, 2.4);
          const shift = state.rng.range(-Math.PI / 5, Math.PI / 5);
          enemy.ai.driftDir = normalize(rotateVec(enemy.ai.driftDir || vec2(1, 0), shift));
        }
        enemy.ai.jitterTimer = (enemy.ai.jitterTimer || 0) - dt;
        if (enemy.ai.jitterTimer <= 0) {
          enemy.ai.jitterTimer = state.rng.range(0.5, 0.9);
          const jitterAngle = state.rng.range(-Math.PI / 3, Math.PI / 3);
          enemy.ai.jitterVec = normalize(rotateVec(enemy.ai.driftDir || vec2(1, 0), jitterAngle));
        }
        const toPlayer = normalize(sub(player.pos, enemy.pos));
        const drift = enemy.ai.driftDir || vec2();
        const desired = add(
          mulScalar(toPlayer, enemy.speed * 0.6),
          mulScalar(drift, enemy.speed * 0.4)
        );
        enemy.vel = lerpVec(enemy.vel, desired, 0.05);
        enemy.vel = mulScalar(enemy.vel, 0.985);
        if (enemy.ai.jitterVec) {
          enemy.vel = add(enemy.vel, mulScalar(enemy.ai.jitterVec, 10 * dt));
        }
        break;
      }
    }
    enemy.pos = add(enemy.pos, mulScalar(enemy.vel, dt));
  }

  function updateEnemies(state, dt) {
    const keep = [];
    const player = state.player;
    for (const enemy of state.enemies) {
      const prevDist =
        enemy.prevPsDist ?? Math.hypot(enemy.pos.x - player.pos.x, enemy.pos.y - player.pos.y);
      updateEnemy(state, enemy, dt);
      const nowDist = Math.hypot(enemy.pos.x - player.pos.x, enemy.pos.y - player.pos.y);
      if (
        !enemy.niceTriggered &&
        prevDist > player.psRadius &&
        nowDist < player.psRadius &&
        nowDist > player.r + enemy.r
      ) {
        enemy.niceTriggered = true;
        applyNiceAvoidBonus(state);
      }
      enemy.prevPsDist = nowDist;
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
    const target = targetEnemies(Math.floor(state.time), 0);
    const weights = spawnWeights(0);
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

  function escapeMultiplierProduct(player) {
    return player.multipliers.reduce((acc, m) => acc * m.M, 1);
  }

  function updateEscapeProgress(state, dt) {
    state.escapeAccumulator += dt;
    const player = state.player;
    const timeFactor = Math.floor(state.time / 10) + 1;
    const multiplierProduct = escapeMultiplierProduct(player);
    const deltaPerSecond = player.level * timeFactor * multiplierProduct;
    while (state.escapeAccumulator >= 1) {
      player.escapeDistance += deltaPerSecond;
      state.relativeDistance += deltaPerSecond - state.shuenSpeed;
      const maxBuffer = SHUEN_RELATIVE_RANGE * 2;
      state.relativeDistance = clamp(state.relativeDistance, -SHUEN_RELATIVE_RANGE, maxBuffer);
      state.escapeAccumulator -= 1;
    }
  }

  function isShuenOverlapping(state) {
    if (state.relativeDistance > 0) return false;
    const player = state.player;
    const shuenFront = getShuenX(state) + SHUEN_BAND_WIDTH;
    return player.pos.x <= shuenFront;
  }

  function updateShuenDamage(state, dt) {
    const player = state.player;
    if (isShuenOverlapping(state)) {
      state.shuenDamageTimer += dt;
      while (state.shuenDamageTimer >= 1) {
        state.shuenDamageTimer -= 1;
        const damage = state.shuenCurrentDps;
        player.hp -= damage;
        state.shuenCurrentDps *= SHUEN_DPS_RATE;
        addToast(`終焉ダメージ -${damage.toFixed(1)}`);
        if (player.hp <= 0) {
          player.hp = 0;
          triggerGameOver(state);
          break;
        }
      }
    } else {
      state.shuenDamageTimer = 0;
      state.shuenCurrentDps = SHUEN_DPS0;
    }
  }

  function updateShuenSpeed(state, dt) {
    state.shuenGrowthTimer += dt;
    while (state.shuenGrowthTimer >= SHUEN_GROWTH_INTERVAL) {
      state.shuenGrowthTimer -= SHUEN_GROWTH_INTERVAL;
      state.shuenSpeed *= SHUEN_GROWTH_RATE;
      addToast(`終焉の追尾速度が上昇 (${state.shuenSpeed.toFixed(1)})`);
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

  function updateMultiplierBreakdownUI(state, force = false) {
    if (!multiplierBreakdown) return;
    if (!force && !state.multiplierUiDirty && state.time - state.lastMultiplierUiUpdate < 1) {
      return;
    }
    state.lastMultiplierUiUpdate = state.time;
    state.multiplierUiDirty = false;

    const player = state.player;
    const segments = [
      {
        label: '加速',
        value: formatLargeNumber(player.level, MULTIPLIER_DECIMALS),
        className: 'mul-accel',
      },
    ];

    for (let i = 0; i < MULTIPLIER_COLOR_CLASSES.length; i += 1) {
      const slotClass = MULTIPLIER_COLOR_CLASSES[i];
      const slotLabel = MULTIPLIER_SLOT_LABELS[i] ?? `乗算${String.fromCharCode(65 + i)}`;
      const slotMultiplier = player.multipliers.find(
        m => (m.slotIndex ?? m.colorSlot ?? -1) === i
      );
      const value = slotMultiplier ? slotMultiplier.M : 1;
      segments.push({
        label: slotLabel,
        value: formatLargeNumber(value, MULTIPLIER_DECIMALS),
        className: slotClass,
      });
    }

    const operator = '<span class="mul-operator">×</span>';
    const nameRow = segments
      .map(seg => `<span class="mul-segment ${seg.className}"><span class="mul-label">${seg.label}</span></span>`)
      .join(operator);
    const valueRow = segments
      .map(seg => `<span class="mul-segment ${seg.className}"><span class="mul-value">${seg.value}</span></span>`)
      .join(operator);

    multiplierBreakdown.innerHTML = `<div class="mul-row mul-names">${nameRow}</div><div class="mul-row mul-values">${valueRow}</div>`;
  }

  function updateUI(state) {
    const player = state.player;
    hpDisplay.textContent = `HP: ${Math.ceil(player.hp)}/${player.maxHp}`;
    psDisplay.textContent = `PS: ${Math.round(player.psRadius)}px`;
    if (escapeDistanceText) {
      escapeDistanceText.textContent = `${formatLargeNumber(player.escapeDistance, 2)} 光年`;
    }
    levelText.textContent = player.level;
    xpText.textContent = `${Math.floor(player.xp)}/${player.xpNeeded}`;
    const ratio = clamp(player.xp / player.xpNeeded, 0, 1);
    xpBarFill.style.width = `${ratio * 100}%`;
    xpRangeStacks.textContent = player.xpRangeStacks;
    xpSweepCount.textContent = state.xpSweepCharges;
    xpSweepButton.disabled = state.xpSweepCharges <= 0 || state.paused;

    if (timeDisplay) {
      const elapsed = Math.floor(state.time);
      const minutes = String(Math.floor(elapsed / 60)).padStart(2, '0');
      const seconds = String(elapsed % 60).padStart(2, '0');
      timeDisplay.textContent = `${minutes}:${seconds}`;
    }

    if (relativeBarShuen) {
      const ratioRelative = clamp(state.relativeDistance / SHUEN_RELATIVE_RANGE, 0, 1);
      const widthPercent = clamp(1 - ratioRelative, 0, 1);
      const adjusted = Math.max(widthPercent * 100, widthPercent > 0 ? 1 : 0);
      relativeBarShuen.style.width = `${adjusted}%`;
    }

    updateMultiplierBreakdownUI(state);
  }

  function draw(state) {
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
    ctx.save();
    ctx.fillStyle = '#05060b';
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
    ctx.restore();

    const player = state.player;

    // Draw Shuen curtain
    const shuenX = getShuenX(state);
    ctx.save();
    ctx.fillStyle = 'rgba(255, 64, 80, 0.45)';
    ctx.fillRect(shuenX, 0, SHUEN_BAND_WIDTH, CANVAS_H);
    ctx.restore();

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
    spawnCooldown: 0,
    running: true,
    toasts: [],
    xpSweepCharges: 0,
    spawnPaused: false,
    paused: false,
    pendingPerkChoices: 0,
    perkModalActive: false,
    currentPerkOptions: [],
    nextMultiplierOrder: 0,
    multiplierUiDirty: true,
    lastMultiplierUiUpdate: -Infinity,
    escapeAccumulator: 0,
    relativeDistance: SHUEN_RELATIVE_RANGE,
    shuenSpeed: SHUEN_INITIAL_SPEED,
    shuenGrowthTimer: 0,
    shuenDamageTimer: 0,
    shuenCurrentDps: SHUEN_DPS0,
  };

  function resetState() {
    state.rng = new Random(Date.now());
    state.player = createPlayer();
    state.enemies = [];
    state.xpOrbs = [];
    state.time = 0;
    state.spawnCooldown = 0;
    state.running = true;
    state.xpSweepCharges = 0;
    state.spawnPaused = false;
    state.paused = false;
    state.pendingPerkChoices = 0;
    state.perkModalActive = false;
    state.currentPerkOptions = [];
    state.nextMultiplierOrder = 0;
    state.multiplierUiDirty = true;
    state.lastMultiplierUiUpdate = -Infinity;
    state.escapeAccumulator = 0;
    state.relativeDistance = SHUEN_RELATIVE_RANGE;
    state.shuenSpeed = SHUEN_INITIAL_SPEED;
    state.shuenGrowthTimer = 0;
    state.shuenDamageTimer = 0;
    state.shuenCurrentDps = SHUEN_DPS0;
    for (const toast of state.toasts) {
      if (toast.element && toast.element.parentElement) {
        toast.element.parentElement.removeChild(toast.element);
      }
    }
    state.toasts = [];
    gameOverPanel.classList.add('hidden');
    perkModal.classList.add('hidden');
    perkOptions.innerHTML = '';
    for (let i = 0; i < 3; i++) {
      spawnXpOrb(state, randomPointAvoidingWall(state));
    }
  }

  function update(dt) {
    if (!state.running || state.paused) return;
    state.time += dt;
    updatePlayer(state, dt);
    updateEnemies(state, dt);
    updateDamageFromEnemies(state);
    updateXpOrbs(state, dt);
    updateEscapeProgress(state, dt);
    updateShuenDamage(state, dt);
    pickXpIfCollide(state);
    refillEnemies(state, dt);
    updateShuenSpeed(state, dt);
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
    if (!state.paused) {
      updateToasts(delta);
    }
    requestAnimationFrame(renderLoop);
  }

  function onKeyDown(e) {
    switch (e.code) {
      case 'Digit1':
      case 'Numpad1':
        if (state.perkModalActive) {
          choosePerk(0);
        }
        break;
      case 'Digit2':
      case 'Numpad2':
        if (state.perkModalActive) {
          choosePerk(1);
        }
        break;
      case 'Digit3':
      case 'Numpad3':
        if (state.perkModalActive) {
          choosePerk(2);
        }
        break;
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
      case 'F2':
        state.player.escapeDistance += 10;
        addToast('逃避距離 +10 (F2)');
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
        console.log('Escape delta factors:', {
          level: state.player.level,
          timeFactor: Math.floor(state.time / 10) + 1,
          multipliers: state.player.multipliers.map(m => ({ id: m.id, M: m.M })),
        });
        console.log('Shuen state:', {
          speed: state.shuenSpeed,
          relative: state.relativeDistance,
        });
        console.log('Enemies target:', targetEnemies(Math.floor(state.time), 0));
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
