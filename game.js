/* Battleship Bluff - game.js (vanilla JS, offline) */
(() => {
  'use strict';

  // Board: 9 columns x 7 rows (cells are square)
  const COLS = 9;
  const ROWS = 7;
  const COL_LABELS = 'ABCDEFGHI'.split('');

  const SHIPS = [
    { id: 'S5', name: 'Carrier', len: 5 },
    { id: 'S4', name: 'Battleship', len: 4 },
    { id: 'S3a', name: 'Cruiser A', len: 3 },
    { id: 'S3b', name: 'Cruiser B', len: 3 },
    { id: 'S2', name: 'Destroyer', len: 2 },
  ];

  const HINT_CARDS = [
    { id: 'row', name: 'Row', desc: 'Hint about a row.' },
    { id: 'col', name: 'Column', desc: 'Hint about a column.' },
    { id: 'area', name: '3×3 Area', desc: 'Hint about a 3×3 area.' },
    { id: 'cell', name: 'Single Cell', desc: 'Hint about one cell.' },
  ];

  const TurnPhase = {
    START: 'start',
    SETUP: 'setup',
    PLAY: 'play',
  };

  const $ = (sel) => document.querySelector(sel);
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };

  const randInt = (n) => Math.floor(Math.random() * n);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  function makeGrid(fill) {
    const g = [];
    for (let r = 0; r < ROWS; r++) {
      const row = [];
      for (let c = 0; c < COLS; c++) row.push(typeof fill === 'function' ? fill(r, c) : fill);
      g.push(row);
    }
    return g;
  }

  function coordToText(r, c) {
    return `${COL_LABELS[c]}${r + 1}`;
  }

  function computeShipCells(origin, orient, len) {
    const cells = [];
    for (let i = 0; i < len; i++) {
      const r = origin.r + (orient === 'V' ? i : 0);
      const c = origin.c + (orient === 'H' ? i : 0);
      cells.push({ r, c });
    }
    return cells;
  }

  function cellsInBounds(cells) {
    return cells.every(({ r, c }) => r >= 0 && r < ROWS && c >= 0 && c < COLS);
  }

  function cellsOverlap(cells, occ, ignoreShipId = null) {
    for (const { r, c } of cells) {
      const cur = occ[r][c];
      if (cur && cur !== ignoreShipId) return true;
    }
    return false;
  }

  function hintCells(type, selection) {
    if (type === 'row') {
      const r = selection.row;
      return Array.from({ length: COLS }, (_, c) => ({ r, c }));
    }
    if (type === 'col') {
      const c = selection.col;
      return Array.from({ length: ROWS }, (_, r) => ({ r, c }));
    }
    if (type === 'area') {
      const { r: cr, c: cc } = selection.center;
      const out = [];
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const r = cr + dr, c = cc + dc;
          if (r >= 0 && r < ROWS && c >= 0 && c < COLS) out.push({ r, c });
        }
      }
      return out;
    }
    // cell
    return [{ r: selection.cell.r, c: selection.cell.c }];
  }

  function hintRect(type, selection) {
    // Return bounding rect in grid units: {r,c,w,h}
    if (type === 'row') return { r: selection.row, c: 0, w: COLS, h: 1 };
    if (type === 'col') return { r: 0, c: selection.col, w: 1, h: ROWS };
    if (type === 'area') {
      const { r: cr, c: cc } = selection.center;
      const r0 = clamp(cr - 1, 0, ROWS - 1);
      const c0 = clamp(cc - 1, 0, COLS - 1);
      const r1 = clamp(cr + 1, 0, ROWS - 1);
      const c1 = clamp(cc + 1, 0, COLS - 1);
      return { r: r0, c: c0, w: c1 - c0 + 1, h: r1 - r0 + 1 };
    }
    return { r: selection.cell.r, c: selection.cell.c, w: 1, h: 1 };
  }

  function evaluateAreaHasShip(player, cells) {
    return cells.some(({ r, c }) => player.occupancy[r][c] != null);
  }

  function countDestroyedNonShipCells(player) {
    let n = 0;
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        if (!player.occupancy[r][c] && player.defenseShots[r][c] === 'miss') n++;
      }
    }
    return n;
  }

  function getDestroyedNonShipCells(player) {
    const out = [];
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        if (!player.occupancy[r][c] && player.defenseShots[r][c] === 'miss') out.push({ r, c });
      }
    }
    return out;
  }

  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = randInt(i + 1);
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  function roundHalf(n) {
    // round(n/2)
    return Math.round(n / 2);
  }

  const icons = {
    rotateSVG: () => `
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
        <path d="M12 6V3L8 7l4 4V8c2.76 0 5 2.24 5 5a5 5 0 1 1-9.9-1h-2.1A7 7 0 1 0 12 6z" />
      </svg>
    `,
    row: () => `
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
        <path d="M4 7h16v2H4V7zm0 8h16v2H4v-2zm0-4h16v2H4v-2z" />
      </svg>
    `,
    col: () => `
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
        <path d="M7 4h2v16H7V4zm8 0h2v16h-2V4zm-4 0h2v16h-2V4z" />
      </svg>
    `,
    area: () => `
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
        <path d="M4 4h6v6H4V4zm10 0h6v6h-6V4zM4 14h6v6H4v-6zm10 10v-6h6v6h-6zM11 11h2v2h-2v-2z" />
      </svg>
    `,
    cell: () => `
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
        <path d="M12 2l3 3h-2v4h-2V5H9l3-3zm0 20l-3-3h2v-4h2v4h2l-3 3zM2 12l3-3v2h4v2H5v2l-3-3zm20 0l-3 3v-2h-4v-2h4V9l3 3z" />
      </svg>
    `,
  };

  const App = {
    state: null,

    init() {
      this.cacheEls();
      this.bind();
      this.startTimerEnabled = false;
      this.renderStartTimerOption();

      this.showPanel('#startPanel');
      this.setPhasePill('Ready');
      this.els.timerPill.classList.add('hidden');

      this.renderStaticBoards();
    },

    cacheEls() {
      this.els = {
        phasePill: $('#phasePill'),
        timerPill: $('#timerPill'),
        timerText: $('#timerText'),
        effectsInfoBtn: $('#effectsInfoBtn'),
        flowInfoBtn: $('#flowInfoBtn'),
        effectsInfoOverlay: $('#effectsInfoOverlay'),
        flowInfoOverlay: $('#flowInfoOverlay'),
        closeEffectsInfoBtn: $('#closeEffectsInfoBtn'),
        closeFlowInfoBtn: $('#closeFlowInfoBtn'),

        startPanel: $('#startPanel'),
        setupPanel: $('#setupPanel'),
        playPanel: $('#playPanel'),

        startBtn: $('#startBtn'),
        turnTimerInput: $('#turnTimerInput'),
        timerToggleBtn: $('#timerToggleBtn'),
        extraShotToggle: $('#extraShotToggle'),

        // Setup
        setupTitle: $('#setupTitle'),
        setupSubtitle: $('#setupSubtitle'),
        shipPalette: $('#shipPalette'),
        setupBoard: $('#setupBoard'),
        setupShipLayer: $('#setupShipLayer'),
        setupRotateHandle: $('#setupRotateHandle'),
        randomBtn: $('#randomBtn'),
        resetBtn: $('#resetBtn'),
        lockInBtn: $('#lockInBtn'),
        setupReadyText: $('#setupReadyText'),

        // Play
        turnTitle: $('#turnTitle'),
        turnSubtitle: $('#turnSubtitle'),
        shotsText: $('#shotsText'),
        hintsLeftText: $('#hintsLeftText'),
        targetBoard: $('#targetBoard'),
        targetHintLayer: $('#targetHintLayer'),
        enemyShips: $('#enemyShips'),

        ownBoard: $('#ownBoard'),
        ownShipLayer: $('#ownShipLayer'),
        ownHintLayer: $('#ownHintLayer'),
        ownHideOverlay: $('#ownHideOverlay'),
        showOwnBtn: $('#showOwnBtn'),
        hideOwnBtn: $('#hideOwnBtn'),
        ownHintTruthText: $('#ownHintTruthText'),
        toggleHasBtn: $('#toggleHasBtn'),
        toggleHasNotBtn: $('#toggleHasNotBtn'),
        confirmHintBtn: $('#confirmHintBtn'),
        cardsRow: $('#cardsRow'),

        guessBar: $('#guessBar'),
        incomingHintDesc: $('#incomingHintDesc'),
        guessTrueBtn: $('#guessTrueBtn'),
        guessLieBtn: $('#guessLieBtn'),
        confirmShotBtn: $('#confirmShotBtn'),

        logLine: $('#logLine'),
        forfeitBtn: $('#forfeitBtn'),

        passOverlay: $('#passOverlay'),
        passTitle: $('#passTitle'),
        passBody: $('#passBody'),
        readyBtn: $('#readyBtn'),

        resultOverlay: $('#resultOverlay'),
        resultSmall: $('#resultSmall'),
        resultBig: $('#resultBig'),
        resultEffect: $('#resultEffect'),
        resultContinueBtn: $('#resultContinueBtn'),

        toast: $('#toast'),

        gameOverOverlay: $('#gameOverOverlay'),
        gameOverTitle: $('#gameOverTitle'),
        gameOverBody: $('#gameOverBody'),
        restartBtn: $('#restartBtn'),
      };
    },

    bind() {
      this.els.startBtn.addEventListener('click', () => this.startGame());
      this.els.timerToggleBtn.addEventListener('click', () => this.setTimerEnabled(!this.startTimerEnabled));
      this.els.randomBtn.addEventListener('click', () => this.randomPlace());
      this.els.resetBtn.addEventListener('click', () => this.resetPlacement());
      this.els.lockInBtn.addEventListener('click', () => this.lockIn());

      this.els.showOwnBtn.addEventListener('click', () => this.setOwnVisible(true));
      this.els.hideOwnBtn.addEventListener('click', () => this.setOwnVisible(false));

      this.els.toggleHasBtn.addEventListener('click', () => this.setHasToggle(true));
      this.els.toggleHasNotBtn.addEventListener('click', () => this.setHasToggle(false));
      this.els.confirmHintBtn.addEventListener('click', () => this.confirmHint());

      this.els.guessTrueBtn.addEventListener('click', () => this.setGuess(true));
      this.els.guessLieBtn.addEventListener('click', () => this.setGuess(false));
      this.els.confirmShotBtn.addEventListener('click', () => this.confirmShot());

      this.els.readyBtn.addEventListener('click', () => this.onReady());
      this.els.forfeitBtn.addEventListener('click', () => this.confirmEndGame());

      this.els.restartBtn.addEventListener('click', () => window.location.reload());
      this.els.effectsInfoBtn.addEventListener('click', () => this.openInfoOverlay('effectsInfoOverlay'));
      this.els.flowInfoBtn.addEventListener('click', () => this.openInfoOverlay('flowInfoOverlay'));
      this.els.closeEffectsInfoBtn.addEventListener('click', () => this.closeInfoOverlay('effectsInfoOverlay'));
      this.els.closeFlowInfoBtn.addEventListener('click', () => this.closeInfoOverlay('flowInfoOverlay'));

      this.els.effectsInfoOverlay.addEventListener('click', (ev) => {
        if (ev.target === this.els.effectsInfoOverlay) this.closeInfoOverlay('effectsInfoOverlay');
      });
      this.els.flowInfoOverlay.addEventListener('click', (ev) => {
        if (ev.target === this.els.flowInfoOverlay) this.closeInfoOverlay('flowInfoOverlay');
      });

      window.addEventListener('resize', () => {
        if (!this.state) return;
        if (this.state.phase === TurnPhase.SETUP) this.renderSetup();
        if (this.state.phase === TurnPhase.PLAY) this.renderPlay();
      });
      window.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape') this.closeInfoOverlays();
      });
    },

    openInfoOverlay(id) {
      const overlay = this.els[id];
      if (!overlay) return;
      overlay.classList.remove('hidden');
    },

    closeInfoOverlay(id) {
      const overlay = this.els[id];
      if (!overlay) return;
      overlay.classList.add('hidden');
    },

    closeInfoOverlays() {
      this.closeInfoOverlay('effectsInfoOverlay');
      this.closeInfoOverlay('flowInfoOverlay');
    },

    // Panels
    showPanel(sel) {
      this.els.startPanel.classList.add('hidden');
      this.els.setupPanel.classList.add('hidden');
      this.els.playPanel.classList.add('hidden');
      $(sel).classList.remove('hidden');
    },

    setPhasePill(text) {
      this.els.phasePill.textContent = text;
    },

    // Game state
    setTimerEnabled(enabled) {
      this.startTimerEnabled = !!enabled;
      this.renderStartTimerOption();
    },

    renderStartTimerOption() {
      const enabled = !!this.startTimerEnabled;
      this.els.timerToggleBtn.textContent = enabled ? 'Timer On' : 'Timer Off';
      this.els.timerToggleBtn.classList.toggle('toggleOn', enabled);
      this.els.turnTimerInput.disabled = !enabled;
    },

    newPlayerState() {
      return {
        ships: [], // {id,len,origin,orient}
        occupancy: makeGrid(null), // shipId or null
        defenseShots: makeGrid('none'), // none|miss|hit on own board (enemy shots)
        targetShots: makeGrid('unknown'), // unknown|miss|hit on opponent board
        cards: HINT_CARDS.map(c => ({ ...c, used: false })),
        hints: {
          active: null, // hint object waiting to be judged
          past: [], // judged or forced correct hints
        },
        bonusShotsNextTurn: 0, // bonus shots next time this player attacks
      };
    },

    startGame() {
      const turnSeconds = clamp(parseInt(this.els.turnTimerInput.value || '60', 10), 15, 180);
      const timerEnabled = !!this.startTimerEnabled;
      const extraShotOnHit = !!this.els.extraShotToggle.checked;

      this.state = {
        phase: TurnPhase.SETUP,
        config: { turnSeconds, timerEnabled, extraShotOnHit },
        setupPlayer: 0,
        currentPlayer: 0,
        players: [this.newPlayerState(), this.newPlayerState()],
        ui: {
          setup: {
            paletteSelected: null, // shipId
            editingShipId: null,   // shipId
          },
          play: {
            ownVisible: false,
            hint: {
              selectedCardId: null,
              claimHas: true,
              selection: null, // depends on card type
              computedTruth: null, // true if hint would be TRUE, false if LIE
              setThisTurn: false,
            },
            incoming: {
              hintId: null,
              guess: null,
              judged: false,
            },
            targetSel: null,
          },
        },
        turn: {
          shotsRemaining: 1,
          timer: turnSeconds,
          timerId: null,
          paused: false,
          hasFiredThisTurn: false,
        },
        pass: {
          nextPhase: null,
          nextPlayer: null,
          text: '',
        }
      };

      this.openPassOverlay(`Player 1`, `Get ready to place your ships. Keep the screen hidden while passing.`);
      this.setPhasePill('Setup');
    },

    openPassOverlay(title, body, nextPhase = null, nextPlayer = null) {
      this.state.pass = { nextPhase, nextPlayer, text: body };
      this.els.passTitle.textContent = title;
      this.els.passBody.textContent = body;
      this.els.passOverlay.classList.remove('hidden');
      this.pauseTimer(true);
    },

    onReady() {
      this.els.passOverlay.classList.add('hidden');
      if (!this.state) return;

      // When coming from start, go to setup; from play, go to next player's turn.
      if (this.state.phase === TurnPhase.SETUP) {
        this.showPanel('#setupPanel');
        this.renderSetup();
        return;
      }
      if (this.state.phase === TurnPhase.PLAY) {
        this.showPanel('#playPanel');
        this.renderPlay();
        this.startTurnTimer();
        return;
      }
    },

    // Setup rendering
    renderStaticBoards() {
      // Prebuild cells once for each board grid.
      const build = (gridEl, clickHandler) => {
        gridEl.innerHTML = '';
        for (let r = 0; r < ROWS; r++) {
          for (let c = 0; c < COLS; c++) {
            const b = document.createElement('button');
            b.className = 'cell';
            b.type = 'button';
            b.dataset.r = String(r);
            b.dataset.c = String(c);
            b.setAttribute('aria-label', coordToText(r, c));
            b.addEventListener('click', (ev) => clickHandler(ev, r, c));
            gridEl.appendChild(b);
          }
        }
      };

      build(this.els.setupBoard, (ev, r, c) => this.onSetupCellClick(ev, r, c));
      build(this.els.targetBoard, (ev, r, c) => this.onTargetCellClick(ev, r, c));
      build(this.els.ownBoard, (ev, r, c) => this.onOwnCellClick(ev, r, c));
    },

    currentSetupPlayer() {
      return this.state.players[this.state.setupPlayer];
    },

    renderSetup() {
      const pIdx = this.state.setupPlayer;
      const player = this.currentSetupPlayer();
      this.els.setupTitle.textContent = `Player ${pIdx + 1}: Place your fleet`;
      this.els.setupSubtitle.textContent = `Ships: 5, 4, 3, 3, 2. Tap a ship above, then tap the board to place it.`;
      this.renderShipPalette();

      // Clear selection handle
      this.els.setupRotateHandle.classList.add('hidden');

      // Render ship layer
      this.renderShipLayer(this.els.setupShipLayer, player, {
        selectable: true,
        selectedShipId: this.state.ui.setup.editingShipId,
        onShipClick: (shipId) => this.toggleEditShip(shipId),
      });

      // Render hits/misses on setup board (none in setup)
      this.renderCellsFromDefense(this.els.setupBoard, player);

      // Update lock button
      const allPlaced = player.ships.length === SHIPS.length;
      this.els.lockInBtn.disabled = !allPlaced;
      this.els.setupReadyText.textContent = allPlaced ? 'All ships placed. You can lock in now.' : 'Place all ships to continue.';
    },

    renderShipPalette() {
      const player = this.currentSetupPlayer();
      const used = new Set(player.ships.map(s => s.id));
      const ui = this.state.ui.setup;

      this.els.shipPalette.innerHTML = '';
      for (const ship of SHIPS) {
        const chip = el('div', 'shipChip');
        if (used.has(ship.id)) chip.classList.add('disabled');
        if (ui.paletteSelected === ship.id) chip.classList.add('selected');

        const meta = el('div', 'meta');
        meta.appendChild(el('div', 'name', ship.name));
        meta.appendChild(el('div', 'len', `Length: ${ship.len}`));

        const mini = el('div', 'shipMini');
        mini.style.width = `${18 + ship.len * 8}px`;

        chip.appendChild(meta);
        chip.appendChild(mini);

        chip.addEventListener('click', () => {
          if (used.has(ship.id)) return;
          ui.paletteSelected = (ui.paletteSelected === ship.id) ? null : ship.id;
          ui.editingShipId = null;
          this.renderSetup();
        });

        this.els.shipPalette.appendChild(chip);
      }
    },

    toggleEditShip(shipId) {
      const ui = this.state.ui.setup;
      ui.paletteSelected = null;
      ui.editingShipId = (ui.editingShipId === shipId) ? null : shipId;
      this.renderSetup();

      if (ui.editingShipId) {
        this.positionRotateHandle();
      }
    },

    positionRotateHandle() {
      // Position the rotate handle near the selected ship's top-right.
      const player = this.currentSetupPlayer();
      const shipId = this.state.ui.setup.editingShipId;
      if (!shipId) return;

      const ship = player.ships.find(s => s.id === shipId);
      if (!ship) return;

      const rect = this.shipRect(ship);
      const handle = this.els.setupRotateHandle;

      handle.style.left = `${((rect.c + rect.w) / COLS) * 100 - 6}%`;
      handle.style.top = `${(rect.r / ROWS) * 100 - 2}%`;

      handle.classList.remove('hidden');
      handle.onclick = () => this.rotateSelectedShipSetup();
    },

    shipRect(ship) {
      const w = ship.orient === 'H' ? ship.len : 1;
      const h = ship.orient === 'V' ? ship.len : 1;
      return { r: ship.origin.r, c: ship.origin.c, w, h };
    },

    onSetupCellClick(_ev, r, c) {
      const player = this.currentSetupPlayer();
      const ui = this.state.ui.setup;

      if (ui.editingShipId) {
        // Move selected ship to new origin
        const ship = player.ships.find(s => s.id === ui.editingShipId);
        if (!ship) return;
        this.tryMoveShip(player, ship.id, { r, c }, ship.orient);
        this.renderSetup();
        this.positionRotateHandle();
        return;
      }

      if (!ui.paletteSelected) return;
      const def = SHIPS.find(s => s.id === ui.paletteSelected);
      if (!def) return;

      const placed = this.tryPlaceShip(player, def.id, def.len, { r, c }, 'H');
      if (placed) {
        ui.paletteSelected = null;
      } else {
        // If horizontal fails, try vertical automatically for convenience
        const placedV = this.tryPlaceShip(player, def.id, def.len, { r, c }, 'V');
        if (placedV) ui.paletteSelected = null;
        else this.toast('Cannot place ship there.', 'bad');
      }
      this.renderSetup();
    },

    tryPlaceShip(player, id, len, origin, orient) {
      const cells = computeShipCells(origin, orient, len);
      if (!cellsInBounds(cells)) return false;
      if (cellsOverlap(cells, player.occupancy)) return false;

      player.ships.push({ id, len, origin: { ...origin }, orient });
      for (const { r, c } of cells) player.occupancy[r][c] = id;
      return true;
    },

    removeShipFromOccupancy(player, ship) {
      const cells = computeShipCells(ship.origin, ship.orient, ship.len);
      for (const { r, c } of cells) {
        if (player.occupancy[r][c] === ship.id) player.occupancy[r][c] = null;
      }
    },

    writeShipToOccupancy(player, ship) {
      const cells = computeShipCells(ship.origin, ship.orient, ship.len);
      for (const { r, c } of cells) player.occupancy[r][c] = ship.id;
    },

    tryMoveShip(player, shipId, newOrigin, newOrient) {
      const ship = player.ships.find(s => s.id === shipId);
      if (!ship) return false;

      // Temporarily remove
      this.removeShipFromOccupancy(player, ship);

      const len = ship.len;
      let origin = { ...newOrigin };

      // keep within bounds
      if (newOrient === 'H') origin.c = clamp(origin.c, 0, COLS - len);
      if (newOrient === 'V') origin.r = clamp(origin.r, 0, ROWS - len);

      const cells = computeShipCells(origin, newOrient, len);
      const ok = cellsInBounds(cells) && !cellsOverlap(cells, player.occupancy, shipId);

      if (ok) {
        ship.origin = origin;
        ship.orient = newOrient;
      }

      // Restore occupancy (either new or old)
      this.writeShipToOccupancy(player, ship);
      return ok;
    },

    rotateSelectedShipSetup() {
      const player = this.currentSetupPlayer();
      const shipId = this.state.ui.setup.editingShipId;
      if (!shipId) return;
      const ship = player.ships.find(s => s.id === shipId);
      if (!ship) return;

      const nextOrient = ship.orient === 'H' ? 'V' : 'H';
      const ok = this.tryMoveShip(player, ship.id, ship.origin, nextOrient);
      if (!ok) this.toast('Cannot rotate here.', 'bad');

      this.renderSetup();
      this.positionRotateHandle();
    },

    randomPlace() {
      const player = this.currentSetupPlayer();
      const missing = SHIPS.filter(s => !player.ships.some(ps => ps.id === s.id));
      for (const def of missing) {
        let placed = false;
        for (let tries = 0; tries < 600 && !placed; tries++) {
          const orient = Math.random() < 0.5 ? 'H' : 'V';
          const origin = {
            r: randInt(ROWS),
            c: randInt(COLS),
          };
          const o2 = { ...origin };
          if (orient === 'H') o2.c = clamp(o2.c, 0, COLS - def.len);
          if (orient === 'V') o2.r = clamp(o2.r, 0, ROWS - def.len);

          placed = this.tryPlaceShip(player, def.id, def.len, o2, orient);
        }
        if (!placed) this.toast('Random placement failed (rare). Try again.', 'bad');
      }
      this.state.ui.setup.paletteSelected = null;
      this.state.ui.setup.editingShipId = null;
      this.renderSetup();
    },

    resetPlacement() {
      const player = this.currentSetupPlayer();
      player.ships = [];
      player.occupancy = makeGrid(null);
      this.state.ui.setup.paletteSelected = null;
      this.state.ui.setup.editingShipId = null;
      this.renderSetup();
    },

    lockIn() {
      const pIdx = this.state.setupPlayer;
      const player = this.currentSetupPlayer();
      if (player.ships.length !== SHIPS.length) return;

      if (pIdx === 0) {
        // pass to player 2 setup
        this.state.setupPlayer = 1;
        this.openPassOverlay('Player 2', 'Get ready to place your ships. Keep the screen hidden while passing.');
        // still setup phase
        return;
      }

      // Both players placed -> start play with player 1
      this.state.phase = TurnPhase.PLAY;
      this.state.currentPlayer = 0;
      this.state.ui.play.ownVisible = false;
      this.state.ui.play.hint.selectedCardId = null;
      this.state.ui.play.hint.selection = null;
      this.state.ui.play.hint.setThisTurn = false;

      this.openPassOverlay('Player 1', 'Game starts! Hand the device to Player 1. Keep the screen hidden while passing.');
      this.setPhasePill('Play');
    },

    // Board render helpers
    renderCellsFromDefense(gridEl, player) {
      // Update hit/miss visuals on a player's own grid
      const cells = gridEl.querySelectorAll('.cell');
      for (const b of cells) {
        const r = parseInt(b.dataset.r, 10);
        const c = parseInt(b.dataset.c, 10);
        const s = player.defenseShots[r][c];

        b.classList.toggle('hit', s === 'hit');
        b.classList.toggle('miss', s === 'miss');
      }
    },

    renderCellsFromTarget(gridEl, attacker, defender = null) {
      const sunkCellKeys = defender ? this.getSunkCellKeySet(defender) : null;
      const cells = gridEl.querySelectorAll('.cell');
      for (const b of cells) {
        const r = parseInt(b.dataset.r, 10);
        const c = parseInt(b.dataset.c, 10);
        const s = attacker.targetShots[r][c];
        b.classList.toggle('hit', s === 'hit');
        b.classList.toggle('miss', s === 'miss');
        const isSunkCell = !!(sunkCellKeys && sunkCellKeys.has(`${r},${c}`));
        b.classList.toggle('sunkShipCell', isSunkCell);
      }
    },

    renderShipLayer(layerEl, player, opts) {
      const { selectable, selectedShipId, onShipClick, sunkShipIds } = opts;
      layerEl.innerHTML = '';
      for (const ship of player.ships) {
        const shipEl = el('div', 'ship');
        shipEl.classList.add(ship.orient === 'H' ? 'h' : 'v');
        if (ship.id === selectedShipId) shipEl.classList.add('selected');
        if (sunkShipIds && sunkShipIds.has(ship.id)) shipEl.classList.add('sunk');

        // Position in percent to stay responsive.
        const w = ship.orient === 'H' ? ship.len : 1;
        const h = ship.orient === 'V' ? ship.len : 1;

        shipEl.style.left = `${(ship.origin.c / COLS) * 100}%`;
        shipEl.style.top = `${(ship.origin.r / ROWS) * 100}%`;
        shipEl.style.width = `${(w / COLS) * 100}%`;
        shipEl.style.height = `${(h / ROWS) * 100}%`;

        shipEl.dataset.shipId = ship.id;

        if (selectable) {
          shipEl.addEventListener('click', (e) => {
            e.stopPropagation();
            onShipClick && onShipClick(ship.id);
          });
        } else {
          shipEl.style.pointerEvents = 'none';
        }

        layerEl.appendChild(shipEl);
      }
    },

    // Play
    getCurrentPlayerIdx() {
      return this.state.currentPlayer;
    },
    getCurrentPlayer() {
      return this.state.players[this.state.currentPlayer];
    },
    getOpponentPlayerIdx() {
      return this.state.currentPlayer === 0 ? 1 : 0;
    },
    getOpponentPlayer() {
      return this.state.players[this.getOpponentPlayerIdx()];
    },

    startTurnTimer() {
      this.stopTurnTimer();
      const s = this.state;
      if (!s || s.phase !== TurnPhase.PLAY) return;
      if (!s.config.timerEnabled) {
        this.els.timerPill.classList.add('hidden');
        return;
      }

      s.turn.paused = false;
      this.els.timerPill.classList.remove('hidden');
      this.els.timerText.textContent = `${s.turn.timer}s`;

      s.turn.timerId = setInterval(() => {
        if (s.turn.paused) return;
        s.turn.timer--;
        this.els.timerText.textContent = `${s.turn.timer}s`;
        if (s.turn.timer <= 0) {
          this.stopTurnTimer();
          this.toast("Time's up!", 'bad');
          // Auto-end turn (no shot) after short pause
          setTimeout(() => this.endTurn(), 1200);
        }
      }, 1000);
    },

    stopTurnTimer() {
      if (!this.state) return;
      if (this.state.turn.timerId) clearInterval(this.state.turn.timerId);
      this.state.turn.timerId = null;
    },

    pauseTimer(paused) {
      if (!this.state) return;
      this.state.turn.paused = paused;
    },

    startTurn() {
      const s = this.state;
      const curIdx = this.getCurrentPlayerIdx();
      const cur = this.getCurrentPlayer();
      const opp = this.getOpponentPlayer();

      s.turn.timer = s.config.turnSeconds;
      s.turn.hasFiredThisTurn = false;

      // Shots: base 1 + bonus
      s.turn.shotsRemaining = 1 + (cur.bonusShotsNextTurn || 0);
      cur.bonusShotsNextTurn = 0;

      // UI reset
      s.ui.play.ownVisible = false;
      this.setOwnVisible(false, true);

      s.ui.play.hint.selectedCardId = null;
      s.ui.play.hint.selection = null;
      s.ui.play.hint.setThisTurn = false;
      s.ui.play.hint.computedTruth = null;
      s.ui.play.hint.claimHas = true;

      s.ui.play.targetSel = null;

      // Incoming hint: opponent's active hint (about opponent's own board)
      s.ui.play.incoming.hintId = (opp.hints.active && !opp.hints.active.resolved) ? opp.hints.active.id : null;
      s.ui.play.incoming.guess = null;
      s.ui.play.incoming.judged = false;

      this.renderPlay();
      this.startTurnTimer();
    },

    renderPlay() {
      const s = this.state;
      const curIdx = this.getCurrentPlayerIdx();
      const cur = this.getCurrentPlayer();
      const opp = this.getOpponentPlayer();

      this.els.turnTitle.textContent = `Player ${curIdx + 1}'s Turn`;
      this.els.turnSubtitle.textContent = `Before your first shot, you may place 1 hint on your board (optional).`;

      this.els.shotsText.textContent = String(s.turn.shotsRemaining);
      this.els.hintsLeftText.textContent = String(cur.cards.filter(c => !c.used).length);

      // Target board: show attacks so far
      this.renderCellsFromTarget(this.els.targetBoard, cur, opp);

      // Selected target highlight
      for (const b of this.els.targetBoard.querySelectorAll('.cell')) {
        const r = parseInt(b.dataset.r, 10);
        const c = parseInt(b.dataset.c, 10);
        const sel = s.ui.play.targetSel;
        b.classList.toggle('sel', !!sel && sel.r === r && sel.c === c);
        b.classList.toggle('blocked', cur.targetShots[r][c] !== 'unknown');
      }

      // Own board: show defense hits/misses
      this.renderCellsFromDefense(this.els.ownBoard, cur);

      // Render ships on own board (only when visible)
      const ownFleet = this.getFleetStatus(cur);
      const ownSunkShipIds = new Set(
        Object.entries(ownFleet)
          .filter(([, st]) => st.sunk)
          .map(([shipId]) => shipId)
      );
      this.renderShipLayer(this.els.ownShipLayer, cur, {
        selectable: false,
        sunkShipIds: ownSunkShipIds
      });
      this.els.ownShipLayer.style.opacity = s.ui.play.ownVisible ? '1' : '0';

      // Render hints:
      this.renderHintsLayer(this.els.targetHintLayer, opp, { view: 'opponent' }); // hints about opponent (visible on your target board)
      this.renderHintsLayer(this.els.ownHintLayer, cur, { view: 'self' }); // your own hints (preview + your past)

      // Cards
      this.renderCards();

      // Hint controls state
      this.renderHintControls();

      // Enemy ships status
      this.renderEnemyShips();

      // Guess bar
      this.renderGuessBar();

      // Log
      this.els.logLine.textContent = this.makeLogLine();
    },

    makeLogLine() {
      const s = this.state;
      const cur = this.getCurrentPlayer();
      const opp = this.getOpponentPlayer();

      const incoming = opp.hints.active && !opp.hints.active.resolved;
      if (incoming && !s.ui.play.incoming.judged) {
        return 'Incoming hint is active. Select a target cell, choose TRUE/LIE, then confirm.';
      }
      if (s.turn.shotsRemaining > 0 && !s.ui.play.targetSel) {
        return 'Pick a target cell.';
      }
      if (s.ui.play.targetSel && (!incoming || s.ui.play.incoming.judged)) {
        return 'Tap another target cell or confirm a shot (if required).';
      }
      return '...';
    },

    renderEnemyShips() {
      const cur = this.getCurrentPlayer();
      const opp = this.getOpponentPlayer();

      // Determine opponent ship status from their defenseShots
      const shipStatus = this.getFleetStatus(opp);

      this.els.enemyShips.innerHTML = '';
      for (const def of SHIPS) {
        const st = shipStatus[def.id];
        const row = el('div', 'enemyRow');
        if (st.sunk) row.classList.add('sunk');

        const left = el('div', 'left');
        const mini = el('div', `mini len${def.len}`);
        const name = el('div', '', def.name);

        left.appendChild(mini);
        left.appendChild(name);

        const right = el('div', 'right', st.sunk ? 'SUNK' : `${st.hits}/${st.len}`);

        row.appendChild(left);
        row.appendChild(right);

        this.els.enemyShips.appendChild(row);
      }
    },

    getFleetStatus(player) {
      const status = {};
      for (const def of SHIPS) status[def.id] = { len: def.len, hits: 0, sunk: false };

      // Map ship cells by ship id
      const shipCells = {};
      for (const ship of player.ships) {
        shipCells[ship.id] = computeShipCells(ship.origin, ship.orient, ship.len);
      }

      for (const ship of player.ships) {
        const cells = shipCells[ship.id];
        let hits = 0;
        for (const { r, c } of cells) {
          if (player.defenseShots[r][c] === 'hit') hits++;
        }
        status[ship.id].hits = hits;
        status[ship.id].sunk = hits === ship.len;
      }

      return status;
    },

    getSunkCellKeySet(player) {
      const out = new Set();
      const fleet = this.getFleetStatus(player);
      for (const ship of player.ships) {
        if (!fleet[ship.id] || !fleet[ship.id].sunk) continue;
        const cells = computeShipCells(ship.origin, ship.orient, ship.len);
        for (const { r, c } of cells) out.add(`${r},${c}`);
      }
      return out;
    },

    renderGuessBar() {
      const s = this.state;
      const opp = this.getOpponentPlayer();

      const incoming = opp.hints.active && !opp.hints.active.resolved;
      const needsJudgement = incoming && !s.ui.play.incoming.judged;

      if (!needsJudgement) {
        this.els.guessBar.classList.add('hidden');
        return;
      }

      this.els.guessBar.classList.remove('hidden');

      // Describe incoming hint briefly
      const h = opp.hints.active;
      this.els.incomingHintDesc.textContent = this.describeHint(h, { claimed: true });

      this.els.guessTrueBtn.classList.toggle('primary', s.ui.play.incoming.guess === true);
      this.els.guessLieBtn.classList.toggle('primary', s.ui.play.incoming.guess === false);

      const targetChosen = !!s.ui.play.targetSel;
      this.els.confirmShotBtn.disabled = !(targetChosen && (s.ui.play.incoming.guess !== null));
    },

    describeHint(hint, { claimed }) {
      const hasTxt = claimed ? (hint.claimHas ? 'HAS' : 'HAS NOT') : (hint.areaHasShip ? 'HAS' : 'HAS NOT');

      if (hint.type === 'row') return `Hint: Row ${hint.selection.row + 1} ${hasTxt} a ship cell.`;
      if (hint.type === 'col') return `Hint: Column ${COL_LABELS[hint.selection.col]} ${hasTxt} a ship cell.`;
      if (hint.type === 'area') return `Hint: 3×3 area around ${coordToText(hint.selection.center.r, hint.selection.center.c)} ${hasTxt} a ship cell.`;
      return `Hint: Cell ${coordToText(hint.selection.cell.r, hint.selection.cell.c)} ${hasTxt} a ship cell.`;
    },

    renderHintsLayer(layerEl, defenderPlayer, { view }) {
      // view: 'opponent' (you are attacking this defender) or 'self' (your own board)
      layerEl.innerHTML = '';

      // Past hints (correct display)
      for (const hint of defenderPlayer.hints.past) {
        const overlay = this.makeHintOverlay(hint, { mode: 'past', correct: true });
        if (hint.blink) overlay.classList.add('blink');
        layerEl.appendChild(overlay);
      }

      // Active hint (claimed colors) - only show to opponent on target board, and to self too (so you remember)
      if (defenderPlayer.hints.active && !defenderPlayer.hints.active.resolved) {
        const hint = defenderPlayer.hints.active;
        const overlay = this.makeHintOverlay(hint, { mode: 'active', correct: false });
        layerEl.appendChild(overlay);
      }

      // Preview hint while placing on own board
      if (view === 'self') {
        const s = this.state;
        const uiHint = s.ui.play.hint;
        if (uiHint.selectedCardId && uiHint.selection) {
          const preview = {
            id: 'preview',
            owner: this.getCurrentPlayerIdx(),
            type: uiHint.selectedCardId,
            selection: uiHint.selection,
            claimHas: uiHint.claimHas,
          };
          const overlay = this.makeHintOverlay(preview, { mode: 'active', correct: false });
          overlay.style.borderStyle = 'dashed';
          overlay.style.opacity = '0.95';
          layerEl.appendChild(overlay);
        }
      }
    },

    makeHintOverlay(hint, { mode, correct }) {
      const rect = hintRect(hint.type, hint.selection);
      const d = el('div', 'hintOverlay');

      d.style.left = `${(rect.c / COLS) * 100}%`;
      d.style.top = `${(rect.r / ROWS) * 100}%`;
      d.style.width = `${(rect.w / COLS) * 100}%`;
      d.style.height = `${(rect.h / ROWS) * 100}%`;

      d.classList.add(mode);

      const showHas = correct ? !!hint.areaHasShip : !!hint.claimHas;
      d.classList.add(showHas ? 'has' : 'hasnot');

      return d;
    },

    renderCards() {
      const s = this.state;
      const cur = this.getCurrentPlayer();
      const uiHint = s.ui.play.hint;

      this.els.cardsRow.innerHTML = '';
      for (const card of cur.cards) {
        const c = el('div', 'hintCard');
        if (card.used) c.classList.add('used');
        if (uiHint.selectedCardId === card.id) c.classList.add('selected');

        const iconWrap = el('div', 'hintIcon');
        iconWrap.innerHTML = (icons[card.id] ? icons[card.id]() : icons.cell());

        c.appendChild(iconWrap);

        const name = el('div', 'hintName', card.name);
        const text = el('div', 'hintText', card.desc);

        c.appendChild(name);
        c.appendChild(text);

        c.addEventListener('click', () => {
          if (!this.state.ui.play.ownVisible) {
            this.toast('Show your board to place a hint.', 'bad');
            return;
          }
          if (this.state.turn.hasFiredThisTurn) {
            this.toast('Hints must be placed before your first shot.', 'bad');
            return;
          }
          if (this.state.ui.play.hint.setThisTurn) {
            this.toast('Only one hint per turn.', 'bad');
            return;
          }
          if (cur.hints.active && !cur.hints.active.resolved) {
            this.toast('You already have an active hint waiting to be judged.', 'bad');
            return;
          }
          if (card.used) return;

          uiHint.selectedCardId = (uiHint.selectedCardId === card.id) ? null : card.id;
          uiHint.selection = null;
          uiHint.computedTruth = null;

          this.renderPlay();
        });

        this.els.cardsRow.appendChild(c);
      }
    },

    renderHintControls() {
      const s = this.state;
      const cur = this.getCurrentPlayer();
      const uiHint = s.ui.play.hint;

      // Toggle buttons
      this.els.toggleHasBtn.classList.toggle('active', uiHint.claimHas === true);
      this.els.toggleHasNotBtn.classList.toggle('active', uiHint.claimHas === false);

      // Confirm hint enabled when a card is selected and selection made
      const canConfirm = !!uiHint.selectedCardId && !!uiHint.selection && !uiHint.setThisTurn && !s.turn.hasFiredThisTurn;
      this.els.confirmHintBtn.disabled = !canConfirm;

      // Truth preview text
      if (!uiHint.selectedCardId) {
        this.els.ownHintTruthText.innerHTML = 'Select a hint card to place one hint (optional, once per turn).';
        return;
      }
      if (!uiHint.selection) {
        this.els.ownHintTruthText.innerHTML = 'Tap your board to choose the hint area. <span class="muted">(Only you can see whether it is true or a bluff.)</span>';
        return;
      }

      const cardId = uiHint.selectedCardId;
      const cells = hintCells(cardId, uiHint.selection);
      const areaHas = evaluateAreaHasShip(cur, cells);
      uiHint.areaHasShip = areaHas;

      const truth = uiHint.claimHas ? areaHas : !areaHas;
      uiHint.computedTruth = truth;

      const badge = truth ? `<span style="color: var(--good); font-weight:900;">TRUE</span>` : `<span style="color: var(--danger); font-weight:900;">LIE</span>`;
      const note = truth ? 'It matches your real board.' : 'It does NOT match your real board (a bluff).';

      this.els.ownHintTruthText.innerHTML = `This hint would be: ${badge} <span class="muted tiny">— ${note}</span>`;
    },

    setHasToggle(has) {
      if (!this.state) return;
      this.state.ui.play.hint.claimHas = has;
      // Recompute truth and update colors
      this.renderPlay();
    },

    setOwnVisible(visible, silent = false) {
      if (!this.state) return;
      this.state.ui.play.ownVisible = visible;
      this.els.ownHideOverlay.classList.toggle('hidden', visible);
      this.els.hideOwnBtn.classList.toggle('hidden', !visible);
      if (!silent) this.renderPlay();
    },

    onOwnCellClick(_ev, r, c) {
      const s = this.state;
      if (!s || s.phase !== TurnPhase.PLAY) return;
      if (!s.ui.play.ownVisible) return;

      const cur = this.getCurrentPlayer();
      const uiHint = s.ui.play.hint;
      if (!uiHint.selectedCardId) return;

      // Set selection depending on card
      if (uiHint.selectedCardId === 'row') uiHint.selection = { row: r };
      else if (uiHint.selectedCardId === 'col') uiHint.selection = { col: c };
      else if (uiHint.selectedCardId === 'area') uiHint.selection = { center: { r, c } };
      else uiHint.selection = { cell: { r, c } };

      this.renderPlay();
    },

    confirmHint() {
      const s = this.state;
      const curIdx = this.getCurrentPlayerIdx();
      const cur = this.getCurrentPlayer();
      const uiHint = s.ui.play.hint;

      if (!uiHint.selectedCardId || !uiHint.selection) return;
      if (uiHint.setThisTurn) return;
      if (s.turn.hasFiredThisTurn) return;

      // Determine truth and areaHasShip
      const cells = hintCells(uiHint.selectedCardId, uiHint.selection);
      const areaHas = evaluateAreaHasShip(cur, cells);
      const truth = uiHint.claimHas ? areaHas : !areaHas;

      // Consume card
      const card = cur.cards.find(c => c.id === uiHint.selectedCardId);
      if (card) card.used = true;

      // Create hint
      const hint = {
        id: `H-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        owner: curIdx, // the defender who owns the hinted board
        type: uiHint.selectedCardId,
        selection: structuredClone(uiHint.selection),
        claimHas: uiHint.claimHas,
        areaHasShip: areaHas,
        truth: truth, // whether claim matches reality
        resolved: false,
        forced: false,
      };

      cur.hints.active = hint;
      uiHint.setThisTurn = true;
      uiHint.selectedCardId = null;
      uiHint.selection = null;

      this.toast('Hint placed for your opponent.', 'good');
      this.renderPlay();
    },

    onTargetCellClick(_ev, r, c) {
      const s = this.state;
      if (!s || s.phase !== TurnPhase.PLAY) return;

      const cur = this.getCurrentPlayer();
      if (cur.targetShots[r][c] !== 'unknown') return;
      if (s.turn.shotsRemaining <= 0) return;

      s.ui.play.targetSel = { r, c };
      this.renderPlay();

      const opp = this.getOpponentPlayer();
      const incoming = (opp.hints.active && !opp.hints.active.resolved) ? opp.hints.active : null;
      const needsJudgement = !!incoming && !s.ui.play.incoming.judged;

      if (!needsJudgement) {
        // No active incoming hint -> fire immediately
        this.fireShot();
      } else {
        // Wait for guess + confirm
        this.toast('Choose TRUE/LIE, then confirm.', 'good');
      }
    },

    setGuess(isTrue) {
      const s = this.state;
      if (!s) return;
      s.ui.play.incoming.guess = isTrue;
      this.renderPlay();
    },

    async confirmShot() {
      const s = this.state;
      if (!s || s.phase !== TurnPhase.PLAY) return;

      const opp = this.getOpponentPlayer();

      // ✅ FIX: incoming must be the hint object (or null), not a boolean
      const incoming = (opp.hints.active && !opp.hints.active.resolved) ? opp.hints.active : null;
      if (!incoming) return;

      if (!s.ui.play.targetSel) {
        this.toast('Pick a target cell first.', 'bad');
        return;
      }
      if (s.ui.play.incoming.guess === null) {
        this.toast('Choose TRUE or LIE first.', 'bad');
        return;
      }

      // Resolve hint reveal overlay (timer paused)
      this.pauseTimer(true);

      const guessTrue = s.ui.play.incoming.guess;
      const hintTruth = incoming.truth; // true = the hint was TRUE, false = it was a LIE

      const resultIsTrue = hintTruth === true;
      const bigText = resultIsTrue ? 'It was TRUE!' : 'It was a LIE!';
      const bigColor = resultIsTrue ? 'var(--good)' : 'var(--danger)';

      // Build effect text (effects apply to the hint owner (defender): opponent)
      const effectText = this.getEffectDescription(incoming, guessTrue);

      await this.showResultOverlay(bigText, bigColor, effectText);

      // Mark hint as resolved and move to past (correct display)
      incoming.resolved = true;
      opp.hints.active = null;

      const pastHint = { ...incoming };
      opp.hints.past.push(pastHint);

      // Resume timer for effect stage (as requested)
      this.pauseTimer(false);

      // Apply effects with small animations
      await this.applyHintEffects(incoming, guessTrue);

      // Mark judgement done and proceed with the actual shot
      s.ui.play.incoming.judged = true;
      this.renderPlay();
      this.fireShot();
    },

    getEffectDescription(hint, attackerGuessedTrue) {
      // Effects apply to hint owner (defender).
      const hintWasTrue = hint.truth === true;
      const gTxt = attackerGuessedTrue ? 'believed' : 'doubted';

      if (hintWasTrue) {
        if (attackerGuessedTrue) return 'Effect: none (they trusted a true hint).';
        return 'Effect: some destroyed non-ship cells on the defender board will revive.';
      } else {
        if (attackerGuessedTrue) return 'Effect: defender will get +2 extra shots on their next turn.';
        return 'Effect: a correct hint will be added about the defender (forced).';
      }
    },

    showResultOverlay(bigText, color, effectText) {
      return new Promise((resolve) => {
        this.els.resultSmall.textContent = 'The result is…';
        this.els.resultBig.textContent = '—';
        this.els.resultBig.style.color = 'var(--text)';
        this.els.resultEffect.textContent = '';
        this.els.resultContinueBtn.classList.add('hidden');
        this.els.resultContinueBtn.disabled = true;
        this.els.resultOverlay.classList.remove('hidden');

        setTimeout(() => {
          this.els.resultBig.textContent = bigText;
          this.els.resultBig.style.color = color;
          this.els.resultEffect.textContent = effectText;
          this.els.resultContinueBtn.disabled = false;
          this.els.resultContinueBtn.classList.remove('hidden');
          this.els.resultContinueBtn.focus();
          this.els.resultContinueBtn.onclick = () => {
            this.els.resultContinueBtn.onclick = null;
            this.els.resultOverlay.classList.add('hidden');
            resolve();
          };
        }, 1600);
      });
    },

    async applyHintEffects(hint, attackerGuessedTrue) {
      const opp = this.getOpponentPlayer(); // defender (hint owner)
      const cur = this.getCurrentPlayer();  // attacker

      const hintWasTrue = hint.truth === true;

      if (hintWasTrue) {
        if (attackerGuessedTrue) {
          // no effect
          return;
        }
        // Revive: random selection of destroyed non-ship cells = round(destroyed/2)
        const destroyed = getDestroyedNonShipCells(opp);
        const n = roundHalf(destroyed.length);
        if (n <= 0) return;

        shuffle(destroyed);
        const chosen = destroyed.slice(0, n);

        // Animate on attacker's target board cells and on defender's board cells
        for (const { r, c } of chosen) {
          opp.defenseShots[r][c] = 'none';
          cur.targetShots[r][c] = 'unknown';

          this.animateCell(this.els.targetBoard, r, c, 'reviveAnim');
          this.animateCell(this.els.ownBoard, r, c, 'reviveAnim'); // will show when defender views; still okay
        }

        this.toast(`Revive: ${n} cell(s) restored`, 'good');
        await this.sleep(900);
        this.renderPlay();
        return;
      }

      // Hint was a lie
      if (attackerGuessedTrue) {
        // Defender gets bonus shot next turn
        opp.bonusShotsNextTurn += 2;
        this.toast('+2 SHOTS', 'good', true);
        await this.sleep(900);
        this.renderPlay();
        return;
      }

      // Attacker caught the lie -> force a correct hint about defender
      const forcedHint = this.createForcedCorrectHint(opp);
      forcedHint.blink = true;
      opp.hints.past.push(forcedHint);

      this.toast('Forced correct hint added!', 'bad');
      await this.sleep(900);
      // stop blinking after a short period
      setTimeout(() => {
        forcedHint.blink = false;
        this.renderPlay();
      }, 2500);

      this.renderPlay();
    },

    createForcedCorrectHint(defender) {
      // Choose random type, random selection, set claimHas = correct.
      const type = HINT_CARDS[randInt(HINT_CARDS.length)].id;

      let selection = null;
      if (type === 'row') selection = { row: randInt(ROWS) };
      else if (type === 'col') selection = { col: randInt(COLS) };
      else if (type === 'area') selection = { center: { r: randInt(ROWS), c: randInt(COLS) } };
      else selection = { cell: { r: randInt(ROWS), c: randInt(COLS) } };

      const cells = hintCells(type, selection);
      const areaHas = evaluateAreaHasShip(defender, cells);

      return {
        id: `F-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        owner: defender === this.state.players[0] ? 0 : 1,
        type,
        selection,
        claimHas: areaHas,   // correct claim
        areaHasShip: areaHas,
        truth: true,
        resolved: true,
        forced: true,
        blink: true,
      };
    },

    fireShot() {
      const s = this.state;
      if (!s || s.phase !== TurnPhase.PLAY) return;

      const cur = this.getCurrentPlayer();
      const opp = this.getOpponentPlayer();

      const sel = s.ui.play.targetSel;
      if (!sel) return;

      const { r, c } = sel;
      if (cur.targetShots[r][c] !== 'unknown') return;
      if (s.turn.shotsRemaining <= 0) return;

      // After first shot, lock hint placement for this turn
      s.turn.hasFiredThisTurn = true;

      // Resolve shot
      const hasShip = !!opp.occupancy[r][c];
      if (hasShip) {
        cur.targetShots[r][c] = 'hit';
        opp.defenseShots[r][c] = 'hit';

        // shake animation on target cell
        this.animateCell(this.els.targetBoard, r, c, 'shake');

        // extra shot on hit (base rule toggle)
        if (s.config.extraShotOnHit) s.turn.shotsRemaining += 1;

        this.toast('HIT!', 'good');
      } else {
        cur.targetShots[r][c] = 'miss';
        opp.defenseShots[r][c] = 'miss';
        this.toast('MISS', 'bad');
      }

      // consume one shot
      s.turn.shotsRemaining -= 1;
      this.els.shotsText.textContent = String(s.turn.shotsRemaining);

      // Clear selection
      s.ui.play.targetSel = null;

      // Check win
      const oppStatus = this.getFleetStatus(opp);
      const allSunk = Object.values(oppStatus).every(st => st.sunk);
      if (allSunk) {
        this.stopTurnTimer();
        this.showGameOver(`Player ${this.getCurrentPlayerIdx() + 1} wins!`, 'All enemy ships are sunk.');
        return;
      }

      this.renderPlay();

      // End turn if no shots left
      if (s.turn.shotsRemaining <= 0) {
        this.endTurnWithDelay();
      }
    },

    endTurnWithDelay() {
      this.stopTurnTimer();
      this.toast('Turn ends…', 'good');
      setTimeout(() => this.endTurn(), 3000);
    },

    endTurn() {
      const s = this.state;
      if (!s) return;

      // Switch player
      s.currentPlayer = (s.currentPlayer === 0) ? 1 : 0;

      // Show pass overlay
      this.openPassOverlay(`Player ${s.currentPlayer + 1}`, `Pass the device. Player ${s.currentPlayer + 1}, prepare for your turn.`);
      this.showPanel('#playPanel');
      this.setPhasePill('Play');

      // Start next player's turn when ready
      setTimeout(() => {
        // Ensure we don't start until they hit "I'm ready"
        // We'll hook into onReady() to call renderPlay and start timer, but we also need to reset turn state now.
        this.startTurn();
      }, 0);
    },

    // UI extras
    animateCell(gridEl, r, c, cls) {
      const q = `.cell[data-r="${r}"][data-c="${c}"]`;
      const cell = gridEl.querySelector(q);
      if (!cell) return;
      cell.classList.remove(cls);
      // force reflow
      void cell.offsetWidth;
      cell.classList.add(cls);
      const durationMs = cls === 'reviveAnim' ? 3000 : 1200;
      setTimeout(() => cell.classList.remove(cls), durationMs);
    },

    toast(text, type = 'good', big = false) {
      const t = this.els.toast;
      t.textContent = text;
      t.classList.remove('hidden', 'good', 'bad', 'big');
      t.classList.add(type === 'bad' ? 'bad' : 'good');
      if (big) t.classList.add('big');
      clearTimeout(this._toastT);
      this._toastT = setTimeout(() => t.classList.add('hidden'), big ? 1100 : 900);
    },

    sleep(ms) {
      return new Promise(res => setTimeout(res, ms));
    },

    // Game over
    showGameOver(title, body) {
      this.els.gameOverTitle.textContent = title;
      this.els.gameOverBody.textContent = body;
      this.els.gameOverOverlay.classList.remove('hidden');
    },

    confirmEndGame() {
      const shouldEnd = window.confirm('End the current game?');
      if (!shouldEnd) return;
      this.endGame('Game ended.');
    },

    endGame(msg) {
      this.stopTurnTimer();
      this.showGameOver('Game Over', msg);
    },
  };

  // Boot
  window.addEventListener('DOMContentLoaded', () => {
    App.init();

    // Start actual play turn when play panel becomes visible after setup lock-in pass.
    // We do it from App.onReady() by checking phase, but we also need to start first turn after player 1 ready.
    // We'll hook into pass overlay close by observing phase and current panel.
    const readyBtn = document.getElementById('readyBtn');
    readyBtn.addEventListener('click', () => {
      if (App.state && App.state.phase === TurnPhase.PLAY) {
        // ensure turn started (might already have been started)
        // If timer hasn't started, start it.
        // Also reset incoming state each time.
        // App.startTurn() is called at endTurn(), but for first entry we do it here.
        if (!App.state._firstPlayStarted) {
          App.state._firstPlayStarted = true;
          App.startTurn();
        }
      }
    });
  });

})();
