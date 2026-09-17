import { NextRequest, NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";

export const runtime = "nodejs";

const MODEL = "gemini-3.8-flash";
const MAX_RETRIES = 1;
const INITIAL_RETRY_DELAY_MS = 1500;

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

function extractInteractionText(interaction: any): string | undefined {
    try {
        const fromSteps = interaction?.steps?.at?.(-1)?.content?.[0]?.text;
        if (typeof fromSteps === "string" && fromSteps.trim()) {
            return fromSteps;
        }
    } catch {
        // fall through
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
    let body: { interactionId?: string; question?: string };

    try {
        body = await request.json();
    } catch {
        return NextResponse.json(
            { success: false, error: "Request body must be valid JSON." },
            { status: 400 }
        );
    }

    const { interactionId, question } = body;

    if (!interactionId || typeof interactionId !== "string") {
        return NextResponse.json(
            {
                success: false,
                error: "Missing 'interactionId'. Call /api/lecture-context first, then pass the returned interactionId here.",
            },
            { status: 400 }
        );
    }

    if (!question || typeof question !== "string" || !question.trim()) {
        return NextResponse.json(
            { success: false, error: "A non-empty 'question' string is required." },
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

    const ai = new GoogleGenAI({ apiKey });

    const promptText = [
        "Continue analyzing the same lecture video you already looked at.",
        "Answer the following question using only what you actually saw and heard in the video — do not invent anything not present in it.",
        "If you cannot verify the answer from the video, say so honestly.",
        `Question: ${question.trim()}`,
    ].join(" ");

    let lastError: unknown = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
            const interaction: any = await ai.interactions.create({
                model: MODEL,
                previousInteractionId: interactionId,
                input: [{ type: "text", text: promptText }],
            } as any);

            const answer = extractInteractionText(interaction);

            if (!answer) {
                return NextResponse.json(
                    { success: false, error: "Gemini returned an empty answer." },
                    { status: 502 }
                );
            }

            return NextResponse.json({
                success: true,
                answer,
                interactionId: interaction.id,
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
                    { success: false, error: "Gemini API quota exceeded (429 RESOURCE_EXHAUSTED).", details: message },
                    { status: 429 }
                );
            }

            if (statusCode === 503) {
                return NextResponse.json(
                    { success: false, error: "Gemini API is temporarily unavailable (503 UNAVAILABLE).", details: message },
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