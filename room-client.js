(function () {
  'use strict';

  const ROOM = window.BattleshipRoomState;
  const TRANSPORT = window.BattleshipTransport;

  class RoomClient {
    constructor(session) {
      this.session = session;
      this.transport = TRANSPORT.createTransport(session);
      this.state = ROOM.createInitialRoomState(session);
      this.subscribers = new Set();
      this.gameActionSubscribers = new Set();
      this.started = false;
      this.heartbeatId = null;
      this.bound = {
        status: (payload) => this.handleTransportStatus(payload),
        roomJoined: (payload) => this.handleRoomJoined(payload),
        roomState: (payload) => this.handleRoomState(payload),
        playerJoined: () => this.handleRoomStateRefresh(),
        playerLeft: () => this.handleRoomStateRefresh(),
        playerReady: () => this.handleRoomStateRefresh(),
        gameStarted: (payload) => this.handleGameStarted(payload),
        gameAction: (payload) => this.handleGameAction(payload),
        syncState: (payload) => this.handleSyncState(payload),
        roomClosed: (payload) => this.handleRoomClosed(payload),
        error: (payload) => this.handleError(payload),
      };
    }

    subscribe(handler) {
      this.subscribers.add(handler);
      handler(ROOM.cloneRoomState(this.state));
      return () => this.subscribers.delete(handler);
    }

    subscribeGameActions(handler) {
      this.gameActionSubscribers.add(handler);
      return () => this.gameActionSubscribers.delete(handler);
    }

    emitState() {
      const snapshot = ROOM.cloneRoomState(this.state);
      this.subscribers.forEach((handler) => handler(snapshot));
    }

    setState(patch) {
      Object.assign(this.state, patch);
      this.emitState();
    }

    async connect() {
      if (this.started) return;
      this.started = true;
      this.attachHandlers();
      this.setState({
        connectionStatus: ROOM.CONNECTION_STATUS.CONNECTING,
        roomPhase: ROOM.ROOM_PHASES.CONNECTING,
      });
      await this.transport.connect();
      this.transport.send(ROOM.ROOM_EVENTS.JOIN_ROOM, {
        gameId: this.session.gameId,
        mode: this.session.mode,
        maxPlayers: this.session.maxPlayers,
        roomCode: this.session.roomCode,
        playerName: this.session.playerName,
      });
      this.startHeartbeat();
    }

    attachHandlers() {
      this.transport.on('status', this.bound.status);
      this.transport.on(ROOM.ROOM_EVENTS.ROOM_JOINED, this.bound.roomJoined);
      this.transport.on(ROOM.ROOM_EVENTS.ROOM_STATE, this.bound.roomState);
      this.transport.on(ROOM.ROOM_EVENTS.PLAYER_JOINED, this.bound.playerJoined);
      this.transport.on(ROOM.ROOM_EVENTS.PLAYER_LEFT, this.bound.playerLeft);
      this.transport.on(ROOM.ROOM_EVENTS.PLAYER_READY_STATE, this.bound.playerReady);
      this.transport.on(ROOM.ROOM_EVENTS.GAME_STARTED, this.bound.gameStarted);
      this.transport.on(ROOM.ROOM_EVENTS.GAME_ACTION, this.bound.gameAction);
      this.transport.on(ROOM.ROOM_EVENTS.SYNC_STATE, this.bound.syncState);
      this.transport.on(ROOM.ROOM_EVENTS.ROOM_CLOSED, this.bound.roomClosed);
      this.transport.on(ROOM.ROOM_EVENTS.ERROR, this.bound.error);
    }

    handleTransportStatus(payload) {
      this.setState({
        connectionStatus: payload.status || ROOM.CONNECTION_STATUS.CONNECTED,
        transportKind: payload.transportKind || this.state.transportKind,
      });
    }

    handleRoomJoined(payload) {
      this.state.localPlayerId = payload.playerId;
      this.state.joined = true;
      this.state.roomCode = payload.roomCode;
      this.handleRoomState(payload.room);
    }

    handleRoomState(payload) {
      const players = Array.isArray(payload.players) ? payload.players.slice() : [];
      const roomPhase = payload.phase || ROOM.ROOM_PHASES.WAITING;
      let connectionStatus = ROOM.CONNECTION_STATUS.WAITING;
      if (roomPhase === ROOM.ROOM_PHASES.READY) connectionStatus = ROOM.CONNECTION_STATUS.READY;
      if (roomPhase === ROOM.ROOM_PHASES.PLAYING) connectionStatus = ROOM.CONNECTION_STATUS.PLAYING;

      this.setState({
        players,
        hostId: payload.hostId || null,
        roomPhase,
        settings: ROOM.normalizeRoomSettings(payload.settings),
        gameStarted: !!payload.gameStarted,
        isFull: players.length >= this.session.maxPlayers,
        connectionStatus,
        lastAction: payload.lastAction || this.state.lastAction,
        lastError: null,
      });
      const me = players.find((player) => player.id === this.state.localPlayerId);
      this.state.isReady = !!(me && (me.isHost || me.isReady));
      this.emitState();
    }

    handleRoomStateRefresh() {
      this.requestSync();
    }

    handleGameStarted(payload) {
      if (payload && payload.room && Array.isArray(payload.room.players) && payload.room.players.length) {
        this.handleRoomState(payload.room);
      }
      this.setState({
        roomPhase: ROOM.ROOM_PHASES.PLAYING,
        connectionStatus: ROOM.CONNECTION_STATUS.PLAYING,
        gameStarted: true,
        gameStartSignal: (this.state.gameStartSignal || 0) + 1,
      });
    }

    handleGameAction(payload) {
      this.setState({ lastAction: payload || null });
      this.gameActionSubscribers.forEach((handler) => handler(payload || null));
    }

    handleSyncState(payload) {
      if (payload && payload.room) {
        this.handleRoomState(payload.room);
      }
      if (payload && payload.lastAction) {
        this.setState({ lastAction: payload.lastAction });
      }
    }

    handleRoomClosed(payload) {
      this.setState({
        roomClosed: true,
        roomPhase: ROOM.ROOM_PHASES.ENDED,
        connectionStatus: ROOM.CONNECTION_STATUS.DISCONNECTED,
        lastError: payload && payload.message ? payload.message : 'Room closed.',
      });
    }

    handleError(payload) {
      this.setState({
        connectionStatus: ROOM.CONNECTION_STATUS.ERROR,
        lastError: payload && payload.message ? payload.message : 'Room error.',
      });
    }

    startHeartbeat() {
      clearInterval(this.heartbeatId);
      this.heartbeatId = window.setInterval(() => {
        this.transport.send(ROOM.ROOM_EVENTS.HEARTBEAT, {
          roomCode: this.state.roomCode,
        });
      }, 5000);
    }

    toggleReady(isReady) {
      this.transport.send(ROOM.ROOM_EVENTS.PLAYER_READY, {
        roomCode: this.state.roomCode,
        isReady,
      });
    }

    updateSettings(settings) {
      this.transport.send(ROOM.ROOM_EVENTS.UPDATE_SETTINGS, {
        roomCode: this.state.roomCode,
        settings: ROOM.normalizeRoomSettings(settings),
      });
    }

    updatePlayerName(playerName) {
      this.session.playerName = playerName;
      this.transport.send(ROOM.ROOM_EVENTS.JOIN_ROOM, {
        gameId: this.session.gameId,
        mode: this.session.mode,
        maxPlayers: this.session.maxPlayers,
        roomCode: this.session.roomCode,
        playerName: this.session.playerName,
      });
    }

    startGame() {
      this.transport.send(ROOM.ROOM_EVENTS.START_GAME, {
        roomCode: this.state.roomCode,
      });
    }

    sendGameAction(type, payload) {
      this.transport.send(ROOM.ROOM_EVENTS.GAME_ACTION, {
        roomCode: this.state.roomCode,
        type,
        payload,
      });
    }

    requestSync() {
      this.transport.send(ROOM.ROOM_EVENTS.SYNC_REQUEST, {
        roomCode: this.state.roomCode,
      });
    }

    async disconnect() {
      clearInterval(this.heartbeatId);
      await this.transport.disconnect();
      this.setState({
        connectionStatus: ROOM.CONNECTION_STATUS.DISCONNECTED,
      });
    }
  }

  window.BattleshipRoomClient = {
    RoomClient,
  };
})();
