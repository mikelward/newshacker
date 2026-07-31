FROM ubuntu:24.04

# Node.js 22 LTS — satisfies package.json engines "^20.19.0 || >=22.12.0"
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/*
