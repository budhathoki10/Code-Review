import { ImageResponse } from "next/og";

export const size = { width: 32, height: 32 };
export const contentType = "image/png";

/** The product bracket-and-review mark, generated so the icon stays sharp at every size. */
export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#181a18",
          borderRadius: 3,
        }}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
          <path d="M9.5 6.5H7.5V17.5H9.5" stroke="#ffffff" strokeWidth="1.8" />
          <path d="M13 8H17" stroke="#2da44e" strokeWidth="2.2" />
          <path d="M13 12H17" stroke="#2da44e" strokeWidth="2.2" />
          <path d="M13 16H15.5" stroke="#2da44e" strokeWidth="2.2" />
        </svg>
      </div>
    ),
    { ...size },
  );
}
