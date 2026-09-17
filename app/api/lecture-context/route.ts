import { GoogleGenAI } from "@google/genai";

type RequestBody = {
    videoUrl: string;
    timestamp: number;
};

function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function POST(request: Request) {
    try {
        const body = (await request.json()) as RequestBody;

        const { videoUrl, timestamp } = body;

        if (!videoUrl || typeof videoUrl !== "string") {
            return Response.json(
                {
                    success: false,
                    error: "videoUrl is required",
                },
                { status: 400 }
            );
        }

        if (typeof timestamp !== "number" || timestamp < 0) {
            return Response.json(
                {
                    success: false,
                    error: "timestamp must be a valid number",
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

        const startTime = Math.max(0, timestamp - 120);
        const endTime = timestamp + 30;

        const prompt = `
You are preparing context for an AI tutor inside a video learning application.

The student paused the lecture at approximately ${timestamp} seconds.

Analyze the ACTUAL VIDEO around this point.

Relevant section:
- Start: ${startTime} seconds
- Pause: ${timestamp} seconds
- End: ${endTime} seconds

Use BOTH:

1. What is spoken in the video.
2. What is visually shown on screen.

Pay special attention to:

- code shown on screen
- diagrams
- formulas
- graphs
- tables
- slides
- highlighted text
- UI demonstrations
- examples
- animations
- anything the lecturer points to
- relationships between spoken and visual information

Do not summarize the entire video.

Focus only on the section around the student's pause.

Prepare useful context for another AI tutor.

Include:

- the main concept
- definitions
- important reasoning
- formulas
- examples
- steps
- code
- diagrams
- visual information
- prerequisites
- assumptions
- likely misconceptions
- important connections to the surrounding lecture

The downstream AI tutor may freely use its own general knowledge to:

- simplify difficult concepts
- provide analogies
- provide additional examples
- explain prerequisites
- correct misconceptions
- fill gaps in the lecture
- connect related concepts
- explain things the lecturer skipped

Do not address the student directly.

Return only useful lecture context for the tutor.
`;

        let lastError: unknown = null;

        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                console.log(
                    `Gemini video analysis attempt ${attempt + 1}`
                );

                const interaction = await ai.interactions.create({
                    model: "gemini-3.8-flash",

                    input: [
                        {
                            type: "text",
                            text: prompt,
                        },

                        {
                            type: "video",
                            uri: videoUrl,
                        },
                    ],
                });

                const context =
                    interaction.output_text || "";

                if (!context.trim()) {
                    throw new Error(
                        "Gemini returned empty video context."
                    );
                }

                console.log(
                    "Gemini successfully understood video."
                );

                return Response.json({
                    success: true,
                    context,
                    timestamp,
                    startTime,
                    endTime,
                });
            } catch (error) {
                lastError = error;

                const message =
                    error instanceof Error
                        ? error.message
                        : String(error);

                console.error(
                    "Gemini video analysis error:",
                    message
                );

                const temporary =
                    message.includes("503") ||
                    message.includes("UNAVAILABLE") ||
                    message.includes("high demand") ||
                    message.includes(
                        "temporarily unavailable"
                    );

                if (!temporary) {
                    break;
                }

                if (attempt < 2) {
                    const delay =
                        1500 * Math.pow(2, attempt);

                    await sleep(delay);
                }
            }
        }

        return Response.json(
            {
                success: false,
                error:
                    lastError instanceof Error
                        ? lastError.message
                        : String(lastError),
            },
            { status: 500 }
        );
    } catch (error) {
        console.error(
            "Lecture context route error:",
            error
        );

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