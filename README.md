# agents-pool

Run a pool of role-based agents on a task and get back a reviewed git branch plus a merge request description.

```
agentpool run "Add a CSV export to the reports page"
```

A planner reads the repo and proposes a plan. You approve it. A developer implements it in an isolated git worktree, QA verifies it by running things, and a reviewer reads the diff. The result is a branch with one commit per step and a `MR.md`, and with `--open-pr` a real pull request (GitHub) or merge request (GitLab).

It handles one repository, a typed or Jira task, and four roles. See [What is not here yet](#what-is-not-here-yet).

## Quick start

Needs Node 20+, git, and Claude credentials (`ANTHROPIC_API_KEY`, or an existing Claude Code login).

```sh
npm install
npm run build
npm link                    # puts `agentpool` on your PATH, or use `node dist/cli.js`

cd /path/to/your/repo       # must have at least one commit
agentpool run "Add a CSV export to the reports page"
```

Try the whole flow with fake agents first, at no cost:

```sh
agentpool run --runner dry-run "Anything [ask] [qa-fail-once]"
```

## Tickets and pull requests

```sh
agentpool doctor                                   # checks tools, credentials, remote, config
agentpool run --jira PROJ-123 --open-pr            # task from Jira Cloud, PR/MR when done
agentpool run --jira https://acme.atlassian.net/browse/PROJ-123 "use the existing csv helper"
agentpool pr [run-id] [--dry-run] [--no-draft]     # open the request for a finished run later
```

- **GitHub and GitLab** are detected from the remote URL (github.com, gitlab.com, or a name containing "gitlab"). Self-hosted servers need `"git": {"host": "github"|"gitlab"}` in `.agentpool/config.json` (optionally `apiUrl`, the full API root, and `remote`).
- **Tokens** come from the environment and are never written to disk or logs: `GITHUB_TOKEN`/`GH_TOKEN` (or `gh auth login`), `GITLAB_TOKEN`. The token is checked before anything is pushed.
- The request is a **draft unless the run is ready for review**; `--draft` / `--no-draft` override. Running `pr` twice returns the existing request instead of opening a second one. The base branch must exist on the remote.
- **Jira Cloud** uses `JIRA_EMAIL` and `JIRA_API_TOKEN` (an Atlassian API token), plus `JIRA_BASE_URL` unless you paste the issue URL or set `"jira": {"baseUrl": ...}`. The ticket becomes the task, the request title is `KEY: summary`, and the agents are told ticket text is untrusted. Text you type alongside `--jira` is added as extra instructions. `agentpool jira PROJ-123` previews the task. `--jira-comment` posts the request link back on the ticket; it is off by default because it writes to a shared system.

## How a run works

```
task -> baseline -> plan -> [you approve] -> build -> QA -> review -> MR.md
                      |                       ^       |       |
                 questions                    +-------+-------+  objections, up to --max-rounds
              (park and wait)
```

1. **Baseline.** The run creates a branch `agentpool/<run-id>` in a worktree under `.agentpool/worktrees/`, detects the stack and test command, installs dependencies, and runs the tests once. Failures that already exist are recorded so nobody is blamed for them.
2. **Plan.** The planner (read-only) writes steps and acceptance criteria. It may raise a blocking question only when the answer changes the plan. Everything else becomes a logged assumption.
3. **Approval.** You approve or reject the plan. `--autonomy auto` skips this gate.
4. **Build.** The developer implements the plan in the worktree. The run commits the result.
5. **QA.** QA verifies each acceptance criterion by running something and may add test files. Afterwards the run re-runs the project's tests itself. If QA says pass and the tests fail, the run records a fail.
6. **Review.** The reviewer reads the diff. Its verdict follows its findings: any blocker or major finding means changes requested.
7. **Rounds.** QA and reviewer objections go back to the developer as typed messages, up to `--max-rounds` (default 2). After that the run parks and asks a person whether to finish anyway.
8. **Result.** `MR.md` has the summary, plan, decisions, test evidence, QA and review results, and a section listing what the agents were unsure about, plus the commands to push and open the request.

## Waiting for people

Questions and approvals are first-class, not chat messages. In a terminal the CLI prompts you. Without a terminal (or with `--no-interactive`) the run parks and exits. Answer from anywhere that has the repo:

```sh
agentpool status                         # what is it waiting for?
agentpool answer <run-id> Q-1 "table"    # answer a question
agentpool approve <run-id>               # or: agentpool reject <run-id> "reason"
agentpool resume <run-id>                # carry on
```

`--assume-defaults` means never wait: recommended answers are taken, and a stuck run finishes flagged as not ready.

## Commands

| Command | What it does |
| --- | --- |
| `run [task...]` | Start a run. `--task-file`, `--repo`, `--base`, `--autonomy`, `--runner`, `--model`, `--max-rounds`, `--budget-usd`, `--agent-budget-usd`, `--assume-defaults`, `--skip-baseline`, `--no-interactive`, `--jira`, `--open-pr`, `--draft`/`--no-draft`, `--jira-comment` |
| `resume [run-id]` | Continue a parked, failed or interrupted run |
| `status [run-id]` | Phase, spend, and what to do next |
| `list` | Runs in this repository |
| `log [run-id]` | Full event history (`--json` for raw lines) |
| `answer`, `approve`, `reject` | Human actions on a parked run |
| `agents` | The agents that would run here, including repo overrides |
| `pr [run-id]` | Push the branch and open the GitHub PR / GitLab MR. `--remote`, `--host`, `--draft`, `--no-draft`, `--jira-comment`, `--dry-run` |
| `jira <key\|url>` | Preview a Jira Cloud issue as a task |
| `doctor` | Check setup |
| `clean <run-id>` | Remove a run's worktree; the branch stays |

## Agents and skills are files

Each agent is a markdown file with YAML frontmatter. The body is its system prompt. Built-ins live in [`agents/`](agents) and [`skills/`](skills).

```markdown
---
name: qa
role: Verifies the change against the acceptance criteria and adds tests
tools: [Read, Glob, Grep, Edit, Write, Bash]
writeScope: ["**/*.test.*", "test/**", "tests/**"]
maxTurns: 40
skills: [handoff-format, verify-by-running]
---
You are QA on a software delivery team...
```

- `tools` is the only set of tools the agent can use.
- `writeScope` is enforced after every step. Files outside it are reverted and the violation is recorded and shown in `MR.md`. An empty list means read-only.
- `skills` are markdown files in `skills/` appended to the prompt.

A repository can add or replace agents and skills by committing them under `.agentpool/agents/` and `.agentpool/skills/`. Repo files win by name. Optional `.agentpool/config.json`:

```json
{
  "commands": { "setup": "npm ci", "test": "npm test", "lint": "npm run lint" },
  "autonomy": "plan-approval",
  "maxRounds": 2,
  "budgetUsd": 10,
  "agentBudgetUsd": 3,
  "model": "..."
}
```

An empty string for a command switches off what was auto-detected.

## Design notes

- **Event-sourced.** Everything that happens is appended to `.agentpool/runs/<id>/events.jsonl`. Run state is always folded from that log, so a run can stop anywhere and resume, and `agentpool log` shows exactly what happened.
- **Agents do not chat.** Each returns a typed JSON result. The run turns results into messages (`handoff`, `objection`, `question`, `decision`) and builds the next agent's brief from them. Malformed JSON gets one repair attempt.
- **Evidence over claims.** The run executes the test command itself and records the result next to what QA claimed.
- **Isolation.** Each run works in its own git worktree on its own branch. Your checkout is never touched. Step commits skip git hooks; your CI still runs on the pushed branch.
- **Cost control.** Per-run budget (`--budget-usd`), per-agent-step budget and turn limits. A run that hits its budget stops as failed.
- **Agent runtime.** Each agent runs through the [Claude Agent SDK](https://docs.claude.com/en/api/agent-sdk/overview) with its own tool allowlist, working directory and limits. The `AgentRunner` interface in `src/runner.ts` is the seam for other runtimes.

## Safety, as it stands

Agents run with `acceptEdits` permissions and can use the tools their definition lists, including Bash for the developer, QA and reviewer. The worktree and write-scope checks limit what lands in the branch, but this is **not a sandbox**: a Bash command can still reach anything your user account can. Run it in a container or VM for anything you do not trust. Treat task text pasted from tickets as untrusted input.

## What is not here yet

- Jira Server / Data Center, other trackers, and updating a pull request after review comments
- Product owner, architect, UX, and separate frontend and backend roles
- Web app, live timeline, and a shared message board across machines
- Repo zones for mixed modern and legacy code, and learning from corrections
- Real sandboxing, and agent-to-agent threads with humans joining mid-conversation
- Independent proposals and disagreement cards between agents

## Development

```sh
npm test            # unit tests and orchestrator tests with scripted agents
npm run typecheck
npm run dev -- run --runner dry-run "..."
```
