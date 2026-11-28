# The container owns its certificate store, resolver and every test process.
FROM node:24.21.0-bookworm@sha256:6dac556d980b7f0e5498d08f08cee0ca67798b4ad6c23964a9214920e67758d0
ARG PLAYWRIGHT_VERSION=1.65.0
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/desktop-account-browsers
RUN npm install --prefix /opt/account-test --ignore-scripts --no-audit --no-fund "playwright@${PLAYWRIGHT_VERSION}" \
  && /opt/account-test/node_modules/.bin/playwright install --with-deps chromium \
  && rm -rf /var/lib/apt/lists/*
