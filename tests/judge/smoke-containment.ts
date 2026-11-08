import { main } from "./lib";
import { smokeContainment } from "./scenarios";

await main(async () => {
  console.log(`Evidence: ${await smokeContainment()}`);
});
