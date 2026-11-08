import type { EgressAllowEntry } from "./egress";

export type SandboxRole = "browser" | "repair" | "preview-browser" | "dependency-prep" | "containment-probe";

export type NetworkPlan =
  | { mode: "egress"; allow: EgressAllowEntry[] }
  | { mode: "none" }
  | { mode: "private"; network: string; alias?: string };

export type SandboxSpec = {
  sessionId: string;
  role: SandboxRole;
  image: string;
  command?: string[];
  user: string;
  cpus: number;
  memoryMb: number;
  pids: number;
  wallSeconds: number;
  tmpfs: { path: string; sizeMb: number; exec?: boolean }[];
  shmMb?: number;
  network: NetworkPlan;
  env?: Record<string, string>;
  volumes?: { name: string; target: string; readOnly: boolean }[];
  workdir?: string;
};

export type ExitInfo = {
  exitCode: number | null;
  oomKilled: boolean;
  reason: "exited" | "wall_limit" | "killed" | "oom" | "start_failed";
};

export type DestroyResult = { verified: boolean; attempts: number; error?: string };

export type EgressDecision = {
  at: string;
  action: "connect" | "http";
  target: string;
  path?: string;
  allowed: boolean;
  reason: string;
  sourceIp: string;
};

export interface SandboxHandle {
  readonly sessionId: string;
  readonly containerName: string;
  readonly containerId: string;
  readonly imageDigest: string;
  readonly address: string | null;
  readonly hardening: readonly string[];
  readonly policy: Record<string, unknown>;
  readonly policyHash: string;
  send(message: unknown): void;
  messages(): AsyncIterable<string>;
  stderrTail(): string;
  stop(reason?: ExitInfo["reason"]): Promise<void>;
  waitForExit(): Promise<ExitInfo>;
  drainEgressDecisions(): Promise<EgressDecision[]>;
  destroy(): Promise<DestroyResult>;
}

export interface SandboxProvider {
  readonly name: string;
  readonly ociRuntime: string;
  create(spec: SandboxSpec): Promise<SandboxHandle>;
  verifyGone(containerName: string): Promise<boolean>;
  listManaged(): Promise<{ name: string; state: string; sessionId: string }[]>;
  forceRemove(containerName: string): Promise<boolean>;
  checkReady(): Promise<{ ready: boolean; detail: string }>;
}
