import { GoogleGenAI } from "@google/genai";

export async function GET() {
    try {
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
            contents: "Say hello in one short sentence.",
        });

        return Response.json({
            success: true,
            response: response.text,
        });
    } catch (error) {
        console.error("Gemini test error:", error);

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