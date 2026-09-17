"use client";

import {
    useCallback,
    useEffect,
    useRef,
    useState,
} from "react";

import YouTube from "react-youtube";

import {
    GoogleGenAI,
    Modality,
} from "@google/genai";


// ========================================
// TYPES
// ========================================

type Message = {
    role: "user" | "gemini";
    text: string;
};

type WorkletMessage =
    | {
        type: "audio";
        data: Float32Array;
    }
    | {
        type: "speechStart";
        rms: number;
    }
    | {
        type: "speechEnd";
        rms: number;
    };


type TranscriptSegment = {
    text: string;
    duration: number;
    offset: number;
};


// ========================================
// YOUTUBE VIDEO ID
// ========================================

function getYouTubeVideoId(
    value: string
) {
    const input =
        value.trim();

    // Already a YouTube ID
    if (
        /^[a-zA-Z0-9_-]{11}$/.test(
            input
        )
    ) {
        return input;
    }

    try {
        const url =
            new URL(input);

        // youtu.be/VIDEO_ID
        if (
            url.hostname.includes(
                "youtu.be"
            )
        ) {
            return url.pathname
                .slice(1)
                .split("/")[0];
        }

        // youtube.com/watch?v=VIDEO_ID
        const id =
            url.searchParams.get(
                "v"
            );

        if (id) {
            return id;
        }

        // embed / shorts / live
        const parts =
            url.pathname
                .split("/")
                .filter(Boolean);

        const markerIndex =
            parts.findIndex(
                (part) =>
                    [
                        "embed",
                        "shorts",
                        "live",
                    ].includes(part)
            );

        if (
            markerIndex >= 0
        ) {
            return (
                parts[
                markerIndex + 1
                ] || ""
            );
        }

        return "";

    } catch {
        return "";
    }
}


// ========================================
// FLOAT32 -> PCM16 BASE64
// ========================================

function float32ToPCM16Base64(
    samples: Float32Array
) {
    const buffer =
        new ArrayBuffer(
            samples.length * 2
        );

    const view =
        new DataView(buffer);

    for (
        let i = 0;
        i < samples.length;
        i++
    ) {
        const sample =
            Math.max(
                -1,
                Math.min(
                    1,
                    samples[i] * 2.2
                )
            );

        view.setInt16(
            i * 2,
            sample < 0
                ? sample * 0x8000
                : sample * 0x7fff,
            true
        );
    }

    const bytes =
        new Uint8Array(
            buffer
        );

    let binary = "";

    const chunkSize =
        0x8000;

    for (
        let i = 0;
        i < bytes.length;
        i += chunkSize
    ) {
        binary +=
            String.fromCharCode(
                ...bytes.subarray(
                    i,
                    i + chunkSize
                )
            );
    }

    return btoa(binary);
}


// ========================================
// BASE64 -> PCM16
// ========================================

function base64ToInt16(
    base64: string
) {
    const binary =
        atob(base64);

    const bytes =
        new Uint8Array(
            binary.length
        );

    for (
        let i = 0;
        i < binary.length;
        i++
    ) {
        bytes[i] =
            binary.charCodeAt(i);
    }

    return new Int16Array(
        bytes.buffer
    );
}


// ========================================
// MAIN PAGE
// ========================================

