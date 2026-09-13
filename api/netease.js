const NETEASE_BASE_URL = "https://music.163.com";
const MAX_SEARCH_RESULTS = 10;
const MAX_PLAYLIST_RESULTS = 50;
const MAX_TRACK_RESULTS = 50;

export default async function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    response.status(405).json({ error: "Method not allowed" });
    return;
  }

  const { musicU, csrf, aiMusicU, aiCsrf, action, args = {} } = request.body || {};
  const cookie = buildCookie(musicU, csrf);
  const aiCookie = buildCookie(aiMusicU, aiCsrf);
  const cleanAction = String(action || "").trim();
  const isTogetherAction = cleanAction === "create_listen_together" || cleanAction === "listen_together_heartbeat";
  if (isTogetherAction ? !aiCookie : !cookie) {
    response.status(400).json({
      error: isTogetherAction ? "还没填写一起听账号 MUSIC_U。" : "还没填写网易云 MUSIC_U。",
    });
    return;
  }

  try {
    const result = await runAction(cleanAction, args, cookie, csrf, aiCookie, aiCsrf);
    response.status(200).json(result);
  } catch (error) {
    response.status(502).json({ error: error?.message || "网易云音乐请求失败。" });
  }
}

async function runAction(action, args, cookie, csrf, aiCookie, aiCsrf) {
  switch (action) {
    case "search_songs": {
      const songs = await searchSongs(cookie, args.query, args.limit);
      return { action, summary: `找到了 ${songs.length} 首歌`, songs };
    }
    case "list_playlists": {
      const playlists = await listPlaylists(cookie);
      return { action, summary: `读取了 ${playlists.length} 个歌单`, playlists };
    }
    case "get_playlist_songs": {
      const playlist = await resolvePlaylist(cookie, args.playlist);
      const detail = await getPlaylistSongs(cookie, playlist.id);
      return { action, summary: `读取了歌单《${detail.name || playlist.name}》`, playlist: detail };
    }
    case "get_play_history": {
      const records = await getPlayHistory(cookie, args.limit, args.all_time);
      return { action, summary: `读取了 ${records.length} 条听歌记录`, records };
    }
    case "daily_recommend": {
      const songs = await getDailyRecommend(cookie, csrf);
      return { action, summary: `读取了今日 ${songs.length} 首推荐`, songs };
    }
    case "create_playlist": {
      requireCsrf(csrf);
      const requestedName = String(args.name || "").trim();
      if (!requestedName) throw new Error("还没有填写歌单名称。" );
      const existingPlaylists = await listPlaylists(cookie);
      const existingPlaylist = existingPlaylists.find((playlist) => normalizeName(playlist.name) === normalizeName(requestedName));
      if (existingPlaylist) {
        return {
          action,
          summary: `歌单《${existingPlaylist.name}》已经存在，没有重复创建`,
          playlist: existingPlaylist,
          created: false,
          alreadyExisted: true,
        };
      }
      const playlist = await createPlaylist(cookie, csrf, args.name, args.description, args.privacy);
      return { action, summary: `创建了歌单《${playlist.name}》`, playlist, created: true, alreadyExisted: false };
    }
    case "add_song_to_playlist": {
      requireCsrf(csrf);
      const playlist = await resolvePlaylist(cookie, args.playlist);
      const song = await resolveSong(cookie, args.song);
      const playlistDetail = await getPlaylistSongs(cookie, playlist.id);
      if (playlistDetail.songs.some((item) => Number(item.id) === Number(song.id))) {
        return {
          action,
          summary: `《${song.name}》已经在《${playlist.name}》里，没有重复添加`,
          playlist,
          song,
          added: false,
          alreadyExisted: true,
        };
      }
      await manipulatePlaylist(cookie, csrf, playlist.id, song.id, "add");
      return { action, summary: `已把《${song.name}》加入《${playlist.name}》`, playlist, song, added: true, alreadyExisted: false };
    }
    case "remove_song_from_playlist": {
      requireCsrf(csrf);
      const playlist = await resolvePlaylist(cookie, args.playlist);
      const song = await resolveSong(cookie, args.song);
      await manipulatePlaylist(cookie, csrf, playlist.id, song.id, "del");
      return { action, summary: `已从《${playlist.name}》移除《${song.name}》`, playlist, song };
    }
    case "like_song": {
      requireCsrf(csrf);
      const song = await resolveSong(cookie, args.song);
      const liked = args.like !== false;
      await setSongLike(cookie, csrf, song.id, liked);
      return { action, summary: `${liked ? "已红心" : "已取消红心"}《${song.name}》`, song, liked };
    }
    case "create_listen_together": {
      const room = await createListenTogetherRoom({
        userCookie: cookie,
        userCsrf: csrf,
        aiCookie,
        aiCsrf,
        songReference: args.song,
      });
      const playing = room.songName ? `，播放《${room.songName}》` : "";
      return { action, summary: `创建了一起听房间${playing}`, room };
    }
    case "listen_together_heartbeat": {
      await sendListenTogetherHeartbeat(aiCookie, args);
      return { action, summary: "一起听房间在线" };
    }
    default:
      throw new Error("AI 没有给出可用的网易云操作。" );
  }
}

