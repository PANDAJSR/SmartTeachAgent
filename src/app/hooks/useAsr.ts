import { useMemo, useRef, useState } from "react";
import {
  ASR_MODEL_OPTIONS,
  DEFAULT_ASR_MODEL_ID,
  type AsrPipeline,
  type ChineseConverter,
} from "../types";

type UseAsrResult = {
  asrModelId: string;
  asrPreloading: boolean;
  asrReadyMap: Record<string, boolean>;
  recording: boolean;
  transcribing: boolean;
  asrError: string;
  asrModelLabel: string;
  setAsrModelId: (value: string) => void;
  toggleRecording: () => void;
  preloadAsrModel: () => Promise<void>;
  stopRecording: () => void;
  cleanupAsr: () => void;
};

type UseAsrPayload = {
  loading: boolean;
  appendTranscript: (text: string) => void;
};

export function useAsr(payload: UseAsrPayload): UseAsrResult {
  const [recording, setRecording] = useState<boolean>(false);
  const [transcribing, setTranscribing] = useState<boolean>(false);
  const [asrError, setAsrError] = useState<string>("");
  const [asrModelId, setAsrModelId] = useState<string>(DEFAULT_ASR_MODEL_ID);
  const [asrPreloading, setAsrPreloading] = useState<boolean>(false);
  const [asrReadyMap, setAsrReadyMap] = useState<Record<string, boolean>>({});
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const asrPipelineRef = useRef<{ modelId: string; pipeline: AsrPipeline } | null>(null);
  const asrPipelineLoadingRef = useRef<Promise<AsrPipeline> | null>(null);
  const zhSimplifierRef = useRef<ChineseConverter | null>(null);
  const zhSimplifierLoadingRef = useRef<Promise<ChineseConverter> | null>(null);

  const ensureAsrPipeline = async (modelId: string): Promise<AsrPipeline> => {
    if (asrPipelineRef.current?.modelId === modelId) {
      return asrPipelineRef.current.pipeline;
    }
    if (asrPipelineLoadingRef.current) {
      return asrPipelineLoadingRef.current;
    }
    const loadingTask = (async () => {
      const { env, pipeline } = await import("@huggingface/transformers");
      env.allowLocalModels = false;
      const createPipeline = pipeline as (...args: unknown[]) => Promise<unknown>;
      const transcriber = (await createPipeline("automatic-speech-recognition", modelId)) as AsrPipeline;
      asrPipelineRef.current = { modelId, pipeline: transcriber };
      setAsrReadyMap((prev) => ({ ...prev, [modelId]: true }));
      return transcriber;
    })();
    asrPipelineLoadingRef.current = loadingTask;
    try {
      return await loadingTask;
    } finally {
      asrPipelineLoadingRef.current = null;
    }
  };

  const decodeAudioBlob = async (blob: Blob): Promise<Float32Array> => {
    const arrayBuffer = await blob.arrayBuffer();
    const AudioContextCtor =
      window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextCtor) {
      throw new Error("当前环境不支持音频解码");
    }
    const audioContext = new AudioContextCtor({ sampleRate: 16000 });
    try {
      const decoded = await audioContext.decodeAudioData(arrayBuffer.slice(0));
      if (decoded.numberOfChannels === 1) {
        return new Float32Array(decoded.getChannelData(0));
      }
      const mixed = new Float32Array(decoded.length);
      for (let i = 0; i < decoded.numberOfChannels; i += 1) {
        const channelData = decoded.getChannelData(i);
        for (let j = 0; j < decoded.length; j += 1) {
          mixed[j] += channelData[j] / decoded.numberOfChannels;
        }
      }
      return mixed;
    } finally {
      await audioContext.close();
    }
  };

  const ensureZhSimplifier = async (): Promise<ChineseConverter> => {
    if (zhSimplifierRef.current) {
      return zhSimplifierRef.current;
    }
    if (zhSimplifierLoadingRef.current) {
      return zhSimplifierLoadingRef.current;
    }
    const loadingTask = (async () => {
      const openccModule = await import("opencc-js");
      const createConverter = (
        openccModule as unknown as { Converter: (options: { from: string; to: string }) => ChineseConverter }
      ).Converter;
      const converter = createConverter({ from: "tw", to: "cn" });
      zhSimplifierRef.current = converter;
      return converter;
    })();
    zhSimplifierLoadingRef.current = loadingTask;
    try {
      return await loadingTask;
    } finally {
      zhSimplifierLoadingRef.current = null;
    }
  };

  const normalizeToSimplifiedChinese = async (text: string): Promise<string> => {
    const clean = text.trim();
    if (!clean) {
      return clean;
    }
    try {
      const converter = await ensureZhSimplifier();
      return converter(clean);
    } catch {
      return clean;
    }
  };

  const transcribeAudio = async (blob: Blob): Promise<void> => {
    setTranscribing(true);
    setAsrError("");
    try {
      const [transcriber, audio] = await Promise.all([ensureAsrPipeline(asrModelId), decodeAudioBlob(blob)]);
      const result = await transcriber(audio, { language: "zh", task: "transcribe" });
      const text = String(result?.text || "").trim();
      if (!text) {
        throw new Error("未识别到语音内容，请重试");
      }
      payload.appendTranscript(await normalizeToSimplifiedChinese(text));
    } catch (error) {
      setAsrError(error instanceof Error ? error.message : "语音识别失败");
    } finally {
      setTranscribing(false);
    }
  };

  const stopMediaTracks = (): void => {
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    mediaStreamRef.current = null;
  };

  const startRecording = async (): Promise<void> => {
    if (recording || transcribing || payload.loading) {
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setAsrError("当前环境不支持麦克风录音");
      return;
    }
    setAsrError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
      mediaStreamRef.current = stream;
      audioChunksRef.current = [];
      const preferredMimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";
      const recorder = new MediaRecorder(stream, { mimeType: preferredMimeType });
      mediaRecorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };
      recorder.onstop = () => {
        const recordedBlob = new Blob(audioChunksRef.current, { type: preferredMimeType });
        audioChunksRef.current = [];
        mediaRecorderRef.current = null;
        setRecording(false);
        stopMediaTracks();
        if (recordedBlob.size > 0) {
          void transcribeAudio(recordedBlob);
        }
      };
      recorder.start();
      setRecording(true);
    } catch (error) {
      stopMediaTracks();
      setRecording(false);
      setAsrError(error instanceof Error ? error.message : "无法启动录音");
    }
  };

  const stopRecording = (): void => {
    const recorder = mediaRecorderRef.current;
    if (!recorder) {
      setRecording(false);
      stopMediaTracks();
      return;
    }
    if (recorder.state !== "inactive") {
      recorder.stop();
    }
  };

  const toggleRecording = (): void => {
    if (recording) {
      stopRecording();
      return;
    }
    void startRecording();
  };

  const preloadAsrModel = async (): Promise<void> => {
    if (asrPreloading || transcribing || recording || payload.loading) {
      return;
    }
    setAsrPreloading(true);
    setAsrError("");
    try {
      await ensureAsrPipeline(asrModelId);
    } catch (error) {
      setAsrError(error instanceof Error ? error.message : "模型预加载失败");
    } finally {
      setAsrPreloading(false);
    }
  };

  const cleanupAsr = (): void => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop();
    }
    stopMediaTracks();
  };

  const asrModelLabel = useMemo(() => {
    const matched = ASR_MODEL_OPTIONS.find((item) => item.value === asrModelId);
    return matched?.label || asrModelId;
  }, [asrModelId]);

  return {
    asrModelId,
    asrPreloading,
    asrReadyMap,
    recording,
    transcribing,
    asrError,
    asrModelLabel,
    setAsrModelId,
    toggleRecording,
    preloadAsrModel,
    stopRecording,
    cleanupAsr,
  };
}
