"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function Home() {
  const [videoUrl, setVideoUrl] = useState("");
  const router = useRouter();

  function startLearning() {
    if (!videoUrl.trim()) {
      return;
    }

    router.push(
      `/learn?video=${encodeURIComponent(videoUrl.trim())}`
    );
  }

  return (
    <main
      style={{
        minHeight: "100vh",
        background: "#000",
        color: "#fff",
        padding: "60px 48px",
      }}
    >
      <h1
        style={{
          fontSize: "48px",
          marginBottom: "12px",
        }}
      >
        Ready to Learn
      </h1>

      <p
        style={{
          fontSize: "22px",
          color: "#aaa",
          marginBottom: "40px",
        }}
      >
        Watch. Ask. Understand. Continue.
      </p>

      <div
        style={{
          maxWidth: "700px",
        }}
      >
        <input
          type="text"
          value={videoUrl}
          onChange={(e) => setVideoUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              startLearning();
            }
          }}
          placeholder="Paste YouTube video URL"
          style={{
            width: "100%",
            padding: "16px",
            fontSize: "18px",
            background: "#111",
            color: "#fff",
            border: "1px solid #444",
            borderRadius: "8px",
            outline: "none",
            marginBottom: "16px",
          }}
        />

        <button
          onClick={startLearning}
          style={{
            padding: "14px 24px",
            fontSize: "18px",
            background: "#fff",
            color: "#000",
            border: "none",
            borderRadius: "8px",
            cursor: "pointer",
          }}
        >
          Start Learning
        </button>
      </div>
    </main>
  );
}