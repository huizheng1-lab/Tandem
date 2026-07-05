import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

function App(): React.ReactElement {
  const [pong, setPong] = useState("checking...");

  useEffect(() => {
    void window.tandem.ping().then(setPong).catch((error: unknown) => {
      setPong(String(error));
    });
  }, []);

  return (
    <main className="shell">
      <aside className="sidebar">
        <div className="brand">Tandem</div>
        <button type="button" className="projectButton">
          Pick Project
        </button>
      </aside>
      <section className="workspace">
        <header className="statusBar">
          <span>IDLE</span>
          <span>Round 0/0</span>
          <span>$0.00</span>
        </header>
        <section className="transcript">
          <div className="bubble system">Desktop bridge: {pong}</div>
        </section>
        <footer className="composer">
          <textarea placeholder="Ask Tandem to build something..." rows={3} />
          <button type="button">Send</button>
        </footer>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(<App />);
