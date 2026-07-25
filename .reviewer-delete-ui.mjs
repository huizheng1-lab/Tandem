import WebSocket from "ws";

const target = JSON.parse(await (await fetch("http://127.0.0.1:9333/json")).text())[0];
const ws = new WebSocket(target.webSocketDebuggerUrl);
let id = 0;
const consoleMsgs = [];
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const msgId = ++id;
    const handler = (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id === msgId) {
        ws.off("message", handler);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    };
    ws.on("message", handler);
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });
}

async function evalExpr(expr, awaitPromise = false) {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise, returnByValue: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result.value;
}

await new Promise((resolve) => ws.on("open", resolve));
await send("Runtime.enable");
await send("Console.enable");
ws.on("message", (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.method === "Console.messageAdded") consoleMsgs.push(msg.params.message);
  if (msg.method === "Runtime.exceptionThrown") consoleMsgs.push({ exception: msg.params.exceptionDetails });
});

// Reveal the sidebar and list its session delete buttons.
const sidebarInfo = await evalExpr(`
  (function() {
    const buttons = Array.from(document.querySelectorAll('.dangerAction'));
    return JSON.stringify(buttons.map((b, i) => ({ i, text: b.textContent, visible: !!(b.offsetWidth || b.offsetHeight) })));
  })()
`);
console.log("DELETE BUTTONS FOUND:", sidebarInfo);
