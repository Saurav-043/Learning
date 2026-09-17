"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function HomePage() {
  const [videoUrl, setVideoUrl] = useState("");
  const [error, setError] = useState("");

  const router = useRouter();

  const handleStart = () => {
    const trimmed = videoUrl.trim();

    if (!trimmed) {
      setError("Please paste a YouTube lecture URL.");
      return;
    }

    setError("");

    router.push(`/learn?video=${encodeURIComponent(trimmed)}`);
  };

  return (
    <main
      style={{
        minHeight: "100vh",
        background: "#000",
        color: "#fff",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "24px",
      }}
    >
      <div style={{ maxWidth: "560px", width: "100%" }}>
        <h1 style={{ fontSize: "32px", marginBottom: "8px" }}>
          AI Tutor
        </h1>

        <p style={{ color: "#aaa", marginBottom: "24px" }}>
          Paste a YouTube lecture link to start learning with an AI
          tutor.
        </p>

        <input
          type="text"
          value={videoUrl}
          onChange={(event) => setVideoUrl(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              handleStart();
            }
          }}
          placeholder="https://www.youtube.com/watch?v=..."
          style={{
            width: "100%",
            padding: "14px",
            borderRadius: "8px",
            border: "1px solid #333",
            background: "#111",
            color: "#fff",
            fontSize: "15px",
            marginBottom: "12px",
          }}
        />

        {error && (
          <div
            style={{
              color: "#ff6b6b",
              marginBottom: "12px",
              fontSize: "14px",
            }}
          >
            {error}
          </div>
        )}

        <button
          onClick={handleStart}
          style={{
            width: "100%",
            padding: "14px",
            border: "none",
            borderRadius: "8px",
            background: "#fff",
            color: "#000",
            fontSize: "16px",
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          Start Learning
        </button>
      </div>
    </main>
  );
}