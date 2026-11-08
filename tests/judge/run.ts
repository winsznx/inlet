import { inferenceConfigured } from "@inlet/config";
import { assert, main } from "./lib";
import { smokeContainment, smokeInference, smokeLocal, smokeRecovery } from "./scenarios";

await main(async () => {
  assert(inferenceConfigured(), "A real inference key is required. The judge suite does not accept a harness in place of the model.");
  for (const [name, scenario] of [["local", smokeLocal], ["containment", smokeContainment], ["recovery", smokeRecovery], ["inference", smokeInference]] as const) {
    console.log(`\n${name}`);
    console.log(`Evidence: ${await scenario()}`);
  }
});
