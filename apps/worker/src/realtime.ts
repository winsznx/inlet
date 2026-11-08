import { investigationChannel, publish } from "@inlet/control";

export function publishInvestigation(id: string, sequence: number): void {
  publish(investigationChannel(id), sequence);
}
