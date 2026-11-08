import { env } from "@inlet/config";
import { FIXTURES, fixtureInternalUrl, FIXTURE_DOMAIN_SUFFIX } from "@inlet/policy";
import type { FixtureSlot } from "@inlet/policy";
import type { EgressAllowEntry } from "@inlet/sandbox";

export type RunnerTarget = { url: string; allow: EgressAllowEntry[]; proxyServer: string };

function proxyServer(): string {
  return `http://${env().EGRESS_PROXY_HOST}:${env().EGRESS_PROXY_PORT}`;
}

export function fixtureTarget(slot: FixtureSlot, path = "/contact"): RunnerTarget {
  const fixture = FIXTURES[slot];
  if (!fixture.internalHost.endsWith(FIXTURE_DOMAIN_SUFFIX)) throw new Error("Invalid fixture host");
  return {
    url: fixtureInternalUrl(slot, path),
    allow: [{ host: fixture.internalHost, port: fixture.port, scope: "fixture" }],
    proxyServer: proxyServer(),
  };
}

export function verifiedTarget(formUrl: string): RunnerTarget {
  const url = new URL(formUrl);
  return {
    url: formUrl,
    allow: [{ host: url.hostname, port: Number(url.port || 443), scope: "verified" }],
    proxyServer: proxyServer(),
  };
}

export function targetForSite(site: { fixtureSlot: string | null; formUrl: string }): RunnerTarget {
  if (site.fixtureSlot) {
    const path = new URL(site.formUrl).pathname;
    return fixtureTarget(site.fixtureSlot as FixtureSlot, path);
  }
  return verifiedTarget(site.formUrl);
}
