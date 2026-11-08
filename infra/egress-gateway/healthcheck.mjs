import { networkInterfaces } from "node:os";

const prefix = process.env.SANDBOX_SUBNET_PREFIX ?? "172.30.";
const port = process.env.CONTROL_PORT ?? "3191";
const address = Object.values(networkInterfaces())
  .flat()
  .find((net) => net?.family === "IPv4" && !net.internal && !net.address.startsWith(prefix))?.address;

const response = await fetch(`http://${address}:${port}/health`).catch(() => null);
process.exit(response?.ok ? 0 : 1);
