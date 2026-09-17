import { NextRequest, NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";

export const runtime = "nodejs";

const MODEL = "gemini-3.8-flash";
const CONTEXT_WINDOW_BEFORE_SECONDS = 90;
const CONTEXT_WINDOW_AFTER_SECONDS = 30;
const TIMESTAMP_BUCKET_SECONDS = 20;
const MAX_RETRIES = 1;
const INITIAL_RETRY_DELAY_MS = 1500;
const CACHE_TTL_MS = 10 * 60 * 1000;

type CacheEntry = {
    context: string;
    interactionId?: string;
    createdAt: number;
};

const cache = new Map<string, CacheEntry>();

function formatTimestamp(totalSeconds: number): string {
    const safeSeconds = Math.max(0, Math.floor(totalSeconds));
    const minutes = Math.floor(safeSeconds / 60);
    const seconds = safeSeconds % 60;
    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(
        2,
        "0"
    )}`;
}

function extractYoutubeVideoId(url: string): string {
    const value = url.trim();

    if (/^[a-zA-Z0-9_-]{11}$/.test(value)) {
        return value;
    }

    try {
        const parsed = new URL(value);
        const hostname = parsed.hostname.toLowerCase();

        if (hostname === "youtu.be" || hostname.endsWith(".youtu.be")) {
            return parsed.pathname.replace(/^\/+/, "").split("/")[0] || "";
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

function normalizeYoutubeUrl(url: string): string | null {
    const id = extractYoutubeVideoId(url);
    if (!id) return null;
    return `https://www.youtube.com/watch?v=${id}`;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractStatusCode(error: unknown): number {
    if (error && typeof error === "object") {
        const anyError = error as Record<string, unknown>;
        if (typeof anyError.status === "number") return anyError.status;
        if (typeof anyError.code === "number") return anyError.code;
        const message =
            typeof anyError.message === "string" ? anyError.message : "";
        const match = message.match(/"code"\s*:\s*(\d+)/);
        if (match) return parseInt(match[1], 10);
        const statusMatch = message.match(/\b(429|503|500|400|403|404)\b/);
        if (statusMatch) return parseInt(statusMatch[1], 10);
    }
    return 500;
}

function extractErrorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (typeof error === "string") return error;
    return "Unknown error from Gemini API";
}

function bucketTimestamp(timestamp: number): number {
    return (
        Math.floor(timestamp / TIMESTAMP_BUCKET_SECONDS) *
        TIMESTAMP_BUCKET_SECONDS
    );
}

function extractInteractionText(interaction: any): string | undefined {
    try {
        const fromSteps = interaction?.steps?.at?.(-1)?.content?.[0]?.text;
        if (typeof fromSteps === "string" && fromSteps.trim()) {
            return fromSteps;
        }
    } catch {
        // fall through to other accessors
    }

    if (
        typeof interaction?.outputText === "string" &&
        interaction.outputText.trim()
    ) {
        return interaction.outputText;
    }

    if (
        typeof interaction?.output_text === "string" &&
        interaction.output_text.trim()
    ) {
        return interaction.output_text;
    }

    return undefined;
}

