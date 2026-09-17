"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import YouTube from "react-youtube";
import { GoogleGenAI, Type } from "@google/genai";

const LIVE_MODEL = "gemini-3.1-flash-live-preview";

type ConversationItem = {
    role: "user" | "assistant";
    text: string;
};

type GeminiSession = any;

function getYouTubeVideoId(url: string): string {
    if (!url) return "";

    const value = url.trim();

    if (/^[a-zA-Z0-9_-]{11}$/.test(value)) {
        return value;
    }

    try {
        const parsed = new URL(value);
        const hostname = parsed.hostname.toLowerCase();

        if (hostname === "youtu.be" || hostname.endsWith(".youtu.be")) {
            return parsed.pathname.replace(/^\/+/, "").split("/")[0];
        }

        if (
            hostname === "youtube.com" ||
            hostname === "www.youtube.com" ||
            hostname.endsWith(".youtube.com")
        ) {
            const v = parsed.searchParams.get("v");
            if (v) return v;

            const parts = parsed.pathname.split("/").filter(Boolean);
            const index = parts.findIndex((part) =>
                ["embed", "shorts", "live"].includes(part.toLowerCase())
            );

            if (index !== -1 && parts[index + 1]) {
                return parts[index + 1];
            }
        }
    } catch {
        return "";
    }

    return "";
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    const chunkSize = 0x8000;

    for (let i = 0; i < bytes.length; i += chunkSize) {
        const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
        binary += String.fromCharCode(...chunk);
    }

    return btoa(binary);
}

const consultLectureVideoDeclaration = {
    name: "consultLectureVideo",
    description:
        "Look further into the lecture video for something the live frame and current lecture context do not cover — for example something taught earlier or later than the current pause point. Only use this when you cannot answer from the current frame, audio, or lecture context.",
    parameters: {
        type: Type.OBJECT,
        properties: {
            question: {
                type: Type.STRING,
                description: "The specific thing to check, phrased as a clear question.",
            },
        },
        required: ["question"],
    },
};

