import { ImageResponse } from "next/og";

export const size = { width: 32, height: 32 };
export const contentType = "image/png";

/** A minimal pull-request glyph (source branch, target branch, merge point) — generated so no binary asset needs to be hand-authored or committed. */
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
          background: "#171717",
          borderRadius: 7,
        }}
      >
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
          <circle cx="4.5" cy="4.5" r="2.25" stroke="#ffffff" strokeWidth="1.6" />
          <circle cx="4.5" cy="13.5" r="2.25" stroke="#ffffff" strokeWidth="1.6" />
          <circle cx="13.5" cy="4.5" r="2.25" stroke="#ffffff" strokeWidth="1.6" />
          <path d="M4.5 6.75V11.25" stroke="#ffffff" strokeWidth="1.6" strokeLinecap="round" />
          <path
            d="M13.5 6.75C13.5 9.5 11.5 11.25 9 11.25"
            stroke="#ffffff"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
        </svg>
      </div>
    ),
    { ...size },
  );
}