export async function POST(request: NextRequest) {
    let body: { videoUrl?: string; timestamp?: number };

    try {
        body = await request.json();
    } catch {
        return NextResponse.json(
            { success: false, error: "Request body must be valid JSON." },
            { status: 400 }
        );
    }

    const { videoUrl, timestamp } = body;

    if (!videoUrl || typeof videoUrl !== "string") {
        return NextResponse.json(
            { success: false, error: "A 'videoUrl' string is required." },
            { status: 400 }
        );
    }

    const normalizedUrl = normalizeYoutubeUrl(videoUrl);

    if (!normalizedUrl) {
        return NextResponse.json(
            { success: false, error: "Could not parse a valid YouTube video from 'videoUrl'." },
            { status: 400 }
        );
    }

    if (
        timestamp === undefined ||
        typeof timestamp !== "number" ||
        !Number.isFinite(timestamp) ||
        timestamp < 0
    ) {
        return NextResponse.json(
            {
                success: false,
                error: "A valid non-negative numeric 'timestamp' (in seconds) is required.",
            },
            { status: 400 }
        );
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        return NextResponse.json(
            { success: false, error: "GEMINI_API_KEY is not configured on the server." },
            { status: 500 }
        );
    }

    const timestampText = formatTimestamp(timestamp);
    const bucketedTimestamp = bucketTimestamp(timestamp);
    const windowStart = Math.max(
        0,
        bucketedTimestamp - CONTEXT_WINDOW_BEFORE_SECONDS
    );
    const windowEnd =
        bucketedTimestamp + TIMESTAMP_BUCKET_SECONDS + CONTEXT_WINDOW_AFTER_SECONDS;

    const cacheKey = `${normalizedUrl}::${bucketedTimestamp}`;
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.createdAt < CACHE_TTL_MS) {
        return NextResponse.json({
            success: true,
            context: cached.context,
            timestamp,
            timestampText,
            interactionId: cached.interactionId,
            model: MODEL,
            cached: true,
        });
    }

    const ai = new GoogleGenAI({ apiKey });

    const promptText = [
        "This is an educational lecture video.",
        `The student paused it at ${timestampText} (${timestamp} seconds in).`,
        `Analyze the actual content of this lecture, focusing especially on what is happening between roughly ${formatTimestamp(windowStart)} and ${formatTimestamp(windowEnd)}, using the rest of the video as context if it helps make that part understandable.`,
        "Identify the topic being taught.",
        "Explain the concept(s) being covered.",
        "Identify any definitions given.",
        "Identify any equations or formulas shown or spoken, and write them out exactly.",
        "Identify any code shown, and describe what it does.",
        "Identify any diagrams shown, and describe their structure and labels.",
        "Identify any examples given.",
        "Explain what the lecturer is teaching at this point and what the student should understand by now.",
        "Do not invent information that is not actually present in the video.",
        "Return a clear, well-structured block of text suitable as background context for a separate AI tutor that has not seen the video.",
    ].join(" ");

    let lastError: unknown = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
            const interaction: any = await ai.interactions.create({
                model: MODEL,
                input: [
                    { type: "text", text: promptText },
                    { type: "video", uri: normalizedUrl },
                ],
            } as any);

            const context = extractInteractionText(interaction);

            if (!context) {
                return NextResponse.json(
                    { success: false, error: "Gemini returned an empty response for this video." },
                    { status: 502 }
                );
            }

            cache.set(cacheKey, {
                context,
                interactionId: interaction.id,
                createdAt: Date.now(),
            });

            return NextResponse.json({
                success: true,
                context,
                timestamp,
                timestampText,
                interactionId: interaction.id,
                model: MODEL,
            });
        } catch (error) {
            lastError = error;
            const statusCode = extractStatusCode(error);
            const isRetryable = statusCode === 503;

            if (isRetryable && attempt < MAX_RETRIES) {
                await sleep(INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt));
                continue;
            }

            const message = extractErrorMessage(error);

            if (statusCode === 429) {
                return NextResponse.json(
                    {
                        success: false,
                        error: "Gemini API quota exceeded (429 RESOURCE_EXHAUSTED). Check https://aistudio.google.com/usage — this is a project quota/billing issue, not a code bug.",
                        details: message,
                    },
                    { status: 429 }
                );
            }

            if (statusCode === 503) {
                return NextResponse.json(
                    {
                        success: false,
                        error: "Gemini API is temporarily unavailable (503 UNAVAILABLE). Please retry shortly.",
                        details: message,
                    },
                    { status: 503 }
                );
            }

            return NextResponse.json(
                { success: false, error: "Gemini API request failed.", details: message },
                { status: statusCode >= 400 && statusCode < 600 ? statusCode : 500 }
            );
        }
    }

    return NextResponse.json(
        {
            success: false,
            error: "Gemini API request failed after retries.",
            details: extractErrorMessage(lastError),
        },
        { status: 500 }
    );
}