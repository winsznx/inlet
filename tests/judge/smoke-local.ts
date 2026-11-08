import { main } from "./lib";
import { smokeLocal } from "./scenarios";

await main(async () => {
  console.log(`Evidence: ${await smokeLocal()}`);
});
