export interface DesktopLaunchOptions {
  hidden: boolean;
  automation?: {
    port: number;
    tokenFile: string;
    projectDir: string;
  };
}

function argumentValue(argv: string[], name: string): string | undefined {
  return argv.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1);
}

export function parseDesktopLaunchOptions(argv = process.argv.slice(1)): DesktopLaunchOptions {
  const hidden = argv.includes("--hidden");
  const portValue = argumentValue(argv, "--automation-port");
  const tokenFile = argumentValue(argv, "--automation-token-file");
  const projectDir = argumentValue(argv, "--automation-project-dir");
  const requested = portValue !== undefined || tokenFile !== undefined || projectDir !== undefined;
  if (!requested) return { hidden };
  const port = Number(portValue);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error("--automation-port must be an integer from 0 to 65535.");
  if (!tokenFile) throw new Error("--automation-token-file is required with --automation-port.");
  if (!projectDir) throw new Error("--automation-project-dir is required with --automation-port.");
  return { hidden, automation: { port, tokenFile, projectDir } };
}
