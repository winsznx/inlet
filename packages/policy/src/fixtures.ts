export const FIXTURE_DOMAIN_SUFFIX = ".acme-demo.test";

export type FixtureSlot = "healthy" | "broken" | "demo-broken" | "attack";

export type FixtureDefinition = {
  slot: FixtureSlot;
  port: number;
  internalHost: string;
  label: string;
  repairable: boolean;
};

export const FIXTURES: Record<FixtureSlot, FixtureDefinition> = {
  healthy: {
    slot: "healthy",
    port: 3110,
    internalHost: "healthy.acme-demo.test",
    label: "Sample environment",
    repairable: false,
  },
  broken: {
    slot: "broken",
    port: 3111,
    internalHost: "broken.acme-demo.test",
    label: "Controlled fault-injection example",
    repairable: true,
  },
  "demo-broken": {
    slot: "demo-broken",
    port: 3112,
    internalHost: "demo-broken.acme-demo.test",
    label: "Controlled fault-injection example",
    repairable: false,
  },
  attack: {
    slot: "attack",
    port: 3113,
    internalHost: "attack.acme-demo.test",
    label: "Controlled attack page",
    repairable: false,
  },
};

export function fixtureInternalUrl(slot: FixtureSlot, path = "/contact"): string {
  const fixture = FIXTURES[slot];
  return `http://${fixture.internalHost}:${fixture.port}${path}`;
}

export function fixtureRecipient(slot: FixtureSlot): string {
  return `enquiries@${slot}.acme-demo.test`;
}

export function fixtureSlotForLocalUrl(raw: string): FixtureSlot | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(url.hostname)) return null;
  const match = Object.values(FIXTURES).find((fixture) => String(fixture.port) === url.port);
  return match?.slot ?? null;
}
