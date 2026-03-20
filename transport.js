(function () {
  'use strict';

  const SESSION = window.BattleshipSession;
  const ROOM = window.BattleshipRoomState;

  const STORAGE_PREFIX = 'battleship-bluff.devroom.';
  const CHANNEL_NAME = 'battleship-bluff.devroom.channel';

  function createId(prefix) {
    return `${prefix}_${Math.random().toString(16).slice(2)}_${Date.now().toString(36)}`;
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
      this.clientId = createId('client');
      this.playerId = createId('player');
      this.connected = false;
      this.roomCode = session.roomCode;
      this.channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(CHANNEL_NAME) : null;
      if (this.channel) {
        this.channel.addEventListener('message', (event) => this.onBroadcast(event.data));
      }
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
      if (!room || room.players.length < room.maxPlayers) {
        return ROOM.ROOM_PHASES.WAITING;
      }
      if (room.gameStarted) return ROOM.ROOM_PHASES.PLAYING;
      if (room.players.length >= room.maxPlayers && room.players.every((player) => player.isReady)) {
        return ROOM.ROOM_PHASES.READY;
      }
      return ROOM.ROOM_PHASES.WAITING;
    }

    resetMatchState(room) {
      if (!room) return;
      room.gameStarted = false;
      room.lastAction = null;
      room.players.forEach((player) => {
        player.isReady = false;
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
        isReady: false,
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
      if (!existing && room.players.length >= room.maxPlayers) {
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

      const index = room.players.findIndex((player) => player.id === this.playerId);
      if (index === -1) return;

      const [player] = room.players.splice(index, 1);
      room.updatedAt = Date.now();

      if (player.id === room.hostId) {
        if (room.players.length === 0) {
          this.deleteRoom(roomCode);
        } else {
          this.broadcast(ROOM.ROOM_EVENTS.ROOM_CLOSED, {
            roomCode,
            message: 'The host closed the room.',
          }, roomCode);
          this.deleteRoom(roomCode);
        }
      } else if (room.players.length === 0) {
        this.deleteRoom(roomCode);
      } else {
        this.resetMatchState(room);
        room.phase = this.normalizeRoomPhase(room);
        this.saveRoom(room);
        this.broadcast(ROOM.ROOM_EVENTS.PLAYER_LEFT, {
          roomCode,
          playerId: player.id,
        }, roomCode);
        this.broadcast(ROOM.ROOM_EVENTS.ROOM_STATE, this.makeRoomSnapshot(room), roomCode);
      }
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

      player.isReady = !!payload.isReady;
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
      if (room.players.length < room.maxPlayers) {
        this.emit(ROOM.ROOM_EVENTS.ERROR, { message: 'Waiting for another player.' });
        return;
      }
      if (!room.players.every((player) => player.isReady)) {
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
    }

    connect() {
      this.emit(ROOM.ROOM_EVENTS.ERROR, {
        message: 'Remote WebSocket transport is not enabled in this local-test phase.',
      });
      return Promise.resolve();
    }

    disconnect() {
      return Promise.resolve();
    }

    send() {}
  }

  function createTransport(session) {
    // For this phase we always use the local-dev transport so same-machine testing
    // works even when future hub-style URLs already include a ws parameter.
    // The WebSocket transport class is intentionally kept here for a later swap-in.
    return new LocalDevRoomTransport(session);
  }

  window.BattleshipTransport = {
    BaseTransport,
    LocalDevRoomTransport,
    WebSocketRoomTransport,
    createTransport,
  };
})();
