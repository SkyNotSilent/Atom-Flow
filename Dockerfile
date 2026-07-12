# Dockerfile for AtomFlow
FROM node:22-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --include=dev

# Copy source code
COPY --chown=node:node . .

# Vite embeds the public tldraw production license during the image build.
ARG VITE_TLDRAW_LICENSE_KEY
ENV VITE_TLDRAW_LICENSE_KEY=$VITE_TLDRAW_LICENSE_KEY

# Build frontend
RUN npm run build

ENV NODE_ENV=production

# The server persists its RSS fallback cache here when object storage is unavailable.
RUN mkdir -p /app/.cache && chown node:node /app/.cache

# Expose local fallback port; Railway injects PORT at runtime.
EXPOSE 1000

# Run the production process without root privileges.
USER node

# Start server
CMD ["npm", "start"]
