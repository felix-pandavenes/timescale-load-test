import { runSwapsCli } from "./swaps/cli.js";
import { runQueryCli } from "./query/cli.js";

const [mode, ...rest] = process.argv.slice(2);

switch (mode) {
  case "swaps":
    await runSwapsCli(rest);
    break;
  case "query":
    await runQueryCli(rest);
    break;
  default:
    console.error(`Usage: main.ts <swaps|query> [options]${mode ? `\nUnknown mode "${mode}"` : ""}`);
    process.exit(1);
}
