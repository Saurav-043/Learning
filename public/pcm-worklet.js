class PCMProcessor extends AudioWorkletProcessor {
    process(inputs) {
        const input = inputs[0];

        if (input && input[0] && input[0].length > 0) {
            const channelData = input[0];

            const buffer = new ArrayBuffer(channelData.length * 2);
            const view = new DataView(buffer);

            for (let i = 0; i < channelData.length; i++) {
                const sample = Math.max(-1, Math.min(1, channelData[i]));

                view.setInt16(
                    i * 2,
                    sample < 0 ? sample * 0x8000 : sample * 0x7fff,
                    true
                );
            }

            this.port.postMessage(buffer, [buffer]);
        }

        return true;
    }
}

registerProcessor("pcm-processor", PCMProcessor);