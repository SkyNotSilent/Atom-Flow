# Dockerfile for AtomFlow
FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy source code
COPY . .

# Build frontend
RUN npm run build

# Expose local fallback port; Railway injects PORT at runtime.
EXPOSE 1000

# Start server
CMD ["npm", "start"]
