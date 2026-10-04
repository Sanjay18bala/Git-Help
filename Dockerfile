# GitHelp, always on: the built app, the API and the bot's background checks in one container.
#   docker build -t githelp .
#   docker run -d --name githelp --restart unless-stopped -p 5173:5173 --env-file .env -v githelp-data:/app/.data githelp
# Node 22.13+ is required for the built-in node:sqlite.
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=5173
COPY --from=build /app /app
# The database (linked channels, replies, settings, the sealed GitHub token) lives in this volume.
RUN mkdir -p /app/.data && chown -R node:node /app/.data
USER node
VOLUME /app/.data
EXPOSE 5173
CMD ["node", "start.js"]
