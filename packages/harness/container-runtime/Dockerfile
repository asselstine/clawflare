# Clawflare Coding Container Image
# 
# This is a standard Debian-based image with Node.js, git, ripgrep, and other
# essential development tools. It includes a tiny HTTP server that runs inside
# the container to provide secure command execution and file operations.
#
# The entrypoint handles MITM TLS certificate installation from Cloudflare Containers.

FROM docker.io/library/node:22-bookworm-slim

# Install essential development tools
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    coreutils \
    findutils \
    git \
    grep \
    openssh-client \
    ripgrep \
    sed \
    tar \
    curl \
  && rm -rf /var/lib/apt/lists/*

# Set up workspace
WORKDIR /workspace

EXPOSE 8080

# Copy runtime server
COPY server.mjs /usr/local/bin/clawflare-container-server.mjs

# Entrypoint handles CA certificate installation for MITM HTTPS interception
# then starts the runtime server
ENTRYPOINT ["/bin/sh", "-lc", "if [ -f /etc/cloudflare/certs/cloudflare-containers-ca.crt ]; then cp /etc/cloudflare/certs/cloudflare-containers-ca.crt /usr/local/share/ca-certificates/cloudflare-containers-ca.crt && update-ca-certificates; fi; exec node /usr/local/bin/clawflare-container-server.mjs"]
