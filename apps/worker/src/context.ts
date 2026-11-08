import { pino } from "pino";
import { env } from "@inlet/config";
import { OciSandboxProvider } from "@inlet/sandbox";
import type { SandboxProvider } from "@inlet/sandbox";

export const log = pino({ level: env().LOG_LEVEL, base: { service: "worker" } });

let provider: SandboxProvider | undefined;

export function sandboxProvider(): SandboxProvider {
  provider ??= new OciSandboxProvider();
  return provider;
}
