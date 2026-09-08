# Personal Organizer — container image for Northflank (or any Docker host).
FROM node:22-alpine

# Timezone data so Europe/Bucharest conversions work correctly.
# (Alpine has no tzdata by default; without it every fixture time would be
# computed as UTC and land an hour or two off.)
RUN apk add --no-cache tzdata
ENV TZ=Europe/Bucharest

WORKDIR /app

# Install dependencies first so this layer caches between code changes.
COPY package*.json ./
RUN npm install --omit=dev

# Application code.
COPY . .

# The app reads both of these from the environment; DATA_DIR must point at
# the mounted persistent volume or data resets on every redeploy.
ENV PORT=3000
ENV DATA_DIR=/data

EXPOSE 3000

CMD ["node", "server.js"]
