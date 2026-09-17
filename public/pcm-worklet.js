class PCMProcessor extends AudioWorkletProcessor {
    constructor() {
        super();

        this.inputBuffer = [];

        this.inputSampleRate = sampleRate;
        this.outputSampleRate = 16000;

        // Send 20 ms packets to Gemini.
        this.outputSamplesPerPacket = 320;

        // ================================
        // VAD STATE
        // ================================

        this.speaking = false;

        this.speechMs = 0;
        this.silenceMs = 0;

        // Estimated background noise.
        this.noiseFloor = 0.001;

        this.initialChunks = 0;

        this.speechStartThreshold = 0.003;
        this.speechEndThreshold = 0.0018;

        // Start detecting speech quickly.
        this.startHoldMs = 120;

        // Respond quickly after the user stops speaking.
        this.endSilenceMs = 600;

        // Keep approximately 60 ms of audio before speech starts.
        // This prevents the beginning of a word from being cut.
        this.preRoll = [];

        this.preRollMaxPackets = 3;
    }

    // ============================================
    // RMS / VOLUME
    // ============================================

    calculateRms(samples) {
        let sum = 0;

        for (let i = 0; i < samples.length; i++) {
            sum += samples[i] * samples[i];
        }

        return Math.sqrt(sum / samples.length);
    }

    // ============================================
    // ADAPTIVE NOISE FLOOR
    // ============================================

    updateNoiseFloor(rms) {
        // Never update the noise floor while the user is speaking.
        if (this.speaking) {
            return;
        }

        this.initialChunks++;

        // Quickly estimate the initial microphone noise.
        if (this.initialChunks <= 10) {
            this.noiseFloor =
                this.noiseFloor * 0.8 +
                rms * 0.2;
        }

        // Slowly adapt to environmental noise.
        else if (rms < this.noiseFloor * 1.8) {
            this.noiseFloor =
                this.noiseFloor * 0.98 +
                rms * 0.02;
        }

        // Speech must be clearly above the noise floor.
        this.speechStartThreshold = Math.min(
            0.005,
            Math.max(
                0.0025,
                this.noiseFloor * 1.8
            )
        );

        // Lower threshold for detecting the end of speech.
        this.speechEndThreshold = Math.min(
            0.003,
            Math.max(
                0.0015,
                this.noiseFloor * 1.25
            )
        );
    }

    // ============================================
    // RESAMPLE MICROPHONE AUDIO
    // ============================================

    resample(inputChunk) {
        const output =
            new Float32Array(
                this.outputSamplesPerPacket
            );

        const ratio =
            this.inputSampleRate /
            this.outputSampleRate;

        for (
            let i = 0;
            i < output.length;
            i++
        ) {
            const position = i * ratio;

            const index =
                Math.floor(position);

            const fraction =
                position - index;

            const sample1 =
                inputChunk[index] || 0;

            const sample2 =
                inputChunk[index + 1] ??
                sample1;

            output[i] =
                sample1 +
                (sample2 - sample1) *
                fraction;
        }

        return output;
    }

    // ============================================
    // SEND MESSAGE TO MAIN THREAD
    // ============================================

    sendMessage(message) {
        this.port.postMessage(message);
    }

    // ============================================
    // AUDIO PROCESSOR
    // ============================================

    process(inputs) {
        const input = inputs[0];

        if (!input || !input[0]) {
            return true;
        }

        const samples = input[0];

        // Store incoming microphone samples.
        for (
            let i = 0;
            i < samples.length;
            i++
        ) {
            this.inputBuffer.push(
                samples[i]
            );
        }

        /*
         * Process microphone audio in 20 ms chunks.
         *
         * This is important for realtime voice.
         *
         * 100 ms chunks:
         *     noticeable latency
         *
         * 20 ms chunks:
         *     much smoother realtime streaming
         */

        const requiredInputSamples =
            Math.ceil(
                this.inputSampleRate *
                0.02
            );

        while (
            this.inputBuffer.length >=
            requiredInputSamples
        ) {
            // ========================================
            // GET 20 MS INPUT CHUNK
            // ========================================

            const inputChunk =
                new Float32Array(
                    this.inputBuffer.slice(
                        0,
                        requiredInputSamples
                    )
                );

            this.inputBuffer =
                this.inputBuffer.slice(
                    requiredInputSamples
                );

            // ========================================
            // CONVERT TO 16 KHZ
            // ========================================

            const output =
                this.resample(
                    inputChunk
                );

            // ========================================
            // CALCULATE VOLUME
            // ========================================

            const rms =
                this.calculateRms(
                    output
                );

            const packetMs = 20;

            // ========================================
            // UPDATE NOISE FLOOR
            // ========================================

            this.updateNoiseFloor(
                rms
            );

            const loudEnough =
                rms >=
                this.speechStartThreshold;

            const quietEnough =
                rms <=
                this.speechEndThreshold;

            // ========================================
            // PRE-ROLL
            // ========================================

            /*
             * Always keep the most recent
             * ~60 ms of audio.
             *
             * If speech starts, we send this
             * audio first so the first syllable
             * isn't lost.
             */

            this.preRoll.push(
                output.slice()
            );

            if (
                this.preRoll.length >
                this.preRollMaxPackets
            ) {
                this.preRoll.shift();
            }

            // ========================================
            // USER NOT CURRENTLY SPEAKING
            // ========================================

            if (!this.speaking) {
                if (loudEnough) {
                    this.speechMs +=
                        packetMs;
                } else {
                    this.speechMs = 0;
                }

                /*
                 * Require a small amount of
                 * continuous speech before
                 * triggering speechStart.
                 */

                if (
                    this.speechMs >=
                    this.startHoldMs
                ) {
                    this.speaking = true;

                    this.silenceMs = 0;

                    // Tell React that speech started.
                    this.sendMessage({
                        type: "speechStart",
                        rms,
                    });

                    // ====================================
                    // SEND PRE-ROLL
                    // ====================================

                    for (
                        const oldPacket of
                        this.preRoll
                    ) {
                        this.sendMessage({
                            type: "audio",
                            data: oldPacket,
                        });
                    }

                    this.preRoll.length = 0;

                    /*
                     * Do not send the current packet
                     * twice.
                     */
                    continue;
                }

                /*
                 * Don't send background noise
                 * to Gemini.
                 */

                continue;
            }

            // ========================================
            // USER IS SPEAKING
            // ========================================

            /*
             * Send every 20 ms packet immediately.
             *
             * This keeps the Gemini Live connection
             * continuously supplied with audio.
             */

            this.sendMessage({
                type: "audio",
                data: output,
            });

            // ========================================
            // SILENCE DETECTION
            // ========================================

            if (quietEnough) {
                this.silenceMs +=
                    packetMs;
            } else {
                this.silenceMs = 0;
            }

            // ========================================
            // USER FINISHED SPEAKING
            // ========================================

            if (
                this.silenceMs >=
                this.endSilenceMs
            ) {
                this.speaking = false;

                this.speechMs = 0;
                this.silenceMs = 0;

                this.preRoll.length = 0;

                // Tell React to finish this
                // Gemini Live turn.
                this.sendMessage({
                    type: "speechEnd",
                    rms,
                });
            }
        }

        return true;
    }
}

registerProcessor(
    "pcm-processor",
    PCMProcessor
);