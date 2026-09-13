export default async function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    response.status(405).json({ error: "Method not allowed" });
    return;
  }

  const authorization = request.headers.authorization || "";
  const { audioDataUrl, filename = "voice-clone.m4a", mimeType = "", fileId, voiceId } = request.body || {};
  const normalizedVoiceId = String(voiceId || "").trim();
  const normalizedFileId = Number(fileId || 0);

  if (!authorization.startsWith("Bearer ") || (!audioDataUrl && !normalizedFileId) || !normalizedVoiceId) {
    response.status(400).json({ error: "Missing MiniMax key, audio file, or voice_id" });
    return;
  }
  if (!isValidVoiceId(normalizedVoiceId)) {
    response.status(400).json({ error: "Voice ID 需要英文开头，长度 8 到 256，只能包含字母、数字、-、_，结尾不能是 - 或 _。" });
    return;
  }

  try {
    let cloneFileId = normalizedFileId;
    if (!cloneFileId) {
      const { buffer, mediaType } = parseAudioDataUrl(audioDataUrl, mimeType);
      if (!isSupportedAudioType(mediaType, filename)) {
        response.status(400).json({ error: "音频格式只支持 mp3 / m4a / wav。" });
        return;
      }
      if (buffer.length > 3 * 1024 * 1024) {
        response.status(400).json({ error: "音频太大了，建议压到 3MB 以内。" });
        return;
      }

      const uploadData = await uploadCloneAudio({ authorization, buffer, filename, mediaType });
      cloneFileId = Number(uploadData?.file?.file_id || 0);
      if (!cloneFileId) {
        response.status(502).json({ error: "MiniMax 没有返回 file_id。" });
        return;
      }
    }

    const cloneData = await cloneVoice({ authorization, fileId: cloneFileId, voiceId: normalizedVoiceId });
    response.status(200).json({
      voiceId: normalizedVoiceId,
      fileId: cloneFileId,
      status: cloneData?.base_resp?.status_msg || "success",
    });
  } catch (error) {
    response.status(502).json({ error: error?.message || "Voice clone request failed" });
  }
}

async function uploadCloneAudio({ authorization, buffer, filename, mediaType }) {
  const form = new FormData();
  form.append("purpose", "voice_clone");
  form.append("file", new Blob([buffer], { type: mediaType }), filename || "voice-clone.m4a");

  const upstream = await fetch("https://api.minimaxi.com/v1/files/upload", {
    method: "POST",
    headers: {
      Authorization: authorization,
    },
    body: form,
  });
  const data = await readJsonResponse(upstream);
  assertMiniMaxSuccess(upstream, data, "上传音频失败");
  return data;
}

async function cloneVoice({ authorization, fileId, voiceId }) {
  const upstream = await fetch("https://api.minimaxi.com/v1/voice_clone", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: authorization,
    },
    body: JSON.stringify({
      file_id: fileId,
      voice_id: voiceId,
      need_noise_reduction: true,
      need_volume_normalization: true,
      aigc_watermark: false,
    }),
  });
  const data = await readJsonResponse(upstream);
  assertMiniMaxSuccess(upstream, data, "克隆声音失败");
  return data;
}

async function readJsonResponse(upstream) {
  const text = await upstream.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { error: text };
  }
}

function parseAudioDataUrl(value, fallbackType = "") {
  const source = String(value || "");
  const match = source.match(/^data:([^;,]+)?;base64,(.+)$/);
  if (!match) throw new Error("音频读取失败，请重新选择文件。");
  return {
    buffer: Buffer.from(match[2], "base64"),
    mediaType: match[1] || fallbackType || "audio/mp4",
  };
}

function isSupportedAudioType(mediaType, filename = "") {
  const type = String(mediaType || "").toLowerCase();
  const name = String(filename || "").toLowerCase();
  return (
    ["audio/mpeg", "audio/mp3", "audio/mp4", "audio/x-m4a", "audio/wav", "audio/wave", "audio/x-wav"].includes(type) ||
    /\.(mp3|m4a|wav)$/i.test(name)
  );
}

function isValidVoiceId(value = "") {
  const text = String(value || "").trim();
  return text.length >= 8 && text.length <= 256 && /^[A-Za-z][A-Za-z0-9_-]*[A-Za-z0-9]$/.test(text);
}

function assertMiniMaxSuccess(upstream, data, fallbackMessage) {
  const statusCode = Number(data?.base_resp?.status_code || 0);
  if (upstream.ok && statusCode === 0) return;
  throw new Error(formatMiniMaxError(data, fallbackMessage));
}

function formatMiniMaxError(data, fallbackMessage = "MiniMax 请求失败") {
  if (!data || typeof data !== "object") return fallbackMessage;
  const message = data?.base_resp?.status_msg || data?.message || data?.error || fallbackMessage;
  const code = data?.base_resp?.status_code;
  return [message, code ? `code ${code}` : ""].filter(Boolean).join("，");
}
