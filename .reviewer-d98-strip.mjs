import WebSocket from "ws";

const target = JSON.parse(await (await fetch("http://127.0.0.1:9349/json")).text())[0];
const ws = new WebSocket(target.webSocketDebuggerUrl);
let id = 0;
function send(method, params = {}, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const msgId = ++id;
    const timer = setTimeout(() => reject(new Error(`send(${method}) timeout`)), timeoutMs);
    const handler = (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id === msgId) {
        ws.off("message", handler);
        clearTimeout(timer);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    };
    ws.on("message", handler);
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });
}
async function evalExpr(expr, awaitPromise = false, timeoutMs = 15000) {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise, returnByValue: true }, timeoutMs);
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result.value;
}

await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("ws open timeout")), 8000);
  ws.on("open", () => { clearTimeout(t); resolve(); });
});
await send("Runtime.enable");

const testDir = "C:\\\\Users\\\\huizh\\\\AppData\\\\Local\\\\Temp\\\\claude\\\\C--Users-huizh-Apps-HZ-code\\\\3b6d5c24-0d79-4eae-ae30-d07ef47b9f73\\\\scratchpad\\\\d98-strip-check";

await evalExpr(`window.tandem.startSession({ projectDir: "${testDir}" }).then(() => "ok")`, true, 15000);
await evalExpr(
  `window.tandem.setConfig({ leader: "minimax/minimax-m3", worker: "minimax/minimax-m3", triage: "auto", permissionMode: "yolo" }).then(() => "ok")`,
  true, 10000
);
console.log("session started, config set");

evalExpr(
  `window.tandem.runPipeline({ prompt: "Create a file called note.txt containing the single word: done", attachments: [] }).catch(() => {})`,
  false, 5000
).catch(() => {});

console.log("run fired; sampling the activity strip every 5s...");
const samples = [];
let done = false;
for (let i = 0; i < 60 && !done; i++) {
  await new Promise((r) => setTimeout(r, 5000));
  try {
    const state = await evalExpr(`
      JSON.stringify({
        strip: (document.querySelector('.activityStrip') || {}).textContent || null,
        phase: (document.querySelector('.phaseChip') || {}).textContent || null,
        cost: Array.from(document.querySelectorAll('header span')).map(s => s.textContent).find(t => t && (t.includes('$') || t.includes('price unknown'))) || null
      })
    `, false, 8000);
    const parsed = JSON.parse(state);
    samples.push(parsed);
    console.log(`  [${i * 5}s] phase=${parsed.phase} strip=${JSON.stringify(parsed.strip)} cost=${parsed.cost}`);
    if (parsed.phase === "DONE") { done = true; }
  } catch (e) {
    console.log(`  [${i * 5}s] poll error: ${e.message}`);
  }
}

await new Promise((r) => setTimeout(r, 2000));
const finalState = await evalExpr(`
  JSON.stringify({
    stripPresent: !!document.querySelector('.activityStrip'),
    phase: (document.querySelector('.phaseChip') || {}).textContent || null,
    cost: Array.from(document.querySelectorAll('header span')).map(s => s.textContent).find(t => t && (t.includes('$') || t.includes('price unknown'))) || null
  })
`, false, 8000);
console.log("FINAL STATE AFTER DONE:", finalState);

ws.close();
setTimeout(() => process.exit(0), 200);
