import { runAxiCli } from "axi-sdk-js";
import type { AxiRenderable } from "./lib/output.js";
import { VERSION } from "./version.js";
import { getCommandContext, type CommandContext } from "./context.js";
import { homeCommand } from "./commands/home.js";
import { authCommand, AUTH_HELP } from "./commands/auth.js";
import { browserCommand, BROWSER_HELP } from "./commands/browser.js";
import { jobsCommand, JOBS_HELP } from "./commands/jobs.js";
import { candidatesCommand, candidateGetCommand, CANDIDATES_HELP } from "./commands/candidates.js";
import { messagesCommand, MESSAGES_HELP } from "./commands/messages.js";
import { stageCommand, STAGE_HELP } from "./commands/stage.js";
import { digestCommand, DIGEST_HELP } from "./commands/digest.js";
import { scoreCommand, SCORE_HELP } from "./commands/score.js";
import { setupCommand, SETUP_HELP } from "./commands/setup.js";
import { discoverCommand, DISCOVER_HELP } from "./commands/discover.js";

export const DESCRIPTION =
  "Indeed for agents - a persistent authenticated browser session over the employer dashboard, with ref-based interactive primitives and discovery capture";

const TOP_LEVEL_HELP = `indeed-axi - ${DESCRIPTION}

commands:
  browser open           start/attach the visible Chrome and snapshot the dashboard
  browser snapshot       page outline with [ref=eN] tags (--full, --query)
  browser click|fill     act on refs from the snapshot, get a fresh snapshot
  browser goto|find|select|press|eval|screenshot|console|status|close
  jobs list              live employer jobs (ref, title)
  candidates list|sync   pipeline rows / pull packets into the local store
  candidates note <id>   add a candidate note in Indeed (--confirm gated)
  candidate get <id>     one candidate packet (store or live with --refresh)
  messages read|send     thread reads / gated single message send
  messages unread        live unread count
  stage move <id> --to   move a pipeline stage (--confirm gated)
  digest                 ranked hiring review over the local store (offline)
  score record <id>      record a screening score (--note --confirm syncs to Indeed)
  auth login             open a visible Chrome window, wait for manual login
  auth status            browser session state (--browser to probe live)
  auth logout            close the browser, clear the record (--purge deletes the profile)
  discover               record a manual employer-dashboard session (dev command)
  setup hooks|status     install ambient session context

global flags: --help, -v/--version, update (self-update)

auth: none to configure - Indeed exposes no public employer API. Login is
manual through the persistent profile (2FA included). Browser state lives
in ~/.indeed-axi/ (override with INDEED_STATE_DIR). Navigation is scoped
to *.indeed.com; one headed browser at a time.

run \`indeed-axi <command> --help\` for a command reference.`;

interface HelpEntry {
  help: string;
}

const COMMAND_HELP: Record<string, HelpEntry> = {
  auth: { help: AUTH_HELP },
  browser: { help: BROWSER_HELP },
  jobs: { help: JOBS_HELP },
  candidates: { help: CANDIDATES_HELP },
  candidate: { help: CANDIDATES_HELP },
  messages: { help: MESSAGES_HELP },
  stage: { help: STAGE_HELP },
  digest: { help: DIGEST_HELP },
  score: { help: SCORE_HELP },
  setup: { help: SETUP_HELP },
  discover: { help: DISCOVER_HELP },
};

type Command = (args: string[], ctx: CommandContext) => Promise<AxiRenderable>;

function withContext(command: Command): (args: string[]) => Promise<AxiRenderable> {
  return (args: string[]) => command(args, getCommandContext());
}

export async function main(): Promise<void> {
  await runAxiCli({
    description: DESCRIPTION,
    version: VERSION,
    topLevelHelp: TOP_LEVEL_HELP,
    getCommandHelp: (command: string) => COMMAND_HELP[command]?.help ?? null,
    home: withContext(homeCommand),
    commands: {
      auth: withContext(authCommand),
      browser: withContext(browserCommand),
      jobs: withContext(jobsCommand),
      candidates: withContext(candidatesCommand),
      candidate: withContext(candidateGetCommand),
      messages: withContext(messagesCommand),
      stage: withContext(stageCommand),
      digest: withContext(digestCommand),
      score: withContext(scoreCommand),
      discover: withContext(discoverCommand),
      setup: (args: string[]) => setupCommand(args),
    },
  });
}

// Direct execution (node dist/index.js) instead of the bin wrapper.
if (process.argv[1]?.endsWith("index.js")) {
  await main();
}
