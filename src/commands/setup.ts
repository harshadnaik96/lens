import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { execSync, spawn } from "node:child_process";
import { LENS_HOME, CONFIG_PATH } from "../config.js";

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
};

function header(s: string) {
  console.log(`\n${C.bold}${C.cyan}━━━ ${s} ━━━${C.reset}`);
}
function ok(s: string) {
  console.log(`  ${C.green}✓${C.reset} ${s}`);
}
function warn(s: string) {
  console.log(`  ${C.yellow}!${C.reset} ${s}`);
}

function which(bin: string): boolean {
  try {
    execSync(`command -v ${bin}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function makeRl() {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

async function ask(
  rl: readline.Interface,
  q: string,
  def?: string,
): Promise<string> {
  const suffix = def ? ` ${C.dim}(${def})${C.reset}` : "";
  return new Promise((resolve) => {
    rl.question(`${q}${suffix} ${C.cyan}›${C.reset} `, (a) =>
      resolve((a || "").trim() || def || ""),
    );
  });
}

async function askChoice(
  rl: readline.Interface,
  q: string,
  choices: string[],
  def: string,
): Promise<string> {
  while (true) {
    const a = (await ask(rl, `${q} [${choices.join("/")}]`, def)).toLowerCase();
    if (choices.includes(a)) return a;
    warn(`Pick one of: ${choices.join(", ")}`);
  }
}

async function askSecret(_rl: readline.Interface, q: string): Promise<string> {
  process.stdout.write(`${q} ${C.cyan}›${C.reset} `);
  return new Promise((resolve) => {
    const stdin = process.stdin;
    let buf = "";
    const ENTER1 = 0x0a,
      ENTER2 = 0x0d,
      CTRLC = 0x03,
      BS = 0x08,
      DEL = 0x7f;
    const onData = (chunk: Buffer) => {
      for (const code of chunk) {
        if (code === ENTER1 || code === ENTER2) {
          stdin.removeListener("data", onData);
          if (stdin.isTTY) (stdin as any).setRawMode(false);
          stdin.pause();
          process.stdout.write("\n");
          resolve(buf.trim());
          return;
        }
        if (code === CTRLC) {
          process.exit(130);
        }
        if (code === DEL || code === BS) {
          if (buf.length) {
            buf = buf.slice(0, -1);
            process.stdout.write("\b \b");
          }
          continue;
        }
        if (code < 0x20) continue;
        buf += String.fromCharCode(code);
        process.stdout.write("•");
      }
    };
    if (stdin.isTTY) (stdin as any).setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

export interface SetupOpts {
  noServe?: boolean;
  force?: boolean;
}

export async function runSetup(opts: SetupOpts = {}) {
  console.log(`${C.bold}🔍 Lens — interactive setup${C.reset}`);
  console.log(
    `${C.dim}This will write ~/.lens/config.json and (optionally) start the UI.${C.reset}`,
  );

  if (fs.existsSync(CONFIG_PATH) && !opts.force) {
    warn(`Config already exists at ${CONFIG_PATH}.`);
    const rl0 = makeRl();
    const overwrite =
      (await askChoice(rl0, "Overwrite?", ["y", "n"], "n")) === "y";
    rl0.close();
    if (!overwrite) {
      console.log(
        `Keeping existing config. Run ${C.bold}lens setup --force${C.reset} to redo.`,
      );
      return;
    }
  }

  fs.mkdirSync(LENS_HOME, { recursive: true });
  const rl = makeRl();

  // Provider
  header("1. Provider");
  const detected: Array<[string, boolean]> = [
    ["claude", which("claude")],
    ["gemini", which("gemini")],
    ["codex", which("codex")],
  ];
  for (const [name, present] of detected) {
    console.log(
      `  ${present ? C.green + "✓" : C.dim + "○"} ${name}${C.reset}${present ? "" : C.dim + " (not on PATH)" + C.reset}`,
    );
  }

  const firstFound = detected.find(([, p]) => p)?.[0] ?? "claude";
  const provider = await askChoice(
    rl,
    "Default provider",
    ["claude", "gemini", "codex"],
    firstFound,
  );
  if (!detected.find(([n]) => n === provider)?.[1]) {
    warn(
      `'${provider}' is not on PATH. You'll need to install + authenticate it before \`lens analyze\` works.`,
    );
  }

  // Forge
  header("2. Forge");
  const forge = await askChoice(
    rl,
    "Which forge are your PRs on",
    ["github", "bitbucket"],
    "github",
  );

  const cfg: any = {
    forge,
    provider: {
      default: provider,
      claudeBin: "claude",
      geminiBin: "gemini",
      codexBin: "codex",
    },
  };

  if (forge === "github") {
    header("3. GitHub auth");
    const ghPresent = which("gh");
    if (ghPresent)
      ok("gh CLI detected — Lens can use it directly, no token needed.");
    else
      warn(
        "gh CLI not found. Install it (https://cli.github.com) or paste a token below.",
      );

    const useGh = ghPresent
      ? (await askChoice(rl, "Use gh CLI for auth?", ["y", "n"], "y")) === "y"
      : false;

    let token = "";
    if (!useGh) {
      console.log(
        `${C.dim}Create a fine-grained PAT: https://github.com/settings/personal-access-tokens/new${C.reset}`,
      );
      console.log(
        `${C.dim}Permissions: Contents=Read, Pull requests=Read+Write${C.reset}`,
      );
      token = await askSecret(rl, "GitHub token (input hidden)");
    }
    const scope = await ask(
      rl,
      "PR scope (reviewer | author | org:NAME | repo:owner/name)",
      "reviewer",
    );
    cfg.github = { token, scope, baseUrl: "https://api.github.com" };
  } else {
    header("3. Bitbucket auth");
    const isServer =
      (await askChoice(
        rl,
        "Bitbucket Cloud or Server (self-hosted)?",
        ["cloud", "server"],
        "cloud",
      )) === "server";
    const baseUrl = isServer
      ? await ask(rl, "Server base URL", "https://bitbucket.mycorp.com")
      : "https://api.bitbucket.org/2.0";
    if (!isServer) {
      console.log(
        `${C.dim}Create an API token: https://bitbucket.org/account/settings/personal-access-tokens/${C.reset}`,
      );
      console.log(
        `${C.dim}Scopes: Repositories:Read, Pull requests:Read+Write${C.reset}`,
      );
    }
    const username = await ask(rl, "Bitbucket username (not email)");
    if (!username) {
      warn("Username is required.");
      rl.close();
      process.exit(1);
    }
    const apiToken = await askSecret(rl, "API token (input hidden)");
    if (!apiToken) {
      warn("API token is required.");
      rl.close();
      process.exit(1);
    }
    const scope = await ask(rl, "PR scope (reviewer | author)", "author");
    cfg.bitbucket = { username, apiToken, scope, baseUrl };
  }

  // Reviewer identity
  header("4. Reviewer identity");
  const name = await ask(
    rl,
    "Your display name (used in posted comments)",
    process.env.USER || "Reviewer",
  );
  cfg.reviewer = { name, botFooter: "[Reviewed by {name} via lens]" };

  rl.close();

  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  ok(`Wrote ${CONFIG_PATH}`);

  header("Done");
  console.log(
    `Try: ${C.bold}lens list${C.reset}   then  ${C.bold}lens analyze <prId>${C.reset}`,
  );

  if (!opts.noServe) {
    const rl2 = makeRl();
    const start =
      (await askChoice(
        rl2,
        "Start the UI on http://localhost:7777 now?",
        ["y", "n"],
        "y",
      )) === "y";
    rl2.close();
    if (start) {
      const binPath = path.resolve(process.argv[1]!);
      const child = spawn(process.execPath, [binPath, "serve"], {
        stdio: "inherit",
      });
      child.on("exit", (code) => process.exit(code ?? 0));
      return;
    }
  }
  console.log(`Run ${C.bold}lens serve${C.reset} when you're ready to curate.`);
}