export default function LearnPage() {

    // --------------------------------------
    // Basic state
    // --------------------------------------

    const [videoUrl, setVideoUrl] =
        useState("");

    const [pausedAt, setPausedAt] =
        useState<number | null>(
            null
        );

    const [doubtMode, setDoubtMode] =
        useState(false);

    const [status, setStatus] =
        useState("Ready");

    const [micLevel, setMicLevel] =
        useState(0);

    const [speaking, setSpeaking] =
        useState(false);

    const [conversation, setConversation] =
        useState<Message[]>([]);


    // --------------------------------------
    // Lecture context
    // --------------------------------------

    const [
        lectureContext,
        setLectureContext,
    ] = useState("");

    const [
        lectureLoading,
        setLectureLoading,
    ] = useState(false);


    const [
        transcript,
        setTranscript,
    ] = useState<TranscriptSegment[]>([]);

    const [
        transcriptLoading,
        setTranscriptLoading,
    ] = useState(false);


    // --------------------------------------
    // YouTube player
    // --------------------------------------

    const playerRef =
        useRef<any>(null);


    // --------------------------------------
    // Gemini session
    // --------------------------------------

    const sessionRef =
        useRef<any>(null);


    // --------------------------------------
    // Audio refs
    // --------------------------------------

    const audioContextRef =
        useRef<AudioContext | null>(
            null
        );

    const micStreamRef =
        useRef<MediaStream | null>(
            null
        );

    const sourceRef =
        useRef<MediaStreamAudioSourceNode | null>(
            null
        );

    const gainRef =
        useRef<GainNode | null>(
            null
        );

    const analyserRef =
        useRef<AnalyserNode | null>(
            null
        );

    const workletRef =
        useRef<AudioWorkletNode | null>(
            null
        );

    const monitorGainRef =
        useRef<GainNode | null>(
            null
        );

    const animationRef =
        useRef<number | null>(
            null
        );


    // --------------------------------------
    // Gemini output audio
    // --------------------------------------

    const outputSourcesRef =
        useRef<
            Set<AudioBufferSourceNode>
        >(new Set());

    const outputQueueTimeRef =
        useRef(0);


    // --------------------------------------
    // Transcription refs
    // --------------------------------------

    const currentUserTextRef =
        useRef("");

    const currentGeminiTextRef =
        useRef("");


    // --------------------------------------
    // VAD refs
    // --------------------------------------

    const speechActiveRef =
        useRef(false);

    const finishingTurnRef =
        useRef(false);


    // ========================================
    // GET VIDEO URL
    // ========================================

    useEffect(() => {

        const params =
            new URLSearchParams(
                window.location.search
            );

        setVideoUrl(
            params.get("video") ||
            ""
        );

    }, []);


    // ========================================
    // LOAD YOUTUBE TRANSCRIPT
    // ========================================

    const loadTranscript =
        useCallback(
            async () => {

                if (!videoUrl) {
                    return [];
                }

                setTranscriptLoading(true);
                setStatus("Loading lecture...");

                try {

                    const response =
                        await fetch(
                            "/api/youtube-transcript",
                            {
                                method: "POST",
                                headers: {
                                    "Content-Type":
                                        "application/json",
                                },
                                body: JSON.stringify({
                                    videoUrl,
                                }),
                            }
                        );

                    const data =
                        await response.json();

                    if (!response.ok) {
                        throw new Error(
                            data.error ||
                            "Could not load YouTube transcript"
                        );
                    }

                    const segments =
                        Array.isArray(data.transcript)
                            ? data.transcript
                            : [];

                    setTranscript(segments);

                    return segments as TranscriptSegment[];

                } finally {

                    setTranscriptLoading(false);

                }

            },
            [videoUrl]
        );


    useEffect(() => {

        if (!videoUrl) {
            return;
        }

        setTranscript([]);
        setLectureContext("");

        void loadTranscript()
            .then(() => {
                setStatus("Ready");
            })
            .catch((error) => {
                console.error(
                    "Transcript load error:",
                    error
                );

                setStatus(
                    error instanceof Error
                        ? error.message
                        : "Could not load lecture transcript"
                );
            });

    }, [videoUrl, loadTranscript]);


    // ========================================
    // STOP GEMINI AUDIO
    // ========================================

    const stopAudioPlayback =
        useCallback(() => {

            for (
                const source of
                outputSourcesRef.current
            ) {
                try {
                    source.stop();
                } catch { }
            }

            outputSourcesRef.current.clear();

            const ctx =
                audioContextRef.current;

            outputQueueTimeRef.current =
                ctx
                    ? ctx.currentTime
                    : 0;

        }, []);


    // ========================================
    // PLAY GEMINI AUDIO
    // ========================================

    const playGeminiAudio =
        useCallback(
            (
                base64: string
            ) => {

                const ctx =
                    audioContextRef.current;

                if (!ctx) {
                    return;
                }

                const pcm =
                    base64ToInt16(
                        base64
                    );

                if (
                    !pcm.length
                ) {
                    return;
                }

                const buffer =
                    ctx.createBuffer(
                        1,
                        pcm.length,
                        24000
                    );

                const channel =
                    buffer.getChannelData(
                        0
                    );

                for (
                    let i = 0;
                    i < pcm.length;
                    i++
                ) {
                    channel[i] =
                        pcm[i] / 32768;
                }

                const source =
                    ctx.createBufferSource();

                source.buffer =
                    buffer;

                source.connect(
                    ctx.destination
                );

                const startAt =
                    Math.max(
                        ctx.currentTime +
                        0.06,
                        outputQueueTimeRef.current
                    );

                source.start(
                    startAt
                );

                outputQueueTimeRef.current =
                    startAt +
                    buffer.duration;

                outputSourcesRef.current.add(
                    source
                );

                source.onended =
                    () => {

                        outputSourcesRef.current.delete(
                            source
                        );

                    };

            },
            []
        );


    // ========================================
    // STOP MICROPHONE
    // ========================================

    const stopMicrophone =
        useCallback(() => {

            if (
                animationRef.current !==
                null
            ) {

                cancelAnimationFrame(
                    animationRef.current
                );

                animationRef.current =
                    null;

            }


            try {
                sourceRef.current?.disconnect();
            } catch { }

            try {
                gainRef.current?.disconnect();
            } catch { }

            try {
                analyserRef.current?.disconnect();
            } catch { }

            try {
                workletRef.current?.disconnect();
            } catch { }

            try {
                monitorGainRef.current?.disconnect();
            } catch { }


            micStreamRef.current
                ?.getTracks()
                .forEach(
                    (track) =>
                        track.stop()
                );


            micStreamRef.current =
                null;


            const ctx =
                audioContextRef.current;

            audioContextRef.current =
                null;


            if (
                ctx &&
                ctx.state !==
                "closed"
            ) {

                void ctx.close();

            }


            sourceRef.current =
                null;

            gainRef.current =
                null;

            analyserRef.current =
                null;

            workletRef.current =
                null;

            monitorGainRef.current =
                null;


            speechActiveRef.current =
                false;

            finishingTurnRef.current =
                false;


            setSpeaking(false);

            setMicLevel(0);

        }, []);


    // ========================================
    // CLOSE GEMINI SESSION
    // ========================================

    const closeGeminiSession =
        useCallback(() => {

            try {
                sessionRef.current?.close?.();
            } catch { }

            sessionRef.current =
                null;

        }, []);


    // ========================================
    // SAVE CONVERSATION
    // ========================================

    const addFinishedConversation =
        useCallback(() => {

            const userText =
                currentUserTextRef.current
                    .trim();

            const geminiText =
                currentGeminiTextRef.current
                    .trim();


            if (userText) {

                setConversation(
                    (prev) => [
                        ...prev,

                        {
                            role: "user",
                            text: userText,
                        },

                    ]
                );

            }


            if (geminiText) {

                setConversation(
                    (prev) => [
                        ...prev,

                        {
                            role: "gemini",
                            text:
                                geminiText,
                        },

                    ]
                );

            }


            currentUserTextRef.current =
                "";

            currentGeminiTextRef.current =
                "";

        }, []);


    // ========================================
    // FINISH SPEECH TURN
    // ========================================

    const finishTurn =
        useCallback(() => {

            const session =
                sessionRef.current;

            if (
                !session ||
                finishingTurnRef.current
            ) {
                return;
            }


            finishingTurnRef.current =
                true;

            speechActiveRef.current =
                false;

            setSpeaking(false);

            setStatus(
                "Thinking..."
            );


            try {

                session.sendRealtimeInput({
                    audioStreamEnd: true,
                });

            } catch (error) {

                console.error(
                    "audioStreamEnd error:",
                    error
                );

                finishingTurnRef.current =
                    false;

            }

        }, []);


    // ========================================
    // START MICROPHONE
    // ========================================

    const startMicrophone =
        useCallback(
            async () => {

                if (
                    !sessionRef.current
                ) {
                    return;
                }


                const stream =
                    await navigator
                        .mediaDevices
                        .getUserMedia({
                            audio: {
                                channelCount: 1,
                                echoCancellation: true,
                                noiseSuppression: true,
                                autoGainControl: true,
                            },
                        });


                micStreamRef.current =
                    stream;


                const ctx =
                    new AudioContext();

                audioContextRef.current =
                    ctx;


                if (
                    ctx.state ===
                    "suspended"
                ) {

                    await ctx.resume();

                }


                await ctx.audioWorklet
                    .addModule(
                        "/pcm-worklet.js"
                    );


                const source =
                    ctx.createMediaStreamSource(
                        stream
                    );

                const gain =
                    ctx.createGain();

                const analyser =
                    ctx.createAnalyser();

                const worklet =
                    new AudioWorkletNode(
                        ctx,
                        "pcm-processor"
                    );

                const monitorGain =
                    ctx.createGain();


                gain.gain.value =
                    1;

                analyser.fftSize =
                    1024;

                monitorGain.gain.value =
                    0;


                source.connect(
                    gain
                );

                gain.connect(
                    analyser
                );

                gain.connect(
                    worklet
                );

                worklet.connect(
                    monitorGain
                );

                monitorGain.connect(
                    ctx.destination
                );


                sourceRef.current =
                    source;

                gainRef.current =
                    gain;

                analyserRef.current =
                    analyser;

                workletRef.current =
                    worklet;

                monitorGainRef.current =
                    monitorGain;


                // --------------------------------
                // WORKLET MESSAGES
                // --------------------------------

                worklet.port.onmessage =
                    (
                        event: MessageEvent<WorkletMessage>
                    ) => {

                        const message =
                            event.data;

                        const session =
                            sessionRef.current;


                        // Speech started
                        if (
                            message.type ===
                            "speechStart"
                        ) {

                            if (
                                !speechActiveRef.current
                            ) {

                                speechActiveRef.current =
                                    true;

                                finishingTurnRef.current =
                                    false;

                                setSpeaking(true);

                                setStatus(
                                    "Listening..."
                                );

                            }

                            return;
                        }


                        // Speech ended
                        if (
                            message.type ===
                            "speechEnd"
                        ) {

                            if (
                                speechActiveRef.current
                            ) {

                                finishTurn();

                            }

                            return;
                        }


                        // Audio
                        if (
                            message.type !==
                            "audio" ||
                            !session
                        ) {
                            return;
                        }


                        try {

                            const base64 =
                                float32ToPCM16Base64(
                                    message.data
                                );


                            session.sendRealtimeInput({
                                audio: {
                                    data:
                                        base64,

                                    mimeType:
                                        "audio/pcm;rate=16000",
                                },
                            });

                        } catch (error) {

                            console.error(
                                "Audio send error:",
                                error
                            );

                        }

                    };


                // --------------------------------
                // MICROPHONE LEVEL
                // --------------------------------

                const updateLevel =
                    () => {

                        const analyser =
                            analyserRef.current;

                        if (!analyser) {
                            return;
                        }


                        const data =
                            new Uint8Array(
                                analyser.fftSize
                            );


                        analyser
                            .getByteTimeDomainData(
                                data
                            );


                        let sum = 0;


                        for (
                            const value of data
                        ) {

                            const normalized =
                                (value - 128) /
                                128;

                            sum +=
                                normalized *
                                normalized;

                        }


                        const rms =
                            Math.sqrt(
                                sum /
                                data.length
                            );


                        setMicLevel(
                            Math.min(
                                100,
                                Math.round(
                                    rms * 1000
                                )
                            )
                        );


                        animationRef.current =
                            requestAnimationFrame(
                                updateLevel
                            );

                    };


                updateLevel();

            },
            [finishTurn]
        );


    // ========================================
    // CREATE GEMINI LIVE SESSION
    // ========================================

    const createGeminiSession =
        useCallback(
            async (
                context: string
            ) => {

                // ----------------------------------
                // Get ephemeral token
                // ----------------------------------

                const response =
                    await fetch(
                        "/api/gemini-token"
                    );


                const data =
                    await response.json();


                if (
                    !response.ok ||
                    !data.token
                ) {

                    throw new Error(
                        data.error ||
                        "Could not get Gemini token"
                    );

                }


                // ----------------------------------
                // Gemini client
                // ----------------------------------

                const ai =
                    new GoogleGenAI({
                        apiKey:
                            data.token,
                    });


                // ----------------------------------
                // Live session
                // ----------------------------------

                const session =
                    await ai.live.connect({

                        model:
                            "gemini-3.1-flash-live-preview",


                        config: {

                            responseModalities: [
                                Modality.AUDIO,
                            ],


                            inputAudioTranscription:
                                {},

                            outputAudioTranscription:
                                {},


                            // --------------------------------
                            // Hybrid VAD
                            // --------------------------------

                            realtimeInputConfig: {

                                automaticActivityDetection:
                                {

                                    disabled:
                                        true,

                                    prefixPaddingMs:
                                        300,

                                    silenceDurationMs:
                                        1500,

                                },

                            },


                            // --------------------------------
                            // AI TUTOR INSTRUCTIONS
                            // --------------------------------

                            systemInstruction: {

                                parts: [

                                    {

                                        text: `

You are the AI Tutor inside
"Ready to Learn".

You are helping a student understand
a video lecture.

========================================
PRIMARY CONTEXT
========================================

The student is currently learning from
the relevant lecture transcript provided below.

Use the lecture context as your PRIMARY
context.

However, you are NOT restricted to the
lecture.

You can and SHOULD use your own general
knowledge whenever it helps the student
understand something better.

========================================
YOUR TEACHING GOAL
========================================

Your goal is NOT simply to answer the
student's question.

Your goal is to make the student
UNDERSTAND the concept.

If the student's question is unclear,
interpret it in the context of the
lecture.

If the student does not understand your
first explanation, DO NOT simply repeat
the same explanation.

Change your teaching strategy.

For example:

First:
Give a simple explanation.

If they still don't understand:
Use an analogy.

If necessary:
Give a tiny concrete example.

If necessary:
Explain the prerequisite concept.

Then:
Connect everything back to the lecture.

========================================
USE YOUR OWN KNOWLEDGE
========================================

You are allowed to use your own knowledge
to:

- clarify difficult concepts
- simplify explanations
- provide examples
- create analogies
- explain prerequisites
- correct misconceptions
- add missing information
- connect related concepts
- explain things the lecturer skipped
- correct technically incorrect statements

Do not blindly repeat the lecturer.

If the lecturer is incorrect or
incomplete, politely correct or clarify
the information.

========================================
CONVERSATION
========================================

Remember the conversation within the
current doubt session.

If the student asks a follow-up question,
connect it to what they previously asked.

Do not treat every question as a
completely new question.

========================================
SPEAKING STYLE
========================================

You are speaking to the student.

Be natural.

Avoid unnecessarily long answers.

Use simple language when possible.

When technical detail is required,
explain it clearly.

Do not sound like a textbook.

Teach like a patient expert tutor.

========================================
LECTURE CONTEXT
========================================

${context}

========================================
END LECTURE TRANSCRIPT CONTEXT
========================================

`,

                                    },

                                ],

                            },

                        },


                        // ==================================
                        // CALLBACKS
                        // ==================================

                        callbacks: {

                            onopen: () => {

                                setStatus(
                                    "Listening..."
                                );

                            },


                            onmessage: (
                                message: any
                            ) => {

                                const content =
                                    message?.serverContent;

                                if (!content) {
                                    return;
                                }


                                // --------------------------------
                                // Gemini interrupted
                                // --------------------------------

                                if (
                                    content.interrupted
                                ) {

                                    stopAudioPlayback();

                                }


                                // --------------------------------
                                // User transcript
                                // --------------------------------

                                if (
                                    content
                                        .inputTranscription
                                        ?.text
                                ) {

                                    currentUserTextRef.current +=
                                        content
                                            .inputTranscription
                                            .text;

                                }


                                // --------------------------------
                                // Gemini transcript
                                // --------------------------------

                                if (
                                    content
                                        .outputTranscription
                                        ?.text
                                ) {

                                    currentGeminiTextRef.current +=
                                        content
                                            .outputTranscription
                                            .text;

                                }


                                // --------------------------------
                                // Gemini audio
                                // --------------------------------

                                const parts =
                                    content
                                        .modelTurn
                                        ?.parts || [];


                                for (
                                    const part of parts
                                ) {

                                    if (
                                        part
                                            .inlineData
                                            ?.data
                                    ) {

                                        playGeminiAudio(
                                            part
                                                .inlineData
                                                .data
                                        );

                                    }

                                }


                                // --------------------------------
                                // Turn complete
                                // --------------------------------

                                if (
                                    content.turnComplete
                                ) {

                                    finishingTurnRef.current =
                                        false;

                                    speechActiveRef.current =
                                        false;

                                    setSpeaking(
                                        false
                                    );

                                    setStatus(
                                        "Listening..."
                                    );

                                    addFinishedConversation();

                                }

                            },


                            onerror: (
                                error: any
                            ) => {

                                console.error(
                                    "Gemini Live error:",
                                    error
                                );

                                setStatus(
                                    "Gemini connection error"
                                );

                            },


                            onclose: (
                                event: any
                            ) => {

                                console.log(
                                    "Gemini Live closed:",
                                    event?.reason ||
                                    "closed"
                                );

                            },

                        },

                    });


                sessionRef.current =
                    session;

            },
            [
                addFinishedConversation,
                playGeminiAudio,
                stopAudioPlayback,
            ]
        );


    // ========================================
    // PREPARE LECTURE CONTEXT
    // ========================================

    const analyzeLecture =
        useCallback(
            async (
                timestamp: number
            ) => {

                setLectureLoading(true);

                setStatus("Preparing lecture context...");

                try {

                    // 2 minutes before the pause
                    // 30 seconds after the pause
                    const startTime =
                        Math.max(0, timestamp - 120);

                    const endTime =
                        timestamp + 30;

                    let availableTranscript =
                        transcript;

                    // If the initial transcript request
                    // has not finished yet, load it now.
                    if (!availableTranscript.length) {
                        availableTranscript =
                            await loadTranscript();
                    }

                    if (!availableTranscript.length) {
                        throw new Error(
                            "No YouTube transcript is available for this lecture."
                        );
                    }

                    const relevantSegments =
                        availableTranscript.filter(
                            (segment) => {

                                const segmentStart =
                                    segment.offset;

                                const segmentEnd =
                                    segment.offset +
                                    segment.duration;

                                return (
                                    segmentEnd >= startTime &&
                                    segmentStart <= endTime
                                );

                            }
                        );

                    if (!relevantSegments.length) {
                        throw new Error(
                            "No transcript was found around the current timestamp."
                        );
                    }

                    // Do not send timestamp spam to Gemini.
                    const context =
                        relevantSegments
                            .map(
                                (segment) =>
                                    segment.text
                            )
                            .join(" ");

                    setLectureContext(context);

                    return context;

                } finally {

                    setLectureLoading(false);

                }

            },
            [loadTranscript, transcript]
        );


    // ========================================
    // ASK A DOUBT
    // ========================================

    const askDoubt =
        useCallback(
            async () => {

                if (
                    !playerRef.current
                ) {
                    return;
                }


                // Reset current conversation
                currentUserTextRef.current =
                    "";

                currentGeminiTextRef.current =
                    "";


                setConversation([]);

                setLectureContext("");


                try {

                    // --------------------------------
                    // Get exact current time
                    // --------------------------------

                    const currentTime =
                        playerRef.current
                            .getCurrentTime();


                    const exactTime =
                        Math.floor(
                            currentTime
                        );


                    // --------------------------------
                    // PAUSE VIDEO IMMEDIATELY
                    // --------------------------------

                    playerRef.current
                        .pauseVideo();


                    setPausedAt(
                        exactTime
                    );


                    setDoubtMode(
                        true
                    );


                    // --------------------------------
                    // PREPARE 2 MIN BACK + 30 SEC FORWARD
                    // --------------------------------

                    const context =
                        await analyzeLecture(
                            exactTime
                        );


                    // --------------------------------
                    // START AI TUTOR
                    // --------------------------------

                    setStatus(
                        "Starting AI tutor..."
                    );


                    await createGeminiSession(
                        context
                    );


                    // --------------------------------
                    // START MICROPHONE
                    // --------------------------------

                    await startMicrophone();


                    setStatus(
                        "Listening..."
                    );

                } catch (error) {

                    console.error(
                        "Ask doubt error:",
                        error
                    );


                    setStatus(
                        error instanceof Error
                            ? error.message
                            : "Could not start AI tutor"
                    );


                    stopMicrophone();

                    closeGeminiSession();

                    setDoubtMode(
                        false
                    );

                }

            },
            [
                analyzeLecture,
                closeGeminiSession,
                createGeminiSession,
                startMicrophone,
                stopMicrophone,
            ]
        );


    // ========================================
    // CONTINUE LECTURE
    // ========================================

    const continueLecture =
        useCallback(() => {

            // Stop Gemini audio
            stopAudioPlayback();

            // Stop microphone
            stopMicrophone();

            // Close Gemini
            closeGeminiSession();


            setDoubtMode(
                false
            );

            setStatus(
                "Lecture resumed"
            );


            // --------------------------------
            // Resume exact timestamp
            // --------------------------------

            if (
                playerRef.current &&
                pausedAt !== null
            ) {

                playerRef.current
                    .seekTo(
                        pausedAt,
                        true
                    );

                playerRef.current
                    .playVideo();

            }

        }, [
            closeGeminiSession,
            pausedAt,
            stopAudioPlayback,
            stopMicrophone,
        ]);


    // ========================================
    // MANUAL FALLBACK
    // ========================================

    const manualFinish =
        useCallback(() => {

            if (
                speechActiveRef.current
            ) {

                finishTurn();

                return;

            }


            if (
                sessionRef.current
            ) {

                setStatus(
                    "Thinking..."
                );


                try {

                    sessionRef.current
                        .sendRealtimeInput({
                            audioStreamEnd:
                                true,
                        });

                } catch (error) {

                    console.error(
                        error
                    );

                }

            }

        }, [finishTurn]);


    // ========================================
    // CLEANUP
    // ========================================

    useEffect(() => {

        return () => {

            stopAudioPlayback();

            stopMicrophone();

            closeGeminiSession();

        };

    }, [
        closeGeminiSession,
        stopAudioPlayback,
        stopMicrophone,
    ]);


    // ========================================
    // FORMAT TIME
    // ========================================

    const formatTime =
        (seconds: number) => {

            const mins =
                Math.floor(
                    seconds / 60
                );

            const secs =
                seconds % 60;

            return `${mins}:${secs
                .toString()
                .padStart(2, "0")}`;

        };


    // ========================================
    // UI
    // ========================================

    return (

        <main className="min-h-screen bg-black px-6 py-8 text-white">

            <div className="mx-auto max-w-6xl">


                {/* ==================================
            HEADER
        ================================== */}

                <h1 className="mb-2 text-3xl font-bold">

                    Ready to Learn

                </h1>


                <p className="mb-6 text-zinc-400">

                    Watch. Ask. Understand. Continue.

                </p>


                <div className="grid gap-6 lg:grid-cols-[1.5fr_1fr]">


                    {/* ==================================
              VIDEO
          ================================== */}

                    <section>

                        <div className="overflow-hidden rounded-2xl bg-zinc-900">

                            {videoUrl ? (

                                <YouTube

                                    videoId={
                                        getYouTubeVideoId(
                                            videoUrl
                                        )
                                    }

                                    opts={{

                                        width:
                                            "100%",

                                        height:
                                            "500",

                                        playerVars: {

                                            autoplay:
                                                0,

                                            rel:
                                                0,

                                        },

                                    }}


                                    onReady={(
                                        event
                                    ) => {

                                        playerRef.current =
                                            event.target;

                                    }}

                                />

                            ) : (

                                <div className="flex h-[500px] items-center justify-center text-zinc-500">

                                    No video selected.

                                </div>

                            )}

                        </div>


                        {/* ==================================
                MAIN BUTTON
            ================================== */}

                        {!doubtMode ? (

                            <button

                                onMouseDown={(
                                    event
                                ) =>
                                    event.preventDefault()
                                }

                                onClick={
                                    askDoubt
                                }

                                disabled={
                                    lectureLoading ||
                                    transcriptLoading
                                }

                                className="mt-4 w-full rounded-xl bg-white px-5 py-4 font-semibold text-black transition hover:bg-zinc-200 disabled:cursor-not-allowed disabled:opacity-50 select-none"

                            >

                                {transcriptLoading
                                    ? "Loading Lecture..."
                                    : lectureLoading
                                        ? "Preparing Context..."
                                        : "Ask a Doubt"}

                            </button>

                        ) : (

                            <button

                                onMouseDown={(
                                    event
                                ) =>
                                    event.preventDefault()
                                }

                                onClick={
                                    continueLecture
                                }

                                className="mt-4 w-full rounded-xl bg-white px-5 py-4 font-semibold text-black transition hover:bg-zinc-200 select-none"

                            >

                                Continue Lecture

                            </button>

                        )}

                    </section>


                    {/* ==================================
              AI TUTOR
          ================================== */}

                    <section className="rounded-2xl border border-zinc-800 bg-zinc-950 p-5">


                        {/* HEADER */}

                        <div className="mb-4 flex items-center justify-between">

                            <h2 className="text-xl font-semibold">

                                AI Tutor

                            </h2>


                            <span className="text-sm text-zinc-400">

                                {status}

                            </span>

                        </div>


                        {/* ==================================
                TIMESTAMP
            ================================== */}

                        {pausedAt !== null &&
                            doubtMode && (

                                <div className="mb-4 rounded-lg bg-zinc-900 px-4 py-3 text-sm text-zinc-300">

                                    Lecture paused at{" "}

                                    <strong>

                                        {formatTime(
                                            pausedAt
                                        )}

                                    </strong>

                                </div>

                            )}


                        {/* ==================================
                LECTURE CONTEXT
            ================================== */}

                        {doubtMode && (

                            <div className="mb-4 rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-3">

                                <div className="flex items-center justify-between">

                                    <span className="text-sm text-zinc-300">

                                        Lecture context

                                    </span>


                                    <span className="text-xs text-zinc-500">

                                        {lectureLoading
                                            ? "Preparing..."
                                            : lectureContext
                                                ? "Connected"
                                                : transcriptLoading
                                                    ? "Loading..."
                                                    : "Waiting"}

                                    </span>

                                </div>


                                {!lectureContext && transcriptLoading && (

                                    <p className="mt-2 text-xs text-zinc-500">

                                        Loading the lecture transcript so the
                                        tutor can use the relevant part instantly
                                        when you ask a doubt.

                                    </p>

                                )}


                                {lectureContext && (

                                    <p className="mt-2 text-xs text-zinc-500">

                                        Gemini is using the
                                        lecture from 2 minutes
                                        before your pause through
                                        30 seconds after it, together
                                        with its own knowledge.

                                    </p>

                                )}

                            </div>

                        )}


                        {/* ==================================
                MICROPHONE
            ================================== */}

                        {doubtMode && (

                            <div className="mb-4 rounded-lg bg-zinc-900 px-4 py-3 text-sm text-zinc-300">

                                <div className="flex items-center justify-between">

                                    <span>
                                        Microphone
                                    </span>


                                    <span>

                                        {speaking
                                            ? "Speaking"
                                            : "Waiting"}

                                    </span>

                                </div>


                                <div className="mt-2 h-2 overflow-hidden rounded-full bg-zinc-800">

                                    <div

                                        className="h-full rounded-full bg-white transition-all"

                                        style={{
                                            width: `${Math.min(
                                                100,
                                                micLevel
                                            )}%`,
                                        }}

                                    />

                                </div>

                            </div>

                        )}


                        {/* ==================================
                CONVERSATION
            ================================== */}

                        <div className="min-h-[300px] space-y-3 overflow-y-auto">

                            {conversation.length ===
                                0 ? (

                                <p className="text-sm text-zinc-500">

                                    {doubtMode
                                        ? "Start speaking. Ask anything about the lecture."
                                        : "Pause the lecture and ask your doubt here."}

                                </p>

                            ) : (

                                conversation.map(
                                    (
                                        message,
                                        index
                                    ) => (

                                        <div

                                            key={`${message.role}-${index}`}

                                            className={`rounded-xl p-3 text-sm ${message.role ===
                                                "user"
                                                ? "ml-8 bg-zinc-800 text-white"
                                                : "mr-8 bg-zinc-900 text-zinc-200"
                                                }`}

                                        >

                                            <div className="mb-1 text-xs font-semibold uppercase text-zinc-500">

                                                {message.role ===
                                                    "user"
                                                    ? "You"
                                                    : "Gemini"}

                                            </div>


                                            {message.text}

                                        </div>

                                    )
                                )

                            )}

                        </div>


                        {/* ==================================
                MANUAL FALLBACK
            ================================== */}

                        {doubtMode && (

                            <button

                                onMouseDown={(
                                    event
                                ) =>
                                    event.preventDefault()
                                }

                                onClick={
                                    manualFinish
                                }

                                className="mt-4 w-full rounded-xl border border-zinc-700 px-4 py-3 text-sm font-medium text-zinc-200 hover:bg-zinc-900 select-none"

                            >

                                Finish & Ask Now

                            </button>

                        )}

                    </section>

                </div>

            </div>

        </main>

    );
}