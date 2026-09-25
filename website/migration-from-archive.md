# Moving an install from the archived repository

Omnesis used to live in a private repository that is now archived. Since release 0.5.11 it lives at **https://github.com/omnesis-dev/Omnesis**, which is public and has a fresh history.

If you installed Omnesis before that move, your install still points at the old history, and `omnesis update` cannot follow the move on its own. Re-running the install command once on each of your machines moves it to the new repository. This guide walks through it. It is written so that you can follow it yourself, or hand it to your coding agent and have it do the work.

Your data, settings, certificate, keyring, embedding model and device pairings are kept. Collectors do not need a new pairing code.

## Before you start

Know which role each machine has:

- the **gateway**: the machine that stores your index and serves the portal (usually just one);
- **collectors**: machines that sync sources to the gateway, such as a Mac reading Apple Notes or iMessage;
- **agent hosts**: machines where OpenClaw or Hermes is connected to Omnesis;
- **CLI-only** machines, where you only use the `omnesis` command.

One machine can have several roles. A gateway machine also runs a collector, for example, and a collector machine may also host an agent.

## Migrate, one machine at a time

Do the **gateway first**, then every collector, then the agent hosts. A collector newer than its gateway waits for the gateway to catch up, so this order avoids that pause.

Run the command for the machine's role in a terminal on that machine, as the user that installed Omnesis there:

| Machine       | Command                                                               |
| ------------- | --------------------------------------------------------------------- |
| Gateway       | `curl -fsSL https://omnesis.dev/install.sh \| sh`                     |
| Collector     | `curl -fsSL https://omnesis.dev/install.sh \| sh -s -- --collector`   |
| CLI-only      | `curl -fsSL https://omnesis.dev/install.sh \| sh -s -- --client-only` |
| OpenClaw host | `curl -fsSL https://omnesis.dev/install.sh \| sh -s -- --openclaw`    |
| Hermes host   | `curl -fsSL https://omnesis.dev/install.sh \| sh -s -- --hermes`      |

**Preview first.** Add `--dry-run` to any of these commands to print the installer's plan without changing anything. With a pipe, put it after `sh -s --`: for example `curl -fsSL https://omnesis.dev/install.sh | sh -s -- --collector --dry-run`. The plan's **Role** line must read **"update of this machine's existing install"** (agent hosts are the exception; see below). If it reads anything else, don't run the real command. See "If something goes wrong".

For a machine with several roles, run the command for the highest one in the order the table lists (gateway, then collector, then CLI-only). That run also refreshes any OpenClaw or Hermes plugin on the machine. You don't need a second run for the agents unless the machine only hosts agents.

What to expect:

- The installer prints an **Install plan** whose role reads **"update of this machine's existing install"**. That means it found your existing install and will update it rather than set up a new one. It then runs the machine's own `omnesis update`, which moves your checkout to the new history, rebuilds, restarts the Omnesis services, and rolls back if anything fails. It ends with **"Omnesis is up to date."**
- On an **agent host** the plan's role names the agent instead, and the installer says the agent "is already connected — refreshing its plugin and skill, keeping its pairing". Afterwards, restart the agent so it loads the new plugin: `openclaw gateway restart` or `hermes gateway restart`.
- The gateway machine's update also takes a backup of the gateway's data before it changes anything.

Do not add `--reconfigure` or any setup flag (`--code`, `--port`, `--embedder`, `--mkcert` and so on). Those tell the installer to set the machine up again from scratch.

## Check that it worked

On each machine:

```sh
omnesis --version
```

It should print `0.5.13` or later.

On the gateway machine:

```sh
omnesis devices list
```

Every collector and agent you migrated should show the new version with the state `current`. A device that shows `behind` has not been migrated yet, or has not reconnected. Collectors reconnect on their own within a minute or two.

From now on, `omnesis update` works normally on every machine. On the gateway, `omnesis update --fleet` updates the gateway and then tells every connected collector and agent to update itself.

## If something goes wrong

- **The dry-run's role is not "update of this machine's existing install"** (for example it says "gateway and collector" on a collector machine): the installer did not recognise the existing install, and the real run would set the machine up again. The usual cause is a role flag that doesn't match what the machine runs: check the table above. If the flag is right, see the next item.
- **An install from before version 0.4.7** has no update record for the installer to find, so it runs the full setup. A collector then asks for a pairing code. Create one on the gateway machine with `omnesis devices pair --kind collector` and paste it in. Your data on the gateway is untouched.
- **The update refuses because the checkout has local changes**: someone edited files in the Omnesis source directory. Commit or discard those changes (`git -C <that directory> stash`), then re-run the command.
- **An agent did not pick up the new plugin**: restart it with `openclaw gateway restart` or `hermes gateway restart`.

Anything else: open an issue at https://github.com/omnesis-dev/Omnesis/issues. Include the machine's role and the last lines the installer printed.

## For coding agents

If a person handed you this file: migrate each Omnesis machine they name with the command for its role from the table above.

- Do the gateway first.
- Run the command as the user that owns the install.
- Run it with `--dry-run` first. Stop and ask the person if the printed role is not "update of this machine's existing install" (agent hosts excepted).
- Afterwards, confirm `omnesis --version` on each machine and `omnesis devices list` on the gateway.
- Never pass `--reconfigure` or setup flags, and never delete the existing Omnesis source directory or `~/.config/omnesis`.
