# Steel MCP Server. The browser is always a Steel session, cloud or self-hosted, so this image
# ships no Chromium of its own and needs no native build tools.
FROM node:22-alpine AS builder

WORKDIR /app

# Everything `npm run build` compiles from. tsconfig.build.json is the project the build script
# names; without it the build fails before it reads a source file.
COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY scripts/clean-dist.mjs ./scripts/clean-dist.mjs

# The tracked lock makes the image use the same dependency graph as CI and release. Scripts are
# skipped because `prepare` builds, and the explicit build below is the one whose failure is visible.
RUN npm ci --ignore-scripts
RUN npm run build

# Reduces node_modules to what the runtime stage should carry: the four production dependencies, plus
# the two optional peers `node dist/hosted.js` imports. Those peers are absent from a default install
# by design, so that a desktop or npx user does not pay for the hosted stack, which means this image
# has to ask for them by name — at the versions package.json declares, so the two cannot drift.
#
# Both other orderings are wrong, and each was measured to be wrong:
#   - installing before the prune loses the peers, because prune drops anything package.json does not
#     list as a dependency;
#   - `npm install --omit=dev <names>` installs nothing at all, so the hosted entrypoint cannot resolve
#     ioredis at startup.
# Deleting devDependencies first is what lets the plain install below add the peers without also
# putting the compiler and the linter back — which cost 280MB of image before it was caught.
#
# The exporter stack is deliberately not here. tracing.ts loads it through a dynamic import inside a
# try/catch that warns and carries on, so an image without it serves normally and an operator who
# wants traces installs two more packages.
# The version ranges are read before the peer block is deleted, because npm keeps a declared peer
# through a prune even when it is marked optional — deleting the declarations is what lets the prune
# take the exporter stack with it.
RUN IOREDIS="$(node -p "require('./package.json').peerDependencies.ioredis")" \
 && MCP_NODE="$(node -p "require('./package.json').peerDependencies['@modelcontextprotocol/node']")" \
 && npm pkg delete devDependencies peerDependencies peerDependenciesMeta \
 && npm prune --omit=dev \
 && npm install --no-save --ignore-scripts "ioredis@$IOREDIS" "@modelcontextprotocol/node@$MCP_NODE"

FROM node:22-alpine

WORKDIR /app

COPY --from=builder /app/dist /app/dist
COPY --from=builder /app/node_modules /app/node_modules
COPY --from=builder /app/package.json /app/package.json

# stdio by default: that is what Smithery and every subprocess-spawning host launches. Run
# `docker run <image> dist/hosted.js` to serve the multi-tenant HTTP endpoint instead; it listens on
# PORT (8080 by default) and needs STEEL_ALLOWED_HOSTS.
#
# The script is CMD rather than part of ENTRYPOINT so that overriding it works. With the entrypoint
# naming the script, run arguments are *appended* to it, so `docker run <image> node dist/hosted.js`
# executed `node dist/stdio.js node dist/hosted.js` — the stdio server, silently, for an operator who
# asked for the hosted one.
#
# The base URL is deliberately unset, so an unconfigured container talks to Steel Cloud and says what
# it needs rather than silently pointing at a self-hosted browser that is not there.
ENTRYPOINT ["node"]
CMD ["dist/stdio.js"]
