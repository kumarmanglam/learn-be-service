# Node 20 + JDK 21 in one Alpine image so the service can run both the
# Express server and javac/java. Kept small; runs as a non-root user.
FROM node:20-alpine

# JDK provides javac + java. Alpine's openjdk21 is compact.
RUN apk add --no-cache openjdk21-jdk
ENV JAVA_HOME=/usr/lib/jvm/java-21-openjdk
ENV PATH="$JAVA_HOME/bin:$PATH"

WORKDIR /app

# Install deps first for layer caching.
COPY package*.json ./
RUN npm install --omit=dev

COPY server.js ./

# Defense-in-depth: never execute user code as root.
RUN adduser -D runner
USER runner

EXPOSE 3000
CMD ["node", "server.js"]
