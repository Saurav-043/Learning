import { GoogleGenAI } from "@google/genai";

export async function POST(request: Request) {
    try {
        const body = await request.json();

        const { videoUrl } = body;

        if (!videoUrl) {
            return Response.json(
                {
                    success: false,
                    error: "videoUrl is required",
                },
                { status: 400 }
            );
        }

        const apiKey = process.env.GEMINI_API_KEY;

        if (!apiKey) {
            return Response.json(
                {
                    success: false,
                    error: "GEMINI_API_KEY is missing",
                },
                { status: 500 }
            );
        }

        const ai = new GoogleGenAI({
            apiKey,
        });

        const response = await ai.models.generateContent({
            model: "gemini-3.8-flash",

            contents: [
                {
                    role: "user",
                    parts: [
                        {
                            fileData: {
                                fileUri: videoUrl,
                            },
                        },
                        {
                            text: "Briefly describe what this video is about.",
                        },
                    ],
                },
            ],
        });

        return Response.json({
            success: true,
            response: response.text || "",
        });
    } catch (error) {
        console.error("YouTube test error:", error);

        return Response.json(
            {
                success: false,
                error:
                    error instanceof Error
                        ? error.message
                        : String(error),
            },
            { status: 500 }
        );
    }
}