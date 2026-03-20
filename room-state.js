(function () {
  'use strict';

  const ROOM_PHASES = {
    IDLE: 'idle',
    CONNECTING: 'connecting',
    WAITING: 'waiting',
    READY: 'ready',
    PLAYING: 'playing',
    ENDED: 'ended',
  };

  const CONNECTION_STATUS = {
    OFFLINE: 'offline',
    CONNECTING: 'connecting',
    CONNECTED: 'connected',
    WAITING: 'waiting',
    READY: 'ready',
    PLAYING: 'playing',
    DISCONNECTED: 'disconnected',
    ERROR: 'error',
  };

  const ROOM_EVENTS = {
    JOIN_ROOM: 'join_room',
    LEAVE_ROOM: 'leave_room',
    PLAYER_READY: 'player_ready',
    START_GAME: 'start_game',
    GAME_ACTION: 'game_action',
    SYNC_REQUEST: 'sync_request',
    HEARTBEAT: 'heartbeat',
    ROOM_JOINED: 'room_joined',
    ROOM_STATE: 'room_state',
    PLAYER_JOINED: 'player_joined',
    PLAYER_LEFT: 'player_left',
    PLAYER_READY_STATE: 'player_ready',
    GAME_STARTED: 'game_started',
    SYNC_STATE: 'sync_state',
    ERROR: 'error',
    ROOM_CLOSED: 'room_closed',
  };

  const GAME_ACTIONS = {
    PLACE_SHIP: 'place_ship',
    CONFIRM_FLEET: 'confirm_fleet',
    ATTACK_CELL: 'attack_cell',
    RESOLVE_ATTACK: 'resolve_attack',
    PLAY_HINT: 'play_hint',
    REVEAL_HINT_RESULT: 'reveal_hint_result',
    APPLY_BLUFF_STATE: 'apply_bluff_state',
    CONSUME_HINT: 'consume_hint',
    END_TURN: 'end_turn',
    RESTART_MATCH: 'restart_match',
    SYNC_SNAPSHOT: 'sync_snapshot',
  };

  function createInitialRoomState(session) {
    return {
      session,
      roomCode: session.roomCode,
      connectionStatus: session.isRoomPlay ? CONNECTION_STATUS.CONNECTING : CONNECTION_STATUS.OFFLINE,
      transportKind: session.isRoomPlay ? 'local-dev' : 'local-only',
      players: [],
      hostId: null,
      localPlayerId: null,
      joined: false,
      roomPhase: session.isRoomPlay ? ROOM_PHASES.CONNECTING : ROOM_PHASES.IDLE,
      isReady: false,
      isFull: false,
      gameStarted: false,
      gameStartSignal: 0,
      lastError: null,
      lastAction: null,
      warnings: [],
      roomClosed: false,
    };
  }

  function cloneRoomState(state) {
    return JSON.parse(JSON.stringify(state));
  }

  window.BattleshipRoomState = {
    ROOM_PHASES,
    CONNECTION_STATUS,
    ROOM_EVENTS,
    GAME_ACTIONS,
    createInitialRoomState,
    cloneRoomState,
  };
})();
