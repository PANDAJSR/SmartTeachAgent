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
  const ttsMediaSourceRef = useRef<MediaSource | null>(null);
  const ttsSourceBufferRef = useRef<SourceBuffer | null>(null);
  const ttsChunkQueueRef = useRef<Uint8Array[]>([]);
  const ttsStreamDoneRef = useRef<boolean>(false);
  const ttsRequestIdRef = useRef<string | null>(null);

  const decodeBase64ToUint8Array = (encoded: string): Uint8Array => {
    const binary = window.atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  };

  const tryFinalizeTtsStream = (): void => {
    const mediaSource = ttsMediaSourceRef.current;
    const sourceBuffer = ttsSourceBufferRef.current;
    if (!mediaSource || !sourceBuffer) {
      return;
    }
    if (!ttsStreamDoneRef.current) {
      return;
    }
    if (ttsChunkQueueRef.current.length > 0 || sourceBuffer.updating) {
      return;
    }
    if (mediaSource.readyState === "open") {
      try {
        mediaSource.endOfStream();
      } catch {
        // ignore end-of-stream errors
      }
    }
  };

  const pumpTtsQueue = (): void => {
    const sourceBuffer = ttsSourceBufferRef.current;
    if (!sourceBuffer || sourceBuffer.updating) {
      return;
    }
    const nextChunk = ttsChunkQueueRef.current.shift();
    if (!nextChunk) {
      tryFinalizeTtsStream();
      return;
    }
    try {
      const chunkBuffer =
        nextChunk.buffer instanceof ArrayBuffer
          ? nextChunk.buffer.slice(nextChunk.byteOffset, nextChunk.byteOffset + nextChunk.byteLength)
          : nextChunk.slice().buffer;
      sourceBuffer.appendBuffer(chunkBuffer);
    } catch (error) {
      setTtsError(error instanceof Error ? error.message : "音频分片写入失败");
      stopTtsPlayback();
    }
  };

  const pushTtsChunk = (chunk: Uint8Array): void => {
    if (!chunk.length) {
      return;
    }
    ttsChunkQueueRef.current.push(chunk);
    pumpTtsQueue();
  };

  const resetTtsAudioSource = (): void => {
    ttsStreamDoneRef.current = true;
    ttsChunkQueueRef.current = [];
    ttsSourceBufferRef.current = null;
    ttsMediaSourceRef.current = null;
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
    setTtsPlaying(false);
    resetTtsAudioSource();
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
      ttsRequestIdRef.current = requestId;
      ttsChunkQueueRef.current = [];
      ttsStreamDoneRef.current = false;

      const mediaSource = new MediaSource();
      ttsMediaSourceRef.current = mediaSource;
      const objectUrl = URL.createObjectURL(mediaSource);
      ttsAudioUrlRef.current = objectUrl;
      const audio = new Audio(objectUrl);
      ttsAudioRef.current = audio;

      await new Promise<void>((resolve, reject) => {
        mediaSource.addEventListener(
          "sourceopen",
          () => {
            try {
              const sourceBuffer = mediaSource.addSourceBuffer("audio/mpeg");
              sourceBuffer.mode = "sequence";
              sourceBuffer.addEventListener("updateend", () => pumpTtsQueue());
              sourceBuffer.addEventListener("error", () => {
                setTtsError("音频流缓冲失败");
                stopTtsPlayback();
              });
              ttsSourceBufferRef.current = sourceBuffer;
              resolve();
            } catch (error) {
              reject(error);
            }
          },
          { once: true }
        );
      });

      audio.onended = () => {
        setTtsPlaying(false);
        ttsRequestIdRef.current = null;
        resetTtsAudioSource();
      };
      audio.onerror = () => {
        setTtsPlaying(false);
        ttsRequestIdRef.current = null;
        setTtsError("音频播放失败，请重试");
        resetTtsAudioSource();
      };
      setTtsPlaying(true);
      const playPromise = audio.play();
      void playPromise.catch((error) => {
        if (ttsRequestIdRef.current !== requestId) {
          return;
        }
        setTtsPlaying(false);
        ttsRequestIdRef.current = null;
        setTtsError(error instanceof Error ? error.message : "音频播放失败，请重试");
        resetTtsAudioSource();
      });

      const synthesizeSpeechStream = window.smartTeach?.synthesizeSpeechStream;
      if (synthesizeSpeechStream) {
        let firstChunkReceived = false;
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
              if (!firstChunkReceived) {
                firstChunkReceived = true;
                setTtsGenerating(false);
              }
              pushTtsChunk(decodeBase64ToUint8Array(event.chunkBase64));
              return;
            }
            if (event.type === "done" || event.type === "stopped") {
              setTtsGenerating(false);
              ttsStreamDoneRef.current = true;
              pumpTtsQueue();
              return;
            }
            if (event.type === "error") {
              setTtsGenerating(false);
              setTtsError(event.error || "语音流生成失败");
              stopTtsPlayback();
            }
          }
        );
        if (streamResult?.error) {
          throw new Error(streamResult.error);
        }
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
      setTtsGenerating(false);
      pushTtsChunk(decodeBase64ToUint8Array(ttsResult.audioBase64));
      ttsStreamDoneRef.current = true;
      pumpTtsQueue();
    } catch (error) {
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
