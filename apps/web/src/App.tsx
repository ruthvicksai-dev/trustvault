import { useEffect, useState } from "react";

interface HealthResponse {
  status: string;
  service: string;
  timestamp: string;
}

export function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/health")
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<HealthResponse>;
      })
      .then(setHealth)
      .catch((err: Error) => setError(err.message));
  }, []);

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: "2rem" }}>
      <h1>TrustVault</h1>
      <p>Secure document sharing with per-document authorization.</p>
      <section>
        <h2>API Health</h2>
        {error && <p style={{ color: "red" }}>Error: {error}</p>}
        {health && (
          <pre style={{ background: "#f4f4f4", padding: "1rem", borderRadius: "4px" }}>
            {JSON.stringify(health, null, 2)}
          </pre>
        )}
        {!health && !error && <p>Checking…</p>}
      </section>
    </main>
  );
}
