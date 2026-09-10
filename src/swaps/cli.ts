import { isDriver } from "../store/index.js";
import { runSwaps } from "./app.js";
import { loadSwapsConfig } from "./config.js";

interface Args {
  config: string;
  driver?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { config: "config/swaps-config.json" };
  for (let i = 0; i < argv.length; i++) {
    const next = argv[i + 1];
    if (argv[i] === "--config" && next) {
      args.config = argv[++i];
    } else if (argv[i] === "--driver" && next) {
      args.driver = argv[++i];
    }
  }
  return args;
}

export async function runSwapsCli(argv: string[]): Promise<void> {
  const args = parseArgs(argv);

  const cfg = loadSwapsConfig(args.config);
  if (args.driver) {
    if (!isDriver(args.driver)) {
      throw new Error(`unknown --driver "${args.driver}" (expected "pg", "postgres", or "mongodb")`);
    }
    cfg.driver = args.driver;
  }

  await runSwaps(cfg);
}