async function createListenTogetherRoom({ userCookie, userCsrf, aiCookie, songReference }) {
  const inviterId = await getUserId(aiCookie);
  const song = await chooseListenTogetherSong(userCookie || aiCookie, userCsrf, songReference);
  const data = await neteaseFetch(aiCookie, "/api/listen/together/room/create", {
    method: "POST",
    body: { refer: "songplay_more" },
  });
  const roomInfo = data?.data?.roomInfo || data?.roomInfo || {};
  const roomId = String(roomInfo.roomId || "").trim();
  if (!roomId) throw new Error("网易云没有返回一起听房间号。" );

  await neteaseFetch(aiCookie, "/api/listen/together/room/check", {
    method: "POST",
    body: { roomId },
  }).catch(() => null);

  if (song?.id) {
    const songId = String(song.id);
    await neteaseFetch(aiCookie, "/api/listen/together/sync/list/command/report", {
      method: "POST",
      body: {
        roomId,
        playlistParam: JSON.stringify({
          commandType: "REPLACE",
          version: [{ userId: String(inviterId), version: 1 }],
          anchorSongId: "",
          anchorPosition: -1,
          randomList: [songId],
          displayList: [songId],
        }),
      },
    });
    await neteaseFetch(aiCookie, "/api/listen/together/play/command/report", {
      method: "POST",
      body: {
        roomId,
        commandInfo: JSON.stringify({
          commandType: "GOTO",
          progress: 0,
          playStatus: "PLAY",
          formerSongId: "-1",
          targetSongId: songId,
          clientSeq: 1,
        }),
      },
    });
  }

  const songId = song?.id ? String(song.id) : "";
  const shareUrl = new URL("https://st.music.163.com/listen-together/share/");
  if (songId) shareUrl.searchParams.set("songId", songId);
  shareUrl.searchParams.set("roomId", roomId);
  shareUrl.searchParams.set("inviterId", String(inviterId));
  return {
    roomId,
    inviterId: String(inviterId),
    songId,
    songName: String(song?.name || ""),
    shareUrl: shareUrl.toString(),
    createdAt: Date.now(),
  };
}

async function chooseListenTogetherSong(cookie, csrf, songReference) {
  const requestedSong = String(songReference || "").trim();
  if (requestedSong) return resolveSong(cookie, requestedSong);
  try {
    const recommendations = await getDailyRecommend(cookie, csrf);
    if (recommendations.length) return recommendations[0];
  } catch {
    // Fall back to recent listening when daily recommendations are unavailable.
  }
  try {
    const history = await getPlayHistory(cookie, 1, false);
    if (history.length) return history[0];
  } catch {
    // A room can still be created before a song is selected.
  }
  return null;
}

async function sendListenTogetherHeartbeat(cookie, args = {}) {
  const roomId = String(args.roomId || "").trim();
  if (!roomId) throw new Error("没有可维持的一起听房间。" );
  await neteaseFetch(cookie, "/api/listen/together/heartbeat", {
    method: "POST",
    body: {
      roomId,
      songId: String(args.songId || ""),
      playStatus: String(args.playStatus || "PLAY"),
      progress: String(Math.max(0, Number(args.progress || 0))),
    },
  });
}

