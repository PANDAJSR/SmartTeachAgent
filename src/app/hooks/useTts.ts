import { useRef, useState } from "react";
import { DEFAULT_EDGE_TTS_VOICE } from "../types";

type UseTtsResult = {
  ttsGenerating: boolean;
  ttsPlaying: boolean;
  ttsError: string;
  stopTtsPlayback: () => void;
  playTtsText: (text: string) => Promise<void>;
  cleanupTts: () => void;
};

export function useTts(): UseTtsResult {
  const [ttsGenerating, setTtsGenerating] = useState<boolean>(false);
  const [ttsPlaying, setTtsPlaying] = useState<boolean>(false);
  const [ttsError, setTtsError] = useState<string>("");
  const ttsAudioRef = useRef<HTMLAudioElement | null>(null);
  const ttsAudioUrlRef = useRef<string | null>(null);
  const ttsRequestIdRef = useRef<string | null>(null);

  const decodeBase64ToUint8Array = (encoded: string): Uint8Array => {
    const binary = window.atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  };

  const mergeChunks = (chunks: Uint8Array[]): Uint8Array => {
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    return merged;
  };

  const ensureAudioElement = (): HTMLAudioElement => {
    const existing = ttsAudioRef.current;
    if (existing) {
      return existing;
    }
    const audio = document.createElement("audio");
    audio.preload = "auto";
    audio.style.display = "none";
    document.body.appendChild(audio);
    ttsAudioRef.current = audio;
    return audio;
  };

  const resetTtsAudioSource = (): void => {
    const previousUrl = ttsAudioUrlRef.current;
    if (previousUrl) {
      URL.revokeObjectURL(previousUrl);
      ttsAudioUrlRef.current = null;
    }
    const audio = ttsAudioRef.current;
    if (audio) {
      audio.onended = null;
      audio.onerror = null;
      audio.src = "";
      if (audio.parentElement) {
        audio.parentElement.removeChild(audio);
      }
      ttsAudioRef.current = null;
    }
  };

  const stopTtsPlayback = (): void => {
    const requestId = ttsRequestIdRef.current;
    if (requestId && window.smartTeach?.stopSpeech) {
      void window.smartTeach.stopSpeech(requestId);
    }
    ttsRequestIdRef.current = null;
    const audio = ttsAudioRef.current;
    if (audio) {
      audio.pause();
      audio.currentTime = 0;
    }
    setTtsGenerating(false);
    setTtsPlaying(false);
    resetTtsAudioSource();
  };

  const playChunksAsMp3 = async (chunks: Uint8Array[], requestId: string): Promise<void> => {
    const merged = mergeChunks(chunks);
    if (!merged.length) {
      throw new Error("未收到可播放的音频数据");
    }
    console.info(`[TTS][${requestId}] 开始播放音频，chunkCount=${chunks.length}, totalBytes=${merged.length}`);

    const arrayBuffer = new ArrayBuffer(merged.byteLength);
    new Uint8Array(arrayBuffer).set(merged);
    const blob = new Blob([arrayBuffer], { type: "audio/mpeg" });
    const objectUrl = URL.createObjectURL(blob);
    ttsAudioUrlRef.current = objectUrl;

    const audio = ensureAudioElement();
    audio.onloadedmetadata = () => {
      console.info(`[TTS][${requestId}] loadedmetadata，duration=${audio.duration}`);
    };
    audio.oncanplay = () => {
      console.info(`[TTS][${requestId}] canplay，readyState=${audio.readyState}`);
    };
    audio.onplaying = () => {
      console.info(`[TTS][${requestId}] playing`);
    };
    audio.onpause = () => {
      console.info(`[TTS][${requestId}] pause`);
    };
    audio.onended = () => {
      console.info(`[TTS][${requestId}] ended`);
      setTtsPlaying(false);
      if (ttsRequestIdRef.current === requestId) {
        ttsRequestIdRef.current = null;
      }
      resetTtsAudioSource();
    };
    audio.onerror = () => {
      console.error(
        `[TTS][${requestId}] audio error，errorCode=${audio.error?.code || "unknown"}，readyState=${audio.readyState}，networkState=${audio.networkState}`
      );
      setTtsPlaying(false);
      if (ttsRequestIdRef.current === requestId) {
        ttsRequestIdRef.current = null;
      }
      setTtsError("音频播放失败，请重试");
      resetTtsAudioSource();
    };

    audio.src = objectUrl;
    audio.load();
    setTtsPlaying(true);
    await audio.play();
    console.info(`[TTS][${requestId}] play() resolved`);
  };

  const playTtsText = async (text: string): Promise<void> => {
    const clean = text.trim();
    if (!clean || ttsGenerating) {
      return;
    }

    setTtsError("");
    stopTtsPlayback();
    setTtsGenerating(true);

    try {
      const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      console.info(`[TTS][${requestId}] 开始朗读，textLength=${clean.length}`);
      ttsRequestIdRef.current = requestId;

      const synthesizeSpeechStream = window.smartTeach?.synthesizeSpeechStream;
      if (synthesizeSpeechStream) {
        const streamChunks: Uint8Array[] = [];
        let firstChunkReceived = false;
        let streamStopped = false;
        console.info(`[TTS][${requestId}] 使用流式合成`);

        const streamResult = await synthesizeSpeechStream(
          {
            text: clean,
            requestId,
            voice: DEFAULT_EDGE_TTS_VOICE,
          },
          (event) => {
            if (ttsRequestIdRef.current !== requestId) {
              return;
            }
            if (event.type === "chunk") {
              const chunk = decodeBase64ToUint8Array(event.chunkBase64);
              if (chunk.length) {
                streamChunks.push(chunk);
                if (!firstChunkReceived) {
                  firstChunkReceived = true;
                  console.info(`[TTS][${requestId}] 收到首个音频分片`);
                  setTtsGenerating(false);
                }
              }
              return;
            }
            if (event.type === "done" || event.type === "stopped") {
              console.info(`[TTS][${requestId}] 流结束，type=${event.type}`);
              if (event.type === "stopped") {
                streamStopped = true;
              }
              setTtsGenerating(false);
              return;
            }
            if (event.type === "error") {
              console.error(`[TTS][${requestId}] 流错误: ${event.error || "语音流生成失败"}`);
              setTtsGenerating(false);
              setTtsError(event.error || "语音流生成失败");
              stopTtsPlayback();
            }
          }
        );

        if (streamResult?.error) {
          console.error(`[TTS][${requestId}] 流请求返回错误: ${streamResult.error}`);
          throw new Error(streamResult.error);
        }
        if (ttsRequestIdRef.current !== requestId) {
          return;
        }

        console.info(`[TTS][${requestId}] 流式合成完成，chunkCount=${streamChunks.length}`);
        setTtsGenerating(false);
        if (!streamChunks.length) {
          const synthesizeSpeech = window.smartTeach?.synthesizeSpeech;
          if (!synthesizeSpeech) {
            throw new Error("流式未返回音频分片，且当前环境不支持非流式兜底");
          }
          console.warn(
            `[TTS][${requestId}] 流式未收到音频分片，自动回退非流式，stopped=${streamStopped}`
          );
          const fallbackResult = await synthesizeSpeech({ text: clean, voice: DEFAULT_EDGE_TTS_VOICE });
          if (!fallbackResult.ok) {
            throw new Error(fallbackResult.error || "语音合成失败");
          }
          await playChunksAsMp3([decodeBase64ToUint8Array(fallbackResult.audioBase64)], requestId);
          return;
        }
        await playChunksAsMp3(streamChunks, requestId);
        return;
      }

      const synthesizeSpeech = window.smartTeach?.synthesizeSpeech;
      if (!synthesizeSpeech) {
        throw new Error("当前模式不支持 Edge TTS，请在 Electron 客户端中使用。");
      }

      const ttsResult = await synthesizeSpeech({ text: clean, voice: DEFAULT_EDGE_TTS_VOICE });
      if (!ttsResult.ok) {
        throw new Error(ttsResult.error || "语音合成失败");
      }

      console.info(`[TTS][${requestId}] 使用非流式合成成功`);
      setTtsGenerating(false);
      await playChunksAsMp3([decodeBase64ToUint8Array(ttsResult.audioBase64)], requestId);
    } catch (error) {
      console.error("[TTS] 朗读失败", error);
      setTtsPlaying(false);
      ttsRequestIdRef.current = null;
      resetTtsAudioSource();
      setTtsError(error instanceof Error ? error.message : "语音合成失败");
    } finally {
      setTtsGenerating(false);
    }
  };

  const cleanupTts = (): void => {
    stopTtsPlayback();
  };

  return {
    ttsGenerating,
    ttsPlaying,
    ttsError,
    stopTtsPlayback,
    playTtsText,
    cleanupTts,
  };
}
