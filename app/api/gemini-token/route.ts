import { GoogleGenAI } from "@google/genai";

export async function GET() {
    try {
        const apiKey = process.env.GEMINI_API_KEY;

        if (!apiKey) {
            return Response.json(
                { error: "GEMINI_API_KEY is missing" },
                { status: 500 }
            );
        }

        const client = new GoogleGenAI({
            apiKey,
        });

        const expireTime = new Date(
            Date.now() + 30 * 60 * 1000
        ).toISOString();

        const token = await client.authTokens.create({
            config: {
                uses: 1,
                expireTime,

                liveConnectConstraints: {
                    model: "gemini-3.1-flash-live-preview",

                    config: {
                        responseModalities: ["AUDIO"],
                        sessionResumption: {},
                    },
                },
            },
        });

        return Response.json({
            token: token.name,
        });
    } catch (error) {
        console.error("Gemini token error:", error);

        return Response.json(
            {
                error:
                    error instanceof Error
                        ? error.message
                        : "Failed to create Gemini token",
            },
            { status: 500 }
        );
    }
}