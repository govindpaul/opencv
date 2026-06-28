# Container image for the multiplayer chess server. Works on any container
# host (Railway, Fly.io, Render, Google Cloud Run, etc.).
FROM node:20-alpine

WORKDIR /app

# Install dependencies first for better layer caching.
COPY package*.json ./
RUN npm install --omit=dev

# Copy the application.
COPY . .

# The server reads PORT from the environment (defaults to 3000).
EXPOSE 3000
CMD ["node", "server.js"]