function buildCookie(musicU, csrf) {
  const cleanMusicU = cleanCookieValue(musicU, "MUSIC_U");
  const cleanCsrf = cleanCookieValue(csrf, "__csrf");
  if (!cleanMusicU) return "";
  return `MUSIC_U=${cleanMusicU}${cleanCsrf ? `; __csrf=${cleanCsrf}` : ""}`;
}

function cleanCookieValue(value, key) {
  return String(value || "")
    .trim()
    .replace(new RegExp(`^${key}=`, "i"), "")
    .split(";")[0]
    .trim();
}

function requireCsrf(csrf) {
  if (!cleanCookieValue(csrf, "__csrf")) {
    throw new Error("这个操作需要先填写网易云 __csrf。" );
  }
}

async function neteaseFetch(cookie, path, { method = "GET", body } = {}) {
  const headers = {
    "User-Agent": "Mozilla/5.0",
    Referer: `${NETEASE_BASE_URL}/`,
    Cookie: cookie,
  };
  let requestBody;
  if (body !== undefined) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    requestBody = new URLSearchParams(body).toString();
  }
  const upstream = await fetch(`${NETEASE_BASE_URL}${path}`, {
    method,
    headers,
    body: requestBody,
    signal: AbortSignal.timeout(12000),
  });
  const text = await upstream.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`网易云返回了无法识别的内容（${upstream.status}）。`);
  }
  if (!upstream.ok || Number(data?.code || 200) >= 400) {
    throw new Error(data?.message || data?.msg || `网易云接口请求失败：${upstream.status}`);
  }
  return data;
}

async function getUserId(cookie) {
  const data = await neteaseFetch(cookie, "/api/nuser/account/get");
  const userId = data?.profile?.userId || data?.account?.id;
  if (!userId) throw new Error("没有读取到网易云账号，MUSIC_U 可能已经过期。" );
  return userId;
}

async function searchSongs(cookie, query, requestedLimit = 8) {
  const cleanQuery = String(query || "").trim();
  if (!cleanQuery) throw new Error("还没有要搜索的歌曲。" );
  const limit = clampNumber(requestedLimit, 1, MAX_SEARCH_RESULTS, 8);
  const params = new URLSearchParams({ s: cleanQuery, type: "1", limit: String(limit) });
  const data = await neteaseFetch(cookie, `/api/search/get?${params.toString()}`);
  const songs = Array.isArray(data?.result?.songs) ? data.result.songs : [];
  return songs.slice(0, limit).map(normalizeSong);
}

async function resolveSong(cookie, reference) {
  const value = String(reference || "").trim();
  if (!value) throw new Error("还没有指定歌曲。" );
  if (/^\d+$/.test(value)) return { id: Number(value), name: `歌曲 ${value}`, artists: [] };
  const songs = await searchSongs(cookie, value, 5);
  if (!songs.length) throw new Error(`没有找到歌曲“${value}”。`);
  return songs[0];
}

async function listPlaylists(cookie) {
  const userId = await getUserId(cookie);
  const params = new URLSearchParams({ uid: String(userId), limit: String(MAX_PLAYLIST_RESULTS), offset: "0" });
  const data = await neteaseFetch(cookie, `/api/user/playlist?${params.toString()}`);
  const playlists = Array.isArray(data?.playlist) ? data.playlist : [];
  return playlists.slice(0, MAX_PLAYLIST_RESULTS).map((playlist) => ({
    id: playlist.id,
    name: String(playlist.name || "未命名歌单"),
    trackCount: Number(playlist.trackCount || 0),
    owned: Number(playlist?.creator?.userId) === Number(userId),
  }));
}

async function resolvePlaylist(cookie, reference) {
  const value = String(reference || "").trim();
  if (!value) throw new Error("还没有指定歌单。" );
  const playlists = await listPlaylists(cookie);
  if (/^\d+$/.test(value)) {
    return playlists.find((playlist) => Number(playlist.id) === Number(value)) || { id: Number(value), name: `歌单 ${value}` };
  }
  const normalized = normalizeName(value);
  const exact = playlists.find((playlist) => normalizeName(playlist.name) === normalized);
  if (exact) return exact;
  const fuzzy = playlists.find((playlist) => normalizeName(playlist.name).includes(normalized) || normalized.includes(normalizeName(playlist.name)));
  if (fuzzy) return fuzzy;
  throw new Error(`没有找到歌单“${value}”。`);
}

