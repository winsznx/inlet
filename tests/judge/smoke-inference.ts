import { main } from "./lib";
import { smokeInference } from "./scenarios";

await main(async () => {
  console.log(`Evidence: ${await smokeInference()}`);
});
