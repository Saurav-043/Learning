import { fetchTranscript } from "youtube-transcript-plus";

type TranscriptSegment = {
    text: string;
    duration: number;
    offset: number;
};

export async function POST(request: Request) {
    try {
        const body = await request.json();

        const { videoUrl } = body;

        if (!videoUrl || typeof videoUrl !== "string") {
            return Response.json(
                {
                    success: false,
                    error: "videoUrl is required",
                },
                { status: 400 }
            );
        }

        console.log(
            "Fetching YouTube transcript..."
        );

        const transcript =
            await fetchTranscript(
                videoUrl,
                {
                    lang: "en",
                }
            );

        const segments: TranscriptSegment[] =
            transcript.map(
                (segment) => ({
                    text: segment.text,
                    duration:
                        segment.duration,
                    offset:
                        segment.offset,
                })
            );

        if (!segments.length) {
            return Response.json(
                {
                    success: false,
                    error:
                        "No transcript was found for this YouTube video.",
                },
                { status: 404 }
            );
        }

        console.log(
            "YouTube transcript loaded:",
            segments.length,
            "segments"
        );

        return Response.json({
            success: true,
            transcript: segments,
        });

    } catch (error) {
        console.error(
            "YouTube transcript error:",
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