# Steel MCP Server. The browser is always a Steel session, cloud or self-hosted, so this image
# ships no Chromium of its own and needs no native build tools.
FROM node:22-alpine AS builder

WORKDIR /app

# Everything `npm run build` compiles from. tsconfig.build.json is the project the build script
# names; without it the build fails before it reads a source file.
COPY package.json tsconfig.json tsconfig.build.json ./
COPY src ./src

# No lockfile is copied because the repository does not track one, so `npm ci` would have nothing to
# read. Scripts are skipped because `prepare` builds, and the explicit build below is the one whose
# failure should be visible.
RUN npm install --ignore-scripts
RUN npm run build

# Drops the compiler and the test stack from what the runtime stage copies.
RUN npm prune --omit=dev

# This image serves either entrypoint, and `node dist/hosted.js` needs ioredis and
# @modelcontextprotocol/node. Both are optional peers — deliberately absent from a default install,
# so a desktop or npx user does not carry the hosted stack — which means the prune above removes
# them and this image has to ask for them by name. Installed at the versions package.json declares.
RUN npm install --no-save --ignore-scripts \
      $(node -p "Object.entries(require('./package.json').peerDependencies).map(([name, range]) => name + '@' + range).join(' ')")

FROM node:22-alpine

WORKDIR /app

COPY --from=builder /app/dist /app/dist
COPY --from=builder /app/node_modules /app/node_modules
COPY --from=builder /app/package.json /app/package.json

# stdio by default: that is what Smithery and every subprocess-spawning host launches. Override the
# command with `node dist/hosted.js` to serve the multi-tenant HTTP endpoint instead; it listens on
# PORT (8080 by default) and needs STEEL_ALLOWED_HOSTS.
#
# The base URL is deliberately unset, so an unconfigured container talks to Steel Cloud and says what
# it needs rather than silently pointing at a self-hosted browser that is not there.
ENTRYPOINT ["node", "dist/stdio.js"]
