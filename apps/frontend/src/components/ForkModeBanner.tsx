'use client';

// ForkModeBanner
// Shows a yellow warning banner at the top of the app when running in fork mode.
// Controlled by NEXT_PUBLIC_FORK_MODE=true environment variable.
// Informs users that they are connected to a local Base fork with no real funds.

export function ForkModeBanner() {
  if (process.env["NEXT_PUBLIC_FORK_MODE"] !== "true") {
    return null;
  }

  return (
    <div
      role="banner"
      style={{
        position: "sticky",
        top: 0,
        zIndex: 1000,
        width: "100%",
        padding: "8px 16px",
        background: "rgba(255, 200, 0, 0.15)",
        borderBottom: "1px solid rgba(255, 200, 0, 0.35)",
        color: "#e8b800",
        fontSize: 13,
        fontFamily: "var(--font-mono, monospace)",
        textAlign: "center",
        letterSpacing: "0.01em",
      }}
    >
      🔧 Fork Mode — connected to local Base fork. No real funds.
    </div>
  );
}
