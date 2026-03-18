(function () {
  'use strict';

  const GAME_ID = 'battleship-bluff';
  const DEFAULT_PLAYER_NAME = 'Player';
  const MAX_NAME_LENGTH = 24;
  const ROOM_CODE_PATTERN = /[A-Z0-9]/g;
  const VALID_MODES = new Set(['local', 'host', 'join']);

  function sanitizePlayerName(raw, fallback = DEFAULT_PLAYER_NAME) {
    const clean = String(raw == null ? '' : raw)
      .replace(/[\u0000-\u001f\u007f]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_NAME_LENGTH);
    return clean || fallback;
  }

  function sanitizeRoomCode(raw) {
    const value = String(raw == null ? '' : raw).toUpperCase().match(ROOM_CODE_PATTERN);
    return value ? value.join('').slice(0, 12) : '';
  }

  function sanitizeWsUrl(raw) {
    const value = String(raw == null ? '' : raw).trim();
    if (!value) return { value: null, error: null };
    try {
      const parsed = new URL(value);
      if (!/^wss?:$/i.test(parsed.protocol)) {
        return { value: null, error: 'WebSocket URL must use ws:// or wss://.' };
      }
      return { value: parsed.toString(), error: null };
    } catch (_error) {
      return { value: null, error: 'WebSocket URL is invalid.' };
    }
  }

  function createSession(partial) {
    const mode = partial.mode || 'local';
    const roomCode = partial.roomCode || null;
    const wsUrl = partial.wsUrl || null;
    const validationErrors = Array.isArray(partial.validationErrors) ? partial.validationErrors.slice() : [];
    const isLocalPlay = mode === 'local';
    const isRoomPlay = mode === 'host' || mode === 'join';

    return {
      source: partial.source || 'direct',
      gameId: GAME_ID,
      mode,
      playerName: partial.playerName || DEFAULT_PLAYER_NAME,
      roomCode,
      wsUrl,
      isRoomPlay,
      isLocalPlay,
      isHost: mode === 'host',
      isGuest: mode === 'join',
      maxPlayers: 2,
      isValid: validationErrors.length === 0,
      validationErrors,
    };
  }

  function resolveSession(search) {
    const params = new URLSearchParams(typeof search === 'string' ? search : window.location.search);
    const errors = [];
    const source = params.get('hub') === '1' ? 'hub' : 'direct';

    const rawMode = String(params.get('mode') || '').trim().toLowerCase();
    const mode = rawMode ? rawMode : 'local';
    if (!VALID_MODES.has(mode)) {
      errors.push(`Unsupported mode "${rawMode || '(empty)'}".`);
    }

    const playerName = sanitizePlayerName(params.get('name'), DEFAULT_PLAYER_NAME);
    const roomCode = sanitizeRoomCode(params.get('room')) || null;
    const wsInfo = sanitizeWsUrl(params.get('ws'));

    if (wsInfo.error) errors.push(wsInfo.error);
    if ((mode === 'host' || mode === 'join') && !roomCode) {
      errors.push('Room mode requires a valid room code.');
    }
    if ((mode === 'host' || mode === 'join') && !String(params.get('name') || '').trim()) {
      errors.push('Room mode requires a player name.');
    }

    const normalizedMode = VALID_MODES.has(mode) ? mode : 'local';
    return createSession({
      source,
      mode: normalizedMode,
      playerName,
      roomCode,
      wsUrl: wsInfo.value,
      validationErrors: errors,
    });
  }

  function createLocalFallbackSession(baseSession, extraErrors) {
    const errors = []
      .concat(baseSession && Array.isArray(baseSession.validationErrors) ? baseSession.validationErrors : [])
      .concat(extraErrors || []);

    return createSession({
      source: baseSession && baseSession.source ? baseSession.source : 'direct',
      mode: 'local',
      playerName: sanitizePlayerName(baseSession && baseSession.playerName, DEFAULT_PLAYER_NAME),
      roomCode: null,
      wsUrl: null,
      validationErrors: errors.filter(Boolean),
    });
  }

  window.BattleshipSession = {
    GAME_ID,
    MAX_NAME_LENGTH,
    sanitizePlayerName,
    sanitizeRoomCode,
    sanitizeWsUrl,
    resolveSession,
    createLocalFallbackSession,
  };
})();
