FROM node:22-slim

WORKDIR /app
ENV PORT=8787 \
    SAMPLE_MODE=true

# Install everything at build time; nothing installs while the app runs.
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
COPY engines/hmem/package.json engines/hmem/
COPY engines/world-model/package.json engines/world-model/
COPY engines/scout-intent/package.json engines/scout-intent/
RUN npm ci

COPY . .
RUN npm run build -w web && mkdir -p logs data/runtime

EXPOSE 8787
# First start runs the two demo nights (a few seconds), then serves the API and UI.
CMD ["sh", "-c", "[ -f data/runtime/latest.json ] || npm run demo; npm start"]