export default function LearnPage() {
    // ---------------------------------------------------------
    // VIDEO
    // ---------------------------------------------------------

    const [videoUrl, setVideoUrl] = useState("");
    const [pausedAt, setPausedAt] = useState(0);

    const playerRef = useRef<any>(null);

    // ---------------------------------------------------------
    // UI STATE
    // ---------------------------------------------------------

    const [doubtMode, setDoubtMode] = useState(false);
    const [status, setStatus] = useState("Paste a lecture URL to start.");
    const [lectureContext, setLectureContext] = useState("");
    const [lectureLoading, setLectureLoading] = useState(false);
    const [conversation, setConversation] = useState<ConversationItem[]>([]);
    const [speaking, setSpeaking] = useState(false);
    const [micLevel, setMicLevel] = useState(0);

    // ---------------------------------------------------------
    // PERSISTENT VIDEO-UNDERSTANDING HANDLE
    // ---------------------------------------------------------

    const interactionIdRef = useRef<string | null>(null);

    // ---------------------------------------------------------
    // GEMINI
    // ---------------------------------------------------------

    const sessionRef = useRef<GeminiSession | null>(null);
    const audioContextRef = useRef<AudioContext | null>(null);
    const micStreamRef = useRef<MediaStream | null>(null);
    const micSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
    const micWorkletRef = useRef<AudioWorkletNode | null>(null);
    const analyserRef = useRef<AnalyserNode | null>(null);

    // ---------------------------------------------------------
    // LIVE VIDEO CAPTURE
    // ---------------------------------------------------------

    const screenStreamRef = useRef<MediaStream | null>(null);
    const screenVideoRef = useRef<HTMLVideoElement | null>(null);
    const frameCanvasRef = useRef<HTMLCanvasElement | null>(null);
    const frameIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const [videoSharing, setVideoSharing] = useState(false);

    // ---------------------------------------------------------
    // AUDIO PLAYBACK (queued, to avoid overlapping chunks)
    // ---------------------------------------------------------

    const outputAudioContextRef = useRef<AudioContext | null>(null);
    const outputQueueTimeRef = useRef(0);
    const outputSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());

    // ---------------------------------------------------------
    // STOP ANY CURRENTLY QUEUED/PLAYING GEMINI AUDIO
    // ---------------------------------------------------------

    const stopAudioPlayback = useCallback(() => {
        for (const source of outputSourcesRef.current) {
            try {
                source.stop();
            } catch {
                // already stopped
            }
        }

        outputSourcesRef.current.clear();

        const ctx = outputAudioContextRef.current;
        outputQueueTimeRef.current = ctx ? ctx.currentTime : 0;

        setSpeaking(false);
    }, []);

    // ---------------------------------------------------------
    // CLEANUP: VIDEO SHARING
    // ---------------------------------------------------------

    const stopVideoSharing = useCallback(() => {
        console.log("SCREEN CAPTURE STOPPED");

        if (frameIntervalRef.current) {
            clearInterval(frameIntervalRef.current);
            frameIntervalRef.current = null;
        }

        if (screenStreamRef.current) {
            screenStreamRef.current.getTracks().forEach((track) => track.stop());
            screenStreamRef.current = null;
        }

        if (screenVideoRef.current) {
            screenVideoRef.current.pause();
            screenVideoRef.current.srcObject = null;
            screenVideoRef.current = null;
        }

        frameCanvasRef.current = null;

        setVideoSharing(false);
    }, []);

    // ---------------------------------------------------------
    // SEND LIVE VIDEO FRAME
    // ---------------------------------------------------------

    const sendVideoFrame = useCallback(() => {
        const session = sessionRef.current;
        const video = screenVideoRef.current;
        const canvas = frameCanvasRef.current;

        if (!session || !video || !canvas) {
            return;
        }

        if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
            return;
        }

        if (video.videoWidth === 0 || video.videoHeight === 0) {
            return;
        }

        const context = canvas.getContext("2d");
        if (!context) return;

        context.drawImage(video, 0, 0, canvas.width, canvas.height);

        canvas.toBlob(
            async (blob) => {
                if (!blob) return;

                try {
                    const buffer = await blob.arrayBuffer();
                    const base64 = arrayBufferToBase64(buffer);

                    if (!sessionRef.current) {
                        return;
                    }

                    sessionRef.current.sendRealtimeInput({
                        video: {
                            data: base64,
                            mimeType: "image/jpeg",
                        },
                    });

                    console.log(
                        "LIVE FRAME SENT TO GEMINI",
                        Math.round(blob.size / 1024),
                        "KB"
                    );
                } catch (error) {
                    console.error("Error sending video frame:", error);
                }
            },
            "image/jpeg",
            0.65
        );
    }, []);

    // ---------------------------------------------------------
    // START VIDEO SHARING
    // ---------------------------------------------------------

    const startVideoSharing = useCallback(async () => {
        try {
            if (!sessionRef.current) {
                setStatus("Connect Gemini first, then share the lecture.");
                console.error("Cannot share video: Gemini session does not exist.");
                return;
            }

            if (!navigator.mediaDevices?.getDisplayMedia) {
                setStatus("This browser does not support screen sharing.");
                return;
            }

            if (screenStreamRef.current) {
                return;
            }

            const stream = await navigator.mediaDevices.getDisplayMedia({
                video: { frameRate: 1 },
                audio: false,
            });

            screenStreamRef.current = stream;

            const video = document.createElement("video");
            video.autoplay = true;
            video.muted = true;
            video.playsInline = true;
            video.srcObject = stream;

            screenVideoRef.current = video;

            await video.play();

            await new Promise<void>((resolve) => {
                if (video.videoWidth > 0 && video.videoHeight > 0) {
                    resolve();
                    return;
                }
                video.onloadedmetadata = () => resolve();
            });

            const width = Math.min(video.videoWidth || 1280, 1280);
            const height = Math.max(
                1,
                Math.round(
                    ((video.videoHeight || 720) / (video.videoWidth || 1280)) * width
                )
            );

            const canvas = document.createElement("canvas");
            canvas.width = width;
            canvas.height = height;

            frameCanvasRef.current = canvas;

            setVideoSharing(true);
            setStatus("Gemini is now receiving live lecture frames.");

            console.log("SCREEN CAPTURE STARTED", video.videoWidth, "x", video.videoHeight);

            sendVideoFrame();

            frameIntervalRef.current = setInterval(() => {
                sendVideoFrame();
            }, 1000);

            const track = stream.getVideoTracks()[0];

            track.onended = () => {
                stopVideoSharing();
                setStatus("Video sharing stopped.");
            };
        } catch (error) {
            console.error("Could not start video sharing:", error);
            setVideoSharing(false);
            setStatus("Video sharing was cancelled or denied.");
        }
    }, [sendVideoFrame, stopVideoSharing]);

    // ---------------------------------------------------------
    // MICROPHONE
    // ---------------------------------------------------------

    const startMicrophone = useCallback(async () => {
        try {
            if (!navigator.mediaDevices?.getUserMedia) {
                setStatus("This browser does not support microphone access.");
                return;
            }

            if (!window.AudioWorkletNode) {
                setStatus("This browser does not support AudioWorklet.");
                return;
            }

            const stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    channelCount: 1,
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true,
                },
            });

            micStreamRef.current = stream;

            const audioContext = new AudioContext({ sampleRate: 16000 });
            audioContextRef.current = audioContext;

            if (audioContext.state === "suspended") {
                await audioContext.resume();
            }

            await audioContext.audioWorklet.addModule("/pcm-worklet.js");

            const source = audioContext.createMediaStreamSource(stream);
            micSourceRef.current = source;

            const analyser = audioContext.createAnalyser();
            analyser.fftSize = 256;
            analyser.smoothingTimeConstant = 0.8;
            analyserRef.current = analyser;

            source.connect(analyser);

            const worklet = new AudioWorkletNode(audioContext, "pcm-processor");
            micWorkletRef.current = worklet;

            worklet.port.onmessage = (event) => {
                const pcm = event.data;

                if (!pcm || !sessionRef.current) return;
                if (!(pcm instanceof ArrayBuffer)) return;

                const base64 = arrayBufferToBase64(pcm);

                sessionRef.current.sendRealtimeInput({
                    audio: {
                        data: base64,
                        mimeType: "audio/pcm;rate=16000",
                    },
                });
            };

            source.connect(worklet);

            setStatus(
                videoSharing
                    ? "Listening + watching lecture"
                    : "Listening"
            );

            console.log("MICROPHONE STARTED");

            const updateLevel = () => {
                if (!analyserRef.current) return;

                const analyser = analyserRef.current;
                const data = new Uint8Array(analyser.frequencyBinCount);
                analyser.getByteTimeDomainData(data);

                let sum = 0;
                for (const value of data) {
                    const normalized = (value - 128) / 128;
                    sum += normalized * normalized;
                }

                const rms = Math.sqrt(sum / data.length);
                setMicLevel(Math.min(1, rms * 4));

                requestAnimationFrame(updateLevel);
            };

            updateLevel();
        } catch (error) {
            console.error("Microphone error:", error);
            setStatus("Microphone permission denied or failed.");
        }
    }, [videoSharing]);

    const stopMicrophone = useCallback(() => {
        if (micWorkletRef.current) {
            micWorkletRef.current.port.onmessage = null;
            micWorkletRef.current.disconnect();
            micWorkletRef.current = null;
        }

        if (micSourceRef.current) {
            micSourceRef.current.disconnect();
            micSourceRef.current = null;
        }

        if (micStreamRef.current) {
            micStreamRef.current.getTracks().forEach((track) => track.stop());
            micStreamRef.current = null;
        }

        if (audioContextRef.current) {
            audioContextRef.current.close();
            audioContextRef.current = null;
        }

        analyserRef.current = null;
        setMicLevel(0);
    }, []);

    // ---------------------------------------------------------
    // PLAY GEMINI AUDIO (queued sequentially — fixes double voice)
    // ---------------------------------------------------------

    const playAudioBytes = useCallback(async (bytes: Uint8Array) => {
        try {
            if (!outputAudioContextRef.current) {
                outputAudioContextRef.current = new AudioContext({ sampleRate: 24000 });
            }

            const ctx = outputAudioContextRef.current;

            if (ctx.state === "suspended") {
                await ctx.resume();
            }

            const samples = new Int16Array(
                bytes.buffer,
                bytes.byteOffset,
                Math.floor(bytes.byteLength / 2)
            );

            if (samples.length === 0) {
                return;
            }

            const buffer = ctx.createBuffer(1, samples.length, 24000);
            const channel = buffer.getChannelData(0);

            for (let i = 0; i < samples.length; i++) {
                channel[i] = samples[i] / 32768;
            }

            const source = ctx.createBufferSource();
            source.buffer = buffer;
            source.connect(ctx.destination);

            // Schedule this chunk to start exactly when the
            // previous chunk finishes, instead of immediately —
            // this is what stops chunks overlapping into a
            // "double voice" effect.
            const startAt = Math.max(
                ctx.currentTime + 0.02,
                outputQueueTimeRef.current
            );

            source.start(startAt);

            outputQueueTimeRef.current = startAt + buffer.duration;

            outputSourcesRef.current.add(source);

            setSpeaking(true);

            source.onended = () => {
                outputSourcesRef.current.delete(source);

                if (outputSourcesRef.current.size === 0) {
                    setSpeaking(false);
                }
            };
        } catch (error) {
            console.error("Audio playback error:", error);
        }
    }, []);

    // ---------------------------------------------------------
    // TOOL CALL: consultLectureVideo
    // ---------------------------------------------------------

    const handleToolCall = useCallback(async (toolCall: any) => {
        const session = sessionRef.current;
        if (!session) return;

        const functionResponses: any[] = [];

        for (const functionCall of toolCall?.functionCalls || []) {
            if (functionCall.name !== "consultLectureVideo") {
                functionResponses.push({
                    name: functionCall.name,
                    id: functionCall.id,
                    response: { error: "Unknown tool." },
                });
                continue;
            }

            const question =
                typeof functionCall.args?.question === "string"
                    ? functionCall.args.question
                    : "";

            const currentInteractionId = interactionIdRef.current;

            if (!question || !currentInteractionId) {
                functionResponses.push({
                    name: functionCall.name,
                    id: functionCall.id,
                    response: { error: "No lecture video context is available right now." },
                });
                continue;
            }

            try {
                const response = await fetch("/api/lecture-question", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ interactionId: currentInteractionId, question }),
                });

                const data = await response.json();

                if (!response.ok || !data.answer) {
                    functionResponses.push({
                        name: functionCall.name,
                        id: functionCall.id,
                        response: { error: data.error || "Could not consult the lecture video." },
                    });
                    continue;
                }

                if (typeof data.interactionId === "string") {
                    interactionIdRef.current = data.interactionId;
                }

                functionResponses.push({
                    name: functionCall.name,
                    id: functionCall.id,
                    response: { answer: data.answer },
                });
            } catch (error) {
                console.error("consultLectureVideo error:", error);
                functionResponses.push({
                    name: functionCall.name,
                    id: functionCall.id,
                    response: { error: "Could not reach the lecture video service." },
                });
            }
        }

        try {
            session.sendToolResponse({ functionResponses });
        } catch (error) {
            console.error("sendToolResponse error:", error);
        }
    }, []);

    // ---------------------------------------------------------
    // GEMINI MESSAGE
    // ---------------------------------------------------------

    const handleGeminiMessage = useCallback(
        async (message: any) => {
            try {
                if (message?.toolCall) {
                    void handleToolCall(message.toolCall);
                }

                const serverContent = message?.serverContent;

                // Gemini sends this when the student starts talking
                // while it's still speaking (barge-in). Stop whatever
                // is queued/playing immediately, or the old response
                // keeps sounding underneath the new one.
                if (serverContent?.interrupted) {
                    stopAudioPlayback();
                }

                const modelTurn = serverContent?.modelTurn;
                const parts = modelTurn?.parts || [];

                for (const part of parts) {
                    if (part?.inlineData?.data) {
                        const mimeType = part.inlineData.mimeType || "";

                        if (mimeType.startsWith("audio/")) {
                            const binary = atob(part.inlineData.data);
                            const bytes = new Uint8Array(binary.length);

                            for (let i = 0; i < binary.length; i++) {
                                bytes[i] = binary.charCodeAt(i);
                            }

                            await playAudioBytes(bytes);
                        }
                    }
                }

                let text = "";
                for (const part of parts) {
                    if (typeof part?.text === "string") {
                        text += part.text;
                    }
                }

                if (text.trim()) {
                    setConversation((previous) => [
                        ...previous,
                        { role: "assistant", text: text.trim() },
                    ]);
                }

                if (serverContent?.turnComplete) {
                    // Don't force-stop speaking here — audio chunks
                    // already queued still need to finish playing.
                    // `speaking` is cleared by the last chunk's onended.
                }
            } catch (error) {
                console.error("Gemini message handling error:", error);
            }
        },
        [handleToolCall, playAudioBytes, stopAudioPlayback]
    );

    // ---------------------------------------------------------
    // CREATE GEMINI SESSION
    // ---------------------------------------------------------

    const createGeminiSession = useCallback(
        async (context: string) => {
            try {
                setStatus("Connecting to Gemini Live...");

                const tokenResponse = await fetch("/api/gemini-token");

                if (!tokenResponse.ok) {
                    throw new Error(`Token request failed: ${tokenResponse.status}`);
                }

                const tokenData = await tokenResponse.json();
                const token = tokenData?.token;

                if (!token) {
                    console.error("Token response:", tokenData);
                    throw new Error("Gemini token was not returned.");
                }

                const ai = new GoogleGenAI({ apiKey: token });

                const session = await ai.live.connect({
                    model: LIVE_MODEL,

                    callbacks: {
                        onopen: () => {
                            console.log("GEMINI LIVE CONNECTED");
                            setStatus("Gemini Live connected.");
                        },

                        onmessage: handleGeminiMessage,

                        onerror: (error: any) => {
                            console.error("GEMINI LIVE ERROR", error);
                            setStatus("Gemini Live error. Check console.");
                        },

                        onclose: (event: any) => {
                            console.log("Gemini Live closed:", event);
                            setSpeaking(false);
                        },
                    },

                    config: {
                        responseModalities: [Modality.AUDIO],
                        sessionResumption: {},

                        tools: [
                            { functionDeclarations: [consultLectureVideoDeclaration] },
                        ],

                        systemInstruction: `
You are an AI Tutor helping a student watching an educational lecture.

You may receive:
1. The student's microphone audio.
2. Live visual frames captured from the lecture screen, roughly once per second.
3. Written lecture context, generated earlier by analyzing the actual lecture video around the point where the student paused.
4. A tool called consultLectureVideo, which lets you check a part of the lecture video that is not visible in the current frame (for example something taught earlier or later than the current pause point).

When a live visual frame is available, inspect it carefully. It may contain slides, equations, diagrams, code, definitions, examples, or teacher annotations. Use the most recent frame to understand what the student is currently looking at.

Never claim to see something that is not actually present in the frame you received. Never invent lecture content.

Use consultLectureVideo only when the current frame and the lecture context below do not already answer the question — for example if the student asks about something earlier in the lecture than what is currently on screen.

Lecture context from the paused moment:

${context || "No additional lecture context is available."}

Answer naturally, like a patient teacher. Keep answers clear and reasonably concise.
`,
                    },
                });

                sessionRef.current = session;
            } catch (error) {
                console.error("Gemini session creation failed:", error);
                setStatus("Could not connect to Gemini Live.");
                throw error;
            }
        },
        [handleGeminiMessage]
    );

    // ---------------------------------------------------------
    // GET LECTURE CONTEXT
    // ---------------------------------------------------------

    const analyzeLecture = useCallback(
        async (timestamp: number) => {
            try {
                setLectureLoading(true);
                setStatus("Analyzing the lecture...");

                const response = await fetch("/api/lecture-context", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ videoUrl, timestamp }),
                });

                const data = await response.json();

                if (!response.ok) {
                    throw new Error(data?.error || "Lecture analysis failed.");
                }

                const context = data?.context || "";

                interactionIdRef.current =
                    typeof data.interactionId === "string" ? data.interactionId : null;

                setLectureContext(context);

                return context;
            } catch (error) {
                console.error("Lecture context error:", error);
                setLectureContext("");
                interactionIdRef.current = null;
                return "";
            } finally {
                setLectureLoading(false);
            }
        },
        [videoUrl]
    );

    // ---------------------------------------------------------
    // ASK DOUBT
    // ---------------------------------------------------------

    const askDoubt = useCallback(async () => {
        try {
            if (!playerRef.current) {
                setStatus("YouTube player is not ready.");
                return;
            }

            const currentTime = playerRef.current.getCurrentTime();
            const exactTime = Math.floor(Number(currentTime) || 0);

            playerRef.current.pauseVideo();

            setPausedAt(exactTime);
            setDoubtMode(true);
            setConversation([]);
            setStatus(`Paused at ${exactTime}s`);

            const context = await analyzeLecture(exactTime);

            await createGeminiSession(context);
            await startMicrophone();

            setStatus("Gemini is listening.");
        } catch (error) {
            console.error("Ask doubt failed:", error);
            setStatus("Could not start AI Tutor.");
        }
    }, [analyzeLecture, createGeminiSession, startMicrophone]);

    // ---------------------------------------------------------
    // CONTINUE LECTURE
    // ---------------------------------------------------------

    const continueLecture = useCallback(() => {
        stopAudioPlayback();
        stopVideoSharing();
        stopMicrophone();

        if (sessionRef.current) {
            try {
                sessionRef.current.close();
            } catch {
                // ignore
            }
            sessionRef.current = null;
        }

        interactionIdRef.current = null;

        setDoubtMode(false);
        setConversation([]);

        if (playerRef.current) {
            playerRef.current.seekTo(pausedAt, true);
            playerRef.current.playVideo();
        }

        setStatus("Lecture resumed.");
    }, [pausedAt, stopAudioPlayback, stopMicrophone, stopVideoSharing]);

    // ---------------------------------------------------------
    // CLEANUP WHEN PAGE CLOSES
    // ---------------------------------------------------------

    useEffect(() => {
        return () => {
            stopAudioPlayback();
            stopVideoSharing();
            stopMicrophone();

            if (sessionRef.current) {
                try {
                    sessionRef.current.close();
                } catch {
                    // ignore
                }
                sessionRef.current = null;
            }

            if (outputAudioContextRef.current) {
                outputAudioContextRef.current.close();
                outputAudioContextRef.current = null;
            }
        };
    }, [stopAudioPlayback, stopMicrophone, stopVideoSharing]);

    // ---------------------------------------------------------
    // READ URL
    // ---------------------------------------------------------

    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        setVideoUrl(params.get("video") || "");
    }, []);

    const videoId = getYouTubeVideoId(videoUrl);

    // ---------------------------------------------------------
    // UI
    // ---------------------------------------------------------

    return (
        <main style={{ minHeight: "100vh", background: "#000", color: "#fff", padding: "24px" }}>
            <div style={{ maxWidth: "1500px", margin: "0 auto" }}>
                <h1 style={{ fontSize: "32px", marginBottom: "8px" }}>AI Tutor</h1>

                <p style={{ color: "#aaa", marginBottom: "24px" }}>
                    Watch. Ask. Understand. Continue.
                </p>

                {!videoId && (
                    <div
                        style={{
                            padding: "20px",
                            border: "1px solid #333",
                            borderRadius: "10px",
                            color: "#aaa",
                        }}
                    >
                        No valid YouTube video was provided.
                    </div>
                )}

                {videoId && (
                    <div
                        style={{
                            display: "grid",
                            gridTemplateColumns: "minmax(0, 1.6fr) minmax(320px, 0.8fr)",
                            gap: "24px",
                            alignItems: "start",
                        }}
                    >
                        <section>
                            <div
                                style={{
                                    width: "100%",
                                    borderRadius: "12px",
                                    overflow: "hidden",
                                    background: "#111",
                                }}
                            >
                                <YouTube
                                    videoId={videoId}
                                    opts={{
                                        width: "100%",
                                        height: "500",
                                        playerVars: { autoplay: 0, rel: 0 },
                                    }}
                                    onReady={(event) => {
                                        playerRef.current = event.target;
                                    }}
                                />
                            </div>

                            <div
                                style={{
                                    marginTop: "16px",
                                    padding: "16px",
                                    background: "#111",
                                    border: "1px solid #292929",
                                    borderRadius: "10px",
                                }}
                            >
                                <div style={{ color: "#aaa", fontSize: "14px", marginBottom: "8px" }}>
                                    Lecture
                                </div>
                                <div style={{ wordBreak: "break-all", fontSize: "14px" }}>
                                    {videoUrl}
                                </div>
                            </div>
                        </section>

                        <section
                            style={{
                                background: "#0d0d0d",
                                border: "1px solid #292929",
                                borderRadius: "12px",
                                padding: "20px",
                                minHeight: "500px",
                            }}
                        >
                            <h2 style={{ fontSize: "22px", marginBottom: "8px" }}>AI Tutor</h2>

                            <div style={{ color: "#aaa", fontSize: "14px", marginBottom: "20px" }}>
                                {status}
                            </div>

                            {!doubtMode && (
                                <button
                                    onClick={askDoubt}
                                    disabled={lectureLoading}
                                    style={{
                                        width: "100%",
                                        padding: "14px",
                                        border: "none",
                                        borderRadius: "8px",
                                        background: "#fff",
                                        color: "#000",
                                        cursor: lectureLoading ? "not-allowed" : "pointer",
                                        fontSize: "16px",
                                        fontWeight: 600,
                                        opacity: lectureLoading ? 0.6 : 1,
                                    }}
                                >
                                    {lectureLoading ? "Analyzing..." : "Ask Doubt"}
                                </button>
                            )}

                            {doubtMode && (
                                <>
                                    <div
                                        style={{
                                            padding: "14px",
                                            border: "1px solid #333",
                                            borderRadius: "8px",
                                            marginBottom: "14px",
                                        }}
                                    >
                                        <div style={{ fontSize: "13px", color: "#888", marginBottom: "6px" }}>
                                            Paused at
                                        </div>
                                        <strong>{pausedAt}s</strong>
                                    </div>

                                    <div
                                        style={{
                                            padding: "14px",
                                            border: "1px solid #333",
                                            borderRadius: "8px",
                                            marginBottom: "12px",
                                        }}
                                    >
                                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                                            <span>Microphone</span>
                                            <span style={{ color: micLevel > 0.05 ? "#fff" : "#777" }}>
                                                {micLevel > 0.05 ? "Listening" : "Ready"}
                                            </span>
                                        </div>

                                        <div
                                            style={{
                                                height: "5px",
                                                background: "#222",
                                                borderRadius: "10px",
                                                marginTop: "10px",
                                                overflow: "hidden",
                                            }}
                                        >
                                            <div
                                                style={{
                                                    width: `${Math.round(micLevel * 100)}%`,
                                                    height: "100%",
                                                    background: "#fff",
                                                    transition: "width 80ms linear",
                                                }}
                                            />
                                        </div>
                                    </div>

                                    <div
                                        style={{
                                            padding: "14px",
                                            border: "1px solid #333",
                                            borderRadius: "8px",
                                            marginBottom: "12px",
                                        }}
                                    >
                                        <div
                                            style={{
                                                display: "flex",
                                                justifyContent: "space-between",
                                                alignItems: "center",
                                                marginBottom: "10px",
                                            }}
                                        >
                                            <span>Lecture Vision</span>
                                            <span style={{ fontSize: "13px", color: videoSharing ? "#fff" : "#777" }}>
                                                {videoSharing ? "LIVE" : "OFF"}
                                            </span>
                                        </div>

                                        <button
                                            onClick={videoSharing ? stopVideoSharing : startVideoSharing}
                                            style={{
                                                width: "100%",
                                                padding: "12px",
                                                border: "1px solid #444",
                                                borderRadius: "7px",
                                                background: videoSharing ? "#222" : "#fff",
                                                color: videoSharing ? "#fff" : "#000",
                                                cursor: "pointer",
                                                fontSize: "14px",
                                                fontWeight: 600,
                                            }}
                                        >
                                            {videoSharing ? "Stop Lecture Vision" : "Share Lecture With AI"}
                                        </button>

                                        <p style={{ fontSize: "12px", color: "#777", lineHeight: "1.5", marginTop: "10px", marginBottom: 0 }}>
                                            Click this and choose <strong>This Tab</strong> in the browser sharing dialog. Gemini will receive approximately one lecture frame per second.
                                        </p>
                                    </div>

                                    <div
                                        style={{
                                            padding: "12px",
                                            border: "1px solid #333",
                                            borderRadius: "8px",
                                            marginBottom: "12px",
                                            textAlign: "center",
                                            color: speaking ? "#fff" : "#777",
                                        }}
                                    >
                                        {speaking ? "Gemini is speaking..." : "Gemini is ready"}
                                    </div>

                                    <div style={{ maxHeight: "280px", overflowY: "auto", marginBottom: "16px" }}>
                                        {conversation.length === 0 && (
                                            <div style={{ padding: "20px", textAlign: "center", color: "#666", fontSize: "14px" }}>
                                                Ask your doubt using your microphone.
                                            </div>
                                        )}

                                        {conversation.map((item, index) => (
                                            <div
                                                key={index}
                                                style={{
                                                    marginBottom: "12px",
                                                    padding: "12px",
                                                    borderRadius: "8px",
                                                    background: item.role === "user" ? "#151515" : "#111",
                                                    border: "1px solid #252525",
                                                }}
                                            >
                                                <div style={{ fontSize: "12px", color: "#777", marginBottom: "5px" }}>
                                                    {item.role === "user" ? "You" : "AI Tutor"}
                                                </div>
                                                <div style={{ fontSize: "14px", lineHeight: "1.5" }}>{item.text}</div>
                                            </div>
                                        ))}
                                    </div>

                                    <button
                                        onClick={continueLecture}
                                        style={{
                                            width: "100%",
                                            padding: "13px",
                                            border: "none",
                                            borderRadius: "8px",
                                            background: "#fff",
                                            color: "#000",
                                            cursor: "pointer",
                                            fontSize: "15px",
                                            fontWeight: 600,
                                        }}
                                    >
                                        Continue Lecture
                                    </button>
                                </>
                            )}
                        </section>
                    </div>
                )}
            </div>
        </main>
    );
}