async function getPlaylistSongs(cookie, playlistId) {
  const data = await neteaseFetch(cookie, `/api/v6/playlist/detail?id=${encodeURIComponent(playlistId)}`);
  const playlist = data?.playlist || {};
  let tracks = Array.isArray(playlist.tracks) ? playlist.tracks : [];
  if (!tracks.length && Array.isArray(playlist.trackIds) && playlist.trackIds.length) {
    const ids = playlist.trackIds.slice(0, MAX_TRACK_RESULTS).map((track) => track.id);
    const detail = await neteaseFetch(cookie, `/api/song/detail?ids=${encodeURIComponent(JSON.stringify(ids))}`);
    tracks = Array.isArray(detail?.songs) ? detail.songs : [];
  }
  return {
    id: playlist.id || Number(playlistId),
    name: String(playlist.name || "未命名歌单"),
    songs: tracks.slice(0, MAX_TRACK_RESULTS).map(normalizeSong),
  };
}

async function getPlayHistory(cookie, requestedLimit = 20, allTime = false) {
  const userId = await getUserId(cookie);
  const limit = clampNumber(requestedLimit, 1, 30, 20);
  const params = new URLSearchParams({ uid: String(userId), type: allTime ? "0" : "1", limit: String(limit) });
  const data = await neteaseFetch(cookie, `/api/v1/play/record?${params.toString()}`);
  const records = data?.weekData || data?.allData || [];
  return (Array.isArray(records) ? records : []).slice(0, limit).map((record) => ({
    ...normalizeSong(record.song || {}),
    playCount: Number(record.playCount ?? record.score ?? 0),
  }));
}

async function getDailyRecommend(cookie, csrf) {
  const cleanCsrf = cleanCookieValue(csrf, "__csrf");
  const data = await neteaseFetch(
    cookie,
    `/api/v3/discovery/recommend/songs?csrf_token=${encodeURIComponent(cleanCsrf)}`,
    { method: "POST", body: {} },
  );
  const songs = Array.isArray(data?.data?.dailySongs) ? data.data.dailySongs : [];
  return songs.slice(0, 30).map((song) => ({
    ...normalizeSong(song),
    reason: String(song.reason || ""),
  }));
}

async function createPlaylist(cookie, csrf, name, description = "", privacy = 0) {
  const cleanName = String(name || "").trim();
  if (!cleanName) throw new Error("还没有填写歌单名称。" );
  const cleanCsrf = cleanCookieValue(csrf, "__csrf");
  const data = await neteaseFetch(cookie, `/api/playlist/create?csrf_token=${encodeURIComponent(cleanCsrf)}`, {
    method: "POST",
    body: {
      name: cleanName,
      privacy: Number(privacy) === 10 ? "10" : "0",
      type: "NORMAL",
      ...(String(description || "").trim() ? { description: String(description).trim() } : {}),
    },
  });
  return {
    id: data?.playlist?.id,
    name: String(data?.playlist?.name || cleanName),
  };
}

async function manipulatePlaylist(cookie, csrf, playlistId, songId, operation) {
  const cleanCsrf = cleanCookieValue(csrf, "__csrf");
  await neteaseFetch(cookie, `/api/playlist/manipulate/tracks?csrf_token=${encodeURIComponent(cleanCsrf)}`, {
    method: "POST",
    body: {
      op: operation,
      pid: String(playlistId),
      trackIds: JSON.stringify([Number(songId)]),
    },
  });
}

async function setSongLike(cookie, csrf, songId, like) {
  const cleanCsrf = cleanCookieValue(csrf, "__csrf");
  const params = new URLSearchParams({
    alg: "itembased",
    trackId: String(songId),
    like: like ? "true" : "false",
    time: "25",
    csrf_token: cleanCsrf,
  });
  await neteaseFetch(cookie, `/api/radio/like?${params.toString()}`);
}

function normalizeSong(song = {}) {
  const artists = song.ar || song.artists || [];
  const album = song.al || song.album || {};
  return {
    id: song.id,
    name: String(song.name || "未知歌曲"),
    artists: (Array.isArray(artists) ? artists : []).map((artist) => String(artist?.name || "")).filter(Boolean),
    album: String(album?.name || ""),
  };
}

function normalizeName(value = "") {
  return String(value)
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[《》<>「」『』【】[\]()（）'"“”‘’]/g, "")
    .trim();
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}
