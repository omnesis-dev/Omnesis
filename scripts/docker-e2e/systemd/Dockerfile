# The dedicated-account gateway under real systemd: Ubuntu with systemd as its
# first process, a Node 24 under /usr/local that only root can change, and a
# local git repository holding releases of the checkout this image is built
# from. scripts/docker-e2e/systemd/run.sh boots it privileged and runs
# scenario.sh inside it.
FROM node:24-bookworm AS node

FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive

# systemd and dbus for the service manager; git to fetch releases; a compiler
# toolchain for native modules without a prebuilt binary; sudo, because an
# operator runs the admin command through it; curl and procps for the
# scenario's probes.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    systemd systemd-sysv dbus ca-certificates curl git python3 make g++ procps sudo \
  && rm -rf /var/lib/apt/lists/*

COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
  && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
  && node --version && npm --version

# The login account's own checkout, with its dependencies, for its collector.
# Installing it also fills the npm cache the release builds start from.
COPY . /src
RUN cd /src \
  && npm ci --no-audit --no-fund --cache /var/cache/omnesis-npm-seed \
  && chmod -R a+rX /src /var/cache/omnesis-npm-seed

# The repository root fetches releases from:
#   lane-a  this checkout
#   lane-b  one commit later
#   lane-c  a release whose gateway exits as it starts, to prove the rollback
#   lane-d  one commit after lane-b, to interrupt while it builds
RUN git config --global user.name "Omnesis lane" \
  && git config --global user.email lane@example.com \
  && git config --global init.defaultBranch main \
  && mkdir /srv/work \
  && (cd /src && tar --exclude=node_modules -cf - .) | tar -xf - -C /srv/work \
  && cd /srv/work \
  && git init -q && git add -A && git commit -q -m "lane a" && git tag lane-a \
  && printf 'lane b\n' > LANE.txt && git add LANE.txt && git commit -q -m "lane b" && git tag lane-b \
  && git checkout -q -b broken \
  && sed -i '1a if (process.argv.includes("serve")) process.exit(3);' packages/cli/src/index.ts \
  && git commit -qam "lane c: the gateway exits as it starts" && git tag lane-c \
  && git checkout -q main \
  && printf 'lane d\n' > LANE.txt && git commit -qam "lane d" && git tag lane-d \
  && git clone -q --bare /srv/work /srv/omnesis.git \
  && rm -rf /srv/work

STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
