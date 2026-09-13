export default async function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    response.status(405).json({ error: "Method not allowed" });
    return;
  }

  const authorization = request.headers.authorization || "";
  const { text, model = "speech-2.8-turbo", voiceId, speed = 1 } = request.body || {};
  const normalizedText = String(text || "").trim();
  const normalizedVoiceId = String(voiceId || "").trim();

  if (!authorization.startsWith("Bearer ") || !normalizedText || !normalizedVoiceId) {
    response.status(400).json({ error: "Missing MiniMax key, text, or voice_id" });
    return;
  }

  try {
    const requestOptions = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authorization,
      },
      body: JSON.stringify({
        model: String(model || "speech-2.8-turbo").trim(),
        text: normalizedText.slice(0, 220),
        stream: false,
        language_boost: "auto",
        output_format: "hex",
        voice_setting: {
          voice_id: normalizedVoiceId,
          speed: normalizeSpeed(speed),
          vol: 1,
          pitch: 0,
        },
        audio_setting: {
          sample_rate: 32000,
          bitrate: 128000,
          format: "mp3",
          channel: 1,
        },
      }),
    };
    const upstream = await fetchWithTransientRetry("https://api.minimaxi.com/v1/t2a_v2", requestOptions);

    const data = await upstream.json().catch(() => ({}));
    const statusCode = Number(data?.base_resp?.status_code || 0);
    if (!upstream.ok || statusCode !== 0) {
      response.status(upstream.ok ? 502 : upstream.status).json({ error: formatMiniMaxError(data) });
      return;
    }

    const audioHex = String(data?.data?.audio || "");
    if (!audioHex) {
      response.status(502).json({ error: "MiniMax 没有返回音频。" });
      return;
    }

    response.status(200).json({
      audio: `data:audio/mp3;base64,${Buffer.from(audioHex, "hex").toString("base64")}`,
      duration: normalizeDuration(data?.extra_info?.audio_length),
      usageCharacters: Number(data?.extra_info?.usage_characters || normalizedText.length),
    });
  } catch (error) {
    response.status(502).json({ error: error?.message || "TTS request failed" });
  }
}

async function fetchWithTransientRetry(url, options) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const result = await fetch(url, options);
      if (attempt === 0 && (result.status === 408 || result.status === 425 || result.status === 429 || result.status >= 500)) {
        await wait(700);
        continue;
      }
      return result;
    } catch (error) {
      lastError = error;
      if (attempt === 0) {
        await wait(700);
        continue;
      }
    }
  }
  throw lastError || new Error("MiniMax 语音请求失败。");
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function normalizeSpeed(value) {
  const speed = Number(value || 1);
  if (!Number.isFinite(speed)) return 1;
  return Math.min(2, Math.max(0.5, speed));
}

function normalizeDuration(value) {
  const duration = Number(value || 0);
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  return Math.max(1, Math.round(duration / 1000));
}

function formatMiniMaxError(data) {
  if (!data || typeof data !== "object") return "MiniMax 语音请求失败。";
  const message = data?.base_resp?.status_msg || data?.message || data?.error;
  const code = data?.base_resp?.status_code;
  return [message, code ? `code ${code}` : ""].filter(Boolean).join("，") || JSON.stringify(data);
}
