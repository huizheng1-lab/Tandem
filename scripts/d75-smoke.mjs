// D75 live Electron smoke. Uses the bundled Playwright from the codex-runtimes cache.
// Launches the just-built Tandem.exe with isolated --user-data-dir and a temp TANDEM_HOME,
// then exercises the new CLI-models popover trigger + each of the three controls.
import { chromium } from "C:\\Users\\huizh\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\node\\node_modules\\playwright\\index.mjs";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";

const repoRoot = "C:\\Users\\huizh\\Apps\\HZ code";
const isolatedData = join(repoRoot, "release", "d75-smoke-userdata");
const isolatedTandemHome = join(repoRoot, "release", "d75-smoke-home");
if (existsSync(isolatedData)) rmSync(isolatedData, { recursive: true, force: true });
if (existsSync(isolatedTandemHome)) rmSync(isolatedTandemHome, { recursive: true, force: true });
mkdirSync(isolatedData, { recursive: true });
mkdirSync(isolatedTandemHome, { recursive: true });

const screenshotsDir = join(repoRoot, "release", "d75-smoke-shots");
mkdirSync(screenshotsDir, { recursive: true });

const exe = join(repoRoot, "release", "win-unpacked", "Tandem.exe");
if (!existsSync(exe)) {
  console.error("Tandem.exe not found at " + exe);
  process.exit(1);
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
page.on("console", (msg) => {
  if (msg.type() === "error") console.error("PAGE ERR:", msg.text());
});
page.on("pageerror", (err) => console.error("PAGE EXC:", err.message));

await page.exposeFunction("logToStdio", (text) => console.log("STDOUT:", text));

await page.addInitScript((tandemHomePath) => {
  // Note: TANDEM_HOME is read by the main process before the renderer is created. We
  // can't change it from the renderer. So the env is set by the spawner (see below).
  // window.__TANDEM_HOME__ = tandemHomePath;
}, isolatedTandemHome);

// Launch Electron app. We use Playwright's _electron API via the bundled module.
const { _electron: electron } = await import(
  "C:\\Users\\huizh\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\node\\node_modules\\playwright\\index.mjs"
);
const app = await electron.launch({
  executablePath: exe,
  args: [`--user-data-dir=${isolatedData}`],
  env: { ...process.env, TANDEM_HOME: isolatedTandemHome },
  timeout: 30_000
});

const wp = await app.firstWindow({ timeout: 30_000 });
await wp.waitForLoadState("domcontentloaded");
// Give the React app time to hydrate.
await wp.waitForTimeout(1500);

console.log("STEP 1: capture initial state (default non-CLI leader/worker).");
const initialShot = join(screenshotsDir, "01-initial.png");
await wp.screenshot({ path: initialShot, fullPage: false });
console.log("  saved", initialShot);

// Verify the CLI models trigger is present and visible.
const trigger = wp.locator('button.cliModelsTrigger');
const triggerVisible = await trigger.isVisible();
console.log("  cliModelsTrigger visible:", triggerVisible);
const triggerText = await trigger.textContent();
console.log("  cliModelsTrigger text:", JSON.stringify(triggerText));

// Open the popover and capture.
console.log("STEP 2: open popover and capture.");
await trigger.click();
await wp.waitForTimeout(500);
const popover = wp.locator('div[role="dialog"][aria-label="CLI model pins"]');
const popoverVisible = await popover.isVisible();
console.log("  popover visible:", popoverVisible);
const popoverShot = join(screenshotsDir, "02-popover-open.png");
await wp.screenshot({ path: popoverShot, fullPage: false });
console.log("  saved", popoverShot);

// Verify the three controls are inside.
const claudSelect = popover.locator("select").nth(0);
const codexInput = popover.locator("input.cliPinInput");
const codexEffortSelect = popover.locator("select").nth(1);
console.log("  claudSelect count:", await claudSelect.count(), "visible:", await claudSelect.isVisible().catch(() => "n/a"));
console.log("  codexInput count:", await codexInput.count(), "visible:", await codexInput.isVisible().catch(() => "n/a"));
console.log("  codexEffortSelect count:", await codexEffortSelect.count(), "visible:", await codexEffortSelect.isVisible().catch(() => "n/a"));

// Capture the popover position to verify it's NOT clipped by statusBar.
const popoverBox = await popover.boundingBox();
console.log("  popover boundingBox:", popoverBox);

// Read the TANDEM_HOME/.tandem/config.json before and after each control change.
const { readFile } = await import("node:fs/promises");
async function readConfig() {
  const path = join(isolatedTandemHome, ".tandem", "config.json");
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (e) {
    return null;
  }
}

console.log("STEP 3: change Claude CLI dropdown to haiku and verify config.");
await claudSelect.selectOption("haiku");
await wp.waitForTimeout(300);
const configAfterClaudeHaiku = await readConfig();
console.log("  config.claudeCliModel:", configAfterClaudeHaiku?.claudeCliModel);
await claudSelect.selectOption("sonnet");
await wp.waitForTimeout(300);
console.log("  config.claudeCliModel:", (await readConfig())?.claudeCliModel);
await claudSelect.selectOption("opus");
await wp.waitForTimeout(300);
console.log("  config.claudeCliModel:", (await readConfig())?.claudeCliModel);
await claudSelect.selectOption(""); // CLI default
await wp.waitForTimeout(300);
console.log("  config.claudeCliModel after default:", (await readConfig())?.claudeCliModel);

console.log("STEP 4: change Codex CLI model input to gpt-5-mini.");
await codexInput.fill("gpt-5-mini");
await codexInput.blur();
await wp.waitForTimeout(300);
console.log("  config.codexCliModel:", (await readConfig())?.codexCliModel);
await codexInput.fill("");
await codexInput.blur();
await wp.waitForTimeout(300);
console.log("  config.codexCliModel after empty:", (await readConfig())?.codexCliModel);

console.log("STEP 5: change Codex effort to medium.");
await codexEffortSelect.selectOption("medium");
await wp.waitForTimeout(300);
console.log("  config.codexCliReasoningEffort:", (await readConfig())?.codexCliReasoningEffort);
await codexEffortSelect.selectOption("");
await wp.waitForTimeout(300);
console.log("  config.codexCliReasoningEffort after default:", (await readConfig())?.codexCliReasoningEffort);

console.log("STEP 6: outside-click closes popover.");
await wp.locator("body").click({ position: { x: 10, y: 10 } });
await wp.waitForTimeout(300);
const popoverAfterOutsideClick = await popover.isVisible().catch(() => false);
console.log("  popover visible after outside click:", popoverAfterOutsideClick);

console.log("STEP 7: Escape key closes popover.");
await trigger.click();
await wp.waitForTimeout(300);
await wp.keyboard.press("Escape");
await wp.waitForTimeout(300);
const popoverAfterEscape = await popover.isVisible().catch(() => false);
console.log("  popover visible after Escape:", popoverAfterEscape);

console.log("STEP 8: final screenshot.");
const finalShot = join(screenshotsDir, "08-final.png");
await wp.screenshot({ path: finalShot, fullPage: false });
console.log("  saved", finalShot);

await app.close();
await browser.close();
console.log("DONE");
