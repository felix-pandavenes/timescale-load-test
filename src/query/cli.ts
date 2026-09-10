import { runQueryLoad } from "./app.js";
import { loadQueryConfig } from "./config.js";
import { loadQueryPool } from "./queries.js";
import { isDriver } from "../store/index.js";

interface Args {
  config: string;
  queries?: string;
  driver?: string;
  clients?: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { config: "config/query-config.json" };
  for (let i = 0; i < argv.length; i++) {
    const next = argv[i + 1];
    if (argv[i] === "--config" && next) {
      args.config = argv[++i];
    } else if (argv[i] === "--queries" && next) {
      args.queries = argv[++i];
    } else if (argv[i] === "--driver" && next) {
      args.driver = argv[++i];
    } else if (argv[i] === "--clients" && next) {
      args.clients = Number(argv[++i]);
    }
  }
  return args;
}

export async function runQueryCli(argv: string[]): Promise<void> {
  const args = parseArgs(argv);

  const cfg = loadQueryConfig(args.config);
  if (args.driver) {
    if (!isDriver(args.driver)) {
      throw new Error(`unknown --driver "${args.driver}" (expected "pg", "postgres", or "mongodb")`);
    }
    cfg.driver = args.driver;
  }
  if (args.queries) cfg.queriesFile = args.queries;
  if (args.clients !== undefined) {
    if (!Number.isFinite(args.clients) || args.clients <= 0) {
      throw new Error(`--clients must be a positive number, got "${args.clients}"`);
    }
    cfg.numClients = args.clients;
  }

  const queries = loadQueryPool(cfg.queriesFile);

  await runQueryLoad(cfg, queries);
}
