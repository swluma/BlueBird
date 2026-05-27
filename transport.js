(function () {
  'use strict';

  const SESSION = window.BattleshipSession;
  const ROOM = window.BattleshipRoomState;

  const STORAGE_PREFIX = 'battleship-bluff.devroom.';
  const CHANNEL_NAME = 'battleship-bluff.devroom.channel';
  const REMOTE_PLAYER_KEY_PREFIX = 'battleship-bluff.remote-player.';

  function createId(prefix) {
    return `${prefix}_${Math.random().toString(16).slice(2)}_${Date.now().toString(36)}`;
  }

  function getRemoteStorageKey(session) {
    const roomCode = SESSION.sanitizeRoomCode(session && session.roomCode);
    const mode = session && session.mode ? String(session.mode) : 'room';
    return `${REMOTE_PLAYER_KEY_PREFIX}${roomCode || 'noroom'}.${mode}`;
  }

  function getStoredRemoteIdentity(session) {
    try {
      const raw = window.sessionStorage.getItem(getRemoteStorageKey(session));
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return null;
      if (!parsed.playerId || !parsed.clientId) return null;
      return {
        playerId: String(parsed.playerId),
        clientId: String(parsed.clientId),
      };
    } catch (_error) {
      return null;
    }
  }

  function persistRemoteIdentity(session, identity) {
    try {
      window.sessionStorage.setItem(getRemoteStorageKey(session), JSON.stringify(identity));
    } catch (_error) {
      // Session storage is an optimization for reconnects only.
    }
  }

  class BaseTransport {
    constructor() {
      this.listeners = new Map();
    }

    on(eventName, handler) {
      if (!this.listeners.has(eventName)) this.listeners.set(eventName, new Set());
      this.listeners.get(eventName).add(handler);
    }

    off(eventName, handler) {
      const set = this.listeners.get(eventName);
      if (!set) return;
      set.delete(handler);
    }

    emit(eventName, payload) {
      const handlers = this.listeners.get(eventName);
      if (!handlers) return;
      handlers.forEach((handler) => handler(payload));
    }
  }

  class LocalDevRoomTransport extends BaseTransport {
    constructor(session) {
      super();
      this.session = session;
      const identity = getStoredRemoteIdentity(session);
      this.clientId = identity && identity.clientId ? identity.clientId : createId('client');
      this.playerId = identity && identity.playerId ? identity.playerId : createId('player');
      this.connected = false;
      this.roomCode = session.roomCode;
      this.channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(CHANNEL_NAME) : null;
      if (this.channel) {
        this.channel.addEventListener('message', (event) => this.onBroadcast(event.data));
      }
      persistRemoteIdentity(session, {
        playerId: this.playerId,
        clientId: this.clientId,
      });
    }

    connect() {
      this.connected = true;
      this.emit('status', { status: ROOM.CONNECTION_STATUS.CONNECTED, transportKind: 'local-dev' });
      return Promise.resolve();
    }

    disconnect() {
      if (!this.connected) return Promise.resolve();
      if (this.roomCode) {
        this.send(ROOM.ROOM_EVENTS.LEAVE_ROOM, { roomCode: this.roomCode });
      }
      this.connected = false;
      this.emit('status', { status: ROOM.CONNECTION_STATUS.DISCONNECTED, transportKind: 'local-dev' });
      if (this.channel) this.channel.close();
      return Promise.resolve();
    }

    send(eventName, payload) {
      if (!this.connected && eventName !== ROOM.ROOM_EVENTS.LEAVE_ROOM) {
        this.emit(ROOM.ROOM_EVENTS.ERROR, { message: 'Transport is not connected.' });
        return;
      }

      if (eventName === ROOM.ROOM_EVENTS.JOIN_ROOM) this.handleJoinRoom(payload);
      else if (eventName === ROOM.ROOM_EVENTS.LEAVE_ROOM) this.handleLeaveRoom(payload);
      else if (eventName === ROOM.ROOM_EVENTS.UPDATE_SETTINGS) this.handleUpdateSettings(payload);
      else if (eventName === ROOM.ROOM_EVENTS.PLAYER_READY) this.handlePlayerReady(payload);
      else if (eventName === ROOM.ROOM_EVENTS.START_GAME) this.handleStartGame(payload);
      else if (eventName === ROOM.ROOM_EVENTS.GAME_ACTION) this.handleGameAction(payload);
      else if (eventName === ROOM.ROOM_EVENTS.SYNC_REQUEST) this.handleSyncRequest(payload);
      else if (eventName === ROOM.ROOM_EVENTS.HEARTBEAT) this.handleHeartbeat(payload);
    }

    onBroadcast(message) {
      if (!message || message.senderId === this.clientId) return;
      if (message.roomCode && this.roomCode && message.roomCode !== this.roomCode) return;
      this.emit(message.eventName, message.payload);
    }

    storageKey(roomCode) {
      return `${STORAGE_PREFIX}${roomCode}`;
    }

    loadRoom(roomCode) {
      const raw = window.localStorage.getItem(this.storageKey(roomCode));
      return raw ? JSON.parse(raw) : null;
    }

    saveRoom(room) {
      window.localStorage.setItem(this.storageKey(room.roomCode), JSON.stringify(room));
    }

    deleteRoom(roomCode) {
      window.localStorage.removeItem(this.storageKey(roomCode));
    }

    broadcast(eventName, payload, roomCode) {
      this.emit(eventName, payload);
      if (this.channel) {
        this.channel.postMessage({
          senderId: this.clientId,
          roomCode,
          eventName,
          payload,
        });
      }
    }

    normalizeRoomPhase(room) {
      const connectedPlayers = room && Array.isArray(room.players)
        ? room.players.filter((player) => player.status !== 'disconnected')
        : [];
      if (!room || connectedPlayers.length < room.maxPlayers) {
        return ROOM.ROOM_PHASES.WAITING;
      }
      if (room.gameStarted) return ROOM.ROOM_PHASES.PLAYING;
      if (connectedPlayers.length >= room.maxPlayers && connectedPlayers.every((player) => player.isHost || player.isReady)) {
        return ROOM.ROOM_PHASES.READY;
      }
      return ROOM.ROOM_PHASES.WAITING;
    }

    resetMatchState(room) {
      if (!room) return;
      room.gameStarted = false;
      room.lastAction = null;
      room.players.forEach((player) => {
        player.isReady = !!player.isHost;
      });
    }

    reclaimHostSlot(room, payload) {
      if (!room || !payload || payload.mode !== 'host') return;
      const nextPlayers = room.players.filter((player) => !player.isHost || player.id === this.playerId);
      if (nextPlayers.length === room.players.length) return;
      room.players = nextPlayers;
      this.resetMatchState(room);
    }

    createRoom(roomCode, payload) {
      return {
        gameId: payload.gameId,
        roomCode,
        maxPlayers: payload.maxPlayers || 2,
        hostId: this.playerId,
        phase: ROOM.ROOM_PHASES.WAITING,
        gameStarted: false,
        settings: ROOM.normalizeRoomSettings(null),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        players: [],
        lastAction: null,
      };
    }

    upsertPlayer(room, payload) {
      const now = Date.now();
      const existing = room.players.find((player) => player.id === this.playerId);
      if (existing) {
        existing.name = payload.playerName;
        existing.isHost = payload.mode === 'host';
        existing.lastSeenAt = now;
        existing.status = 'connected';
        return { player: existing, isNew: false };
      }

      const player = {
        id: this.playerId,
        clientId: this.clientId,
        name: payload.playerName,
        isHost: payload.mode === 'host',
        isReady: payload.mode === 'host',
        joinedAt: now,
        lastSeenAt: now,
        status: 'connected',
      };
      room.players.push(player);
      return { player, isNew: true };
    }

    makeRoomSnapshot(room) {
      return {
        gameId: room.gameId,
        roomCode: room.roomCode,
        hostId: room.hostId,
        phase: room.phase,
        maxPlayers: room.maxPlayers,
        gameStarted: !!room.gameStarted,
        settings: ROOM.normalizeRoomSettings(room.settings),
        players: room.players.map((player) => ({
          id: player.id,
          name: player.name,
          isHost: !!player.isHost,
          isReady: !!player.isReady,
          status: player.status || 'connected',
        })),
        lastAction: room.lastAction || null,
      };
    }

    handleJoinRoom(payload) {
      const roomCode = SESSION.sanitizeRoomCode(payload.roomCode);
      if (!roomCode) {
        this.emit(ROOM.ROOM_EVENTS.ERROR, { message: 'Room code is missing.' });
        return;
      }

      let room = this.loadRoom(roomCode);
      if (!room) {
        if (payload.mode !== 'host') {
          this.emit(ROOM.ROOM_EVENTS.ERROR, { message: 'Room not found.' });
          return;
        }
        room = this.createRoom(roomCode, payload);
      }

      if (room.gameId !== payload.gameId) {
        this.emit(ROOM.ROOM_EVENTS.ERROR, { message: 'Wrong game type for this room.' });
        return;
      }
      room.settings = ROOM.normalizeRoomSettings(room.settings);

      this.reclaimHostSlot(room, payload);

      const existing = room.players.find((player) => player.id === this.playerId);
      const connectedPlayers = room.players.filter((player) => player.status !== 'disconnected');
      if (!existing && connectedPlayers.length >= room.maxPlayers) {
        this.emit(ROOM.ROOM_EVENTS.ERROR, { message: 'Room is full.' });
        return;
      }

      const result = this.upsertPlayer(room, payload);
      this.roomCode = roomCode;
      if (payload.mode === 'host') room.hostId = this.playerId;
      room.phase = this.normalizeRoomPhase(room);
      room.updatedAt = Date.now();
      this.saveRoom(room);

      const snapshot = this.makeRoomSnapshot(room);
      this.emit(ROOM.ROOM_EVENTS.ROOM_JOINED, {
        roomCode,
        playerId: this.playerId,
        transportKind: 'local-dev',
        room: snapshot,
      });
      if (result.isNew) {
        this.broadcast(ROOM.ROOM_EVENTS.PLAYER_JOINED, {
          roomCode,
          player: {
            id: result.player.id,
            name: result.player.name,
            isHost: result.player.isHost,
            isReady: result.player.isReady,
          },
        }, roomCode);
      }
      this.broadcast(ROOM.ROOM_EVENTS.ROOM_STATE, snapshot, roomCode);
    }

    handleUpdateSettings(payload) {
      const room = this.loadRoom(this.roomCode);
      if (!room) {
        this.emit(ROOM.ROOM_EVENTS.ERROR, { message: 'Room is no longer available.' });
        return;
      }
      const player = room.players.find((entry) => entry.id === this.playerId);
      if (!player) {
        this.emit(ROOM.ROOM_EVENTS.ERROR, { message: 'You are not in this room.' });
        return;
      }
      if (!player.isHost || player.id !== room.hostId) {
        this.emit(ROOM.ROOM_EVENTS.ERROR, { message: 'Only the host can change room settings.' });
        return;
      }
      room.settings = ROOM.normalizeRoomSettings(payload && payload.settings);
      room.updatedAt = Date.now();
      this.saveRoom(room);
      this.broadcast(ROOM.ROOM_EVENTS.ROOM_STATE, this.makeRoomSnapshot(room), room.roomCode);
    }

    handleLeaveRoom(payload) {
      const roomCode = SESSION.sanitizeRoomCode((payload && payload.roomCode) || this.roomCode);
      if (!roomCode) return;

      const room = this.loadRoom(roomCode);
      if (!room) return;

      const player = room.players.find((entry) => entry.id === this.playerId);
      if (!player) return;

      player.status = 'disconnected';
      player.lastSeenAt = Date.now();
      room.updatedAt = Date.now();
      room.phase = this.normalizeRoomPhase(room);
      this.saveRoom(room);
      this.broadcast(ROOM.ROOM_EVENTS.PLAYER_LEFT, {
        roomCode,
        playerId: player.id,
      }, roomCode);
      this.broadcast(ROOM.ROOM_EVENTS.ROOM_STATE, this.makeRoomSnapshot(room), roomCode);
    }

    handlePlayerReady(payload) {
      const room = this.loadRoom(this.roomCode);
      if (!room) {
        this.emit(ROOM.ROOM_EVENTS.ERROR, { message: 'Room is no longer available.' });
        return;
      }

      const player = room.players.find((entry) => entry.id === this.playerId);
      if (!player) {
        this.emit(ROOM.ROOM_EVENTS.ERROR, { message: 'You are not in this room.' });
        return;
      }

      player.isReady = player.isHost ? true : !!payload.isReady;
      player.lastSeenAt = Date.now();
      room.phase = this.normalizeRoomPhase(room);
      room.updatedAt = Date.now();
      this.saveRoom(room);

      this.broadcast(ROOM.ROOM_EVENTS.PLAYER_READY_STATE, {
        roomCode: room.roomCode,
        playerId: player.id,
        isReady: player.isReady,
      }, room.roomCode);
      this.broadcast(ROOM.ROOM_EVENTS.ROOM_STATE, this.makeRoomSnapshot(room), room.roomCode);
    }

    handleStartGame() {
      const room = this.loadRoom(this.roomCode);
      if (!room) {
        this.emit(ROOM.ROOM_EVENTS.ERROR, { message: 'Room is no longer available.' });
        return;
      }
      if (room.hostId !== this.playerId) {
        this.emit(ROOM.ROOM_EVENTS.ERROR, { message: 'Only the host can start the game.' });
        return;
      }
      const connectedPlayers = room.players.filter((player) => player.status !== 'disconnected');
      if (connectedPlayers.length < room.maxPlayers) {
        this.emit(ROOM.ROOM_EVENTS.ERROR, { message: 'Waiting for another player.' });
        return;
      }
      if (!connectedPlayers.every((player) => player.isHost || player.isReady)) {
        this.emit(ROOM.ROOM_EVENTS.ERROR, { message: 'Both players must be ready.' });
        return;
      }

      room.gameStarted = true;
      room.phase = ROOM.ROOM_PHASES.PLAYING;
      room.updatedAt = Date.now();
      this.saveRoom(room);
      const snapshot = this.makeRoomSnapshot(room);
      this.broadcast(ROOM.ROOM_EVENTS.GAME_STARTED, {
        roomCode: room.roomCode,
        room: snapshot,
      }, room.roomCode);
      this.broadcast(ROOM.ROOM_EVENTS.ROOM_STATE, snapshot, room.roomCode);
    }

    handleGameAction(payload) {
      const room = this.loadRoom(this.roomCode);
      if (!room) return;

      room.lastAction = {
        type: payload.type,
        payload: payload.payload,
        playerId: this.playerId,
        at: Date.now(),
      };
      room.updatedAt = Date.now();
      this.saveRoom(room);
      this.broadcast(ROOM.ROOM_EVENTS.GAME_ACTION, room.lastAction, room.roomCode);
      this.broadcast(ROOM.ROOM_EVENTS.ROOM_STATE, this.makeRoomSnapshot(room), room.roomCode);
    }

    handleSyncRequest() {
      const room = this.loadRoom(this.roomCode);
      if (!room) return;
      this.broadcast(ROOM.ROOM_EVENTS.SYNC_STATE, {
        roomCode: room.roomCode,
        room: this.makeRoomSnapshot(room),
      }, room.roomCode);
    }

    handleHeartbeat() {
      const room = this.loadRoom(this.roomCode);
      if (!room) return;
      const player = room.players.find((entry) => entry.id === this.playerId);
      if (!player) return;
      player.lastSeenAt = Date.now();
      room.updatedAt = Date.now();
      this.saveRoom(room);
    }
  }

  class WebSocketRoomTransport extends BaseTransport {
    constructor(session) {
      super();
      this.session = session;
      const identity = getStoredRemoteIdentity(session);
      this.clientId = identity && identity.clientId ? identity.clientId : createId('ws_client');
      this.playerId = identity && identity.playerId ? identity.playerId : createId('ws_player');
      this.socket = null;
      this.connected = false;
      this.roomCode = session.roomCode;
      this.reconnectIdentity();
    }

    connect() {
      if (!this.session.wsUrl) {
        this.emit(ROOM.ROOM_EVENTS.ERROR, {
          message: 'Room mode requires a WebSocket URL.',
        });
        return Promise.resolve();
      }
      if (this.connected && this.socket && this.socket.readyState === window.WebSocket.OPEN) {
        return Promise.resolve();
      }

      this.emit('status', {
        status: ROOM.CONNECTION_STATUS.CONNECTING,
        transportKind: 'websocket',
      });

      return new Promise((resolve) => {
        const socket = new window.WebSocket(this.session.wsUrl);
        this.socket = socket;
        let settled = false;

        const finish = () => {
          if (settled) return;
          settled = true;
          resolve();
        };

        socket.addEventListener('open', () => {
          this.connected = true;
          this.emit('status', {
            status: ROOM.CONNECTION_STATUS.CONNECTED,
            transportKind: 'websocket',
          });
          finish();
        });

        socket.addEventListener('message', (event) => this.onMessage(event.data));

        socket.addEventListener('close', () => {
          this.connected = false;
          this.emit('status', {
            status: ROOM.CONNECTION_STATUS.DISCONNECTED,
            transportKind: 'websocket',
          });
          if (!settled) finish();
        });

        socket.addEventListener('error', () => {
          this.emit(ROOM.ROOM_EVENTS.ERROR, {
            message: 'Could not connect to the room server.',
          });
          if (!settled) finish();
        });
      });
    }

    disconnect() {
      if (!this.socket) return Promise.resolve();
      if (this.connected) {
        this.send(ROOM.ROOM_EVENTS.LEAVE_ROOM, { roomCode: this.roomCode });
      }
      try {
        this.socket.close();
      } catch (_error) {
        // Ignore close errors from already-closing sockets.
      }
      this.socket = null;
      this.connected = false;
      return Promise.resolve();
    }

    reconnectIdentity() {
      persistRemoteIdentity(this.session, {
        playerId: this.playerId,
        clientId: this.clientId,
      });
    }

    send(eventName, payload) {
      if (!this.socket || this.socket.readyState !== window.WebSocket.OPEN) {
        if (eventName !== ROOM.ROOM_EVENTS.LEAVE_ROOM) {
          this.emit(ROOM.ROOM_EVENTS.ERROR, { message: 'Room connection is not open.' });
        }
        return;
      }

      const message = this.normalizeOutgoingMessage(eventName, payload);
      if (!message) return;
      this.socket.send(JSON.stringify(message));
    }

    normalizeOutgoingMessage(eventName, payload) {
      const roomCode = SESSION.sanitizeRoomCode((payload && payload.roomCode) || this.roomCode);

      if (eventName === ROOM.ROOM_EVENTS.JOIN_ROOM) {
        this.roomCode = roomCode;
        return {
          type: ROOM.ROOM_EVENTS.JOIN_ROOM,
          payload: {
            gameId: payload.gameId,
            mode: payload.mode,
            roomCode,
            player: {
              id: this.playerId,
              name: payload.playerName,
            },
          },
        };
      }

      if (eventName === ROOM.ROOM_EVENTS.LEAVE_ROOM) {
        return {
          type: ROOM.ROOM_EVENTS.LEAVE_ROOM,
          payload: {
            roomCode,
            playerId: this.playerId,
          },
        };
      }

      if (eventName === ROOM.ROOM_EVENTS.PLAYER_READY) {
        return {
          type: ROOM.ROOM_EVENTS.PLAYER_READY,
          payload: {
            roomCode,
            ready: !!(payload && payload.isReady),
          },
        };
      }

      if (eventName === ROOM.ROOM_EVENTS.UPDATE_SETTINGS) {
        return {
          type: ROOM.ROOM_EVENTS.UPDATE_SETTINGS,
          payload: {
            roomCode,
            settings: ROOM.normalizeRoomSettings(payload && payload.settings),
          },
        };
      }

      if (eventName === ROOM.ROOM_EVENTS.START_GAME) {
        return {
          type: ROOM.ROOM_EVENTS.START_GAME,
          payload: {
            roomCode,
            seed: Date.now(),
          },
        };
      }

      if (eventName === ROOM.ROOM_EVENTS.GAME_ACTION) {
        return {
          type: ROOM.ROOM_EVENTS.GAME_ACTION,
          payload: {
            roomCode,
            action: {
              type: payload && payload.type,
              payload: payload && payload.payload,
            },
          },
        };
      }

      if (eventName === ROOM.ROOM_EVENTS.SYNC_REQUEST) {
        return {
          type: ROOM.ROOM_EVENTS.SYNC_REQUEST,
          payload: {
            roomCode,
          },
        };
      }

      if (eventName === ROOM.ROOM_EVENTS.HEARTBEAT) {
        return {
          type: ROOM.ROOM_EVENTS.HEARTBEAT,
          payload: {
            roomCode,
          },
        };
      }

      return null;
    }

    onMessage(raw) {
      let message;
      try {
        message = JSON.parse(raw);
      } catch (_error) {
        this.emit(ROOM.ROOM_EVENTS.ERROR, { message: 'Received an invalid room message.' });
        return;
      }

      const type = message && message.type ? String(message.type) : '';
      const payload = message && typeof message.payload === 'object' ? message.payload : {};

      if (type === ROOM.ROOM_EVENTS.ROOM_JOINED) {
        this.roomCode = SESSION.sanitizeRoomCode(payload.roomCode || this.roomCode);
        this.emit(ROOM.ROOM_EVENTS.ROOM_JOINED, {
          roomCode: this.roomCode,
          playerId: payload.playerId || this.playerId,
          transportKind: 'websocket',
          room: this.normalizeIncomingRoom(payload.room),
        });
        return;
      }

      if (type === ROOM.ROOM_EVENTS.ROOM_STATE) {
        this.emit(ROOM.ROOM_EVENTS.ROOM_STATE, this.extractRoomStatePayload(payload));
        return;
      }

      if (type === ROOM.ROOM_EVENTS.PLAYER_JOINED) {
        this.emit(ROOM.ROOM_EVENTS.PLAYER_JOINED, {
          roomCode: payload.roomCode || this.roomCode,
          player: this.normalizeIncomingPlayer(payload.player),
        });
        return;
      }

      if (type === ROOM.ROOM_EVENTS.PLAYER_LEFT) {
        this.emit(ROOM.ROOM_EVENTS.PLAYER_LEFT, payload);
        return;
      }

      if (type === ROOM.ROOM_EVENTS.PLAYER_READY_STATE) {
        this.emit(ROOM.ROOM_EVENTS.PLAYER_READY_STATE, {
          roomCode: payload.roomCode || this.roomCode,
          playerId: payload.playerId,
          isReady: !!payload.ready,
        });
        return;
      }

      if (type === ROOM.ROOM_EVENTS.GAME_STARTED) {
        this.emit(ROOM.ROOM_EVENTS.GAME_STARTED, {
          roomCode: payload.roomCode || this.roomCode,
          room: this.normalizeIncomingRoom({
            roomCode: payload.roomCode || this.roomCode,
            phase: ROOM.ROOM_PHASES.PLAYING,
          }),
        });
        return;
      }

      if (type === ROOM.ROOM_EVENTS.GAME_ACTION) {
        const action = payload && payload.action ? payload.action : {};
        this.emit(ROOM.ROOM_EVENTS.GAME_ACTION, {
          type: action.type || null,
          payload: action.payload || null,
          playerId: payload.fromPlayerId || null,
          at: Date.now(),
        });
        return;
      }

      if (type === ROOM.ROOM_EVENTS.SYNC_STATE) {
        this.emit(ROOM.ROOM_EVENTS.SYNC_STATE, {
          roomCode: payload.roomCode || this.roomCode,
          room: this.normalizeIncomingRoom(payload.room),
          lastAction: payload.lastAction || null,
        });
        return;
      }

      if (type === ROOM.ROOM_EVENTS.ERROR) {
        this.emit(ROOM.ROOM_EVENTS.ERROR, {
          message: payload && payload.message ? payload.message : 'Room error.',
          code: payload && payload.code ? payload.code : null,
          recoverable: payload ? payload.recoverable !== false : true,
        });
        return;
      }

      if (type === ROOM.ROOM_EVENTS.ROOM_CLOSED) {
        this.emit(ROOM.ROOM_EVENTS.ROOM_CLOSED, payload || {});
      }
    }

    extractRoomStatePayload(payload) {
      const roomPayload = payload && payload.room ? payload.room : payload;
      const normalizedRoom = this.normalizeIncomingRoom(roomPayload);
      if (payload && payload.lastAction && !normalizedRoom.lastAction) {
        normalizedRoom.lastAction = payload.lastAction;
      }
      return normalizedRoom;
    }

    normalizeIncomingRoom(room) {
      const players = Array.isArray(room && room.players) ? room.players : [];
      const phase = room && room.phase ? room.phase : ROOM.ROOM_PHASES.WAITING;
      const started = !!((room && room.gameStarted) || phase === ROOM.ROOM_PHASES.PLAYING || room && room.startedAt);
      return {
        roomCode: room && room.roomCode ? room.roomCode : this.roomCode,
        hostId: room && room.hostId ? room.hostId : null,
        phase,
        maxPlayers: room && room.maxPlayers ? room.maxPlayers : this.session.maxPlayers,
        gameStarted: started,
        settings: ROOM.normalizeRoomSettings(room && room.settings),
        players: players.map((player) => this.normalizeIncomingPlayer(player, room && room.hostId)),
        lastAction: room && room.lastAction ? room.lastAction : null,
      };
    }

    normalizeIncomingPlayer(player, hostId) {
      const safePlayer = player && typeof player === 'object' ? player : {};
      return {
        id: safePlayer.id || null,
        name: safePlayer.name || 'Player',
        isHost: safePlayer.isHost != null ? !!safePlayer.isHost : safePlayer.id === hostId,
        isReady: safePlayer.isReady != null ? !!safePlayer.isReady : !!safePlayer.ready,
        status: safePlayer.status || 'connected',
      };
    }
  }

  function createTransport(session) {
    if (session && session.wsUrl && typeof window.WebSocket === 'function') {
      return new WebSocketRoomTransport(session);
    }
    return new LocalDevRoomTransport(session);
  }

  window.BattleshipTransport = {
    BaseTransport,
    LocalDevRoomTransport,
    WebSocketRoomTransport,
    createTransport,
  };
})();
