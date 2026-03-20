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

  const HINT_TYPES = [
    { id: 'row', name: 'Row', desc: 'Hint about a row.' },
    { id: 'col', name: 'Column', desc: 'Hint about a column.' },
    { id: 'area', name: '3×3 Area', desc: 'Hint about a 3×3 area.' },
    { id: 'cell', name: 'Single Cell', desc: 'Hint about one cell.' },
  ];
  const HINT_CARDS = [
    ...HINT_TYPES,
    { id: 'fake', name: 'Fake', desc: 'Pretend to place a hint. No area is recorded.' },
  ];

  const TurnPhase = {
    START: 'start',
    SETUP: 'setup',
    PLAY: 'play',
  };

  const SessionAPI = window.BattleshipSession;
  const RoomAPI = window.BattleshipRoomState;
  const RoomClientAPI = window.BattleshipRoomClient;

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
    if (type === 'fake') return [];
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
    if (type === 'fake') return { r: 0, c: 0, w: 0, h: 0 };
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

  function evaluateAreaHasUnexposedShip(player, cells) {
    return cells.some(({ r, c }) => player.occupancy[r][c] != null && player.defenseShots[r][c] !== 'hit');
  }

  function getRevivableDestroyedCells(player, excludedCellKeys = new Set()) {
    const out = [];
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const shot = player.defenseShots[r][c];
        const hasShip = player.occupancy[r][c] != null;
        const key = `${r},${c}`;

        if (shot === 'miss') {
          out.push({ r, c });
          continue;
        }
        if (shot === 'hit' && hasShip && !excludedCellKeys.has(key)) {
          out.push({ r, c });
        }
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

  function isHintType(type) {
    return HINT_TYPES.some((card) => card.id === type);
  }

  function randomHintSelection(type) {
    if (type === 'row') return { row: randInt(ROWS) };
    if (type === 'col') return { col: randInt(COLS) };
    if (type === 'area') return { center: { r: randInt(ROWS), c: randInt(COLS) } };
    return { cell: { r: randInt(ROWS), c: randInt(COLS) } };
  }

  function createUnconstrainedFakeDisguise(player) {
    // Intentionally unconstrained: fake-hint disguise may overlap fully with past hints
    // and therefore may reveal no new information.
    const unconsumed = (player?.cards || [])
      .filter((card) => isHintType(card.id) && !card.used)
      .map((card) => card.id);
    const pool = unconsumed.length > 0 ? unconsumed : HINT_TYPES.map((card) => card.id);
    const type = pool[randInt(pool.length)];
    return {
      type,
      selection: randomHintSelection(type),
      claimHas: Math.random() < 0.5,
    };
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
    fake: () => `
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
        <path d="M12 2a6 6 0 0 0-6 6h2a4 4 0 1 1 4 4 1 1 0 0 0-1 1v3h2v-2.1A6 6 0 0 0 12 2zm-1 17h2v3h-2v-3z" />
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
      this.renderStaticBoards();
      this.bootstrapSession();
    },

    cacheEls() {
      this.els = {
        modePill: $('#modePill'),
        roomPill: $('#roomPill'),
        connectionPill: $('#connectionPill'),
        phasePill: $('#phasePill'),
        timerPill: $('#timerPill'),
        timerText: $('#timerText'),
        effectsInfoBtn: $('#effectsInfoBtn'),
        flowInfoBtn: $('#flowInfoBtn'),
        placeHintEffectsInfoBtn: $('#placeHintEffectsInfoBtn'),
        effectsInfoOverlay: $('#effectsInfoOverlay'),
        guessHintInfoOverlay: $('#guessHintInfoOverlay'),
        placeHintInfoOverlay: $('#placeHintInfoOverlay'),
        flowInfoOverlay: $('#flowInfoOverlay'),
        closeEffectsInfoBtn: $('#closeEffectsInfoBtn'),
        closeGuessHintInfoBtn: $('#closeGuessHintInfoBtn'),
        closePlaceHintInfoBtn: $('#closePlaceHintInfoBtn'),
        closeFlowInfoBtn: $('#closeFlowInfoBtn'),
        exhaustHintOverlay: $('#exhaustHintOverlay'),
        exhaustHintBoard: $('#exhaustHintBoard'),
        exhaustHintLayer: $('#exhaustHintLayer'),
        exhaustTypePicker: $('#exhaustTypePicker'),
        exhaustHintSelectionText: $('#exhaustHintSelectionText'),
        confirmExhaustHintBtn: $('#confirmExhaustHintBtn'),

        startPanel: $('#startPanel'),
        roomPanel: $('#roomPanel'),
        setupPanel: $('#setupPanel'),
        playPanel: $('#playPanel'),
        sessionNotice: $('#sessionNotice'),

        startBtn: $('#startBtn'),
        p1NameInput: $('#p1NameInput'),
        p2NameInput: $('#p2NameInput'),
        turnTimerInput: $('#turnTimerInput'),
        timerToggleBtn: $('#timerToggleBtn'),
        extraShotToggle: $('#extraShotToggle'),
        roomInfoBtn: $('#roomInfoBtn'),
        closeRoomInfoBtn: $('#closeRoomInfoBtn'),

        roomPanelTitle: $('#roomPanelTitle'),
        roomPanelLead: $('#roomPanelLead'),
        roomPlayerName: $('#roomPlayerName'),
        roomCodeText: $('#roomCodeText'),
        roomConnectionText: $('#roomConnectionText'),
        roomPhaseText: $('#roomPhaseText'),
        roomPlayers: $('#roomPlayers'),
        roomWaitingText: $('#roomWaitingText'),
        roomErrorNotice: $('#roomErrorNotice'),
        roomDevNotice: $('#roomDevNotice'),
        roomReadyBtn: $('#roomReadyBtn'),
        roomStartBtn: $('#roomStartBtn'),
        roomRetryBtn: $('#roomRetryBtn'),
        roomLocalBtn: $('#roomLocalBtn'),
        roomLastActionText: $('#roomLastActionText'),

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
        targetLockOverlay: $('#targetLockOverlay'),
        enemyShips: $('#enemyShips'),

        ownBoard: $('#ownBoard'),
        ownShipLayer: $('#ownShipLayer'),
        ownHintLayer: $('#ownHintLayer'),
        ownHideOverlay: $('#ownHideOverlay'),
        showOwnBtn: $('#showOwnBtn'),
        hideOwnBtn: $('#hideOwnBtn'),
        ownHintTruthText: $('#ownHintTruthText'),
        hintCardsEffectText: $('#hintCardsEffectText'),
        toggleHasBtn: $('#toggleHasBtn'),
        toggleHasNotBtn: $('#toggleHasNotBtn'),
        confirmHintBtn: $('#confirmHintBtn'),
        cardsRow: $('#cardsRow'),

        guessBar: $('#guessBar'),
        incomingHintDesc: $('#incomingHintDesc'),
        guessEffectsInfoBtn: $('#guessEffectsInfoBtn'),
        guessTrueBtn: $('#guessTrueBtn'),
        guessLieBtn: $('#guessLieBtn'),
        guessFakeBtn: $('#guessFakeBtn'),
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
        resultGuess: $('#resultGuess'),
        resultEffect: $('#resultEffect'),
        resultContinueBtn: $('#resultContinueBtn'),
        exhaustHintTitle: $('#exhaustHintTitle'),
        exhaustHintBody: $('#exhaustHintBody'),

        toast: $('#toast'),
        turnPopup: $('#turnPopup'),
        hintOutcomePopup: $('#hintOutcomePopup'),
        hintOutcomeTitle: $('#hintOutcomeTitle'),
        hintOutcomeTruth: $('#hintOutcomeTruth'),
        hintOutcomeGuess: $('#hintOutcomeGuess'),
        hintOutcomeEffect: $('#hintOutcomeEffect'),

        gameOverOverlay: $('#gameOverOverlay'),
        gameOverTitle: $('#gameOverTitle'),
        gameOverBody: $('#gameOverBody'),
        restartBtn: $('#restartBtn'),
      };
    },

    bind() {
      this.els.startBtn.addEventListener('click', () => this.startGame());
      this.els.timerToggleBtn.addEventListener('click', () => this.setTimerEnabled(!this.startTimerEnabled));
      this.els.p1NameInput.addEventListener('change', () => this.commitRoomPlayerName(0));
      this.els.p2NameInput.addEventListener('change', () => this.commitRoomPlayerName(1));
      this.els.p1NameInput.addEventListener('blur', () => this.commitRoomPlayerName(0));
      this.els.p2NameInput.addEventListener('blur', () => this.commitRoomPlayerName(1));
      this.els.roomInfoBtn.addEventListener('click', () => this.openRoomModal());
      this.els.closeRoomInfoBtn.addEventListener('click', () => this.closeRoomModal());
      this.els.roomReadyBtn.addEventListener('click', () => this.toggleRoomReady());
      this.els.roomStartBtn.addEventListener('click', () => this.startRoomMatch());
      this.els.roomRetryBtn.addEventListener('click', () => this.retryRoomConnection());
      this.els.roomLocalBtn.addEventListener('click', () => this.continueInLocalMode('Room mode cancelled by user.'));
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
      this.els.guessFakeBtn.addEventListener('click', () => this.setGuess('fake'));
      this.els.confirmShotBtn.addEventListener('click', () => this.confirmShot());
      this.els.guessEffectsInfoBtn.addEventListener('click', () => this.openInfoOverlay('guessHintInfoOverlay'));

      this.els.readyBtn.addEventListener('click', () => this.onReady());
      this.els.forfeitBtn.addEventListener('click', () => this.confirmEndGame());

      this.els.restartBtn.addEventListener('click', () => this.handleRestartRequest());
      this.els.effectsInfoBtn.addEventListener('click', () => this.openInfoOverlay('effectsInfoOverlay'));
      this.els.placeHintEffectsInfoBtn.addEventListener('click', () => this.openInfoOverlay('placeHintInfoOverlay'));
      this.els.flowInfoBtn.addEventListener('click', () => this.openInfoOverlay('flowInfoOverlay'));
      this.els.closeEffectsInfoBtn.addEventListener('click', () => this.closeInfoOverlay('effectsInfoOverlay'));
      this.els.closeGuessHintInfoBtn.addEventListener('click', () => this.closeInfoOverlay('guessHintInfoOverlay'));
      this.els.closePlaceHintInfoBtn.addEventListener('click', () => this.closeInfoOverlay('placeHintInfoOverlay'));
      this.els.closeFlowInfoBtn.addEventListener('click', () => this.closeInfoOverlay('flowInfoOverlay'));
      this.els.exhaustTypePicker.addEventListener('click', (ev) => {
        const btn = ev.target.closest('.exhaustTypeBtn');
        if (!btn) return;
        const type = btn.dataset.type;
        if (!type) return;
        this.setExhaustHintType(type);
      });
      this.els.confirmExhaustHintBtn.addEventListener('click', () => this.confirmExhaustHintSelection());

      this.els.effectsInfoOverlay.addEventListener('click', (ev) => {
        if (ev.target === this.els.effectsInfoOverlay) this.closeInfoOverlay('effectsInfoOverlay');
      });
      this.els.guessHintInfoOverlay.addEventListener('click', (ev) => {
        if (ev.target === this.els.guessHintInfoOverlay) this.closeInfoOverlay('guessHintInfoOverlay');
      });
      this.els.placeHintInfoOverlay.addEventListener('click', (ev) => {
        if (ev.target === this.els.placeHintInfoOverlay) this.closeInfoOverlay('placeHintInfoOverlay');
      });
      this.els.flowInfoOverlay.addEventListener('click', (ev) => {
        if (ev.target === this.els.flowInfoOverlay) this.closeInfoOverlay('flowInfoOverlay');
      });
      this.els.roomPanel.addEventListener('click', (ev) => {
        if (ev.target === this.els.roomPanel) this.closeRoomModal();
      });

      window.addEventListener('resize', () => {
        if (!this.state) return;
        if (this.state.phase === TurnPhase.SETUP) this.renderSetup();
        if (this.state.phase === TurnPhase.PLAY) this.renderPlay();
      });
      window.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape') {
          this.closeInfoOverlays();
          this.closeRoomModal();
        }
      });
      window.addEventListener('beforeunload', () => {
        if (this.roomClient) this.roomClient.disconnect();
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
      this.closeInfoOverlay('guessHintInfoOverlay');
      this.closeInfoOverlay('placeHintInfoOverlay');
      this.closeInfoOverlay('flowInfoOverlay');
    },

    openRoomModal() {
      if (!this.session || !this.session.isRoomPlay) return;
      this.els.roomPanel.classList.remove('hidden');
    },

    closeRoomModal() {
      this.els.roomPanel.classList.add('hidden');
    },

    isExhaustHintModalOpen() {
      const s = this.state;
      return !!(s && s.ui && s.ui.play && s.ui.play.exhaustReward && s.ui.play.exhaustReward.open);
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

    bootstrapSession() {
      this.session = SessionAPI.resolveSession(window.location.search);
      this.roomState = RoomAPI.createInitialRoomState(this.session);
      this.roomClient = null;
      this.roomLaunchConsumed = false;
      this.lastAppliedRemoteActionAt = 0;
      this._lastTurnPopupKey = null;
      this.roomWaitingOverlayOpen = false;
      if (this.session.playerName && !this.els.p1NameInput.value) {
        this.els.p1NameInput.value = this.session.playerName;
      }

      this.els.timerPill.classList.add('hidden');
      this.setPhasePill('Ready');
      this.updateSessionPills();
      this.renderRoomLaunchControls();
      this.renderRoomNameInputs();
      this.renderSessionNotice();

      if (this.session.isRoomPlay && this.session.isValid) {
        this.showPanel('#startPanel');
        this.startRoomBootstrap();
        return;
      }

      this.showPanel('#startPanel');
      if (this.session.isRoomPlay && !this.session.isValid) {
        this.renderSessionNotice(true);
      }
    },

    updateSessionPills() {
      const modeLabel = this.session.mode === 'local'
        ? 'Mode: Local'
        : `Mode: ${this.session.isHost ? 'Host' : 'Join'}`;
      this.els.modePill.textContent = modeLabel;

      const showRoom = !!this.session.isRoomPlay;
      this.els.roomPill.classList.toggle('hidden', !showRoom);
      this.els.connectionPill.classList.toggle('hidden', !showRoom);

      if (showRoom) {
        this.els.roomPill.textContent = `Room: ${this.session.roomCode || '----'}`;
        const status = this.roomState && this.roomState.connectionStatus ? this.roomState.connectionStatus : 'offline';
        this.els.connectionPill.textContent = status;
      }
    },

    renderRoomLaunchControls() {
      const validRoom = !!(this.session && this.session.isRoomPlay && this.session.isValid);
      this.els.roomInfoBtn.classList.toggle('hidden', !validRoom);
      this.els.startBtn.classList.toggle('hidden', validRoom);
      this.els.startBtn.disabled = validRoom;
    },

    renderRoomNameInputs() {
      const inputs = [this.els.p1NameInput, this.els.p2NameInput];
      if (!this.session || !this.session.isRoomPlay) {
        inputs.forEach((input) => {
          input.readOnly = false;
          input.classList.remove('roomNameReadonly');
          input.removeAttribute('title');
        });
        return;
      }

      const players = (this.roomState && Array.isArray(this.roomState.players)) ? this.roomState.players : [];
      const sorted = players.slice().sort((a, b) => {
        if (a.isHost === b.isHost) return 0;
        return a.isHost ? -1 : 1;
      });
      const fallbackNames = [
        this.session.isHost ? this.session.playerName : '',
        this.session.isGuest ? this.session.playerName : '',
      ];
      const names = [
        (sorted[0] && sorted[0].name) || fallbackNames[0],
        (sorted[1] && sorted[1].name) || fallbackNames[1],
      ];

      inputs.forEach((input, idx) => {
        input.readOnly = true;
        input.classList.add('roomNameReadonly');
        input.title = 'Names are locked in room mode.';
        if (document.activeElement !== input) {
          input.value = names[idx] || '';
        }
      });
    },

    commitRoomPlayerName() {
      if (!this.session || !this.session.isRoomPlay) return;
      return;
    },

    renderSessionNotice(forceVisible = false) {
      const errors = (this.session && this.session.validationErrors) || [];
      const show = forceVisible || errors.length > 0;
      this.els.sessionNotice.classList.toggle('hidden', !show);
      this.els.sessionNotice.classList.remove('warn', 'error', 'info');
      if (!show) {
        this.els.sessionNotice.textContent = '';
        return;
      }

      const label = this.session.isRoomPlay ? 'Room launch issue' : 'Session notice';
      this.els.sessionNotice.classList.add(this.session.isRoomPlay ? 'warn' : 'info');
      this.els.sessionNotice.textContent = `${label}: ${errors.join(' ')} Continuing in local mode is available below.`;
    },

    async startRoomBootstrap() {
      this.setPhasePill('Room');
      this.renderRoomPanel();
      this.openRoomModal();

      this.roomClient = new RoomClientAPI.RoomClient(this.session);
      let lastGameStartSignal = 0;
      this.roomClient.subscribe((nextState) => {
        this.roomState = nextState;
        this.updateSessionPills();
        this.renderRoomPanel();
        const nextGameStartSignal = Number(nextState.gameStartSignal || 0);
        if (nextGameStartSignal > lastGameStartSignal && !this.roomLaunchConsumed) {
          this.roomLaunchConsumed = true;
          this.beginRoomBackedGame();
        }
        lastGameStartSignal = nextGameStartSignal;
      });
      this.roomClient.subscribeGameActions((action) => this.consumeRoomGameAction(action));

      await this.roomClient.connect();
    },

    renderRoomPanel() {
      if (!this.els.roomPanel) return;
      const state = this.roomState || RoomAPI.createInitialRoomState(this.session);
      const players = Array.isArray(state.players) ? state.players : [];
      const localPlayer = players.find((player) => player.id === state.localPlayerId) || null;
      const everyoneReady = players.length === this.session.maxPlayers && players.every((player) => player.isReady);

      this.els.roomPanelTitle.textContent = this.session.isHost ? 'Host Room' : 'Join Room';
      this.els.roomPanelLead.textContent = this.session.isHost
        ? 'Waiting for another player to join this local-dev room.'
        : 'Joining the room and waiting for the host to start.';
      this.els.roomDevNotice.textContent = this.session.wsUrl
        ? 'A ws URL was provided, but this phase intentionally uses the built-in local-dev transport so same-PC testing works with npm start.'
        : 'Local-dev transport is active and gameplay sync now mirrors state across room clients.';
      this.els.roomPlayerName.textContent = (localPlayer && localPlayer.name) || this.session.playerName;
      this.els.roomCodeText.textContent = this.session.roomCode || '----';
      this.els.roomConnectionText.textContent = state.connectionStatus;
      this.els.roomPhaseText.textContent = state.roomPhase;
      this.els.roomWaitingText.textContent = this.makeRoomWaitingText(state, players, everyoneReady);
      this.els.roomLastActionText.textContent = state.lastAction
        ? `Last room action: ${state.lastAction.type}`
        : 'No room actions yet.';

      this.els.roomPlayers.innerHTML = '';
      if (players.length === 0) {
        const empty = el('div', 'muted tiny', 'No players connected yet.');
        this.els.roomPlayers.appendChild(empty);
      } else {
        for (const player of players) {
          const row = el('div', 'roomPlayerRow');
          const meta = el('div', 'roomPlayerMeta');
          const name = el('div', 'roomPlayerName', player.name);
          const sub = el(
            'div',
            'roomPlayerSub',
            `${player.isHost ? 'Host' : 'Guest'}${player.id === state.localPlayerId ? ' • You' : ''}`
          );
          const status = el(
            'div',
            `roomPlayerState ${player.isReady ? 'ready' : 'waiting'}`,
            player.isReady ? 'READY' : 'WAITING'
          );
          meta.appendChild(name);
          meta.appendChild(sub);
          row.appendChild(meta);
          row.appendChild(status);
          this.els.roomPlayers.appendChild(row);
        }
      }

      const showError = !!state.lastError;
      this.els.roomErrorNotice.classList.toggle('hidden', !showError);
      this.els.roomErrorNotice.classList.remove('warn', 'error', 'info');
      if (showError) {
        this.els.roomErrorNotice.classList.add('error');
        this.els.roomErrorNotice.textContent = state.lastError;
      } else {
        this.els.roomErrorNotice.textContent = '';
      }

      const localReady = !!(localPlayer && localPlayer.isReady);
      this.els.roomReadyBtn.textContent = localReady ? 'Set Not Ready' : 'Ready Up';
      this.els.roomReadyBtn.disabled = !!state.roomClosed || state.gameStarted || state.connectionStatus === RoomAPI.CONNECTION_STATUS.ERROR;
      this.els.roomStartBtn.disabled = !this.session.isHost || !everyoneReady || !!state.gameStarted || !!state.roomClosed;
      this.renderRoomNameInputs();
    },

    makeRoomWaitingText(state, players, everyoneReady) {
      if (state.roomClosed) return 'The room was closed. Continue locally or reload.';
      if (state.connectionStatus === RoomAPI.CONNECTION_STATUS.ERROR) return state.lastError || 'Room connection failed.';
      if (state.connectionStatus === RoomAPI.CONNECTION_STATUS.CONNECTING) return 'Connecting to local-dev room transport...';
      if (state.gameStarted) {
        return 'This room already signalled a match. Reload stays in room setup; use Room Info or Retry to reconnect instead of jumping into ship placement.';
      }
      if (players.length < this.session.maxPlayers) return 'Waiting for opponent...';
      if (!everyoneReady) return this.session.isHost ? 'Both players must ready up before the host can start.' : 'Waiting for both players to become ready.';
      return this.session.isHost ? 'Room is ready. Start the match when you want.' : 'Room is ready. Waiting for host to start.';
    },

    toggleRoomReady() {
      if (!this.roomClient || !this.roomState || this.roomState.roomClosed) return;
      this.roomClient.toggleReady(!this.roomState.isReady);
    },

    startRoomMatch() {
      if (!this.roomClient) return;
      this.roomClient.startGame();
    },

    retryRoomConnection() {
      if (!this.session.isRoomPlay || !this.session.isValid) {
        this.continueInLocalMode('Retry was not possible. Switched to local mode.');
        return;
      }
      window.location.reload();
    },

    continueInLocalMode(reason) {
      if (this.roomClient) {
        this.roomClient.disconnect();
        this.roomClient = null;
      }
      this.session = SessionAPI.createLocalFallbackSession(this.session, reason ? [reason] : []);
      this.roomState = RoomAPI.createInitialRoomState(this.session);
      this.updateSessionPills();
      this.renderRoomLaunchControls();
      this.renderRoomNameInputs();
      this.renderSessionNotice(true);
      this.setPhasePill('Ready');
      this.closeRoomModal();
      this.showPanel('#startPanel');
    },

    beginRoomBackedGame() {
      this.closeRoomModal();
      const playerNames = this.getRoomPlayerNames();
      this.startGameWithOptions({
        playerNames,
        roomSession: this.session,
      });
    },

    getRoomPlayerNames() {
      const players = (this.roomState && this.roomState.players) || [];
      const sorted = players.slice().sort((a, b) => {
        if (a.isHost === b.isHost) return 0;
        return a.isHost ? -1 : 1;
      });
      return [
        (sorted[0] && sorted[0].name) || this.session.playerName || 'Player 1',
        (sorted[1] && sorted[1].name) || 'Player 2',
      ];
    },

    reportGameAction(type, payload) {
      if (!this.state || !this.state.multiplayer || !this.state.multiplayer.enabled) return;
      if (!this.roomClient || !this.roomState || !this.roomState.gameStarted) return;
      const includeSyncState = this.shouldAttachSyncState(type);
      const enrichedPayload = Object.assign({}, payload || {});
      if (includeSyncState) {
        enrichedPayload.syncState = this.buildSyncStateSnapshot();
      }
      this.roomClient.sendGameAction(type, enrichedPayload);
    },

    shouldAttachSyncState(type) {
      if (!this.state || this.state.phase !== TurnPhase.SETUP) return true;
      // Do not stream in-progress setup board edits to the opponent.
      // Setup sync is pushed only after lock-in transition snapshots.
      if (type === RoomAPI.GAME_ACTIONS.PLACE_SHIP) return false;
      if (type === RoomAPI.GAME_ACTIONS.CONFIRM_FLEET) return false;
      return true;
    },

    buildSyncStateSnapshot() {
      if (!this.state) return null;
      const snapshot = JSON.parse(JSON.stringify(this.state));
      if (snapshot.turn) {
        snapshot.turn.timerId = null;
      }
      // Do not sync local-only, in-progress hint UI state. It can leak temporary
      // placements to the opponent and spoil bluff information.
      if (snapshot.ui && snapshot.ui.play) {
        if (snapshot.ui.play.hint) {
          snapshot.ui.play.hint.selectedCardId = null;
          snapshot.ui.play.hint.selection = null;
          snapshot.ui.play.hint.computedTruth = null;
        }
        if (snapshot.ui.play.incoming) {
          snapshot.ui.play.incoming.guess = null;
        }
        if (snapshot.ui.play.exhaustReward) {
          snapshot.ui.play.exhaustReward.open = false;
          snapshot.ui.play.exhaustReward.selection = null;
        }
      }
      return snapshot;
    },

    consumeRoomGameAction(action) {
      if (!action || !action.payload || !action.payload.syncState) return;
      if (!this.roomState || !this.roomState.localPlayerId) return;
      if (action.playerId === this.roomState.localPlayerId) return;

      const actionAt = Number(action.at || 0);
      if (actionAt && this.lastAppliedRemoteActionAt && actionAt < this.lastAppliedRemoteActionAt) return;
      if (actionAt && actionAt > this.lastAppliedRemoteActionAt) this.lastAppliedRemoteActionAt = actionAt;

      this.applyRemoteSyncState(action.payload.syncState);

      if (action.type === RoomAPI.GAME_ACTIONS.REVEAL_HINT_RESULT) {
        this.showIncomingHintOutcome(action.payload || {});
      }
    },

    applyRemoteSyncState(snapshot) {
      if (!snapshot || typeof snapshot !== 'object') return;
      const localIdx = this.state && this.state.multiplayer
        ? this.state.multiplayer.localPlayerIdx
        : this.resolveLocalRoomPlayerIdx();
      this.stopTurnTimer();
      this.state = snapshot;
      if (!this.state.turn) return;
      if (!Number.isFinite(this.state.turn.seq)) this.state.turn.seq = 0;
      this.state.turn.timerId = null;
      if (this.state.multiplayer) {
        this.state.multiplayer.localPlayerIdx = localIdx;
      }

      if (this.state.phase === TurnPhase.SETUP) {
        this.hideRoomWaitingOverlay();
        this.showPanel('#setupPanel');
        this.setPhasePill('Setup');
        this.renderSetup();
        this.syncGameOverOverlay();
        return;
      }
      if (this.state.phase === TurnPhase.PLAY) {
        this.showPanel('#playPanel');
        this.setPhasePill('Play');
        this.renderPlay();
        this.startTurnTimer();
        this.maybeShowTurnPopup();
        if (this.isLocalPlayersTurn()) {
          this.handleDeferredTurnStartEffects();
        }
        this.syncGameOverOverlay();
      }
    },

    reportSyncSnapshot(reason) {
      if (!this.state) return;
      this.reportGameAction(RoomAPI.GAME_ACTIONS.SYNC_SNAPSHOT, {
        reason,
        phase: this.state.phase,
        currentPlayer: this.state.currentPlayer,
        setupPlayer: this.state.setupPlayer,
      });
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

    normalizePlayerName(raw, fallback) {
      const name = String(raw ?? '').trim();
      return name ? name.slice(0, 24) : fallback;
    },

    getPlayerName(idx) {
      if (!this.state || !Array.isArray(this.state.playerNames)) return `Player ${idx + 1}`;
      return this.state.playerNames[idx] || `Player ${idx + 1}`;
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
        pendingFakeWrongPlacement: false, // deferred true-hint placement at start of this player's next turn
      };
    },

    startGame() {
      const turnSeconds = clamp(parseInt(this.els.turnTimerInput.value || '60', 10), 15, 180);
      const timerEnabled = !!this.startTimerEnabled;
      const extraShotOnHit = !!this.els.extraShotToggle.checked;
      const playerNames = [
        this.normalizePlayerName(this.els.p1NameInput.value, 'Player 1'),
        this.normalizePlayerName(this.els.p2NameInput.value, 'Player 2'),
      ];

      this.startGameWithOptions({
        config: { turnSeconds, timerEnabled, extraShotOnHit },
        playerNames,
      });
    },

    startGameWithOptions(options = {}) {
      const config = options.config || {
        turnSeconds: clamp(parseInt(this.els.turnTimerInput.value || '60', 10), 15, 180),
        timerEnabled: !!this.startTimerEnabled,
        extraShotOnHit: !!this.els.extraShotToggle.checked,
      };
      const playerNames = Array.isArray(options.playerNames) && options.playerNames.length >= 2
        ? options.playerNames.slice(0, 2)
        : [
            this.normalizePlayerName(this.els.p1NameInput.value, 'Player 1'),
            this.normalizePlayerName(this.els.p2NameInput.value, 'Player 2'),
          ];
      const roomSession = options.roomSession || null;

      this.state = {
        phase: TurnPhase.SETUP,
        config,
        playerNames,
        multiplayer: roomSession ? {
          enabled: true,
          mode: roomSession.mode,
          roomCode: roomSession.roomCode,
          localPlayerIdx: this.resolveLocalRoomPlayerIdx(),
          transport: this.roomState ? this.roomState.transportKind : 'local-dev',
          localOnlyDevWarning: true,
        } : {
          enabled: false,
          mode: 'local',
          roomCode: null,
          localPlayerIdx: null,
          transport: 'local-only',
          localOnlyDevWarning: false,
        },
        setupPlayer: 0,
        currentPlayer: 0,
        players: [this.newPlayerState(), this.newPlayerState()],
        ui: {
          setup: {
            paletteSelected: null, // shipId
            editingShipId: null,   // shipId
          },
          play: {
            ownVisible: !!roomSession,
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
            exhaustReward: {
              open: false,
              type: 'cell',
              selection: null,
              allowedTypes: HINT_TYPES.map((card) => card.id),
              targetPlayerIdx: 1,
              chooserPlayerIdx: 0,
              lockType: false,
              title: 'All Hint Cards Used',
              body: 'Choose a hint type, then tap a position on the copied opponent field. This creates a TRUE hint on the opponent field.',
              selectionPrompt: 'Select hint type and tap a cell.',
              confirmText: 'Create TRUE Hint',
              successToast: 'TRUE hint added.',
            },
            targetSel: null,
          },
          gameOver: {
            visible: false,
            title: 'Game Over',
            body: '-',
          },
        },
        turn: {
          shotsRemaining: 1,
          seq: 0,
          timer: config.turnSeconds,
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
      this.lastAppliedRemoteActionAt = 0;
      this._lastTurnPopupKey = null;
      this.hideRoomWaitingOverlay();
      this.syncGameOverOverlay();

      if (roomSession) {
        this.setPhasePill('Room Setup');
        this.showPanel('#setupPanel');
        this.renderSetup();
        this.syncRoomTurnOverlay();
        return;
      }
      this.hideRoomWaitingOverlay();
      this.openPassOverlay(this.getPlayerName(0), `Get ready to place your ships. Keep the screen hidden while passing.`);
      if (!roomSession) this.setPhasePill('Setup');
    },

    openPassOverlay(title, body, nextPhase = null, nextPlayer = null) {
      this.state.pass = { nextPhase, nextPlayer, text: body };
      this.els.passTitle.textContent = title;
      this.els.passBody.textContent = body;
      this.els.readyBtn.classList.remove('hidden');
      this.els.passOverlay.classList.remove('hidden');
      document.getElementById('app')?.classList.add('pass-blur');
      this.pauseTimer(true);
    },

    resolveLocalRoomPlayerIdx() {
      if (!this.session || !this.session.isRoomPlay || !this.roomState) return null;
      const players = Array.isArray(this.roomState.players) ? this.roomState.players.slice() : [];
      const sorted = players.sort((a, b) => {
        if (a.isHost === b.isHost) return 0;
        return a.isHost ? -1 : 1;
      });
      const idx = sorted.findIndex((player) => player.id === this.roomState.localPlayerId);
      return idx >= 0 ? idx : null;
    },

    isRoomGameplaySyncEnabled() {
      return !!(this.state && this.state.multiplayer && this.state.multiplayer.enabled);
    },

    isLocalPlayersTurn() {
      if (!this.isRoomGameplaySyncEnabled()) return true;
      let localIdx = this.state.multiplayer.localPlayerIdx;
      if (localIdx == null) {
        localIdx = this.resolveLocalRoomPlayerIdx();
        this.state.multiplayer.localPlayerIdx = localIdx;
      }
      if (localIdx == null) return true;
      return this.state.currentPlayer === localIdx;
    },

    getViewerPlayerIdx() {
      if (!this.isRoomGameplaySyncEnabled()) return this.getCurrentPlayerIdx();
      let localIdx = this.state.multiplayer.localPlayerIdx;
      if (localIdx == null) {
        localIdx = this.resolveLocalRoomPlayerIdx();
        this.state.multiplayer.localPlayerIdx = localIdx;
      }
      return localIdx == null ? this.getCurrentPlayerIdx() : localIdx;
    },

    isLocalSetupTurn() {
      if (!this.isRoomGameplaySyncEnabled()) return true;
      let localIdx = this.state.multiplayer.localPlayerIdx;
      if (localIdx == null) {
        localIdx = this.resolveLocalRoomPlayerIdx();
        this.state.multiplayer.localPlayerIdx = localIdx;
      }
      if (localIdx == null) return true;
      return this.state.setupPlayer === localIdx;
    },

    showRoomWaitingOverlay(title, body) {
      if (!this.state) return;
      this.els.passTitle.textContent = title;
      this.els.passBody.textContent = body;
      this.els.readyBtn.classList.add('hidden');
      this.els.passOverlay.classList.remove('hidden');
      document.getElementById('app')?.classList.add('pass-blur');
      this.roomWaitingOverlayOpen = true;
    },

    hideRoomWaitingOverlay() {
      if (!this.roomWaitingOverlayOpen) return;
      this.els.readyBtn.classList.remove('hidden');
      this.els.passOverlay.classList.add('hidden');
      document.getElementById('app')?.classList.remove('pass-blur');
      this.roomWaitingOverlayOpen = false;
    },

    syncRoomTurnOverlay() {
      if (!this.isRoomGameplaySyncEnabled() || !this.state) {
        this.hideRoomWaitingOverlay();
        return;
      }
      if (this.state.phase === TurnPhase.SETUP) {
        if (this.isLocalSetupTurn()) {
          this.hideRoomWaitingOverlay();
          return;
        }
        const activeName = this.getPlayerName(this.state.setupPlayer);
        this.showRoomWaitingOverlay(`${activeName}'s Setup`, `Waiting for ${activeName} to place ships.`);
        return;
      }
      if (this.state.phase === TurnPhase.PLAY) {
        // In room play phase, both clients can watch the synced board live.
        // Interaction is still guarded by turn checks in action handlers.
        this.hideRoomWaitingOverlay();
        return;
      }
      this.hideRoomWaitingOverlay();
    },

    onReady() {
      this.els.passOverlay.classList.add('hidden');
      document.getElementById('app')?.classList.remove('pass-blur');
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
        this.maybeShowTurnPopup();
        if (this.isLocalPlayersTurn()) {
          this.handleDeferredTurnStartEffects();
        }
        this.syncRoomTurnOverlay();
        return;
      }
    },

    async handleDeferredTurnStartEffects() {
      const s = this.state;
      if (!s || s.phase !== TurnPhase.PLAY) return;
      if (this._handlingDeferredTurnStartEffects) return;

      const curIdx = this.getCurrentPlayerIdx();
      const cur = this.getCurrentPlayer();
      if (!cur.pendingFakeWrongPlacement) return;

      this._handlingDeferredTurnStartEffects = true;
      cur.pendingFakeWrongPlacement = false;

      await this.promptTrueHintPlacement({
        targetPlayerIdx: this.getOpponentPlayerIdx(),
        chooserPlayerIdx: curIdx,
        allowedTypes: HINT_TYPES.map((card) => card.id),
        lockType: false,
        title: 'Deferred FAKE Effect',
        body: 'Your opponent guessed your fake hint wrongly on the previous turn. Place a TRUE hint on the opponent field now.',
        selectionPrompt: 'Select hint type and tap a cell.',
        confirmText: 'Create TRUE Hint',
        successToast: 'TRUE hint added on opponent field.',
      });

      this._handlingDeferredTurnStartEffects = false;
      this.renderPlay();
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
      build(this.els.exhaustHintBoard, (ev, r, c) => this.onExhaustHintCellClick(ev, r, c));
    },

    currentSetupPlayer() {
      return this.state.players[this.state.setupPlayer];
    },

    renderSetup() {
      const pIdx = this.state.setupPlayer;
      const player = this.currentSetupPlayer();
      const canEditSetup = this.isLocalSetupTurn();
      this.els.setupTitle.textContent = `${this.getPlayerName(pIdx)}: Place your fleet`;
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
      this.els.lockInBtn.disabled = !canEditSetup || !allPlaced;
      this.els.randomBtn.disabled = !canEditSetup;
      this.els.resetBtn.disabled = !canEditSetup;
      this.els.setupReadyText.textContent = canEditSetup
        ? (allPlaced ? 'All ships placed. You can lock in now.' : 'Place all ships to continue.')
        : `Waiting for ${this.getPlayerName(pIdx)} to finish setup.`;
      this.syncRoomTurnOverlay();
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
          if (!this.isLocalSetupTurn()) return;
          if (used.has(ship.id)) return;
          ui.paletteSelected = (ui.paletteSelected === ship.id) ? null : ship.id;
          ui.editingShipId = null;
          this.renderSetup();
        });

        this.els.shipPalette.appendChild(chip);
      }
    },

    toggleEditShip(shipId) {
      if (!this.isLocalSetupTurn()) return;
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
      if (!this.isLocalSetupTurn()) return;
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
      this.reportGameAction(RoomAPI.GAME_ACTIONS.PLACE_SHIP, {
        playerIndex: this.state ? this.state.setupPlayer : null,
        shipId: id,
        len,
        origin: { ...origin },
        orient,
      });
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
        this.reportGameAction(RoomAPI.GAME_ACTIONS.PLACE_SHIP, {
          playerIndex: this.state ? this.state.setupPlayer : null,
          shipId,
          len,
          origin: { ...origin },
          orient: newOrient,
        });
      }

      // Restore occupancy (either new or old)
      this.writeShipToOccupancy(player, ship);
      return ok;
    },

    rotateSelectedShipSetup() {
      if (!this.isLocalSetupTurn()) return;
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
      if (!this.isLocalSetupTurn()) return;
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
      if (!this.isLocalSetupTurn()) return;
      const player = this.currentSetupPlayer();
      player.ships = [];
      player.occupancy = makeGrid(null);
      this.state.ui.setup.paletteSelected = null;
      this.state.ui.setup.editingShipId = null;
      this.renderSetup();
    },

    lockIn() {
      if (!this.isLocalSetupTurn()) return;
      const pIdx = this.state.setupPlayer;
      const player = this.currentSetupPlayer();
      if (player.ships.length !== SHIPS.length) return;
      this.reportGameAction(RoomAPI.GAME_ACTIONS.CONFIRM_FLEET, {
        playerIndex: pIdx,
        ships: player.ships.map((ship) => ({
          id: ship.id,
          len: ship.len,
          origin: { ...ship.origin },
          orient: ship.orient,
        })),
      });

      if (pIdx === 0) {
        // pass to player 2 setup
        this.state.setupPlayer = 1;
        if (this.isRoomGameplaySyncEnabled()) {
          this.showPanel('#setupPanel');
          this.renderSetup();
          this.reportSyncSnapshot('setup_player_switched');
          return;
        }
        this.openPassOverlay(this.getPlayerName(1), 'Get ready to place your ships. Keep the screen hidden while passing.');
        // still setup phase
        return;
      }

      // Both players placed -> start play with player 1
      this.state.phase = TurnPhase.PLAY;
      this.state.currentPlayer = 0;
      this.state.ui.play.ownVisible = this.isRoomGameplaySyncEnabled();
      this.state.ui.play.hint.selectedCardId = null;
      this.state.ui.play.hint.selection = null;
      this.state.ui.play.hint.setThisTurn = false;

      this.setPhasePill('Play');
      if (this.isRoomGameplaySyncEnabled()) {
        this.showPanel('#playPanel');
        this.startTurn();
        this.syncRoomTurnOverlay();
        this.reportSyncSnapshot('both_fleets_confirmed');
        return;
      }
      const p1Name = this.getPlayerName(0);
      this.openPassOverlay(p1Name, `Game starts! Hand the device to ${p1Name}. Keep the screen hidden while passing.`);
      this.reportSyncSnapshot('both_fleets_confirmed');
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
      const { selectable, selectedShipId, onShipClick, sunkShipIds, showDamageMarks } = opts;
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

        if (showDamageMarks) {
          const shipCells = computeShipCells(ship.origin, ship.orient, ship.len);
          for (const { r, c } of shipCells) {
            if (player.defenseShots[r][c] !== 'hit') continue;
            const localR = r - ship.origin.r;
            const localC = c - ship.origin.c;
            const mark = el('div', 'shipHitMark');
            mark.style.left = `${((localC + 0.5) / w) * 100}%`;
            mark.style.top = `${((localR + 0.5) / h) * 100}%`;
            shipEl.appendChild(mark);
          }
        }

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
      s.turn.seq = (Number(s.turn.seq) || 0) + 1;
      s.turn.hasFiredThisTurn = false;

      // Shots: base 1 + bonus
      s.turn.shotsRemaining = 1 + (cur.bonusShotsNextTurn || 0);
      cur.bonusShotsNextTurn = 0;

      // UI reset
      s.ui.play.ownVisible = this.isRoomGameplaySyncEnabled();
      this.setOwnVisible(s.ui.play.ownVisible, true);

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
      s.ui.play.exhaustReward.open = false;
      s.ui.play.exhaustReward.selection = null;
      s.ui.play.exhaustReward.allowedTypes = HINT_TYPES.map((card) => card.id);
      s.ui.play.exhaustReward.lockType = false;
      this.els.exhaustHintOverlay.classList.add('hidden');

      this.renderPlay();
      this.startTurnTimer();
      this.maybeShowTurnPopup();
    },

    renderPlay() {
      const s = this.state;
      const actorIdx = this.getCurrentPlayerIdx();
      const viewerIdx = this.getViewerPlayerIdx();
      const cur = s.players[viewerIdx];
      const opp = s.players[viewerIdx === 0 ? 1 : 0];
      const forceOwnVisible = this.isRoomGameplaySyncEnabled();
      const watchingOpponentTurn = this.isRoomGameplaySyncEnabled() && !this.isLocalPlayersTurn();
      if (forceOwnVisible && !s.ui.play.ownVisible) s.ui.play.ownVisible = true;
      const ownBoardVisible = forceOwnVisible || s.ui.play.ownVisible;
      this.els.ownHideOverlay.classList.toggle('hidden', ownBoardVisible);
      this.els.hideOwnBtn.classList.toggle('hidden', forceOwnVisible || !ownBoardVisible);

      this.els.turnTitle.textContent = `${this.getPlayerName(actorIdx)}'s Turn`;
      this.els.turnSubtitle.textContent = this.isLocalPlayersTurn()
        ? 'While you still have shots left, you may place 1 hint on your board (optional).'
        : 'Watching opponent turn. Your actions are disabled.';
      this.els.targetLockOverlay.classList.toggle('hidden', this.isLocalPlayersTurn());

      this.els.shotsText.textContent = String(s.turn.shotsRemaining);
      this.els.hintsLeftText.textContent = String(cur.cards.filter(c => !c.used).length);

      // Target board: show attacks so far
      this.renderCellsFromTarget(this.els.targetBoard, cur, opp);

      // Selected target highlight
      for (const b of this.els.targetBoard.querySelectorAll('.cell')) {
        const r = parseInt(b.dataset.r, 10);
        const c = parseInt(b.dataset.c, 10);
        const sel = s.ui.play.targetSel;
        b.classList.toggle('sel', !watchingOpponentTurn && !!sel && sel.r === r && sel.c === c);
        b.classList.toggle('blocked', cur.targetShots[r][c] !== 'unknown');
      }

      // Own board: show defense hits/misses
      this.renderCellsFromDefense(this.els.ownBoard, cur);
      for (const b of this.els.ownBoard.querySelectorAll('.cell')) {
        const r = parseInt(b.dataset.r, 10);
        const c = parseInt(b.dataset.c, 10);
        const sel = s.ui.play.targetSel;
        b.classList.toggle('sel', watchingOpponentTurn && !!sel && sel.r === r && sel.c === c);
      }

      // Render ships on own board (only when visible)
      const ownFleet = this.getFleetStatus(cur);
      const ownSunkShipIds = new Set(
        Object.entries(ownFleet)
          .filter(([, st]) => st.sunk)
          .map(([shipId]) => shipId)
      );
      this.renderShipLayer(this.els.ownShipLayer, cur, {
        selectable: false,
        sunkShipIds: ownSunkShipIds,
        showDamageMarks: true
      });
      this.els.ownShipLayer.style.opacity = ownBoardVisible ? '1' : '0';

      // Render hints:
      this.renderHintsLayer(this.els.targetHintLayer, opp, { view: 'opponent' }); // hints about opponent (visible on your target board)
      this.renderHintsLayer(this.els.ownHintLayer, cur, { view: 'self' }); // your own hints (preview + your past)

      // Cards
      this.renderCards();

      // Hint controls state
      this.renderHintControls();

      // Enemy ships status
      this.renderEnemyShips(cur, opp);

      // Guess bar
      this.renderGuessBar();

      // Log
      this.els.logLine.textContent = this.makeLogLine();

      if (this.isExhaustHintModalOpen()) {
        this.renderExhaustHintModal();
      }
      this.syncRoomTurnOverlay();
    },

    makeLogLine() {
      if (this.isRoomGameplaySyncEnabled() && !this.isLocalPlayersTurn()) {
        return 'Opponent is taking their turn. Live board updates are visible.';
      }
      const s = this.state;
      const cur = this.getCurrentPlayer();
      const opp = this.getOpponentPlayer();

      const incoming = opp.hints.active && !opp.hints.active.resolved;
      if (incoming && !s.ui.play.incoming.judged) {
        const oppFakeUsed = !!opp.cards.find((card) => card.id === 'fake' && card.used);
        if (!oppFakeUsed || incoming.type === 'fake') return 'Incoming hint is active. Select a target cell, choose TRUE/LIE/FAKE, then confirm.';
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

    renderEnemyShips(cur = this.getCurrentPlayer(), opp = this.getOpponentPlayer()) {

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
      if (this.isRoomGameplaySyncEnabled() && !this.isLocalPlayersTurn()) {
        this.els.guessBar.classList.add('hidden');
        return;
      }
      const s = this.state;
      const opp = this.getOpponentPlayer();

      const incoming = (opp.hints.active && !opp.hints.active.resolved) ? opp.hints.active : null;
      const needsJudgement = incoming && !s.ui.play.incoming.judged;

      if (!needsJudgement) {
        this.els.guessBar.classList.add('hidden');
        return;
      }

      this.els.guessBar.classList.remove('hidden');

      // Describe incoming hint briefly (fake hints are disguised as normal hints)
      const claimText = this.describeHint(incoming, { claimed: true }).replace(/^Hint:\s*/, '');
      this.els.incomingHintDesc.textContent = `The opponent says: ${claimText}`;

      const oppFakeUsed = !!opp.cards.find((card) => card.id === 'fake' && card.used);
      const canGuessFake = (incoming.type === 'fake') || !oppFakeUsed;
      if (!canGuessFake && s.ui.play.incoming.guess === 'fake') s.ui.play.incoming.guess = null;

      this.els.guessTrueBtn.classList.toggle('primary', s.ui.play.incoming.guess === true);
      this.els.guessLieBtn.classList.toggle('primary', s.ui.play.incoming.guess === false);
      this.els.guessFakeBtn.classList.toggle('primary', s.ui.play.incoming.guess === 'fake');
      this.els.guessFakeBtn.classList.toggle('hidden', !canGuessFake);

      const targetChosen = !!s.ui.play.targetSel;
      this.els.confirmShotBtn.disabled = !(targetChosen && (s.ui.play.incoming.guess !== null));
    },

    describeHint(hint, { claimed }) {
      const renderType = hint.type === 'fake' ? hint.fakeType : hint.type;
      const renderSelection = hint.type === 'fake' ? hint.fakeSelection : hint.selection;
      const renderClaimHas = hint.type === 'fake' ? hint.fakeClaimHas : hint.claimHas;
      const hasTxt = claimed ? (renderClaimHas ? 'HAS' : 'HAS NOT') : (hint.areaHasShip ? 'HAS' : 'HAS NOT');

      if (renderType === 'row') return `Hint: Row ${renderSelection.row + 1} ${hasTxt} a ship cell.`;
      if (renderType === 'col') return `Hint: Column ${COL_LABELS[renderSelection.col]} ${hasTxt} a ship cell.`;
      if (renderType === 'area') return `Hint: 3×3 area around ${coordToText(renderSelection.center.r, renderSelection.center.c)} ${hasTxt} a ship cell.`;
      return `Hint: Cell ${coordToText(renderSelection.cell.r, renderSelection.cell.c)} ${hasTxt} a ship cell.`;
    },

    renderHintsLayer(layerEl, defenderPlayer, { view }) {
      // view: 'opponent' (you are attacking this defender) or 'self' (your own board)
      layerEl.innerHTML = '';

      // Past hints (correct display)
      for (const hint of defenderPlayer.hints.past) {
        if (hint.type === 'fake') continue;
        const overlay = this.makeHintOverlay(hint, defenderPlayer, { mode: 'past', correct: true });
        if (hint.blink) overlay.classList.add('blink');
        layerEl.appendChild(overlay);
      }

      // Active hint (claimed colors) - only show to opponent on target board, and to self too (so you remember)
      if (defenderPlayer.hints.active && !defenderPlayer.hints.active.resolved) {
        const hint = defenderPlayer.hints.active;
        if (!(hint.type === 'fake' && (!hint.fakeType || !hint.fakeSelection))) {
          const displayHint = hint.type === 'fake'
            ? { type: hint.fakeType, selection: hint.fakeSelection, claimHas: hint.fakeClaimHas }
            : hint;
          const overlay = this.makeHintOverlay(displayHint, defenderPlayer, { mode: 'active', correct: false });
          layerEl.appendChild(overlay);
        }
      }

      // Preview hint while placing on own board
      if (view === 'self') {
        const s = this.state;
        const uiHint = s.ui.play.hint;
        if (this.isLocalPlayersTurn() && uiHint.selectedCardId && uiHint.selection && uiHint.selectedCardId !== 'fake') {
          const preview = {
            id: 'preview',
            owner: this.getCurrentPlayerIdx(),
            type: uiHint.selectedCardId,
            selection: uiHint.selection,
            claimHas: uiHint.claimHas,
          };
          const overlay = this.makeHintOverlay(preview, null, { mode: 'active', correct: false });
          overlay.style.borderStyle = 'dashed';
          overlay.style.opacity = '0.95';
          layerEl.appendChild(overlay);
        }
      }
    },

    makeHintOverlay(hint, defenderPlayer, { mode, correct }) {
      const rect = hintRect(hint.type, hint.selection);
      const d = el('div', 'hintOverlay');

      d.style.left = `${(rect.c / COLS) * 100}%`;
      d.style.top = `${(rect.r / ROWS) * 100}%`;
      d.style.width = `${(rect.w / COLS) * 100}%`;
      d.style.height = `${(rect.h / ROWS) * 100}%`;

      d.classList.add(mode);

      const showHas = correct ? !!hint.areaHasShip : !!hint.claimHas;
      let depletedHas = false;
      if (showHas && defenderPlayer && mode !== 'active') {
        // Non-active HAS overlays are live: once all ship cells in the area are exposed, show HAS NOT styling.
        // Active hints must keep their claimed state because they are allowed to be lies.
        const liveCells = hintCells(hint.type, hint.selection);
        const hasUnexposed = evaluateAreaHasUnexposedShip(defenderPlayer, liveCells);
        if (!hasUnexposed) {
          depletedHas = true;
        }
      }
      d.classList.add(showHas ? 'has' : 'hasnot');
      if (depletedHas) d.classList.add('depletedHas');

      return d;
    },

    renderCards() {
      const s = this.state;
      const cur = this.isRoomGameplaySyncEnabled() ? this.state.players[this.getViewerPlayerIdx()] : this.getCurrentPlayer();
      const uiHint = s.ui.play.hint;
      const hintsLeft = cur.cards.filter((card) => !card.used).length;
      const exhausted = hintsLeft === 0;

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
          if (!this.isLocalPlayersTurn()) return;
          if (!this.state.ui.play.ownVisible) {
            this.toast('Show your board to place a hint.', 'bad');
            return;
          }
          if (this.state.turn.shotsRemaining <= 0) {
            this.toast('No shots left this turn to place a hint.', 'bad');
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

      if (this.els.hintCardsEffectText) {
        this.els.hintCardsEffectText.classList.toggle('active', exhausted);
        this.els.hintCardsEffectText.innerHTML = exhausted
          ? '<b>Effect activated:</b> All hint cards are consumed. Create one TRUE hint on the opponent board.'
          : 'Consume all hint cards to activate: create one TRUE hint on the opponent board.';
      }
    },

    renderHintControls() {
      const s = this.state;
      const cur = this.isRoomGameplaySyncEnabled() ? this.state.players[this.getViewerPlayerIdx()] : this.getCurrentPlayer();
      const uiHint = s.ui.play.hint;
      const isFake = uiHint.selectedCardId === 'fake';

      // Toggle buttons
      this.els.toggleHasBtn.classList.toggle('active', uiHint.claimHas === true);
      this.els.toggleHasNotBtn.classList.toggle('active', uiHint.claimHas === false);
      this.els.toggleHasBtn.classList.toggle('hidden', isFake);
      this.els.toggleHasNotBtn.classList.toggle('hidden', isFake);

      // Confirm hint enabled when a card is selected and placement requirements are met
      const canConfirm = !!uiHint.selectedCardId && (isFake || !!uiHint.selection) && !uiHint.setThisTurn && s.turn.shotsRemaining > 0;
      this.els.confirmHintBtn.disabled = !canConfirm;

      // Truth preview text
      if (!uiHint.selectedCardId) {
        this.els.ownHintTruthText.innerHTML = 'Select a hint card to place one hint (optional, once per turn).';
        return;
      }
      if (isFake) {
        this.els.ownHintTruthText.innerHTML =
          'This card is <b>FAKE</b>. No area is selected and no HAS/HAS NOT choice is used.<br>' +
          '<span class="muted tiny">Confirm directly to pretend placing a hint. It picks from hint types not consumed yet; if all are consumed, it picks a random type. It will not be recorded as a past hint.</span>';
        return;
      }
      if (!uiHint.selection) {
        this.els.ownHintTruthText.innerHTML = 'Tap your board to choose the hint area. <span class="muted">(Only you can see whether it is true or a bluff.)</span>';
        return;
      }

      const cardId = uiHint.selectedCardId;
      const cells = hintCells(cardId, uiHint.selection);
      const areaHas = evaluateAreaHasUnexposedShip(cur, cells);
      uiHint.areaHasShip = areaHas;

      const truth = uiHint.claimHas ? areaHas : !areaHas;
      uiHint.computedTruth = truth;

      const badge = truth ? `<span style="color: var(--good); font-weight:900;">TRUE</span>` : `<span style="color: var(--danger); font-weight:900;">LIE</span>`;
      const note = truth ? 'It matches your real board.' : 'It does NOT match your real board (a bluff).';
      const correctGuessEffect = truth
        ? 'no effect.'
        : 'a forced correct hint about your board is added for your opponent.';
      const wrongGuessEffect = truth
        ? 'about half of your revivable destroyed cells (misses and hits on ships that are not fully sunk) are restored (rounded).'
        : 'you gain 2 bonus shots on your next turn.';

      this.els.ownHintTruthText.innerHTML =
        `This hint would be: ${badge} <span class="muted tiny">- ${note}</span><br>` +
        `<span class="muted tiny">If opponent guesses <b>correctly</b>: ${correctGuessEffect}</span><br>` +
        `<span class="muted tiny">If opponent guesses <b>wrongly</b>: ${wrongGuessEffect}</span>`;
    },

    setHasToggle(has) {
      if (!this.state) return;
      if (this.state.phase === TurnPhase.PLAY && !this.isLocalPlayersTurn()) return;
      if (this.state.ui.play.hint.selectedCardId === 'fake') return;
      this.state.ui.play.hint.claimHas = has;
      // Recompute truth and update colors
      this.renderPlay();
    },

    setOwnVisible(visible, silent = false) {
      if (!this.state) return;
      const forceVisible = this.isRoomGameplaySyncEnabled();
      const effectiveVisible = forceVisible ? true : !!visible;
      this.state.ui.play.ownVisible = effectiveVisible;
      this.els.ownHideOverlay.classList.toggle('hidden', effectiveVisible);
      this.els.hideOwnBtn.classList.toggle('hidden', forceVisible || !effectiveVisible);
      if (!silent) this.renderPlay();
    },

    onOwnCellClick(_ev, r, c) {
      const s = this.state;
      if (!s || s.phase !== TurnPhase.PLAY) return;
      if (!this.isLocalPlayersTurn()) return;
      if (this.isExhaustHintModalOpen()) return;
      if (!s.ui.play.ownVisible) return;

      const cur = this.getCurrentPlayer();
      const uiHint = s.ui.play.hint;
      if (!uiHint.selectedCardId) return;
      if (uiHint.selectedCardId === 'fake') return;

      // Set selection depending on card
      if (uiHint.selectedCardId === 'row') uiHint.selection = { row: r };
      else if (uiHint.selectedCardId === 'col') uiHint.selection = { col: c };
      else if (uiHint.selectedCardId === 'area') uiHint.selection = { center: { r, c } };
      else uiHint.selection = { cell: { r, c } };

      this.renderPlay();
    },

    async confirmHint() {
      const s = this.state;
      if (!s || !this.isLocalPlayersTurn()) return;
      const curIdx = this.getCurrentPlayerIdx();
      const cur = this.getCurrentPlayer();
      const uiHint = s.ui.play.hint;
      const isFake = uiHint.selectedCardId === 'fake';

      if (!uiHint.selectedCardId) return;
      if (!isFake && !uiHint.selection) return;
      if (uiHint.setThisTurn) return;
      if (s.turn.shotsRemaining <= 0) return;

      let areaHas = null;
      let truth = 'fake';
      if (!isFake) {
        const cells = hintCells(uiHint.selectedCardId, uiHint.selection);
        areaHas = evaluateAreaHasUnexposedShip(cur, cells);
        truth = uiHint.claimHas ? areaHas : !areaHas;
      }

      // Consume card
      const card = cur.cards.find(c => c.id === uiHint.selectedCardId);
      if (card) card.used = true;
      this.reportGameAction(RoomAPI.GAME_ACTIONS.CONSUME_HINT, {
        playerIndex: curIdx,
        cardId: uiHint.selectedCardId,
      });

      // Create hint
      let fakeType = null;
      let fakeSelection = null;
      let fakeClaimHas = null;
      if (isFake) {
        const disguise = createUnconstrainedFakeDisguise(cur);
        fakeType = disguise.type;
        fakeSelection = disguise.selection;
        fakeClaimHas = disguise.claimHas;
      }

      const hint = {
        id: `H-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        owner: curIdx, // the defender who owns the hinted board
        type: uiHint.selectedCardId,
        selection: isFake ? null : structuredClone(uiHint.selection),
        claimHas: isFake ? null : uiHint.claimHas,
        fakeType,
        fakeSelection,
        fakeClaimHas,
        areaHasShip: areaHas,
        truth: truth, // whether claim matches reality
        resolved: false,
        forced: false,
      };

      cur.hints.active = hint;
      uiHint.setThisTurn = true;
      uiHint.selectedCardId = null;
      uiHint.selection = null;
      uiHint.computedTruth = null;
      this.reportGameAction(RoomAPI.GAME_ACTIONS.PLAY_HINT, {
        owner: curIdx,
        type: hint.type,
        selection: hint.selection ? structuredClone(hint.selection) : null,
        claimHas: hint.claimHas,
        fakeType: hint.fakeType,
        fakeSelection: hint.fakeSelection ? structuredClone(hint.fakeSelection) : null,
        fakeClaimHas: hint.fakeClaimHas,
      });

      this.toast(isFake ? 'Fake hint played.' : 'Hint placed for your opponent.', 'good');

      const hintsLeft = cur.cards.filter((c) => !c.used).length;
      if (hintsLeft === 0) {
        await this.promptExhaustedCardsTrueHint();
      }

      this.renderPlay();
    },

    promptExhaustedCardsTrueHint() {
      return this.promptTrueHintPlacement({
        targetPlayerIdx: this.getOpponentPlayerIdx(),
        chooserPlayerIdx: this.getCurrentPlayerIdx(),
        allowedTypes: HINT_TYPES.map((card) => card.id),
        lockType: false,
        title: 'All Hint Cards Used',
        body: 'Choose a hint type, then tap a position on the copied opponent field. This creates a TRUE hint on the opponent field.',
        selectionPrompt: 'Select hint type and tap a cell.',
        confirmText: 'Create TRUE Hint',
        successToast: 'TRUE hint added on opponent field.',
      });
    },

    promptTrueHintPlacement(options) {
      return new Promise((resolve) => {
        const s = this.state;
        if (!s || s.phase !== TurnPhase.PLAY) {
          resolve(false);
          return;
        }

        const allowed = Array.from(new Set((options.allowedTypes || []).filter((type) => isHintType(type))));
        if (allowed.length === 0) {
          resolve(false);
          return;
        }

        const reward = s.ui.play.exhaustReward;
        reward.open = true;
        reward.allowedTypes = allowed;
        reward.targetPlayerIdx = options.targetPlayerIdx;
        reward.chooserPlayerIdx = options.chooserPlayerIdx;
        reward.lockType = !!options.lockType;
        reward.type = allowed.includes(options.type) ? options.type : allowed[0];
        reward.selection = null;
        reward.title = options.title || 'Create TRUE Hint';
        reward.body = options.body || 'Choose a hint type and place a TRUE hint.';
        reward.selectionPrompt = options.selectionPrompt || 'Select hint type and tap a cell.';
        reward.confirmText = options.confirmText || 'Create TRUE Hint';
        reward.successToast = options.successToast || 'TRUE hint added.';

        this._resolveExhaustHint = resolve;
        this.pauseTimer(true);
        this.renderExhaustHintModal();
        this.els.exhaustHintOverlay.classList.remove('hidden');
      });
    },

    getConsumedHintTypes(player) {
      return player.cards
        .filter((card) => card.used && isHintType(card.id))
        .map((card) => card.id);
    },

    setExhaustHintType(type) {
      const s = this.state;
      if (!s || !this.isExhaustHintModalOpen()) return;
      if (!isHintType(type)) return;
      const reward = s.ui.play.exhaustReward;
      if (!reward.allowedTypes.includes(type) || reward.lockType) return;
      s.ui.play.exhaustReward.type = type;
      s.ui.play.exhaustReward.selection = null;
      this.renderExhaustHintModal();
    },

    onExhaustHintCellClick(_ev, r, c) {
      const s = this.state;
      if (!s || !this.isExhaustHintModalOpen()) return;

      const reward = s.ui.play.exhaustReward;
      if (!reward.allowedTypes.includes(reward.type)) return;
      const type = s.ui.play.exhaustReward.type;
      if (type === 'row') s.ui.play.exhaustReward.selection = { row: r };
      else if (type === 'col') s.ui.play.exhaustReward.selection = { col: c };
      else if (type === 'area') s.ui.play.exhaustReward.selection = { center: { r, c } };
      else s.ui.play.exhaustReward.selection = { cell: { r, c } };

      this.renderExhaustHintModal();
    },

    renderExhaustHintModal() {
      const s = this.state;
      if (!s || !this.isExhaustHintModalOpen()) return;

      const reward = s.ui.play.exhaustReward;
      const chooser = s.players[reward.chooserPlayerIdx];
      const target = s.players[reward.targetPlayerIdx];

      this.els.exhaustHintTitle.textContent = reward.title;
      this.els.exhaustHintBody.textContent = reward.body;
      this.els.confirmExhaustHintBtn.textContent = reward.confirmText;

      this.renderCellsFromTarget(this.els.exhaustHintBoard, chooser, target);
      this.renderHintsLayer(this.els.exhaustHintLayer, target, { view: 'opponent' });

      const typeButtons = this.els.exhaustTypePicker.querySelectorAll('.exhaustTypeBtn');
      for (const btn of typeButtons) {
        const enabled = reward.allowedTypes.includes(btn.dataset.type);
        btn.classList.toggle('hidden', !enabled);
        btn.disabled = !enabled || reward.lockType;
        btn.classList.toggle('active', btn.dataset.type === reward.type);
      }

      if (reward.selection) {
        const previewHint = {
          type: reward.type,
          selection: reward.selection,
          claimHas: true,
          areaHasShip: true,
        };
        const overlay = this.makeHintOverlay(previewHint, target, { mode: 'past', correct: true });
        overlay.classList.add('rewardPreview');
        overlay.classList.remove('has', 'hasnot', 'depletedHas');
        this.els.exhaustHintLayer.appendChild(overlay);

        this.els.exhaustHintSelectionText.textContent = `Selected: ${this.describeHintSelectionOnly(reward.type, reward.selection)}`;
      } else {
        this.els.exhaustHintSelectionText.textContent = reward.selectionPrompt;
      }

      this.els.confirmExhaustHintBtn.disabled = !reward.selection;
    },

    describeHintSelectionOnly(type, selection) {
      if (type === 'row') return `Row ${selection.row + 1}`;
      if (type === 'col') return `Column ${COL_LABELS[selection.col]}`;
      if (type === 'area') return `3x3 area around ${coordToText(selection.center.r, selection.center.c)}`;
      return `Cell ${coordToText(selection.cell.r, selection.cell.c)}`;
    },

    confirmExhaustHintSelection() {
      const s = this.state;
      if (!s || !this.isExhaustHintModalOpen()) return;

      const reward = s.ui.play.exhaustReward;
      if (!reward.selection) return;

      const targetIdx = reward.targetPlayerIdx;
      const target = s.players[targetIdx];
      const cells = hintCells(reward.type, reward.selection);
      const areaHas = evaluateAreaHasUnexposedShip(target, cells);

      const hint = {
        id: `E-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        owner: targetIdx,
        type: reward.type,
        selection: structuredClone(reward.selection),
        claimHas: areaHas,
        areaHasShip: areaHas,
        truth: true,
        resolved: true,
        forced: true,
        blink: true,
      };
      target.hints.past.push(hint);

      this.closeExhaustHintModal(true);
      this.toast(reward.successToast, 'good');
      setTimeout(() => {
        hint.blink = false;
        this.renderPlay();
      }, 2500);
    },

    closeExhaustHintModal(completed) {
      const s = this.state;
      if (!s || !s.ui || !s.ui.play || !s.ui.play.exhaustReward) return;

      s.ui.play.exhaustReward.open = false;
      s.ui.play.exhaustReward.selection = null;
      this.els.exhaustHintOverlay.classList.add('hidden');
      this.pauseTimer(false);
      const resolve = this._resolveExhaustHint;
      this._resolveExhaustHint = null;
      if (resolve) resolve(!!completed);
    },

    onTargetCellClick(_ev, r, c) {
      const s = this.state;
      if (!s || s.phase !== TurnPhase.PLAY) return;
      if (!this.isLocalPlayersTurn()) return;
      if (this.isExhaustHintModalOpen()) return;

      const cur = this.getCurrentPlayer();
      if (cur.targetShots[r][c] !== 'unknown') return;
      if (s.turn.shotsRemaining <= 0) return;

      s.ui.play.targetSel = { r, c };
      this.renderPlay();

      const opp = this.getOpponentPlayer();
      const incoming = (opp.hints.active && !opp.hints.active.resolved) ? opp.hints.active : null;
      const needsJudgement = !!incoming && !s.ui.play.incoming.judged;
      const oppFakeUsed = !!opp.cards.find((card) => card.id === 'fake' && card.used);
      const canGuessFake = !!incoming && (!oppFakeUsed || incoming.type === 'fake');

      if (!needsJudgement) {
        // No active incoming hint -> fire immediately
        this.fireShot();
      } else {
        // Wait for guess + confirm
        this.toast(canGuessFake ? 'Choose TRUE/LIE/FAKE, then confirm.' : 'Choose TRUE/LIE, then confirm.', 'good');
      }
    },

    setGuess(isTrue) {
      const s = this.state;
      if (!s) return;
      if (!this.isLocalPlayersTurn()) return;
      if (this.isExhaustHintModalOpen()) return;
      s.ui.play.incoming.guess = isTrue;
      this.renderPlay();
    },

    async confirmShot() {
      const s = this.state;
      if (!s || s.phase !== TurnPhase.PLAY) return;
      if (!this.isLocalPlayersTurn()) return;
      if (this.isExhaustHintModalOpen()) return;

      const opp = this.getOpponentPlayer();

      // ✅ FIX: incoming must be the hint object (or null), not a boolean
      const incoming = (opp.hints.active && !opp.hints.active.resolved) ? opp.hints.active : null;
      if (!incoming) return;

      if (!s.ui.play.targetSel) {
        this.toast('Pick a target cell first.', 'bad');
        return;
      }
      const oppFakeUsed = !!opp.cards.find((card) => card.id === 'fake' && card.used);
      const canGuessFake = (!oppFakeUsed || incoming.type === 'fake');
      if (s.ui.play.incoming.guess === null) {
        this.toast(canGuessFake ? 'Choose TRUE, LIE, or FAKE first.' : 'Choose TRUE or LIE first.', 'bad');
        return;
      }

      // Resolve hint reveal overlay (timer paused)
      this.pauseTimer(true);

      const attackerGuess = s.ui.play.incoming.guess;
      const hintTruth = incoming.truth;
      const resultIsTrue = hintTruth === true;
      const bigText = incoming.type === 'fake' ? 'It was FAKE!' : (resultIsTrue ? 'It was TRUE!' : 'It was a LIE!');
      const bigColor = incoming.type === 'fake' ? 'var(--accent)' : (resultIsTrue ? 'var(--good)' : 'var(--danger)');
      const guessText = `You guessed ${attackerGuess === 'fake' ? 'FAKE' : (attackerGuess ? 'TRUE' : 'LIE')}`;
      const guessColor = attackerGuess === 'fake' ? 'var(--accent)' : (attackerGuess ? 'var(--good)' : 'var(--danger)');

      // Build effect text for reveal popup.
      const effectText = this.getEffectDescription(incoming, attackerGuess);

      await this.showResultOverlay(bigText, bigColor, guessText, guessColor, effectText);

      // Mark hint as resolved.
      incoming.resolved = true;
      opp.hints.active = null;
      if (incoming.type !== 'fake') {
        const pastHint = { ...incoming };
        opp.hints.past.push(pastHint);
      }

      // Resume timer for effect stage (as requested)
      this.pauseTimer(false);

      // Apply effects with small animations
      await this.applyHintEffects(incoming, attackerGuess);
      this.reportGameAction(RoomAPI.GAME_ACTIONS.REVEAL_HINT_RESULT, {
        hintId: incoming.id,
        hintOwner: this.getOpponentPlayerIdx(),
        attackerGuess,
        truth: incoming.truth,
        type: incoming.type,
        effectText,
      });

      // Mark judgement done and proceed with the actual shot
      s.ui.play.incoming.judged = true;
      this.renderPlay();
      this.fireShot();
    },

    getEffectDescription(hint, attackerGuess) {
      if (hint.type === 'fake') {
        if (attackerGuess === 'fake') {
          return 'Effect: you place a TRUE hint on the opponent field, with hint type restricted to opponent consumed hint types.';
        }
        return 'Effect: opponent will place a TRUE hint on your field at the start of opponent\'s next turn.';
      }

      const hintWasTrue = hint.truth === true;

      if (hintWasTrue) {
        if (attackerGuess === true) return 'Effect: none (they trusted a true hint).';
        return 'Effect: about half of revivable destroyed cells on the opponent board (misses and hits on ships that are not fully sunk) will revive (rounded).';
      } else {
        if (attackerGuess === false) return 'Effect: a forced correct hint will be added about the opponent.';
        return 'Effect: opponent gains 2 bonus shots on their next turn.';
      }
    },

    showResultOverlay(bigText, color, guessText, guessColor, effectText) {
      return new Promise((resolve) => {
        this.els.resultSmall.textContent = 'The result is…';
        this.els.resultBig.textContent = '—';
        this.els.resultBig.style.color = 'var(--text)';
        this.els.resultGuess.textContent = '';
        this.els.resultGuess.style.color = 'var(--text)';
        this.els.resultEffect.textContent = '';
        this.els.resultContinueBtn.classList.add('hidden');
        this.els.resultContinueBtn.disabled = true;
        this.els.resultOverlay.classList.remove('hidden');

        setTimeout(() => {
          this.els.resultBig.textContent = bigText;
          this.els.resultBig.style.color = color;
          this.els.resultGuess.textContent = guessText;
          this.els.resultGuess.style.color = guessColor;
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

    async applyHintEffects(hint, attackerGuess) {
      const opp = this.getOpponentPlayer(); // defender (hint owner)
      const cur = this.getCurrentPlayer();  // attacker

      if (hint.type === 'fake') {
        const currentIdx = this.getCurrentPlayerIdx();
        const opponentIdx = this.getOpponentPlayerIdx();

        if (attackerGuess === 'fake') {
          const consumed = this.getConsumedHintTypes(opp);
          if (consumed.length === 0) {
            const randomType = HINT_TYPES[randInt(HINT_TYPES.length)].id;
            await this.promptTrueHintPlacement({
              targetPlayerIdx: opponentIdx,
              chooserPlayerIdx: currentIdx,
              allowedTypes: [randomType],
              lockType: true,
              type: randomType,
              title: 'Correct FAKE Guess',
              body: 'Place a TRUE hint on the opponent field. No consumed hint types were available, so a random type was locked in.',
              selectionPrompt: `Type locked to ${HINT_TYPES.find((card) => card.id === randomType)?.name || randomType}. Tap a cell.`,
              confirmText: 'Create TRUE Hint',
              successToast: 'TRUE hint added on opponent field.',
            });
            return;
          }

          await this.promptTrueHintPlacement({
            targetPlayerIdx: opponentIdx,
            chooserPlayerIdx: currentIdx,
            allowedTypes: consumed,
            lockType: false,
            title: 'Correct FAKE Guess',
            body: 'Place a TRUE hint on the opponent field. You may choose only hint types already consumed by that opponent.',
            selectionPrompt: 'Select allowed hint type and tap a cell.',
            confirmText: 'Create TRUE Hint',
            successToast: 'TRUE hint added on opponent field.',
          });
          return;
        }

        opp.pendingFakeWrongPlacement = true;
        this.reportGameAction(RoomAPI.GAME_ACTIONS.APPLY_BLUFF_STATE, {
          effect: 'deferred_true_hint',
          targetPlayer: opponentIdx,
        });
        this.toast(`${this.getPlayerName(opponentIdx)} will place a TRUE hint next turn.`, 'good');
        await this.sleep(900);
        this.renderPlay();
        return;
      }

      const hintWasTrue = hint.truth === true;

      if (hintWasTrue) {
        if (attackerGuess === true) {
          // no effect
          return;
        }
        // Revive from destroyed cells, but never from fully exposed/sunk ship cells.
        const sunkCellKeys = this.getSunkCellKeySet(opp);
        const destroyed = getRevivableDestroyedCells(opp, sunkCellKeys);
        const n = roundHalf(destroyed.length);
        if (n <= 0) return;

        shuffle(destroyed);
        const chosen = destroyed.slice(0, n);
        this.reportGameAction(RoomAPI.GAME_ACTIONS.APPLY_BLUFF_STATE, {
          effect: 'revive_destroyed_cells',
          count: n,
          targetPlayer: this.getOpponentPlayerIdx(),
        });

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
      if (attackerGuess === false) {
        // Attacker caught the lie -> force a correct hint about defender
        const forcedHint = this.createForcedCorrectHint(opp);
        if (!forcedHint) {
          this.toast('Forced hint skipped: all cells already covered by hints.', 'bad');
          await this.sleep(900);
          this.renderPlay();
          return;
        }

        forcedHint.blink = true;
        opp.hints.past.push(forcedHint);
        this.reportGameAction(RoomAPI.GAME_ACTIONS.APPLY_BLUFF_STATE, {
          effect: 'forced_correct_hint',
          targetPlayer: this.getOpponentPlayerIdx(),
          hintType: forcedHint.type,
        });

        this.toast('Forced correct hint added!', 'bad');
        await this.sleep(900);
        // stop blinking after a short period
        setTimeout(() => {
          forcedHint.blink = false;
          this.renderPlay();
        }, 2500);

        this.renderPlay();
        return;
      }

      // Wrong guess on a lie (TRUE or FAKE guess) -> defender bonus shots
      opp.bonusShotsNextTurn += 2;
      this.reportGameAction(RoomAPI.GAME_ACTIONS.APPLY_BLUFF_STATE, {
        effect: 'bonus_shots_next_turn',
        targetPlayer: this.getOpponentPlayerIdx(),
        amount: 2,
      });
      this.toast('+2 SHOTS', 'good', true);
      await this.sleep(900);
      this.renderPlay();
    },

    createForcedCorrectHint(defender) {
      // Choose a random type first, then a random placement that reveals at least one
      // not-yet-covered cell (covered = included in any past hint on defender's field).
      const covered = makeGrid(false);
      for (const pastHint of defender.hints.past) {
        if (!isHintType(pastHint.type)) continue;
        const pastCells = hintCells(pastHint.type, pastHint.selection);
        for (const { r, c } of pastCells) covered[r][c] = true;
      }

      let uncoveredExists = false;
      for (let r = 0; r < ROWS && !uncoveredExists; r++) {
        for (let c = 0; c < COLS; c++) {
          if (!covered[r][c]) {
            uncoveredExists = true;
            break;
          }
        }
      }
      if (!uncoveredExists) return null;

      const typeOrder = shuffle(HINT_TYPES.map((card) => card.id));
      for (const type of typeOrder) {
        const candidates = [];

        if (type === 'row') {
          for (let row = 0; row < ROWS; row++) {
            const selection = { row };
            const cells = hintCells(type, selection);
            if (cells.some(({ r, c }) => !covered[r][c])) candidates.push(selection);
          }
        } else if (type === 'col') {
          for (let col = 0; col < COLS; col++) {
            const selection = { col };
            const cells = hintCells(type, selection);
            if (cells.some(({ r, c }) => !covered[r][c])) candidates.push(selection);
          }
        } else if (type === 'area') {
          for (let r = 0; r < ROWS; r++) {
            for (let c = 0; c < COLS; c++) {
              const selection = { center: { r, c } };
              const cells = hintCells(type, selection);
              if (cells.some((cell) => !covered[cell.r][cell.c])) candidates.push(selection);
            }
          }
        } else {
          for (let r = 0; r < ROWS; r++) {
            for (let c = 0; c < COLS; c++) {
              const selection = { cell: { r, c } };
              const cells = hintCells(type, selection);
              if (cells.some((cell) => !covered[cell.r][cell.c])) candidates.push(selection);
            }
          }
        }

        if (candidates.length === 0) continue;

        const selection = candidates[randInt(candidates.length)];
        const cells = hintCells(type, selection);
        const areaHas = evaluateAreaHasUnexposedShip(defender, cells);

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
      }

      return null;
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
      this.reportGameAction(RoomAPI.GAME_ACTIONS.ATTACK_CELL, {
        attacker: this.getCurrentPlayerIdx(),
        target: { r, c },
      });

      // Track that at least one shot was taken this turn
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
      this.reportGameAction(RoomAPI.GAME_ACTIONS.RESOLVE_ATTACK, {
        attacker: this.getCurrentPlayerIdx(),
        defender: this.getOpponentPlayerIdx(),
        target: { r, c },
        result: hasShip ? 'hit' : 'miss',
        shotsRemainingBeforeConsume: s.turn.shotsRemaining,
      });

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
        this.showGameOver(`${this.getPlayerName(this.getCurrentPlayerIdx())} wins!`, 'All enemy ships are sunk.');
        this.reportSyncSnapshot('game_over');
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
      const previousPlayer = s.currentPlayer;
      const nextPlayer = (s.currentPlayer === 0) ? 1 : 0;
      s.currentPlayer = nextPlayer;

      if (this.isRoomGameplaySyncEnabled()) {
        this.showPanel('#playPanel');
        this.setPhasePill('Play');
        this.startTurn();
        if (this.isLocalPlayersTurn()) {
          this.handleDeferredTurnStartEffects();
        }
        this.reportGameAction(RoomAPI.GAME_ACTIONS.END_TURN, {
          previousPlayer,
          nextPlayer,
        });
        this.renderPlay();
        return;
      }

      this.reportGameAction(RoomAPI.GAME_ACTIONS.END_TURN, {
        previousPlayer,
        nextPlayer,
      });

      // Show pass overlay
      const nextName = this.getPlayerName(s.currentPlayer);
      this.openPassOverlay(nextName, `Pass the device. ${nextName}, prepare for your turn.`);
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

    showTurnPopup(text) {
      const p = this.els.turnPopup;
      if (!p) return;
      clearTimeout(this._turnPopupT);
      p.textContent = text;
      p.classList.remove('hidden', 'show');
      void p.offsetWidth;
      p.classList.add('show');
      this._turnPopupT = setTimeout(() => {
        p.classList.remove('show');
        p.classList.add('hidden');
      }, 1750);
    },

    maybeShowTurnPopup() {
      if (!this.state || this.state.phase !== TurnPhase.PLAY) return;
      if (!this.isLocalPlayersTurn()) return;
      const curIdx = this.getCurrentPlayerIdx();
      const turnSeq = Number(this.state.turn && this.state.turn.seq) || 0;
      const key = `${curIdx}:${turnSeq}`;
      if (this._lastTurnPopupKey === key) return;
      this._lastTurnPopupKey = key;
      this.showTurnPopup('YOUR TURN');
    },

    showHintOutcomePopup({ truthText, truthColor, guessText, guessColor, effectText }) {
      const box = this.els.hintOutcomePopup;
      if (!box) return;
      clearTimeout(this._hintOutcomePopupT);

      this.els.hintOutcomeTitle.textContent = 'Your Hint Was Judged';
      this.els.hintOutcomeTruth.textContent = `Truth: ${truthText}`;
      this.els.hintOutcomeTruth.style.color = truthColor;
      this.els.hintOutcomeGuess.textContent = `Opponent guessed: ${guessText}`;
      this.els.hintOutcomeGuess.style.color = guessColor;
      this.els.hintOutcomeEffect.textContent = effectText || 'Effect: none.';

      box.classList.remove('hidden', 'show');
      void box.offsetWidth;
      box.classList.add('show');
      this._hintOutcomePopupT = setTimeout(() => {
        box.classList.remove('show');
        box.classList.add('hidden');
      }, 2900);
    },

    showIncomingHintOutcome(payload) {
      if (!this.state || !this.isRoomGameplaySyncEnabled()) return;
      if (typeof payload.hintOwner !== 'number') return;

      let localIdx = this.state.multiplayer.localPlayerIdx;
      if (localIdx == null) {
        localIdx = this.resolveLocalRoomPlayerIdx();
        this.state.multiplayer.localPlayerIdx = localIdx;
      }
      if (localIdx == null || localIdx !== payload.hintOwner) return;

      const truthText = payload.type === 'fake'
        ? 'FAKE'
        : (payload.truth === true ? 'TRUE' : 'LIE');
      const truthColor = payload.type === 'fake'
        ? 'var(--accent)'
        : (payload.truth === true ? 'var(--good)' : 'var(--danger)');
      const guessText = payload.attackerGuess === 'fake'
        ? 'FAKE'
        : (payload.attackerGuess ? 'TRUE' : 'LIE');
      const guessColor = payload.attackerGuess === 'fake'
        ? 'var(--accent)'
        : (payload.attackerGuess ? 'var(--good)' : 'var(--danger)');

      this.showHintOutcomePopup({
        truthText,
        truthColor,
        guessText,
        guessColor,
        effectText: payload.effectText || 'Effect: none.',
      });
    },

    sleep(ms) {
      return new Promise(res => setTimeout(res, ms));
    },

    async handleRestartRequest() {
      this.stopTurnTimer();
      this.pauseTimer(false);
      this.els.resultOverlay.classList.add('hidden');
      this.els.passOverlay.classList.add('hidden');
      document.getElementById('app')?.classList.remove('pass-blur');

      if (this.state && this.state.ui && this.state.ui.gameOver) {
        this.state.ui.gameOver.visible = false;
      }
      this.syncGameOverOverlay();

      this.state = null;
      this.setPhasePill('Ready');

      if (this.session && this.session.isRoomPlay && this.roomClient) {
        await this.roomClient.disconnect();
        this.roomClient = null;
        this.roomState = RoomAPI.createInitialRoomState(this.session);
        this.roomLaunchConsumed = false;
        this.updateSessionPills();
        this.renderRoomLaunchControls();
        this.renderRoomNameInputs();
        this.renderSessionNotice();
        this.showPanel('#startPanel');
        await this.startRoomBootstrap();
        return;
      }

      this.renderRoomLaunchControls();
      this.renderRoomNameInputs();
      this.renderSessionNotice();
      this.showPanel('#startPanel');
    },

    syncGameOverOverlay() {
      const gameOver = this.state && this.state.ui ? this.state.ui.gameOver : null;
      if (!gameOver || !gameOver.visible) {
        this.els.gameOverOverlay.classList.add('hidden');
        return;
      }
      this.els.gameOverTitle.textContent = gameOver.title || 'Game Over';
      this.els.gameOverBody.textContent = gameOver.body || '-';
      this.els.gameOverOverlay.classList.remove('hidden');
    },

    // Game over
    showGameOver(title, body) {
      if (this.state && this.state.ui) {
        this.state.ui.gameOver = {
          visible: true,
          title,
          body,
        };
      }
      this.syncGameOverOverlay();
    },

    confirmEndGame() {
      const shouldEnd = window.confirm('End the current game?');
      if (!shouldEnd) return;
      this.endGame('Game ended.');
    },

    endGame(msg) {
      this.stopTurnTimer();
      this.showGameOver('Game Over', msg);
      if (this.isRoomGameplaySyncEnabled()) {
        this.reportSyncSnapshot('game_over_manual');
      }
    },
  };

  function disablePullToRefresh() {
    let touchStartY = 0;
    document.addEventListener('touchstart', (e) => {
      if (!e.touches || e.touches.length === 0) return;
      touchStartY = e.touches[0].clientY;
    }, { passive: true });

    document.addEventListener('touchmove', (e) => {
      if (!e.touches || e.touches.length === 0) return;
      const movingDown = e.touches[0].clientY > touchStartY;
      if (movingDown && window.scrollY <= 0) {
        e.preventDefault();
      }
    }, { passive: false });
  }

  // Boot
  window.addEventListener('DOMContentLoaded', () => {
    disablePullToRefresh();
    App.init();

    // Start actual play turn when play panel becomes visible after setup lock-in pass.
    // We do it from App.onReady() by checking phase, but we also need to start first turn after player 1 ready.
    // We'll hook into pass overlay close by observing phase and current panel.
    const readyBtn = document.getElementById('readyBtn');
    readyBtn.addEventListener('click', () => {
      if (App.state && App.state.phase === TurnPhase.PLAY) {
        if (App.isRoomGameplaySyncEnabled() && !App.isLocalPlayersTurn()) {
          App.syncRoomTurnOverlay();
          return;
        }
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

